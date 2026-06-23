import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	getLabActivityState,
	getLabCapabilities,
	type LabActivityState,
	type LabCapabilitiesState,
} from "../lab-state.ts";
import { EmptyParamsSchema, type ToolResult } from "../schemas.ts";

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
