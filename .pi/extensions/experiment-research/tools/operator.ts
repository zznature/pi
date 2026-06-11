import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { OperatorIntentParamsSchema, type ToolResult } from "../schemas.ts";

export const pauseRunTool = {
	name: "pause_run",
	label: "Pause Run",
	description: "Record an operator pause intent for a hardware run; the kernel pauses at the next safe unit boundary.",
	promptSnippet: "Record an operator pause intent for a hardware run",
	promptGuidelines: ["Use pause_run only to request a safe pause of an active hardware run."],
	parameters: OperatorIntentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("pause_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof OperatorIntentParamsSchema, ToolResult>;

export const abortRunTool = {
	name: "abort_run",
	label: "Abort Run",
	description: "Record an operator abort intent for a hardware run; the kernel stops at the next safe unit boundary.",
	promptSnippet: "Record an operator abort intent for a hardware run",
	promptGuidelines: ["Use abort_run only to request a safe abort of an active hardware run."],
	parameters: OperatorIntentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("abort_run", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof OperatorIntentParamsSchema, ToolResult>;

export const requestOperatorTool = {
	name: "request_operator",
	label: "Request Operator",
	description: "Record a request for operator attention on a hardware run without stopping it automatically.",
	promptSnippet: "Record a request for operator attention on a hardware run",
	promptGuidelines: ["Use request_operator to flag that a human operator should review the run."],
	parameters: OperatorIntentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = dispatch("request_operator", params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof OperatorIntentParamsSchema, ToolResult>;
