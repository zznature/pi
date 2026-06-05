import { loadCapabilities } from "./capabilities.ts";
import { getLabState } from "./lab-state.ts";
import { runLabAgentKernel } from "./kernel/lab-agent-kernel.ts";
import { planNextExperiment } from "./planning.ts";
import { validatePolicy } from "./policy.ts";
import { preflight } from "./preflight.ts";
import { appendPreflightReport, appendRunRecords, readRecordedSummary } from "./records.ts";
import { createErrorResult, createSuccessResult, issuesState } from "./results.ts";
import { getRun, saveRun } from "./runs.ts";
import {
	AnalyzeRunParamsSchema,
	PlanNextExperimentParamsSchema,
	RunExperimentParamsSchema,
	RunPreflightParamsSchema,
	type ExperimentSpec,
	type PlanNextExperimentParams,
	type RunExperimentParams,
	type RunPreflightParams,
	type ToolResult,
	validateExperimentSpec,
	validateSchema,
} from "./schemas.ts";

export type DispatchToolName = "run_preflight" | "run_experiment" | "analyze_run" | "plan_next_experiment";

export interface DispatchContext {
	cwd?: string;
}

function getCwd(ctx: DispatchContext | undefined): string {
	return ctx?.cwd ?? ".";
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

function policyResult(
	commandId: string,
	spec: ExperimentSpec,
	toolName: "run_preflight" | "run_experiment" | "analyze_run",
): ToolResult | undefined {
	const validation = validatePolicy(spec, getLabState(), { toolName });
	if (validation.valid) return undefined;
	return createErrorResult(
		commandId,
		`ExperimentSpec failed policy validation with ${validation.issues.length} issue(s).`,
		"policy_rejected",
		["Change the ExperimentSpec to simulation mode and keep it within Phase 1 limits."],
		issuesState(validation.issues),
		true,
	);
}

function runPreflight(commandId: string, params: RunPreflightParams, ctx?: DispatchContext): ToolResult {
	const specOrResult = validateSpecForTool(commandId, params.spec);
	if ("status" in specOrResult) return specOrResult;

	const policy = policyResult(commandId, specOrResult, "run_preflight");
	if (policy) return policy;

	const capabilityMode = specOrResult.mode === "dry_run" ? "dry_run" : "simulation";
	const result = preflight(specOrResult, loadCapabilities(capabilityMode), getLabState());
	if (!result.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${result.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues and call run_preflight again."],
			{ ...issuesState(result.issues), pointCount: result.pointCount },
			true,
		);
	}

	const records = result.mode === "dry_run" ? appendPreflightReport(specOrResult, result, getCwd(ctx)) : undefined;

	return createSuccessResult(
		commandId,
		`Preflight passed for ${result.pointCount} ${result.mode} point(s).`,
		records ? { ...result, records } : result,
		result.mode === "simulation"
			? ["Call run_experiment with the same ExperimentSpec."]
			: ["Review the dry-run readiness report before considering hardware pilot approval."],
		records?.artifacts,
	);
}

function runExperiment(commandId: string, params: RunExperimentParams, ctx?: DispatchContext): ToolResult {
	if (params.resumeFrom !== undefined) {
		return createErrorResult(
			commandId,
			"Phase 1 does not support run resume.",
			"resume_not_supported",
			["Remove resumeFrom and start a new simulation run."],
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

	const policy = policyResult(commandId, specOrResult, "run_experiment");
	if (policy) return policy;

	const preflightResult = preflight(specOrResult, loadCapabilities("simulation"), getLabState());
	if (!preflightResult.valid) {
		return createErrorResult(
			commandId,
			`Preflight failed with ${preflightResult.issues.length} issue(s).`,
			"preflight_failed",
			["Fix the preflight issues and call run_preflight before retrying run_experiment."],
			{ ...issuesState(preflightResult.issues), pointCount: preflightResult.pointCount },
			true,
		);
	}

	const run = runLabAgentKernel(specOrResult);
	saveRun(run);
	const records = appendRunRecords(run, getCwd(ctx));

	return createSuccessResult(
		commandId,
		`Simulation run ${run.runId} completed with ${run.summary.pointCount} point(s).`,
		{ summary: run.summary, pointRecords: run.points, records },
		["Call analyze_run with the returned runId."],
		records.artifacts,
		run.runId,
	);
}

function analyzeRun(commandId: string, runId: string, ctx?: DispatchContext): ToolResult {
	const run = getRun(runId);
	const summary = run?.summary ?? readRecordedSummary(runId, getCwd(ctx));
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

	return createSuccessResult(
		commandId,
		`Run ${runId} summary: mean signal ${summary.meanSignal}, ${summary.pointCount} point(s).`,
		{ summary },
		["Use plan_next_experiment to choose a bounded next-step strategy."],
		[{ uri: `.pi/experiment-runs/runs/${runId}/summary.json`, label: "Simulation summary", kind: "summary" }],
		runId,
	);
}

function planNext(commandId: string, params: PlanNextExperimentParams, ctx?: DispatchContext): ToolResult {
	const run = getRun(params.runId);
	const summary = run?.summary ?? readRecordedSummary(params.runId, getCwd(ctx));
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

	const plan = planNextExperiment(summary, params.objective);
	return createSuccessResult(
		commandId,
		`Next strategy for ${params.runId}: ${plan.strategy}.`,
		plan,
		["Compile this strategy into a new bounded ExperimentSpec before any run."],
		[{ uri: `.pi/experiment-runs/runs/${params.runId}/summary.json`, label: "Source run summary", kind: "summary" }],
		params.runId,
	);
}

export function dispatch(toolName: string, params: unknown, ctx?: DispatchContext): ToolResult {
	switch (toolName) {
		case "run_preflight": {
			const validation = validateSchema(RunPreflightParamsSchema, params);
			if (!validation.valid) return invalidParamsResult("phase1-run-preflight", issuesState(validation.issues));
			return runPreflight("phase1-run-preflight", validation.value, ctx);
		}
		case "run_experiment": {
			const validation = validateSchema(RunExperimentParamsSchema, params);
			if (!validation.valid) return invalidParamsResult("phase1-run-experiment", issuesState(validation.issues));
			return runExperiment("phase1-run-experiment", validation.value, ctx);
		}
		case "analyze_run": {
			const validation = validateSchema(AnalyzeRunParamsSchema, params);
			if (!validation.valid) return invalidParamsResult("phase1-analyze-run", issuesState(validation.issues));
			return analyzeRun("phase1-analyze-run", validation.value.runId, ctx);
		}
		case "plan_next_experiment": {
			const validation = validateSchema(PlanNextExperimentParamsSchema, params);
			if (!validation.valid) return invalidParamsResult("phase2-plan-next-experiment", issuesState(validation.issues));
			return planNext("phase2-plan-next-experiment", validation.value, ctx);
		}
		default:
			return createErrorResult(
				"phase1-dispatch",
				`Unknown experiment tool: ${toolName}`,
				"tool_not_found",
				["Call one of: run_preflight, run_experiment, analyze_run, plan_next_experiment."],
				{ toolName },
				false,
			);
	}
}
