import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { dispatch } from "../dispatch.ts";
import { recordHardwareCoordinateAudit } from "../kernel/hardware-coordinate-audit.ts";
import {
	HardwareCoordinateAuditParamsSchema,
	OperatorIntentParamsSchema,
	PollRunParamsSchema,
	type ToolResult,
} from "../schemas.ts";

function dispatchToolResult(
	toolCallId: string,
	toolName: Parameters<typeof dispatch>[0],
	params: Parameters<typeof dispatch>[1],
	cwd: string,
): { content: [{ type: "text"; text: string }]; details: ToolResult } {
	const result = dispatch(toolName, params, { cwd, commandId: toolCallId });
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: result,
	};
}

export const pauseRunTool = {
	name: "pause_run",
	label: "Pause Run",
	description: "Record an operator pause intent for a hardware run; the kernel pauses at the next safe unit boundary.",
	promptSnippet: "Record an operator pause intent for a hardware run",
	promptGuidelines: ["Use pause_run only to request a safe pause of an active hardware run."],
	parameters: OperatorIntentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "pause_run", params, ctx.cwd);
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
		return dispatchToolResult(toolCallId, "abort_run", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof OperatorIntentParamsSchema, ToolResult>;

export const pollRunTool = {
	name: "poll_run",
	label: "Poll Run",
	description: "Read the live RunState (status and unit progress) for a run started under the async run lifecycle.",
	promptSnippet: "Read the live RunState and progress for a run",
	promptGuidelines: ["Use poll_run to observe progress between advance_run calls."],
	parameters: PollRunParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "poll_run", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof PollRunParamsSchema, ToolResult>;

export const requestOperatorTool = {
	name: "request_operator",
	label: "Request Operator",
	description: "Record a request for operator attention on a hardware run without stopping it automatically.",
	promptSnippet: "Record a request for operator attention on a hardware run",
	promptGuidelines: ["Use request_operator to flag that a human operator should review the run."],
	parameters: OperatorIntentParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		return dispatchToolResult(toolCallId, "request_operator", params, ctx.cwd);
	},
} satisfies ToolDefinition<typeof OperatorIntentParamsSchema, ToolResult>;

export const recordHardwareCoordinateAuditTool = {
	name: "record_hardware_coordinate_audit",
	label: "Record Hardware Coordinate Audit",
	description: "Record an operator-approved absolute-coordinate audit for later real hardware execution.",
	promptSnippet: "Record operator-reviewed absolute coordinates before supervised real hardware runs",
	promptGuidelines: [
		"Use record_hardware_coordinate_audit only as an operator maintenance action.",
		"Record the audited subject and spatial plan exactly as reviewed on the real setup.",
		"Reference the returned coordinateAuditId from hardwareExecution.coordinateAuditId for supervised real hardware runs.",
	],
	parameters: HardwareCoordinateAuditParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = recordHardwareCoordinateAudit(params, { cwd: ctx.cwd, commandId: toolCallId });
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof HardwareCoordinateAuditParamsSchema, ToolResult>;
