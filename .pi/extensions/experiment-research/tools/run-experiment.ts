import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { RunExperimentParamsSchema, type ToolResult } from "../schemas.ts";

export const runExperimentTool = {
	name: "run_experiment",
	label: "Run Experiment",
	description: "Execute a validated simulation ExperimentSpec or an operator-approved hardware ExperimentSpec.",
	promptSnippet: "Execute a simulation or approved hardware ExperimentSpec and return run records and summary",
	promptGuidelines: [
		"Use run_experiment for simulation specs that passed preflight.",
		"Use hardwareExecution for new hardware calls; legacy hardwarePilot is accepted only during migration.",
		"For hardware specs, require a matching dry-run preflight report, explicit operator approval, and any Raman-specific safety gates.",
	],
	parameters: RunExperimentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("run_experiment", params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof RunExperimentParamsSchema, ToolResult>;
