import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { AnalyzeRunParamsSchema, type ToolResult } from "../schemas.ts";

export const analyzeRunTool = {
	name: "analyze_run",
	label: "Analyze Run",
	description: "Return deterministic quality metrics, anomalies, artifacts, and stopping-rule status for a completed run.",
	promptSnippet: "Analyze a completed experiment run by runId",
	promptGuidelines: ["Use analyze_run after run_experiment returns a runId."],
	parameters: AnalyzeRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("analyze_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof AnalyzeRunParamsSchema, ToolResult>;
