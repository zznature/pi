import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { AnalyzeRunParamsSchema, type ToolResult } from "../schemas.ts";

export const analyzeRunTool = {
	name: "analyze_run",
	label: "Analyze Run",
	description: "Return a deterministic rule-based summary for a completed simulation run.",
	promptSnippet: "Analyze a completed simulation run by runId",
	promptGuidelines: ["Use analyze_run after run_experiment returns a runId."],
	parameters: AnalyzeRunParamsSchema,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("analyze_run", params, { cwd: ctx.cwd });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof AnalyzeRunParamsSchema, ToolResult>;
