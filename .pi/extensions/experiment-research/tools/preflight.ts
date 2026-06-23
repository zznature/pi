import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { RunPreflightParamsSchema, type ToolResult } from "../schemas.ts";

export const runPreflightTool = {
	name: "run_preflight",
	label: "Run Preflight",
	description: "Run simulation, dry-run, or hardware readiness preflight checks for an ExperimentSpec.",
	promptSnippet: "Check whether a simulation, dry-run, or hardware ExperimentSpec is ready",
	promptGuidelines: [
		"Use run_preflight after validate_experiment_spec succeeds and before run_experiment.",
		"Do not use run_preflight to probe real hardware readiness with guessed coordinates or placeholder hardware specs.",
		"For supervised real hardware launch planning, include hardwareExecution.coordinateAuditId in the preview once the operator has recorded the coordinate audit.",
		"For real Raman launch planning, include the planned hardwareExecution preview so preflight can report launch readiness before the final launch call.",
	],
	parameters: RunPreflightParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("run_preflight", params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof RunPreflightParamsSchema, ToolResult>;
