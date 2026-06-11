import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { AdvanceRunParamsSchema, PollRunParamsSchema, StartRunParamsSchema, type ToolResult } from "../schemas.ts";

export const startRunTool = {
	name: "start_run",
	label: "Start Run",
	description: "Admit and start a validated simulation ExperimentSpec under the async run lifecycle, returning a runId without executing units.",
	promptSnippet: "Start a simulation run and return its runId without blocking on execution",
	promptGuidelines: [
		"Use start_run to begin a bounded simulation run that you will drive with advance_run.",
		"start_run only reserves and starts the run; call advance_run to execute units.",
	],
	parameters: StartRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("start_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof StartRunParamsSchema, ToolResult>;

export const advanceRunTool = {
	name: "advance_run",
	label: "Advance Run",
	description: "Execute up to maxUnits units of a running or paused run, stopping at the next safe unit boundary if an operator intent is present.",
	promptSnippet: "Advance a started run by a bounded number of units, honoring operator intents at unit boundaries",
	promptGuidelines: [
		"Use advance_run to execute a started run incrementally so pause_run/abort_run can intervene between batches.",
		"Set maxUnits to keep control returning to the planner; omit it to run to completion.",
	],
	parameters: AdvanceRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("advance_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof AdvanceRunParamsSchema, ToolResult>;

export const pollRunTool = {
	name: "poll_run",
	label: "Poll Run",
	description: "Read the live RunState (status and unit progress) for a run started under the async run lifecycle.",
	promptSnippet: "Read the live RunState and progress for a run",
	promptGuidelines: ["Use poll_run to observe progress between advance_run calls."],
	parameters: PollRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("poll_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof PollRunParamsSchema, ToolResult>;
