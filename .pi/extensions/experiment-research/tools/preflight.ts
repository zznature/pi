import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { RunPreflightParamsSchema, type ToolResult } from "../schemas.ts";

export const runPreflightTool = {
	name: "run_preflight",
	label: "Run Preflight",
	description: "Run simulation, dry-run, or hardware-pilot readiness preflight checks for an ExperimentSpec.",
	promptSnippet: "Check whether a simulation, dry-run, or hardware ExperimentSpec is ready",
	promptGuidelines: ["Use run_preflight after validate_experiment_spec succeeds and before run_experiment."],
	parameters: RunPreflightParamsSchema,
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("run_preflight", params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof RunPreflightParamsSchema, ToolResult>;
