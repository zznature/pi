import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getExperimentState } from "../run-store.ts";
import { GetExperimentStateParamsSchema, type ToolResult } from "../schemas.ts";

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
