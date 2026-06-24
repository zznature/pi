import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	HardwareBridgeV2Client,
	HardwareBridgeV2RequestError,
	type HardwareBridgeV2ActionContract,
} from "../kernel/hw/bridge-v2.ts";
import { createErrorResult, createSuccessResult } from "../results.ts";
import {
	HardwareBridgeV2ReadParamsSchema,
	type HardwareBridgeV2ReadParams,
	type ToolResult,
} from "../schemas.ts";

function findContract(
	contracts: HardwareBridgeV2ActionContract[],
	params: HardwareBridgeV2ReadParams,
): HardwareBridgeV2ActionContract | undefined {
	return contracts.find((contract) => contract.domain === params.domain && contract.action === params.action);
}

function bridgeErrorResult(commandId: string, error: unknown): ToolResult {
	if (error instanceof HardwareBridgeV2RequestError) {
		return createErrorResult(
			commandId,
			`Hardware bridge V2 read request failed: ${error.message}`,
			"bridge_crashed",
			["Check the bridge action payload and hardware readback connection state before retrying."],
			{ code: error.code, detail: error.detail },
			true,
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	return createErrorResult(
		commandId,
		`Hardware bridge V2 read request failed: ${message}`,
		"bridge_crashed",
		["Check the hardware bridge process and retry only if the read action is idempotent."],
		{ message },
		true,
	);
}

export const hardwareBridgeV2ReadTool = {
	name: "hardware_bridge_v2_read",
	label: "Hardware Bridge V2 Read",
	description: "Call a hardware_bridge_v2 action only when its runtime action contract declares sideEffectLevel read.",
	promptSnippet: "Read hardware state through hardware_bridge_v2 using action-contract gated read-only calls",
	promptGuidelines: [
		"Use this tool only for hardware_bridge_v2 actions whose contract reports sideEffectLevel read.",
		"Do not use this tool to move a stage, change temperature, start acquisition, collect artifacts, or change laser/power state.",
		"Read-only calls do not require coordinateAuditId; coordinateAuditId remains required before supervised real motion or acquisition.",
	],
	parameters: HardwareBridgeV2ReadParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const bridge = new HardwareBridgeV2Client({
			cwd: ctx.cwd,
			python: params.python ?? (process.platform === "win32" ? "python" : undefined),
			stageRoot: params.stageRoot,
			requestTimeoutMs: params.timeoutMs ?? 30_000,
		});
		try {
			const contracts = await bridge.listActions(params.timeoutMs);
			const contract = findContract(contracts, params);
			if (!contract) {
				const result = createErrorResult(
					toolCallId,
					`Hardware bridge V2 action is not advertised: ${params.domain}.${params.action}`,
					"invalid_tool_params",
					["Call an action advertised by bridge.list_actions."],
					{ domain: params.domain, action: params.action },
					true,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
				};
			}
			if (contract.sideEffectLevel !== "read") {
				const result = createErrorResult(
					toolCallId,
					`Hardware bridge V2 action ${params.domain}.${params.action} is not read-only.`,
					"hardware_gate_failed",
					["Use run_preflight/run_experiment and the hardware approval gates for non-read hardware actions."],
					{ contract },
					false,
				);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			}
			const response = await bridge.request<unknown>(
				params.domain,
				params.action,
				params.payload ?? {},
				params.timeoutMs,
			);
			const result = createSuccessResult(
				toolCallId,
				`Hardware bridge V2 read action ${params.domain}.${params.action} completed.`,
				{ contract, response },
				["Use readback values as planning input; do not execute real motion or acquisition without the required gates."],
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		} catch (error) {
			const result = bridgeErrorResult(toolCallId, error);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		} finally {
			await bridge.shutdown(1_000).catch(() => bridge.close());
		}
	},
} satisfies ToolDefinition<typeof HardwareBridgeV2ReadParamsSchema, ToolResult>;
