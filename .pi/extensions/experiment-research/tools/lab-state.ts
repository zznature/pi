import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLabState, type LabState } from "../lab-state.ts";
import { EmptyParamsSchema, type ToolResult } from "../schemas.ts";

function createLabStateResult(state: LabState): ToolResult {
	return {
		status: "success",
		summary: "Static lab state loaded. Simulation, dry-run preflight, and the stage-only hardware pilot are available.",
		nextActions: [
			"Draft an ExperimentSpec in simulation, dry_run, or hardware mode.",
			"Call validate_experiment_spec before any preflight or run.",
		],
		artifacts: [],
		commandId: "get-lab-state",
		correlationId: "get-lab-state",
		stateAfter: state,
		stopConditionMet: false,
	};
}

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return static lab state, simulation capabilities, dry-run readiness, and hardware pilot capabilities.",
	promptSnippet: "Inspect static lab state, dry-run readiness, and hardware pilot capabilities",
	promptGuidelines: [
		"Use get_lab_state before planning an experiment when current lab capabilities or mode matter.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const result = createLabStateResult(getLabState(ctx.cwd));
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, ToolResult>;
