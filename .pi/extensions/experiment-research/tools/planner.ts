import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import {
	getLabActivityState,
	getLabCapabilities,
	type LabActivityState,
	type LabCapabilitiesState,
} from "../lab-state.ts";
import { getExperimentState } from "../run-store.ts";
import {
	AdvanceRunParamsSchema,
	AnalyzeRunParamsSchema,
	EmptyParamsSchema,
	GetExperimentStateParamsSchema,
	PlanNextExperimentParamsSchema,
	PollRunParamsSchema,
	RunExperimentParamsSchema,
	RunPreflightParamsSchema,
	StartRunParamsSchema,
	type ToolResult,
	ValidateExperimentSpecParamsSchema,
	type ValidateExperimentSpecParams,
	validateExperimentSpec,
} from "../schemas.ts";

function dispatchToolResult(
	toolCallId: string,
	toolName: Parameters<typeof dispatch>[0],
	params: Parameters<typeof dispatch>[1],
	cwd: string,
): { content: [{ type: "text"; text: string }]; details: ToolResult } {
	const result = dispatch(toolName, params, { cwd, commandId: toolCallId });
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: result,
	};
}

function createValidateSuccessResult(): ToolResult {
	return {
		status: "success",
		summary: "ExperimentSpec is valid for schema checks.",
		nextActions: ["Call run_preflight with the same ExperimentSpec."],
		artifacts: [],
		commandId: "validate-experiment-spec",
		correlationId: "validate-experiment-spec",
		stateAfter: { valid: true },
		stopConditionMet: false,
	};
}

function createValidateErrorResult(params: ValidateExperimentSpecParams): ToolResult {
	const validation = validateExperimentSpec(params.spec);
	const issues = validation.valid ? [] : validation.issues;
	return {
		status: "error",
		summary: `ExperimentSpec failed validation with ${issues.length} issue(s).`,
		nextActions: [
			"Fix the reported schema issues.",
			"Provide a valid plan payload matching plan.kind.",
			"Call validate_experiment_spec again before any run.",
		],
		artifacts: [],
		commandId: "validate-experiment-spec",
		correlationId: "validate-experiment-spec",
		stateAfter: { valid: false, issues },
		errorCode: "invalid_experiment_spec",
		retrySafe: true,
		stopConditionMet: false,
	};
}

function createLabCapabilitiesResult(state: LabCapabilitiesState): ToolResult {
	return {
		status: "success",
		summary:
			"Static lab capabilities loaded. Reuse this result until the capability picture changes.",
		nextActions: [
			"Draft an ExperimentSpec in simulation or dry_run mode within these capabilities.",
			"Collect operator-audited absolute coordinates before compiling a real hardware ExperimentSpec.",
			"Record the reviewed coordinates as a hardware coordinate audit before supervised real hardware execution.",
			"Call validate_experiment_spec before any preflight or run.",
		],
		artifacts: [],
		commandId: "get-lab-capabilities",
		correlationId: "get-lab-capabilities",
		stateAfter: state,
		stopConditionMet: false,
	};
}

function createLabStateResult(state: LabActivityState): ToolResult {
	return {
		status: "success",
		summary:
			state.activeRunId === null
				? "Dynamic lab activity loaded. No run is currently active."
				: `Dynamic lab activity loaded. Run ${state.activeRunId} is currently ${state.mode}.`,
		nextActions:
			state.activeRunId === null
				? [
						"Reuse get_lab_capabilities for static capability planning.",
						"Call get_lab_state again only if active-run or pause/recovery state may have changed.",
					]
				: [
						"Inspect the active run before planning or launching more work.",
						"Call get_lab_state again only if active-run or pause/recovery state may have changed.",
					],
		artifacts: [],
		commandId: "get-lab-state",
		correlationId: "get-lab-state",
		stateAfter: state,
		stopConditionMet: false,
	};
}

export const validateExperimentSpecTool = {
	name: "validate_experiment_spec",
	label: "Validate Experiment Spec",
	description: "Validate an ExperimentSpec candidate against the schema and semantic rules.",
	promptSnippet: "Validate a candidate ExperimentSpec without touching hardware",
	promptGuidelines: [
		"Use validate_experiment_spec before proposing any experiment run.",
		"For real hardware planning, collect operator-audited absolute coordinates before compiling a hardware ExperimentSpec.",
		"For supervised real hardware runs, plan to reference an operator-reviewed coordinateAuditId from hardwareExecution.coordinateAuditId.",
		"Do not call hardware or execution tools when validate_experiment_spec returns an error.",
	],
	parameters: ValidateExperimentSpecParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params) {
		const validation = validateExperimentSpec(params.spec);
		const result = validation.valid ? createValidateSuccessResult() : createValidateErrorResult(params);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof ValidateExperimentSpecParamsSchema, ToolResult>;

export const getLabCapabilitiesTool = {
	name: "get_lab_capabilities",
	label: "Get Lab Capabilities",
	description: "Return static lab capabilities, coordinate conventions, and gated hardware planning constraints.",
	promptSnippet: "Inspect static lab capabilities and real hardware planning constraints",
	promptGuidelines: [
		"Use get_lab_capabilities once per planning context when static capabilities, coordinate conventions, or hardware surfaces matter.",
		"Do not re-call get_lab_capabilities in the same context unless the operator reports a lab capability change.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
		const result = createLabCapabilitiesResult(getLabCapabilities());
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, ToolResult>;

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return dynamic lab activity such as active-run, paused, or recovering state.",
	promptSnippet: "Inspect dynamic run activity before acting on a live or recently active experiment",
	promptGuidelines: [
		"Use get_lab_state only when current active-run or pause/recovery state may affect the next action.",
		"Do not use get_lab_state as the default static capability lookup; use get_lab_capabilities for that.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const result = createLabStateResult(getLabActivityState(ctx.cwd));
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, ToolResult>;

export const getExperimentStateTool = {
	name: "get_experiment_state",
	label: "Get Experiment State",
	description: "Return an experiment/campaign record and its run history by experimentId.",
	promptSnippet: "Inspect experiment run history and lineage before planning the next bounded run",
	promptGuidelines: [
		"Use get_experiment_state before multi-run planning.",
		"Keep the same experimentId when compiling a follow-up ExperimentSpec.",
	],
	parameters: GetExperimentStateParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const state = getExperimentState(ctx.cwd, params.experimentId);
		const result: ToolResult = {
			status: "success",
			summary: `Experiment ${params.experimentId} has ${state.runs.length} recorded run(s).`,
			nextActions: ["Use analyze_run and plan_next_experiment before compiling the next bounded ExperimentSpec."],
			artifacts: [],
			experimentId: params.experimentId,
			commandId: toolCallId,
			correlationId: toolCallId,
			stateAfter: state,
			stopConditionMet: false,
		};
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof GetExperimentStateParamsSchema, ToolResult>;

export const runPreflightTool = {
	name: "run_preflight",
	label: "Run Preflight",
	description: "Run simulation, dry-run, or hardware readiness preflight checks for an ExperimentSpec.",
	promptSnippet: "Check whether a simulation, dry-run, or hardware ExperimentSpec is ready",
	promptGuidelines: [
		"Use run_preflight after validate_experiment_spec succeeds and before run_experiment.",
		"Do not use run_preflight to probe real hardware readiness with guessed coordinates or placeholder hardware specs.",
		"For supervised real hardware launch planning, include hardwareExecution.coordinateAuditId in the preview once the operator has recorded the coordinate audit.",
		"For real Raman launch planning, include the planned hardwareExecution preview so preflight can report launch readiness before the final launch call.",
	],
	parameters: RunPreflightParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "run_preflight", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof RunPreflightParamsSchema, ToolResult>;

export const runExperimentTool = {
	name: "run_experiment",
	label: "Run Experiment",
	description: "Execute a validated simulation ExperimentSpec or an operator-approved hardware ExperimentSpec.",
	promptSnippet: "Execute a simulation or approved hardware ExperimentSpec and return run records and summary",
	promptGuidelines: [
		"Use run_experiment for simulation specs that passed preflight.",
		"Use hardwareExecution for new hardware calls; legacy hardwarePilot is accepted only during migration.",
		"For hardware specs, require a matching dry-run preflight report, explicit operator approval, hardwareExecution.coordinateAuditId for supervised real hardware, and any Raman-specific safety gates.",
		"For Raman workflowBackend v2_bridge, branch before launch: use approval.bootstrapV2ValidationRun only for the first supervised real V2 minimum run; otherwise provide hardwareExecution.raman.v2ValidationId.",
	],
	parameters: RunExperimentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "run_experiment", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof RunExperimentParamsSchema, ToolResult>;

export const startRunTool = {
	name: "start_run",
	label: "Start Run",
	description: "Admit and start a validated simulation ExperimentSpec under the async run lifecycle, returning a runId without executing units.",
	promptSnippet: "Start a simulation run and return its runId without blocking on execution",
	promptGuidelines: [
		"Use start_run to begin a bounded simulation run that you will drive with advance_run.",
		"start_run only reserves and starts the run; call advance_run to execute units.",
	],
	parameters: StartRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "start_run", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof StartRunParamsSchema, ToolResult>;

export const advanceRunTool = {
	name: "advance_run",
	label: "Advance Run",
	description: "Execute up to maxUnits units of a running or paused run, stopping at the next safe unit boundary if an operator intent is present.",
	promptSnippet: "Advance a started run by a bounded number of units, honoring operator intents at unit boundaries",
	promptGuidelines: [
		"Use advance_run to execute a started run incrementally so pause_run/abort_run can intervene between batches.",
		"Set maxUnits to keep control returning to the planner; omit it to run to completion.",
	],
	parameters: AdvanceRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "advance_run", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof AdvanceRunParamsSchema, ToolResult>;

export const analyzeRunTool = {
	name: "analyze_run",
	label: "Analyze Run",
	description: "Return deterministic quality metrics, anomalies, artifacts, and stopping-rule status for a completed run.",
	promptSnippet: "Analyze a completed experiment run by runId",
	promptGuidelines: ["Use analyze_run after run_experiment returns a runId."],
	parameters: AnalyzeRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "analyze_run", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof AnalyzeRunParamsSchema, ToolResult>;

export const planNextExperimentTool = {
	name: "plan_next_experiment",
	label: "Plan Next Experiment",
	description: "Return a constrained next-step strategy and lineage entry for a completed run.",
	promptSnippet: "Choose repeat_same, refine_region, add_replicates, reduce_scope, or stop for the next bounded run",
	promptGuidelines: [
		"Use plan_next_experiment after analyze_run when the user asks what experiment should happen next.",
		"Do not treat plan_next_experiment output as a full ExperimentSpec; compile the strategy into a bounded spec first.",
	],
	parameters: PlanNextExperimentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "plan_next_experiment", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof PlanNextExperimentParamsSchema, ToolResult>;
