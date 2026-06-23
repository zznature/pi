import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { recordHardwareCoordinateAudit } from "../kernel/hardware-coordinate-audit.ts";
import { HardwareCoordinateAuditParamsSchema, type ToolResult } from "../schemas.ts";

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
