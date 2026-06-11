import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runRamanActiveProbe } from "../kernel/raman-active-probe.ts";
import { RamanActiveProbeParamsSchema, type ToolResult } from "../schemas.ts";

export const ramanActiveProbeTool = {
	name: "raman_active_probe",
	label: "Raman Active Probe",
	description: "Run an operator-approved Raman maintenance smoke probe that may capture a frame or acquire a short spectrum.",
	promptSnippet: "Run an operator-approved Raman active smoke probe and record artifacts",
	promptGuidelines: [
		"Use raman_active_probe only as an operator maintenance action, not during planner-controlled dry runs.",
		"Require explicit operator approval and laser safety confirmation before spectrum smoke acquisition.",
	],
	parameters: RamanActiveProbeParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await runRamanActiveProbe(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanActiveProbeParamsSchema, ToolResult>;
