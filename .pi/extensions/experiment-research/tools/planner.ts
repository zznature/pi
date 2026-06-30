import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProcedureSpec } from "../schemas/index.ts";
import { ProcedureSpecValidator, formatValidationErrors } from "../schemas/index.ts";
import { summarizeProcedureProposal } from "../planner/procedure-spec-builder.ts";
import { compileProcedureSpec } from "../kernel/compile-units.ts";
import { getRamanLiveRuntime, getRamanPythonRuntimeConfigInfo } from "../runtime/raman/index.ts";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const ExecutionModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("live-supervised"),
]);

const ProcedureSpecInputSchema = Type.Object(
	{
		procedureSpecId: Type.String(),
		experimentId: Type.String(),
		intentId: Type.String(),
		procedureId: Type.Union([
			Type.Literal("raman_single_point_probe"),
			Type.Literal("raman_parameter_search"),
			Type.Literal("raman_grid_mapping"),
		]),
		procedureVersion: Type.String(),
		resources: Type.Array(
			Type.Object(
				{
					resourceId: Type.String(),
					role: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		limits: Type.Record(Type.String(), Type.Unknown()),
		plan: Type.Record(Type.String(), Type.Unknown()),
		stoppingRules: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		domain: Type.Record(Type.String(), Type.Unknown()),
	},
	{ additionalProperties: true },
);

const ProcedureSpecParamsSchema = Type.Object(
	{
		spec: ProcedureSpecInputSchema,
		executionMode: Type.Optional(ExecutionModeSchema),
	},
	{ additionalProperties: false },
);

interface PlannerToolDetails {
	status: "success" | "warning" | "error";
	summary: string;
	errorCode?: string;
	retrySafe?: boolean;
	stateAfter: Record<string, unknown>;
}

type ProcedureSpecParams = Static<typeof ProcedureSpecParamsSchema>;
type ExecutionMode = Static<typeof ExecutionModeSchema>;

function success(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "success",
			summary,
			stateAfter,
		},
	};
}

function warning(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "warning",
			summary,
			stateAfter,
		},
	};
}

function error(summary: string, errorCode: string, stateAfter: Record<string, unknown> = {}): { content: [{ type: "text"; text: string }]; details: PlannerToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "error",
			summary,
			errorCode,
			retrySafe: true,
			stateAfter,
		},
	};
}

function asProcedureSpec(params: ProcedureSpecParams): ProcedureSpec {
	return params.spec as ProcedureSpec;
}

function validateProcedureSpec(spec: ProcedureSpec): { valid: boolean; issues: string[] } {
	if (!ProcedureSpecValidator.Check(spec)) {
		return {
			valid: false,
			issues: formatValidationErrors(ProcedureSpecValidator, spec),
		};
	}
	return { valid: true, issues: [] };
}

function previewState(spec: ProcedureSpec): Record<string, unknown> {
	const units = compileProcedureSpec(spec);
	const preview = summarizeProcedureProposal(spec);
	return {
		valid: true,
		procedureId: spec.procedureId,
		procedureSpecId: spec.procedureSpecId,
		unitCount: units.length,
		estimatedRuntimeMs: preview.estimatedRuntimeMs,
		estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
		savePath: preview.savePath,
		requiresConfirmation: preview.requiresConfirmation,
		risks: preview.risks,
		limits: preview.limits,
	};
}

function hasRequiredRamanRoles(spec: ProcedureSpec): boolean {
	const roles = new Set(spec.resources.map((resource) => resource.role));
	return roles.has("stage") && roles.has("frame_provider") && roles.has("spectrometer");
}

function resolveExecutionMode(params: ProcedureSpecParams): ExecutionMode {
	return params.executionMode ?? "simulation";
}

async function buildPreflightState(
	spec: ProcedureSpec,
	cwd: string,
	executionMode: ExecutionMode,
): Promise<Record<string, unknown>> {
	const preview = summarizeProcedureProposal(spec);
	const forbiddenRisks = preview.risks.filter((risk) => risk.level === "forbidden");
	const requiredRolesPresent = hasRequiredRamanRoles(spec);
	const requestedModeSupported = executionMode === "simulation" || requiredRolesPresent;

	if (executionMode === "simulation") {
		return {
			mode: executionMode,
			procedureSpecId: spec.procedureSpecId,
			procedureId: spec.procedureId,
			unitCount: preview.unitCount,
			estimatedRuntimeMs: preview.estimatedRuntimeMs,
			estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
			readyForApproval: forbiddenRisks.length === 0 && requiredRolesPresent,
			preflightReady: true,
			controlAvailable: true,
			requiresConfirmation: preview.requiresConfirmation,
			risks: preview.risks,
			limits: preview.limits,
			savePath: preview.savePath,
			requiredRolesPresent,
			requestedModeSupported,
			canProposeRun: true,
		};
	}

	const runtime = getRamanLiveRuntime(cwd);
	if (!runtime) {
		return {
			mode: executionMode,
			procedureSpecId: spec.procedureSpecId,
			procedureId: spec.procedureId,
			unitCount: preview.unitCount,
			estimatedRuntimeMs: preview.estimatedRuntimeMs,
			estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
			readyForApproval: false,
			preflightReady: false,
			controlAvailable: false,
			requiresConfirmation: preview.requiresConfirmation,
			risks: preview.risks,
			limits: preview.limits,
			savePath: preview.savePath,
			requiredRolesPresent,
			requestedModeSupported,
			realRuntimeRegistered: false,
			canProposeRun: true,
		};
	}

	const livePreflight = await runtime.preflight();
	return {
		mode: executionMode,
		procedureSpecId: spec.procedureSpecId,
		procedureId: spec.procedureId,
		unitCount: preview.unitCount,
		estimatedRuntimeMs: preview.estimatedRuntimeMs,
		estimatedRuntimeMinutes: Number((preview.estimatedRuntimeMs / 60_000).toFixed(2)),
		readyForApproval:
			forbiddenRisks.length === 0 &&
			requiredRolesPresent &&
			requestedModeSupported &&
			livePreflight.preflightReady &&
			livePreflight.controlAvailable,
		preflightReady: livePreflight.preflightReady,
		controlAvailable: livePreflight.controlAvailable,
		requiresConfirmation: preview.requiresConfirmation,
		risks: preview.risks,
		limits: preview.limits,
		savePath: preview.savePath,
		requiredRolesPresent,
		requestedModeSupported,
		realRuntimeRegistered: true,
		livePreflightDetails: livePreflight.details ?? {},
		canProposeRun: true,
	};
}

export const getLabCapabilitiesTool = {
	name: "get_lab_capabilities",
	label: "Get Lab Capabilities",
	description: "Return the currently scaffolded LabAgents MVP rebuild capability surface.",
	promptSnippet: "Inspect the currently available high-level lab capability surface",
	promptGuidelines: [
		"Use this before planning or validating a bounded run when you need to know which capability classes are already wired in the rebuild.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute() {
		return success("LabAgents MVP rebuild planner capabilities loaded.", {
			source: "experiment-research",
			stage: "phase10-bounded-search-and-mapping",
			supportedProcedures: [
				"raman_single_point_probe",
				"raman_parameter_search",
				"raman_grid_mapping",
			],
			liveSupportedProceduresWhenRuntimeRegistered: [
				"raman_single_point_probe",
				"raman_parameter_search",
				"raman_grid_mapping",
			],
			plannerTools: [
				"get_lab_capabilities",
				"get_lab_state",
				"validate_procedure_spec",
				"run_preflight",
				"propose_run",
				"approve_and_start_run",
			],
			evaluation: {
				ruleBasedGoodEnoughDecisions: true,
				decisionKinds: [
					"acceptable",
					"continue_search_within_envelope",
					"stop_and_request_user_decision",
				],
			},
			runtimeContract: {
				ramanResourcesDefined: true,
				ramanActionsDefined: true,
				actionResultContractDefined: true,
				liveRuntimeRequiresRegistration: true,
				liveSinglePointExecutionRequiresRegisteredRuntime: true,
				liveParameterSearchExecutionRequiresRegisteredRuntime: true,
				liveGridMappingExecutionRequiresRegisteredRuntime: true,
			},
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, PlannerToolDetails>;

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return the current MVP rebuild extension state and planning mode.",
	promptSnippet: "Inspect the current rebuild-mode lab state before planning the next step",
	promptGuidelines: [
		"Use this before validating or proposing a bounded run so the user can see the current planning and execution boundary.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtimeConfig = getRamanPythonRuntimeConfigInfo(ctx.cwd);
		const liveRuntimeRegistered = getRamanLiveRuntime(ctx.cwd) !== undefined;
		return success("LabAgents planner proposal flow is active.", {
			source: "experiment-research",
			stage: "phase10-bounded-search-and-mapping",
			canValidateProcedureSpecs: true,
			canRunPreflight: true,
			canExecuteSimulationRuns: true,
			canExecuteLiveSinglePointRuns: liveRuntimeRegistered,
			canExecuteLiveParameterSearchRuns: liveRuntimeRegistered,
			canExecuteLiveGridMappingRuns: liveRuntimeRegistered,
			runtimeConfig: {
				source: runtimeConfig.source,
				path: runtimeConfig.path,
				enabled: runtimeConfig.enabled,
			},
			configuredResources: runtimeConfig.resources,
			requiresApproval: true,
			executionEntryPoint: "validate_procedure_spec -> run_preflight -> propose_run -> approve_and_start_run",
			goodEnoughDecisionMode: "explicit_rules",
			ramanRuntimeContractDefined: true,
			nextMilestone: "verification and operator-facing refinement",
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, PlannerToolDetails>;

export const validateProcedureSpecTool = {
	name: "validate_procedure_spec",
	label: "Validate Procedure Spec",
	description: "Validate a bounded ProcedureSpec draft and summarize its proposed run envelope.",
	promptSnippet: "Validate a bounded ProcedureSpec draft before preflight or approval",
	promptGuidelines: [
		"Use validate_procedure_spec before run_preflight or propose_run.",
		"Treat validation success as a bounded planning result, not execution approval.",
	],
	parameters: ProcedureSpecParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProcedureSpecParams) {
		const spec = asProcedureSpec(params);
		const validation = validateProcedureSpec(spec);
		if (!validation.valid) {
			return error("ProcedureSpec validation failed.", "invalid_procedure_spec", {
				valid: false,
				issues: validation.issues,
			});
		}

		return success("ProcedureSpec is valid for bounded planner proposal flow.", previewState(spec));
	},
} satisfies ToolDefinition<typeof ProcedureSpecParamsSchema, PlannerToolDetails>;

export const runPreflightTool = {
	name: "run_preflight",
	label: "Run Preflight",
	description: "Check bounded run readiness before proposal approval.",
	promptSnippet: "Run planner-side preflight checks before proposing an executable bounded run",
	promptGuidelines: [
		"Use run_preflight after validate_procedure_spec and before propose_run.",
		"Do not treat preflight as execution approval; it only checks the current bounded proposal surface.",
	],
	parameters: ProcedureSpecParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: ProcedureSpecParams, _signal, _onUpdate, ctx) {
		const spec = asProcedureSpec(params);
		const validation = validateProcedureSpec(spec);
		if (!validation.valid) {
			return error("ProcedureSpec preflight failed because the spec is invalid.", "invalid_procedure_spec", {
				valid: false,
				issues: validation.issues,
			});
		}

		const state = await buildPreflightState(spec, ctx.cwd, resolveExecutionMode(params));
		if (state.requiredRolesPresent !== true) {
			return error("ProcedureSpec preflight failed because required Raman resources are missing.", "preflight_missing_resources", state);
		}

		if (state.requestedModeSupported !== true) {
			return warning("Requested execution mode is not supported for this ProcedureSpec in the current MVP phase.", state);
		}

		if ((state.risks as Array<{ level: string }>).some((risk) => risk.level === "forbidden")) {
			return warning("ProcedureSpec preflight found forbidden risks that must be resolved before approval.", state);
		}

		if (state.preflightReady !== true || state.controlAvailable !== true) {
			return warning("ProcedureSpec preflight is waiting on live runtime readiness or control availability.", state);
		}

		return success("ProcedureSpec preflight is ready for supervised proposal approval.", state);
	},
} satisfies ToolDefinition<typeof ProcedureSpecParamsSchema, PlannerToolDetails>;
