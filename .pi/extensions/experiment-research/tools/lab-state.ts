import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLabState, type LabState } from "../lab-state.ts";
import { EmptyParamsSchema, type ToolResult } from "../schemas.ts";

function createLabStateResult(state: LabState): ToolResult {
	return {
		status: "success",
		summary: "Static Phase 3 lab state loaded. Simulation and dry-run preflight capabilities are available.",
		nextActions: [
			"Draft an ExperimentSpec in simulation or dry_run mode.",
			"Call validate_experiment_spec before any preflight or run.",
		],
		artifacts: [],
		commandId: "phase3-get-lab-state",
		stateBefore: null,
		stateAfter: state,
		stopConditionMet: false,
	};
}

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return static Phase 3 lab state, simulation capabilities, and dry-run readiness capabilities.",
	promptSnippet: "Inspect static Phase 3 lab state and dry-run readiness capabilities",
	promptGuidelines: [
		"Use get_lab_state before planning an experiment when current lab capabilities or mode matter.",
	],
	parameters: EmptyParamsSchema,
	async execute() {
		const result = createLabStateResult(getLabState());
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, ToolResult>;
