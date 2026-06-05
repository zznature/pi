import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { RunExperimentParamsSchema, type ToolResult } from "../schemas.ts";

export const runExperimentTool = {
	name: "run_experiment",
	label: "Run Experiment",
	description: "Execute a validated simulation ExperimentSpec using the deterministic simulation kernel.",
	promptSnippet: "Execute a simulation ExperimentSpec and return run records and summary",
	promptGuidelines: ["Use run_experiment only for simulation mode ExperimentSpec values that passed preflight."],
	parameters: RunExperimentParamsSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("run_experiment", params, { cwd: ctx.cwd });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof RunExperimentParamsSchema, ToolResult>;
