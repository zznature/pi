import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { PlanNextExperimentParamsSchema, type ToolResult } from "../schemas.ts";

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
		const result = dispatch("plan_next_experiment", params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof PlanNextExperimentParamsSchema, ToolResult>;
