import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import { hardwareBridgeV2ReadTool } from "../tools/hardware-bridge-v2-read.ts";

function toolContext(): ExtensionContext {
	return { cwd: process.cwd() } as unknown as ExtensionContext;
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

test("hardware_bridge_v2_read allows runtime-contract read actions", async () => {
	const result = await hardwareBridgeV2ReadTool.execute(
		"read-stage-position",
		{
			domain: "stage",
			action: "get_position",
			payload: {
				stage: {
					adapter: "memory",
					initialPosition: { xUm: 11, yUm: 22, zUm: 33 },
				},
			},
			timeoutMs: 5_000,
		},
		undefined,
		undefined,
		toolContext(),
	);

	assert.equal(result.details.status, "success");
	const state = asRecord(result.details.stateAfter);
	const contract = asRecord(state.contract);
	assert.equal(contract.sideEffectLevel, "read");
	const response = asRecord(state.response);
	assert.deepEqual(asRecord(response.position), { xUm: 11, yUm: 22, zUm: 33 });
});

test("hardware_bridge_v2_read rejects non-read actions by runtime contract", async () => {
	const result = await hardwareBridgeV2ReadTool.execute(
		"reject-stage-motion",
		{
			domain: "stage",
			action: "move_absolute",
			payload: { xUm: 1 },
			timeoutMs: 5_000,
		},
		undefined,
		undefined,
		toolContext(),
	);

	assert.equal(result.details.status, "error");
	assert.equal(result.details.errorCode, "hardware_gate_failed");
	const state = asRecord(result.details.stateAfter);
	const contract = asRecord(state.contract);
	assert.equal(contract.sideEffectLevel, "motion");
});
