import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCapabilities } from "./capabilities.ts";
import { analyzeRecordedRun, type RunAnalysis } from "./analysis.ts";
import { getLabState } from "./lab-state.ts";
import { validateHardwareCoordinateAuditReadiness } from "./kernel/hw/coord-audit.ts";
import { runHardwarePilotKernel } from "./kernel/hw/pilot.ts";
import { advanceRun, pollRun, startRun, type RunState } from "./kernel/run.ts";
import { runLabAgentKernel } from "./kernel/sim.ts";
import { requestRamanHardwareStop, startRamanHardwareRun } from "./kernel/raman/run.ts";
import { validateRamanHardwareValidationReadiness } from "./kernel/raman/validation.ts";
import { createStageAdapter } from "./kernel/hw/stage.ts";
import { planNextExperiment } from "./planning.ts";
import { validatePolicy } from "./policy.ts";
import { preflight } from "./preflight.ts";
import {
	appendHardwareRunRecords,
	appendOperatorIntent,
	appendPreflightReport,
	appendRunRecords,
	hashExperimentSpec,
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
	type HardwareExecutionParams,
	type OperatorIntentParams,
	type PlanNextExperimentParams,
	type PollRunParams,
	type PreflightHardwareExecutionParams,
	type RunExperimentParams,
	type RunPreflightParams,
	type StartRunParams,
	type ToolResult,
	validateExperimentSpec,
	validateSchema,
} from "./schemas.ts";
import { getUnitCount } from "./spec-utils.ts";

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
		["Change the ExperimentSpec to a supported mode and keep it within the active hardware gates."],
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
	const result = preflight(specOrResult, capabilities, getLabState(getCwd(ctx)), getCwd(ctx));
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
	const launchReadiness = assessLaunchReadinessPreview(specOrResult, params.hardwareExecution, getCwd(ctx));
	const stateAfter = records ? { ...result, specHash: records.specHash, capabilitySnapshotId: records.capabilitySnapshotId, records } : result;
	const stateWithLaunchReadiness =
		launchReadiness.required
			? {
					...stateAfter,
					launchReadiness,
				}
			: stateAfter;

	if (launchReadiness.required && !launchReadiness.evaluated) {
		return {
			...createSuccessResult(
				commandId,
				`Preflight passed for ${result.unitCount} ${result.mode} unit(s), but real hardware launch readiness was not evaluated.`,
				stateWithLaunchReadiness,
				["Provide hardwareExecution preview in run_preflight before scheduling supervised real hardware execution."],
				records?.artifacts,
				undefined,
				specOrResult.experimentId,
			),
			status: "warning",
		};
	}

	if (launchReadiness.required && !launchReadiness.ready) {
		return {
			...createSuccessResult(
				commandId,
				`Preflight passed for ${result.unitCount} ${result.mode} unit(s), but the planned real hardware launch is not ready.`,
				stateWithLaunchReadiness,
				["Resolve the reported real hardware launch readiness issues before run_experiment."],
				records?.artifacts,
				undefined,
				specOrResult.experimentId,
			),
			status: "warning",
		};
	}

	return createSuccessResult(
		commandId,
		launchReadiness.required && launchReadiness.evaluated
			? `Preflight passed for ${result.unitCount} ${result.mode} unit(s), and the planned real hardware launch preview is ready.`
			: `Preflight passed for ${result.unitCount} ${result.mode} unit(s).`,
		stateWithLaunchReadiness,
		result.mode === "simulation"
			? ["Call run_experiment with the same ExperimentSpec."]
			: ["Review the readiness report, then call run_experiment when the bounded spec is ready."],
		records?.artifacts,
		undefined,
		specOrResult.experimentId,
	);
}

function resolveHardwareExecutionParams(commandId: string, params: RunExperimentParams): HardwareExecutionParams | ToolResult {
	const hardwareExecution = params.hardwareExecution;
	const legacyHardwarePilot = params.hardwarePilot;

	if (hardwareExecution && legacyHardwarePilot) {
		return createErrorResult(
			commandId,
			"Provide either hardwareExecution or legacy hardwarePilot parameters, not both.",
			"invalid_tool_params",
			["Use hardwareExecution for new calls.", "Remove hardwarePilot once the caller has migrated."],
			{ hasHardwareExecution: true, hasHardwarePilot: true },
			true,
		);
	}

	if (hardwareExecution) return hardwareExecution;
	if (legacyHardwarePilot) return legacyHardwarePilot;

	return createErrorResult(
		commandId,
		"hardware mode requires hardwareExecution parameters.",
		"hardware_pilot_params_required",
		["Provide hardwareExecution approval, watchdog, and stage adapter parameters.", "Legacy hardwarePilot is still accepted during migration."],
		{ mode: "hardware", acceptedFields: ["hardwareExecution", "hardwarePilot"] },
		true,
	);
}

function simulatedHardwareAllowed(): boolean {
	return process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinRange(value: number, min: number, max: number): boolean {
	return value >= min && value <= max;
}

function isRealHardwareExecution(stageAdapter: HardwareExecutionParams["stageAdapter"] | PreflightHardwareExecutionParams["stageAdapter"]): boolean {
	return stageAdapter === "mc_newton_xyz" && !simulatedHardwareAllowed();
}

function requiresRealRamanLaunchReadiness(spec: ExperimentSpec): boolean {
	return spec.domain?.raman !== undefined && !simulatedHardwareAllowed();
}

function requiresRealHardwareLaunchReadiness(spec: ExperimentSpec): boolean {
	return spec.mode === "hardware" && !simulatedHardwareAllowed();
}

function invalidResumeFromResult(commandId: string, spec: ExperimentSpec, resumeFrom: number): ToolResult | undefined {
	const unitCount = getUnitCount(spec);
	if (resumeFrom <= unitCount) return undefined;
	return createErrorResult(
		commandId,
		`resumeFrom must be between 0 and ${unitCount} for this hardware spec.`,
		"invalid_resume_from",
		["Use the nextUnitIndex from a paused resume.snapshot.json, or omit resumeFrom."],
		{ resumeFrom, unitCount },
		true,
		spec.experimentId,
	);
}

type RamanLaunchExecutionPreview = HardwareExecutionParams | PreflightHardwareExecutionParams;

interface LaunchReadinessAssessment {
	required: boolean;
	evaluated: boolean;
	ready: boolean;
	issues: string[];
}

function preflightReportPath(cwd: string, reportId: string): string {
	return join(cwd, ".pi", "experiment-runs", "preflights", reportId, "preflight.json");
}

function validateBoundedZCoordinateAuditExemption(spec: ExperimentSpec): string[] {
	if (spec.domain?.raman) {
		return ["hardwareExecution.coordinateAuditExemption='bounded_z_adjustment' is not allowed for Raman hardware runs."];
	}
	if (spec.plan.kind !== "points" || spec.plan.points.length !== 1) {
		return ["hardwareExecution.coordinateAuditExemption='bounded_z_adjustment' requires a single-point plan."];
	}
	const [point] = spec.plan.points;
	const zLimits = spec.limits.motion.zUm;
	if (!zLimits || point.zUm === undefined) {
		return ["hardwareExecution.coordinateAuditExemption='bounded_z_adjustment' requires an explicit absolute zUm target inside limits.motion.zUm."];
	}
	if (!withinRange(point.zUm, zLimits.minUm, zLimits.maxUm)) {
		return ["hardwareExecution.coordinateAuditExemption='bounded_z_adjustment' requires the target absolute zUm to stay inside explicit zUm motion limits."];
	}
	return [];
}

function coordinateAuditIssues(
	spec: ExperimentSpec,
	hardwareExecution: RamanLaunchExecutionPreview,
	cwd: string,
): string[] {
	if (!requiresRealHardwareLaunchReadiness(spec)) return [];
	if (hardwareExecution.stageAdapter !== "mc_newton_xyz") {
		return ["Real hardware launch requires stageAdapter mc_newton_xyz."];
	}
	if (hardwareExecution.coordinateAuditExemption === "bounded_z_adjustment") {
		return validateBoundedZCoordinateAuditExemption(spec);
	}
	if (!hardwareExecution.coordinateAuditId) {
		return ["Supervised real hardware execution requires hardwareExecution.coordinateAuditId referencing an operator-reviewed coordinate audit for the current subject and spatial plan."];
	}
	const readiness = validateHardwareCoordinateAuditReadiness(cwd, hardwareExecution.coordinateAuditId, spec);
	return readiness.ok ? [] : readiness.issues.map((issue) => issue.message);
}

function readDryRunReportSpecHash(cwd: string, reportId: string): { ok: true; specHash: string } | { ok: false; issues: string[] } {
	const path = preflightReportPath(cwd, reportId);
	if (!existsSync(path)) {
		return { ok: false, issues: [`Real hardware execution requires approval.dryRunReportId to reference a matching dry-run preflight report. Missing report: ${reportId}.`] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return { ok: false, issues: [`Real hardware execution requires a valid dry-run preflight report. Report ${reportId} is not valid JSON.`] };
	}
	if (!isRecord(parsed)) {
		return { ok: false, issues: [`Real hardware execution requires a valid dry-run preflight report. Report ${reportId} is malformed.`] };
	}
	const spec = parsed.spec;
	const result = parsed.result;
	if (!isRecord(spec) || spec.mode !== "dry_run") {
		return { ok: false, issues: ["Real hardware execution requires approval.dryRunReportId to reference a dry-run preflight report."] };
	}
	if (!isRecord(result) || result.valid !== true) {
		return { ok: false, issues: ["Real hardware execution requires approval.dryRunReportId to reference a successful dry-run preflight report."] };
	}
	const specHash =
		typeof parsed.specHash === "string"
			? parsed.specHash
			: typeof result.specHash === "string"
				? result.specHash
				: undefined;
	if (!specHash) {
		return { ok: false, issues: ["Real hardware execution requires a dry-run preflight report with a recorded specHash."] };
	}
	return { ok: true, specHash };
}

function realHardwareApprovalIssues(spec: ExperimentSpec, hardwareExecution: HardwareExecutionParams, cwd: string): string[] {
	if (!requiresRealHardwareLaunchReadiness(spec)) return [];
	if (!hardwareExecution.approval || hardwareExecution.approval.approved !== true) {
		return ["Real hardware execution requires explicit operator approval in hardwareExecution.approval."];
	}
	const report = readDryRunReportSpecHash(cwd, hardwareExecution.approval.dryRunReportId);
	if (!report.ok) return report.issues;
	if (report.specHash !== hashExperimentSpec(spec)) {
		return ["Real hardware execution requires approval.dryRunReportId to reference a matching dry-run preflight report for the same ExperimentSpec."];
	}
	return [];
}

function realRamanBackendIssues(spec: ExperimentSpec, hardwareExecution: RamanLaunchExecutionPreview): string[] {
	const ramanSpec = spec.domain?.raman;
	if (!ramanSpec) return [];
	const ramanExecution = hardwareExecution.raman;
	const issues: string[] = [];
	if (hardwareExecution.stageAdapter !== "mc_newton_xyz") {
		issues.push("Real Raman hardware execution requires stageAdapter mc_newton_xyz; memory is simulated only.");
		return issues;
	}
	if (ramanSpec.acquisition && ramanExecution?.acquisitionBackend !== "labspec_file_bridge") {
		issues.push("Real Raman acquisition requires raman.acquisitionBackend to be labspec_file_bridge.");
	}
	if (ramanSpec.autofocus?.enabled === true && ramanExecution?.autofocusBackend !== "labspec_file_bridge") {
		issues.push("Real Raman autofocus requires raman.autofocusBackend to be labspec_file_bridge.");
	}
	if (ramanSpec.xyCorrection?.enabled === true && ramanExecution?.xyCorrectionBackend !== "phase_correlation") {
		issues.push("Real Raman XY correction requires raman.xyCorrectionBackend to be phase_correlation.");
	}
	if (spec.domain?.thermal?.enabled === true && spec.domain.thermal.waitBeforeAcquisition !== false) {
		issues.push("Real Raman thermal waiting is not yet supported because the thermal backend is currently fake-only.");
	}
	return issues;
}

function realRamanV2ValidationIssues(
	spec: ExperimentSpec,
	hardwareExecution: RamanLaunchExecutionPreview,
	cwd: string,
): string[] {
	if (!requiresRealRamanLaunchReadiness(spec)) return [];
	if (hardwareExecution.raman?.workflowBackend !== "v2_bridge") return [];
	if (hardwareExecution.approval?.bootstrapV2ValidationRun === true && !hardwareExecution.raman?.v2ValidationId) {
		return [];
	}
	const validationId = hardwareExecution.raman?.v2ValidationId;
	if (!validationId) {
		return [
			"Real Raman V2 launch requires hardwareExecution.raman.v2ValidationId unless hardwareExecution.approval.bootstrapV2ValidationRun is true for the first supervised minimum run.",
		];
	}
	const readiness = validateRamanHardwareValidationReadiness(cwd, validationId, "v2_bridge", spec);
	return readiness.valid ? [] : readiness.issues.map((issue) => issue.message);
}

function assessLaunchReadinessPreview(
	spec: ExperimentSpec,
	hardwareExecution: PreflightHardwareExecutionParams | undefined,
	cwd: string,
): LaunchReadinessAssessment {
	if (!requiresRealHardwareLaunchReadiness(spec)) {
		return { required: false, evaluated: false, ready: true, issues: [] };
	}
	if (!hardwareExecution) {
		return {
			required: true,
			evaluated: false,
			ready: false,
			issues: ["Provide hardwareExecution preview in run_preflight to evaluate real hardware launch readiness."],
		};
	}
	const issues = [
		...coordinateAuditIssues(spec, hardwareExecution, cwd),
		...realRamanBackendIssues(spec, hardwareExecution),
		...realRamanV2ValidationIssues(spec, hardwareExecution, cwd),
	];
	return {
		required: true,
		evaluated: true,
		ready: issues.length === 0,
		issues,
	};
}

function coordinateAuditGateResult(commandId: string, spec: ExperimentSpec, issues: string[]): ToolResult {
	return createErrorResult(
		commandId,
		`Hardware coordinate audit gate failed with ${issues.length} issue(s).`,
		"hardware_gate_failed",
		[
			"Record a matching hardware coordinate audit before supervised real hardware motion or acquisition.",
			"Use hardwareExecution.coordinateAuditExemption='bounded_z_adjustment' only for a non-Raman single-point bounded Z-only adjustment.",
		],
		{ valid: false, issues },
		true,
		spec.experimentId,
	);
}

function hardwareLaunchGateResult(commandId: string, spec: ExperimentSpec, issues: string[]): ToolResult {
	return createErrorResult(
		commandId,
		`Hardware gate failed with ${issues.length} issue(s).`,
		"hardware_gate_failed",
		[
			"Provide explicit operator approval and a matching dry-run preflight report before supervised real hardware execution.",
			"Resolve the reported hardware launch authorization issues before retrying run_experiment.",
		],
		{ valid: false, issues },
		true,
		spec.experimentId,
	);
}

function ramanLaunchGateResult(commandId: string, spec: ExperimentSpec, issues: string[]): ToolResult {
	return createErrorResult(
		commandId,
		`Real Raman V2 parity evidence gate failed with ${issues.length} issue(s).`,
		"raman_launch_gate_failed",
		[
			"Provide real-capable Raman backend settings and the required V2 validation evidence before supervised real hardware execution.",
			"Use approval.bootstrapV2ValidationRun only for the first supervised real V2 minimum run.",
		],
		{ valid: false, issues },
		true,
		spec.experimentId,
	);
}

function enforceLaunchGate(
	commandId: string,
	spec: ExperimentSpec,
	hardwareExecution: HardwareExecutionParams,
	cwd: string,
): ToolResult | undefined {
	if (!requiresRealHardwareLaunchReadiness(spec)) return undefined;
	const ramanBackendIssues = realRamanBackendIssues(spec, hardwareExecution);
	if (ramanBackendIssues.length > 0) {
		return ramanLaunchGateResult(commandId, spec, ramanBackendIssues);
	}
	const ramanV2Issues = realRamanV2ValidationIssues(spec, hardwareExecution, cwd);
	if (ramanV2Issues.length > 0) {
		return ramanLaunchGateResult(commandId, spec, ramanV2Issues);
	}
	const coordinateIssues = coordinateAuditIssues(spec, hardwareExecution, cwd);
	if (coordinateIssues.length > 0) {
		return coordinateAuditGateResult(commandId, spec, coordinateIssues);
	}
	const approvalIssues = realHardwareApprovalIssues(spec, hardwareExecution, cwd);
	if (approvalIssues.length > 0) {
		return hardwareLaunchGateResult(commandId, spec, approvalIssues);
	}
	return undefined;
}

function runHardwareExperiment(commandId: string, spec: ExperimentSpec, params: RunExperimentParams, ctx?: DispatchContext): ToolResult {
	const hardwareExecutionOrResult = resolveHardwareExecutionParams(commandId, params);
	if ("status" in hardwareExecutionOrResult) return hardwareExecutionOrResult;
	const hardwareExecution = hardwareExecutionOrResult;
	const cwd = getCwd(ctx);

	if (params.resumeFrom !== undefined) {
		const invalidResumeFrom = invalidResumeFromResult(commandId, spec, params.resumeFrom);
		if (invalidResumeFrom) return invalidResumeFrom;
	}

	if (hardwareExecution.stageAdapter === "memory" && !simulatedHardwareAllowed()) {
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

	const launchGateResult = enforceLaunchGate(commandId, spec, hardwareExecution, cwd);
	if (launchGateResult) return launchGateResult;

	const gate = validateHardwareGate(spec, hardwareExecution, cwd);
	if (!gate.valid) {
		return createErrorResult(
			commandId,
			`Minimal Raman safety gate failed with ${gate.issues.length} issue(s).`,
			"hardware_gate_failed",
			[
				"Keep all planned motion below limits.motion.zUm.maxUm, the Raman objective collision ceiling.",
				"Keep requested laser power at or below limits.powerEnergy.maxLaserPowerMw.",
			],
			{ valid: false, issues: gate.issues, collisionCeilingUm: gate.collisionCeilingUm, maxPlannedZUm: gate.maxPlannedZUm, laserCeilingMw: gate.laserCeilingMw, requestedLaserPowerMw: gate.requestedLaserPowerMw },
			true,
		);
	}

	const capabilities = loadCapabilities("hardware");
	const preflightResult = preflight(spec, capabilities, getLabState(cwd), cwd);
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
	const pilot = {
		...hardwareExecution,
		intentsPath: hardwareExecution.intentsPath ?? reserved.intentsPath,
	};
	if (spec.domain?.raman) {
		const start = startRamanHardwareRun(
			cwd,
			spec,
			pilot,
			reserved,
			commandId,
			params.resumeFrom ?? 0,
		);
		return createSuccessResult(
			commandId,
			`Raman hardware run ${reserved.record.runId} started with ${start.runState.progress.totalUnits} queued unit(s).`,
			{ runState: start.runState, records: { runDir: reserved.runDir, eventsPath: reserved.eventsPath, intentsPath: reserved.intentsPath } },
			["Call poll_run with the returned runId to observe progress.", "Use pause_run or abort_run to intervene during the hardware run."],
			start.artifacts,
			reserved.record.runId,
			spec.experimentId,
		);
	}

	markRunRunning(cwd, reserved.record.runId);
	const stage = createStageAdapter(pilot, cwd);
	const run = runHardwarePilotKernel(spec, {
		runId: reserved.record.runId,
		stage,
		pilot,
		eventsPath: reserved.eventsPath,
		startPointIndex: params.resumeFrom,
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
	const preflightResult = preflight(specOrResult, capabilities, getLabState(getCwd(ctx)), getCwd(ctx));
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
			["Use run_experiment for approved hardware execution.", "Set spec.mode to simulation to use start_run/advance_run/poll_run."],
			{ mode: spec.mode },
			true,
			spec.experimentId,
		);
	}

	const policy = policyResult(commandId, spec, "run_experiment", ctx);
	if (policy) return policy;

	const cwd = getCwd(ctx);
	const capabilities = loadCapabilities("simulation");
	const preflightResult = preflight(spec, capabilities, getLabState(cwd), cwd);
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
		requestRamanHardwareStop(params.runId);
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
