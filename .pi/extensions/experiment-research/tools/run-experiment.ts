import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { RunExperimentParamsSchema, type ToolResult } from "../schemas.ts";

export const runExperimentTool = {
	name: "run_experiment",
	label: "Run Experiment",
	description: "Execute a validated simulation ExperimentSpec or an approved Phase 4 stage-only hardware pilot.",
	promptSnippet: "Execute a simulation or approved hardware ExperimentSpec and return run records and summary",
	promptGuidelines: [
		"Use run_experiment for simulation specs that passed preflight.",
		"For hardware specs, require a matching dry-run preflight report and explicit operator approval.",
	],
	parameters: RunExperimentParamsSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("run_experiment", params, { cwd: ctx.cwd });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof RunExperimentParamsSchema, ToolResult>;
