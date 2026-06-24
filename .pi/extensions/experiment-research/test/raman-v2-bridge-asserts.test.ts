import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	HardwareBridgeV2RequestError,
} from "../kernel/hw/bridge-v2.ts";
import {
	executeRamanV2RunUnit,
	type RamanV2Bridge,
} from "../kernel/raman/v2-orchestrator.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { getExperimentPoints } from "../spec-utils.ts";

const ROOT_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const TEST_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(ROOT_FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-v2-bridge-asserts-"));
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function autofocusSpec(): ExperimentSpec {
	const spec = loadSpec("raman/base/hardware-spec.json");
	return {
		...spec,
		domain: {
			raman: {
				...spec.domain?.raman,
				operationIntent: "autofocus_then_acquire",
				autofocus: {
					enabled: true,
					every: "once",
					zMinUm: 0,
					zMaxUm: 0.5,
					coarseRangeUm: 1,
					coarseStepUm: 1,
					fineRangeUm: 0,
					fineStepUm: 0.1,
					finalStageToleranceUm: 0.1,
					metric: "tenengrad",
					minConfidence: 0,
					onFailure: "abort",
				},
			},
		},
	};
}

function packageRoot(): string {
	return join(TEST_FIXTURES, "..", "..");
}

function runBridgeProbe(payload: Record<string, unknown>): { code: string; detail: Record<string, unknown> } {
	const script = `
		import { HardwareBridgeV2Client, HardwareBridgeV2RequestError } from "./kernel/hw/bridge-v2.ts";
		import { join } from "node:path";
		const bridge = new HardwareBridgeV2Client({
			cwd: process.cwd(),
			bridgePath: join(process.cwd(), "test/fixtures/offset-memory-stage-bridge-v2.py"),
			requestTimeoutMs: 5000,
		});
		try {
			await bridge.request("stage", "connect", { adapter: "memory" });
			try {
				await bridge.request("stage", "move_absolute", ${JSON.stringify(payload)});
				console.log(JSON.stringify({ ok: false, message: "expected bridge guard rejection" }));
				process.exitCode = 1;
			} catch (error) {
				if (!(error instanceof HardwareBridgeV2RequestError)) throw error;
				console.log(JSON.stringify({ ok: true, code: error.code, detail: error.detail }));
			}
			await bridge.shutdown();
		} catch (error) {
			console.error(error);
			process.exitCode = 1;
		}
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: packageRoot(),
		encoding: "utf-8",
		timeout: 15_000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
	assert.ok(lines.length > 0, "bridge probe produced no stdout");
	const parsed = JSON.parse(lines.at(-1) ?? "{}") as { ok?: boolean; code?: string; detail?: Record<string, unknown> };
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	assert.equal(typeof parsed.code, "string");
	assert.equal(typeof parsed.detail, "object");
	assert.notEqual(parsed.detail, null);
	return { code: parsed.code as string, detail: parsed.detail as Record<string, unknown> };
}

class OvershootBridge implements RamanV2Bridge {
	readonly calls: Array<{ domain: string; action: string; payload: Record<string, unknown> }> = [];
	private position = { xUm: 0, yUm: 0, zUm: 0 };

	async request<Result>(
		domain: string,
		action: string,
		payload: Record<string, unknown> = {},
	): Promise<Result> {
		this.calls.push({ domain, action, payload });
		if (domain === "stage" && action === "get_position") {
			return { position: { ...this.position } } as Result;
		}
		if (domain === "stage" && action === "move_absolute") {
			const target = {
				xUm: typeof payload.xUm === "number" ? payload.xUm : this.position.xUm,
				yUm: typeof payload.yUm === "number" ? payload.yUm : this.position.yUm,
				zUm: typeof payload.zUm === "number" ? payload.zUm : this.position.zUm,
			};
			this.position = { ...target, zUm: target.zUm + 0.75 };
			const zGuardMinUm = typeof payload.zGuardMinUm === "number" ? payload.zGuardMinUm : undefined;
			const zGuardMaxUm = typeof payload.zGuardMaxUm === "number" ? payload.zGuardMaxUm : undefined;
			if (zGuardMinUm !== undefined && this.position.zUm < zGuardMinUm) {
				throw new HardwareBridgeV2RequestError("autofocus_out_of_range", "synthetic autofocus undershoot", {
					target,
					settledPosition: { ...this.position },
					zGuardMinUm,
					zGuardMaxUm,
				});
			}
			if (zGuardMaxUm !== undefined && this.position.zUm > zGuardMaxUm) {
				throw new HardwareBridgeV2RequestError("autofocus_out_of_range", "synthetic autofocus overshoot", {
					target,
					settledPosition: { ...this.position },
					zGuardMinUm,
					zGuardMaxUm,
				});
			}
			const targetToleranceUm = typeof payload.targetToleranceUm === "number" ? payload.targetToleranceUm : undefined;
			if (targetToleranceUm !== undefined && typeof payload.zUm === "number") {
				const targetErrorUm = Math.abs(this.position.zUm - payload.zUm);
				if (targetErrorUm > targetToleranceUm) {
					throw new HardwareBridgeV2RequestError("stage_command_error", "synthetic settle tolerance failure", {
						target,
						settledPosition: { ...this.position },
						targetToleranceUm,
						targetErrorUm,
					});
				}
			}
			return {
				before: target,
				position: { ...this.position },
				moveCommands: [],
			} as Result;
		}
		if (domain === "camera" && action === "capture_frame") {
			throw new Error("capture_frame should not run after autofocus guard failure");
		}
		if (domain === "focus_metric" && action === "calc_score") {
			return { metric: "tenengrad", score: 1 } as Result;
		}
		if (domain === "drift_correction" && action === "phase_correlation") {
			return { pixelShift: { dx: 0, dy: 0 }, confidence: 1 } as Result;
		}
		if (domain === "spectrometer" && action === "begin_acquisition") {
			throw new Error("acquisition should not start after autofocus guard failure");
		}
		if (domain === "thermal" && action === "set_target_temp") {
			return { targetTemperatureC: 25 } as Result;
		}
		if (domain === "thermal" && action === "wait_stable") {
			return { currentTemperatureC: 25, toleranceC: 0.1, stable: true } as Result;
		}
		throw new Error(`unexpected bridge request: ${domain}.${action}`);
	}
}

test("bridge rejects settled autofocus moves that leave the window or miss target tolerance", async () => {
	const windowFailure = runBridgeProbe({
		zUm: 10,
		zGuardMinUm: 9,
		zGuardMaxUm: 10.5,
	});
	assert.equal(windowFailure.code, "autofocus_out_of_range");
	assert.equal(asRecord(windowFailure.detail.target).zUm, 10);
	assert.equal(asRecord(windowFailure.detail.settledPosition).zUm, 10.75);
	assert.equal(windowFailure.detail.zGuardMaxUm, 10.5);

	const toleranceFailure = runBridgeProbe({
		zUm: 10,
		zGuardMinUm: 9,
		zGuardMaxUm: 11,
		targetToleranceUm: 0.1,
	});
	assert.equal(toleranceFailure.code, "stage_command_error");
	assert.equal(asRecord(toleranceFailure.detail.target).zUm, 10);
	assert.equal(asRecord(toleranceFailure.detail.settledPosition).zUm, 10.75);
	assert.equal(toleranceFailure.detail.targetToleranceUm, 0.1);
	assert.equal(Number(toleranceFailure.detail.targetErrorUm) > 0.1, true);
});

test("executeRamanV2RunUnit stops before frame capture or acquisition after autofocus guard failure", async () => {
	const cwd = tempCwd();
	try {
		const spec = autofocusSpec();
		const point = getExperimentPoints(spec)[0];
		const bridge = new OvershootBridge();
		mkdirSync(join(cwd, ".pi", "experiment-runs", "runs", "run-guarded-autofocus"), { recursive: true });
		await assert.rejects(
			() =>
				executeRamanV2RunUnit({
					cwd,
					runId: "run-guarded-autofocus",
					commandId: "guarded-autofocus",
					spec,
					point,
					bridge,
					settleTimeoutMs: 0,
				}),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "autofocus_out_of_range");
				return true;
			},
		);
		assert.equal(bridge.calls.some((call) => call.domain === "camera" && call.action === "capture_frame"), false);
		assert.equal(bridge.calls.some((call) => call.domain === "spectrometer" && call.action === "begin_acquisition"), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
