import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { PlanNextExperimentParamsSchema, type ToolResult } from "../schemas.ts";

export const planNextExperimentTool = {
	name: "plan_next_experiment",
	label: "Plan Next Experiment",
	description: "Return a constrained next-step strategy for a completed simulation run.",
	promptSnippet: "Choose repeat_same, increase_resolution, reduce_range, or stop for the next bounded run",
	promptGuidelines: [
		"Use plan_next_experiment after analyze_run when the user asks what experiment should happen next.",
		"Do not treat plan_next_experiment output as a full ExperimentSpec; compile the strategy into a bounded spec first.",
	],
	parameters: PlanNextExperimentParamsSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("plan_next_experiment", params, { cwd: ctx.cwd });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof PlanNextExperimentParamsSchema, ToolResult>;
