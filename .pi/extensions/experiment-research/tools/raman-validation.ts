import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { recordRamanHardwareValidation } from "../kernel/raman-validation.ts";
import { RamanHardwareValidationParamsSchema, type ToolResult } from "../schemas.ts";

export const ramanHardwareValidationTool = {
	name: "raman_record_hardware_validation",
	label: "Raman Hardware Validation",
	description: "Record operator-reviewed evidence for supervised Raman hardware readiness.",
	promptSnippet: "Record Raman hardware validation evidence after supervised hardware checks",
	promptGuidelines: [
		"Use raman_record_hardware_validation only after operator review of real hardware evidence.",
		"Set hardwareEvidence.evidenceMode to hardware only for supervised LabSpec, camera, acquirer, and MC.Newton evidence.",
		"Do not use fake regression artifacts as production-ready hardware evidence.",
	],
	parameters: RamanHardwareValidationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = recordRamanHardwareValidation(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanHardwareValidationParamsSchema, ToolResult>;
