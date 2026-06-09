import { loadCapabilities } from "./capabilities.ts";
import { analyzeRecordedRun, type RunAnalysis } from "./analysis.ts";
import { getLabState } from "./lab-state.ts";
import { runHardwarePilotKernel } from "./kernel/hardware-pilot.ts";
import { advanceRun, pollRun, startRun, type RunState } from "./kernel/kernel.ts";
import { runLabAgentKernel } from "./kernel/lab-agent-kernel.ts";
import { createStageAdapter } from "./kernel/stage-adapter.ts";
import { planNextExperiment } from "./planning.ts";
import { validatePolicy } from "./policy.ts";
import { preflight } from "./preflight.ts";
import {
	appendHardwareRunRecords,
	appendOperatorIntent,
	appendPreflightReport,
	appendRunRecords,
	type OperatorIntentType,
	validateHardwareGate,
} from "./records.ts";
import { createErrorResult, createSuccessResult, issuesState } from "./results.ts";
import {
	ActiveRunConflictError,
	appendDecisionAudit,
	appendLineage,
	markRunFinished,
	markRunRunning,
	readExperimentLineage,
	readRecordedAnalysis,
	readRecordedArtifacts,
	readRecordedEvents,
	readRecordedSpec,
	readRecordedSummary,
	readRunRecord,
	type ReservedRun,
	reserveRun,
	writeRecordedAnalysis,
} from "./run-store.ts";
import {
	AdvanceRunParamsSchema,
	AnalyzeRunParamsSchema,
	OperatorIntentParamsSchema,
	PlanNextExperimentParamsSchema,
	PollRunParamsSchema,
	RunExperimentParamsSchema,
	RunPreflightParamsSchema,
	StartRunParamsSchema,
	type AdvanceRunParams,
	type ExperimentSpec,
	type OperatorIntentParams,
	type PlanNextExperimentParams,
	type PollRunParams,
	type RunExperimentParams,
	type RunPreflightParams,
	type StartRunParams,
	type ToolResult,
	validateExperimentSpec,
	validateSchema,
} from "./schemas.ts";

export type DispatchToolName =
	| "run_preflight"
	| "run_experiment"
	| "analyze_run"
	| "plan_next_experiment"
	| "start_run"
	| "advance_run"
	| "poll_run";

export interface DispatchContext {
	cwd?: string;
	commandId?: string;
}

function getCwd(ctx: DispatchContext | undefined): string {
	return ctx?.cwd ?? ".";
}

let nextDispatchCommandNumber = 1;

function getCommandId(ctx: DispatchContext | undefined, fallback: string): string {
	if (ctx?.commandId) return ctx.commandId;
	const id = `${fallback}-${String(nextDispatchCommandNumber).padStart(4, "0")}`;
	nextDispatchCommandNumber += 1;
	return id;
}

function invalidParamsResult(commandId: string, issues: ToolResult["stateAfter"]): ToolResult {
	return createErrorResult(
		commandId,
		"Tool parameters failed validation.",
		"invalid_tool_params",
		["Fix the tool parameters and call the tool again."],
		issues,
		true,
	);
}

function validateSpecForTool(commandId: string, value: unknown): ExperimentSpec | ToolResult {
	const validation = validateExperimentSpec(value);
	if (validation.valid) return validation.value;
	return createErrorResult(
		commandId,
		`ExperimentSpec failed validation with ${validation.issues.length} issue(s).`,
		"invalid_experiment_spec",
		["Fix the reported schema issues.", "Call validate_experiment_spec before retrying."],
		issuesState(validation.issues),
		true,
	);
}

function reserveRunGuarded(
	commandId: string,
	cwd: string,
	spec: ExperimentSpec,
	capabilities: Parameters<typeof reserveRun>[3],
): ReservedRun | ToolResult {
	try {
		return reserveRun(cwd, spec, commandId, capabilities);
	} catch (error) {
		if (error instanceof ActiveRunConflictError) {
			return createErrorResult(
				commandId,
				`Cannot start a new run: ${error.runId} is ${error.status}.`,
				"run_active_conflict",
				[
					"Abort or resume the active run before starting a new bounded run.",
					`Call abort_run with runId ${error.runId} to clear a paused or stuck run.`,
				],
				{ activeRunId: error.runId, status: error.status },
				true,
				spec.experimentId,
			);
		}
		throw error;
	}
}

function policyResult(
	commandId: string,
	spec: ExperimentSpec,
	toolName: "run_preflight" | "run_experiment" | "analyze_run",
	ctx?: DispatchContext,
): ToolResult | undefined {
	const validation = validatePolicy(spec, getLabState(getCwd(ctx)), { toolName });
	if (validation.valid) return undefined;
	return createErrorResult(
		commandId,
		`ExperimentSpec failed policy validation with ${validation.issues.length} issue(s).`,
		"policy_rejected",
		["Change the ExperimentSpec to a supported mode and keep it within current phase limits."],
		issuesState(validation.issues),
		true,
		spec.experimentId,
	);
}

function runPreflight(commandId: string, params: RunPreflightParams, ctx?: DispatchContext): ToolResult {
	const specOrResult = validateSpecForTool(commandId, params.spec);
	if ("status" in specOrResult) return specOrResult;

	const policy = policyResult(commandId, specOrResult, "run_preflight", ctx);
	if (policy) return policy;

	const capabilityMode = specOrResult.mode === "simulation" ? "simulation" : "dry_run";
	const capabilities = loadCapabilities(capabilityMode);
	const result = preflight(specOrResult, capabilities, getLabState(getCwd(ctx)));
	if (!result.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${result.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues and call run_preflight again."],
			{ ...issuesState(result.issues), unitCount: result.unitCount },
			true,
			specOrResult.experimentId,
		);
	}

	const records =
		result.mode === "dry_run" || result.mode === "hardware"
			? appendPreflightReport(specOrResult, result, capabilities, getCwd(ctx))
			: undefined;

	return createSuccessResult(
		commandId,
		`Preflight passed for ${result.unitCount} ${result.mode} unit(s).`,
		records ? { ...result, specHash: records.specHash, capabilitySnapshotId: records.capabilitySnapshotId, records } : result,
		result.mode === "simulation"
			? ["Call run_experiment with the same ExperimentSpec."]
			: ["Review the dry-run readiness report before considering hardware pilot approval."],
		records?.artifacts,
		undefined,
		specOrResult.experimentId,
	);
}

function runHardwareExperiment(commandId: string, spec: ExperimentSpec, params: RunExperimentParams, ctx?: DispatchContext): ToolResult {
	if (!params.hardwarePilot) {
		return createErrorResult(
			commandId,
			"hardware mode requires hardwarePilot parameters.",
			"hardware_pilot_params_required",
			["Provide hardwarePilot approval, watchdog, and stage adapter parameters."],
			{ mode: spec.mode },
			true,
		);
	}

	if (params.hardwarePilot.stageAdapter === "memory" && process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE !== "1") {
		return createErrorResult(
			commandId,
			"hardware mode requires a real stage adapter; the memory adapter is a simulated stand-in.",
			"simulated_hardware_not_allowed",
			["Use the mc_newton_xyz stage adapter for hardware runs, or run the spec in simulation mode."],
			{ stageAdapter: "memory" },
			false,
			spec.experimentId,
		);
	}

	const cwd = getCwd(ctx);
	const gate = validateHardwareGate(spec, params.hardwarePilot.approval, cwd);
	if (!gate.valid) {
		return createErrorResult(
			commandId,
			`Hardware gate failed with ${gate.issues.length} issue(s).`,
			"hardware_gate_failed",
			["Run dry-run preflight for the same spec and provide an explicit operator approval."],
			{ valid: false, issues: gate.issues, dryRunReportPath: gate.dryRunReportPath },
			true,
		);
	}

	const capabilities = loadCapabilities("hardware");
	const preflightResult = preflight(spec, capabilities, getLabState(cwd));
	if (!preflightResult.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${preflightResult.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues before retrying hardware run."],
			{ ...issuesState(preflightResult.issues), unitCount: preflightResult.unitCount },
			true,
			spec.experimentId,
		);
	}

	const reserved = reserveRunGuarded(commandId, cwd, spec, capabilities);
	if ("status" in reserved) return reserved;
	markRunRunning(cwd, reserved.record.runId);
	const pilot = {
		...params.hardwarePilot,
		intentsPath: params.hardwarePilot.intentsPath ?? reserved.intentsPath,
	};
	const stage = createStageAdapter(pilot, cwd);
	const run = runHardwarePilotKernel(spec, {
		runId: reserved.record.runId,
		stage,
		pilot,
		eventsPath: reserved.eventsPath,
		startPointIndex: params.resumeFrom === undefined ? undefined : Number(params.resumeFrom),
		correlationId: commandId,
	});
	const records = appendHardwareRunRecords(run, pilot, reserved, cwd);

	const status = run.summary.status === "completed" ? "success" : "warning";
	return {
		...createSuccessResult(
			commandId,
			`Hardware run ${run.runId} ${run.summary.status} with ${run.summary.completedUnits}/${run.summary.unitCount} completed unit(s).`,
			{ summary: run.summary, unitRecords: run.points, records },
			["Review hardware events, approval, and summary records before any next run."],
			records.artifacts,
			run.runId,
			spec.experimentId,
		),
		status,
		stopConditionMet: run.summary.stopConditionMet,
	};
}

function runExperiment(commandId: string, params: RunExperimentParams, ctx?: DispatchContext): ToolResult {
	if (params.resumeFrom !== undefined && Number.isNaN(Number(params.resumeFrom))) {
		return createErrorResult(
			commandId,
			"resumeFrom must be a completed point index for hardware resume.",
			"invalid_resume_from",
			["Use the last completed hardware point index plus one, or omit resumeFrom."],
			{ resumeFrom: params.resumeFrom },
			true,
		);
	}

	const specOrResult = validateSpecForTool(commandId, params.spec);
	if ("status" in specOrResult) return specOrResult;

	if (specOrResult.mode === "dry_run") {
		return createErrorResult(
			commandId,
			"dry_run mode is preflight-only and does not execute through run_experiment.",
			"dry_run_execution_not_supported",
			["Call run_preflight for dry_run readiness, or switch the spec to simulation for run_experiment."],
			{ mode: specOrResult.mode },
			true,
		);
	}

	const policy = policyResult(commandId, specOrResult, "run_experiment", ctx);
	if (policy) return policy;

	if (specOrResult.mode === "hardware") {
		return runHardwareExperiment(commandId, specOrResult, params, ctx);
	}

	if (params.resumeFrom !== undefined) {
		return createErrorResult(
			commandId,
			"Simulation resume is not supported.",
			"resume_not_supported",
			["Remove resumeFrom and start a new simulation run."],
			{ resumeFrom: params.resumeFrom },
			true,
		);
	}

	const capabilities = loadCapabilities("simulation");
	const preflightResult = preflight(specOrResult, capabilities, getLabState(getCwd(ctx)));
	if (!preflightResult.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${preflightResult.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues and call run_preflight before retrying run_experiment."],
			{ ...issuesState(preflightResult.issues), unitCount: preflightResult.unitCount },
			true,
			specOrResult.experimentId,
		);
	}

	const cwd = getCwd(ctx);
	const reserved = reserveRunGuarded(commandId, cwd, specOrResult, capabilities);
	if ("status" in reserved) return reserved;
	markRunRunning(cwd, reserved.record.runId);
	const run = runLabAgentKernel(reserved.record.runId, specOrResult);
	const records = appendRunRecords(run, reserved, commandId, cwd);

	return createSuccessResult(
		commandId,
		`Simulation run ${run.runId} completed with ${run.summary.unitCount} unit(s).`,
		{ summary: run.summary, unitRecords: run.points, records },
		["Call analyze_run with the returned runId."],
		records.artifacts,
		run.runId,
		specOrResult.experimentId,
	);
}

function analyzeRun(commandId: string, runId: string, ctx?: DispatchContext): ToolResult {
	const cwd = getCwd(ctx);
	const summary = readRecordedSummary(cwd, runId);
	if (!summary) {
		return createErrorResult(
			commandId,
			`Run not found: ${runId}`,
			"run_not_found",
			["Use a runId returned by run_experiment."],
			{ runId, found: false },
			false,
		);
	}
	const spec = readRecordedSpec(cwd, runId);
	const events = readRecordedEvents(cwd, runId);
	const artifacts = readRecordedArtifacts(cwd, runId);
	const analysis = analyzeRecordedRun({
		runId,
		summary,
		spec,
		events,
		artifacts,
	});
	const analysisArtifact = writeRecordedAnalysis(cwd, runId, analysis);
	const status = analysis.anomalies.some((anomaly) => anomaly.severity === "critical") ? "warning" : "success";
	const meanSignal = analysis.qualityMetrics.meanSignal;
	const unitCount = analysis.qualityMetrics.unitCount;

	return {
		...createSuccessResult(
			commandId,
			meanSignal === undefined
				? `Run ${runId} analysis completed for ${unitCount} unit(s).`
				: `Run ${runId} analysis completed: mean signal ${meanSignal}, ${unitCount} unit(s).`,
			{ summary, analysis, artifacts: [...analysis.artifactRefs, analysisArtifact] },
			["Use plan_next_experiment to choose a bounded next-step strategy."],
			[
				{ uri: `.pi/experiment-runs/runs/${runId}/summary.json`, label: "Run summary", kind: "summary" },
				analysisArtifact,
			],
			runId,
			analysis.experimentId,
		),
		status,
		stopConditionMet: analysis.stopConditionMet,
	};
}

function planNext(commandId: string, params: PlanNextExperimentParams, ctx?: DispatchContext): ToolResult {
	const cwd = getCwd(ctx);
	const summary = readRecordedSummary(cwd, params.runId);
	if (!summary) {
		return createErrorResult(
			commandId,
			`Run not found: ${params.runId}`,
			"run_not_found",
			["Use a runId returned by run_experiment."],
			{ runId: params.runId, found: false },
			false,
		);
	}

	const rawAnalysis = readRecordedAnalysis(cwd, params.runId);
	const analysis = isRunAnalysis(rawAnalysis) ? rawAnalysis : undefined;
	const summaryExperimentId = readSummaryExperimentId(summary);
	const lineage = summaryExperimentId ? readExperimentLineage(cwd, summaryExperimentId) : [];
	const plan = planNextExperiment({
		summary,
		analysis,
		lineage,
		objective: params.objective,
	});
	const lineagePath = appendLineage(cwd, plan.experimentId, {
		parentRunId: params.runId,
		strategy: plan.strategy,
		inputArtifacts: plan.inputArtifacts,
		generatedSpecId: plan.compilerInput.suggestedSpecId,
		reason: plan.rationale,
		createdAt: new Date().toISOString(),
	});
	const decisionsPath = appendDecisionAudit(cwd, plan.experimentId, {
		decisionId: `${commandId}-decision`,
		commandId,
		parentRunId: params.runId,
		strategy: plan.strategy,
		rationale: plan.rationale,
		inputArtifacts: plan.inputArtifacts,
		stopConditionMet: analysis?.stopConditionMet ?? false,
		createdAt: new Date().toISOString(),
	});
	return createSuccessResult(
		commandId,
		`Next strategy for ${params.runId}: ${plan.strategy}.`,
		{ ...plan, lineagePath, decisionsPath },
		["Compile this strategy into a new bounded ExperimentSpec before any run.", "Run validate_experiment_spec and run_preflight on the compiled spec."],
		plan.inputArtifacts.map((uri) => ({ uri, label: "Planning input artifact", kind: "planning-input" })),
		params.runId,
		plan.experimentId,
	);
}

function isRunAnalysis(value: unknown): value is RunAnalysis {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.schemaVersion === "1" &&
		typeof record.runId === "string" &&
		typeof record.status === "string" &&
		typeof record.qualityMetrics === "object" &&
		record.qualityMetrics !== null &&
		Array.isArray(record.anomalies) &&
		Array.isArray(record.artifactRefs) &&
		Array.isArray(record.stoppingRules) &&
		typeof record.stopConditionMet === "boolean"
	);
}

function readSummaryExperimentId(summary: unknown): string | undefined {
	if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return undefined;
	const experimentId = (summary as Record<string, unknown>).experimentId;
	return typeof experimentId === "string" ? experimentId : undefined;
}

function advanceNextActions(state: RunState): string[] {
	switch (state.status) {
		case "completed":
			return ["Call analyze_run with the returned runId."];
		case "running":
			return ["Call advance_run again to continue execution, or poll_run to observe progress.", "Use pause_run or abort_run to intervene before the next unit."];
		case "paused":
			return ["Resolve the operator pause cause, then call advance_run to resume, or abort_run to finalize the run."];
		case "aborted":
			return ["Run was aborted at a safe unit boundary; review records and start a new bounded run."];
		default:
			return ["Call poll_run to observe the current RunState."];
	}
}

function lifecycleResult(commandId: string, state: RunState, experimentId: string | undefined): ToolResult {
	const terminalStop = state.status === "paused" || state.status === "aborted";
	return {
		...createSuccessResult(
			commandId,
			`Run ${state.runId} is ${state.status} (${state.progress.completedUnits}/${state.progress.totalUnits} units).`,
			{ runState: state },
			advanceNextActions(state),
			[],
			state.runId,
			experimentId,
		),
		status: terminalStop ? "warning" : "success",
		stopConditionMet: terminalStop,
	};
}

function startRunDispatch(commandId: string, params: StartRunParams, ctx?: DispatchContext): ToolResult {
	const specOrResult = validateSpecForTool(commandId, params.spec);
	if ("status" in specOrResult) return specOrResult;
	const spec = specOrResult;

	if (spec.mode !== "simulation") {
		return createErrorResult(
			commandId,
			"The async run lifecycle currently supports simulation specs only.",
			"lifecycle_mode_not_supported",
			["Use run_experiment for approved hardware pilots.", "Set spec.mode to simulation to use start_run/advance_run/poll_run."],
			{ mode: spec.mode },
			true,
			spec.experimentId,
		);
	}

	const policy = policyResult(commandId, spec, "run_experiment", ctx);
	if (policy) return policy;

	const cwd = getCwd(ctx);
	const capabilities = loadCapabilities("simulation");
	const preflightResult = preflight(spec, capabilities, getLabState(cwd));
	if (!preflightResult.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${preflightResult.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues and call run_preflight before retrying start_run."],
			{ ...issuesState(preflightResult.issues), unitCount: preflightResult.unitCount },
			true,
			spec.experimentId,
		);
	}

	const reserved = reserveRunGuarded(commandId, cwd, spec, capabilities);
	if ("status" in reserved) return reserved;
	const state = startRun(cwd, reserved, commandId);
	return createSuccessResult(
		commandId,
		`Started run ${state.runId}; 0/${state.progress.totalUnits} units executed.`,
		{ runState: state },
		["Call advance_run with the returned runId to execute bounded units.", "Call poll_run to observe progress; pause_run/abort_run intervene at the next unit boundary."],
		[],
		state.runId,
		spec.experimentId,
	);
}

function advanceRunDispatch(commandId: string, params: AdvanceRunParams, ctx?: DispatchContext): ToolResult {
	const cwd = getCwd(ctx);
	let record: ReturnType<typeof readRunRecord>;
	try {
		record = readRunRecord(cwd, params.runId);
	} catch {
		return createErrorResult(
			commandId,
			`Run not found: ${params.runId}`,
			"run_not_found",
			["Use a runId returned by start_run."],
			{ runId: params.runId, found: false },
			false,
		);
	}
	if (record.status !== "running" && record.status !== "paused") {
		return createErrorResult(
			commandId,
			`Run ${params.runId} is ${record.status} and cannot be advanced.`,
			"run_not_advanceable",
			["Only running or paused runs can be advanced.", "Start a new bounded run with start_run."],
			{ runId: params.runId, status: record.status },
			false,
			record.experimentId,
		);
	}
	const state = advanceRun(cwd, params.runId, { maxUnits: params.maxUnits, correlationId: commandId });
	return lifecycleResult(commandId, state, record.experimentId);
}

function pollRunDispatch(commandId: string, params: PollRunParams, ctx?: DispatchContext): ToolResult {
	const cwd = getCwd(ctx);
	let record: ReturnType<typeof readRunRecord>;
	try {
		record = readRunRecord(cwd, params.runId);
	} catch {
		return createErrorResult(
			commandId,
			`Run not found: ${params.runId}`,
			"run_not_found",
			["Use a runId returned by start_run."],
			{ runId: params.runId, found: false },
			false,
		);
	}
	const state = pollRun(cwd, params.runId);
	return createSuccessResult(
		commandId,
		`Run ${state.runId} is ${state.status} (${state.progress.completedUnits}/${state.progress.totalUnits} units).`,
		{ runState: state },
		advanceNextActions(state),
		[],
		state.runId,
		record.experimentId,
	);
}

function operatorIntent(
	commandId: string,
	toolName: "pause_run" | "abort_run" | "request_operator",
	params: OperatorIntentParams,
	ctx?: DispatchContext,
): ToolResult {
	const intent: OperatorIntentType =
		toolName === "pause_run" ? "pause" : toolName === "abort_run" ? "abort" : "request_operator";
	const cwd = getCwd(ctx);
	const ref = appendOperatorIntent(params.runId, intent, params.reason, cwd);
	if (intent === "abort") {
		try {
			const record = readRunRecord(cwd, params.runId);
			if (record.status === "running" || record.status === "paused" || record.status === "recovering") {
				markRunFinished(cwd, params.runId, "aborted");
			}
		} catch {
			// Run is not in the store yet; the intent file is still written for a live kernel to consume.
		}
	}
	return createSuccessResult(
		commandId,
		`Recorded operator ${intent} intent for ${params.runId}.`,
		{ runId: params.runId, intent, reason: params.reason },
		[
			"The hardware kernel reads this intent at the next safe point boundary.",
			intent === "abort"
				? "Resume only after the operator clears the cause and approves a new bounded run."
				: "Review run records before resuming or starting a new bounded run.",
		],
		[{ uri: ref.relativeIntentsPath, label: "Operator intents", kind: "intents" }],
		params.runId,
	);
}

export function dispatch(toolName: string, params: unknown, ctx?: DispatchContext): ToolResult {
	switch (toolName) {
		case "run_preflight": {
			const validation = validateSchema(RunPreflightParamsSchema, params);
			const commandId = getCommandId(ctx, "run-preflight");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return runPreflight(commandId, validation.value, ctx);
		}
		case "run_experiment": {
			const validation = validateSchema(RunExperimentParamsSchema, params);
			const commandId = getCommandId(ctx, "run-experiment");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return runExperiment(commandId, validation.value, ctx);
		}
		case "analyze_run": {
			const validation = validateSchema(AnalyzeRunParamsSchema, params);
			const commandId = getCommandId(ctx, "analyze-run");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return analyzeRun(commandId, validation.value.runId, ctx);
		}
		case "plan_next_experiment": {
			const validation = validateSchema(PlanNextExperimentParamsSchema, params);
			const commandId = getCommandId(ctx, "plan-next-experiment");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return planNext(commandId, validation.value, ctx);
		}
		case "start_run": {
			const validation = validateSchema(StartRunParamsSchema, params);
			const commandId = getCommandId(ctx, "start-run");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return startRunDispatch(commandId, validation.value, ctx);
		}
		case "advance_run": {
			const validation = validateSchema(AdvanceRunParamsSchema, params);
			const commandId = getCommandId(ctx, "advance-run");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return advanceRunDispatch(commandId, validation.value, ctx);
		}
		case "poll_run": {
			const validation = validateSchema(PollRunParamsSchema, params);
			const commandId = getCommandId(ctx, "poll-run");
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return pollRunDispatch(commandId, validation.value, ctx);
		}
		case "pause_run":
		case "abort_run":
		case "request_operator": {
			const validation = validateSchema(OperatorIntentParamsSchema, params);
			const commandId = getCommandId(ctx, `${toolName}-intent`);
			if (!validation.valid) return invalidParamsResult(commandId, issuesState(validation.issues));
			return operatorIntent(commandId, toolName, validation.value, ctx);
		}
		default:
			return createErrorResult(
				"dispatch",
				`Unknown experiment tool: ${toolName}`,
				"tool_not_found",
				[
					"Call one of: run_preflight, run_experiment, start_run, advance_run, poll_run, analyze_run, plan_next_experiment, pause_run, abort_run, request_operator.",
				],
				{ toolName },
				false,
			);
	}
}
