import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadCapabilities } from "../capabilities.ts";
import { analyzeRecordedRun } from "../analysis.ts";
import { HardwareBridgeV2Client, HardwareBridgeV2ProtocolError } from "../kernel/hw/bridge-v2.ts";
import { pollRun } from "../kernel/run.ts";
import {
	executeRamanV2RunUnit,
	RamanV2WorkflowAbortError,
	RamanV2WorkflowPauseError,
	type RamanV2Bridge,
} from "../kernel/raman/v2-orchestrator.ts";
import { reconcileRamanV2Hardware } from "../kernel/raman/v2-resume.ts";
import { readResumeSnapshot, reserveRun } from "../run-store.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { getExperimentPoints } from "../spec-utils.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-v2-orchestrator-"));
}

function shiftedPattern(dx: number, dy: number): number[][] {
	const matrix = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0));
	matrix[1 + dy][1 + dx] = 9;
	return matrix;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIniRecord(path: string): Record<string, string> {
	const record: Record<string, string> = {};
	for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
		const trimmed = line.trim();
		const separator = trimmed.indexOf("=");
		if (!trimmed || trimmed.startsWith("#") || separator < 0) continue;
		record[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
	}
	return record;
}

async function fakeLabspecVideoWorker(bridgeDir: string, captureCount: number): Promise<void> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 3_000;
	const handled = new Set<string>();
	let captures = 0;
	while (Date.now() < deadline) {
		if (!existsSync(requestsDir)) {
			await delay(20);
			continue;
		}
		const requestFile = readdirSync(requestsDir).find((entry) => entry.endsWith(".ini") && !handled.has(entry));
		if (!requestFile) {
			await delay(20);
			continue;
		}
		const request = readIniRecord(join(requestsDir, requestFile));
		const requestId = request.request_id;
		assert.ok(requestId);
		mkdirSync(resultsDir, { recursive: true });
		if (request.action === "start_video") {
			writeFileSync(join(resultsDir, requestFile), [`request_id=${requestId}`, "status=ok", ""].join("\n"), "utf-8");
			handled.add(requestFile);
			continue;
		}
		if (request.action === "capture_frame") {
			const outputPath = request.output_path;
			assert.ok(outputPath);
			writeFileSync(outputPath, "P2\n3 3\n255\n0 10 0\n20 200 20\n0 10 0\n", "utf-8");
			writeFileSync(
				join(resultsDir, requestFile),
				[`request_id=${requestId}`, "status=ok", `frame_path=${outputPath}`, ""].join("\n"),
				"utf-8",
			);
			captures += 1;
			handled.add(requestFile);
			if (captures >= captureCount) return;
			continue;
		}
		handled.add(requestFile);
	}
	assert.fail(`fake LabSpec video worker observed ${captures}/${captureCount} capture request(s)`);
}

async function fakeLabspecWorker(bridgeDir: string): Promise<{ requestId: string; outputPath: string }> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!existsSync(requestsDir)) {
			await delay(20);
			continue;
		}
		const requestFile = readdirSync(requestsDir).find((entry) => entry.endsWith(".ini"));
		if (!requestFile) {
			await delay(20);
			continue;
		}
		const request = readIniRecord(join(requestsDir, requestFile));
		const requestId = request.request_id;
		assert.ok(requestId);
		const outputPath = request.output_path;
		assert.ok(outputPath);
		mkdirSync(resultsDir, { recursive: true });
		writeFileSync(outputPath, "raman_shift_nm,intensity\n100,10\n200,20\n", "utf-8");
		writeFileSync(
			join(resultsDir, requestFile),
			[
				`request_id=${requestId}`,
				"status=ok",
				`output_path=${outputPath}`,
				"snr_estimate=24",
				"total_intensity=32",
				"saturated=false",
				"",
			].join("\n"),
			"utf-8",
		);
		return { requestId, outputPath };
	}
	assert.fail("fake LabSpec worker did not observe a Raman V2 acquisition request");
}

class FailingBridge implements RamanV2Bridge {
	private readonly inner: HardwareBridgeV2Client;
	private readonly shouldFail: (domain: string, action: string, count: number) => boolean;
	private failures = 0;

	constructor(
		inner: HardwareBridgeV2Client,
		shouldFail: (domain: string, action: string, count: number) => boolean,
	) {
		this.inner = inner;
		this.shouldFail = shouldFail;
	}

	request<Result>(
		domain: string,
		action: string,
		payload: Record<string, unknown> = {},
		timeoutMs?: number,
	): Promise<Result> {
		this.failures += 1;
		if (this.shouldFail(domain, action, this.failures)) {
			return Promise.reject(new HardwareBridgeV2ProtocolError(`synthetic crash before ${domain}.${action}`));
		}
		return this.inner.request<Result>(domain, action, payload, timeoutMs);
	}
}

async function currentStagePosition(bridge: HardwareBridgeV2Client): Promise<{ xUm: number; yUm: number; zUm: number }> {
	const result = await bridge.request<Record<string, unknown>>("stage", "get_position");
	const position = result.position as { xUm: number; yUm: number; zUm: number };
	return { xUm: position.xUm, yUm: position.yUm, zUm: position.zUm };
}

function v2Spec(minXyConfidence = 0): ExperimentSpec {
	const spec = loadSpec("raman/base/hardware-spec.json");
	return {
		...spec,
		resources: [...spec.resources, { id: "lab-camera", kind: "instrument", role: "camera" }],
		domain: {
			thermal: {
				enabled: true,
				targetTemperatureC: 42,
				toleranceC: 0.2,
				stableWindowS: 0,
				timeoutS: 1,
				pollIntervalS: 0.02,
				waitBeforeAcquisition: true,
			},
			raman: {
				...spec.domain?.raman,
				autofocus: {
					enabled: true,
					every: { kind: "everyNPoints", n: 1 },
					zMinUm: -10,
					zMaxUm: 10,
					coarseRangeUm: 20,
					coarseStepUm: 5,
					fineRangeUm: 0,
					fineStepUm: 1,
					metric: "tenengrad",
					minConfidence: 0.1,
					onFailure: "pause",
				},
				xyCorrection: {
					enabled: true,
					phase: "postFocusCorrection",
					transformArtifactId: "not-used-in-test",
					minConfidence: minXyConfidence,
					maxCorrectionUm: 10,
				},
			},
		},
	};
}

function acquisitionOnlySpec(): ExperimentSpec {
	const spec = loadSpec("raman/base/hardware-spec.json");
	return {
		...spec,
		resources: [...spec.resources, { id: "lab-camera", kind: "instrument", role: "camera" }],
		domain: {
			raman: spec.domain?.raman,
		},
	};
}

test("Raman V2 TS run-unit orchestrates autofocus, XY correction, acquisition, and microstep snapshots", async () => {
	const cwd = tempCwd();
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = v2Spec();
		const reserved = reserveRun(cwd, spec, "raman-v2-orchestrator", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const record = await executeRamanV2RunUnit({
			cwd,
			runId: reserved.record.runId,
			commandId: "raman-v2-orchestrator",
			spec,
			point,
			bridge,
			stage: { adapter: "memory" },
			settleTimeoutMs: 0,
			fakeFocusZUm: 0,
			xyReferenceImage: shiftedPattern(0, 0),
			xyCurrentImage: shiftedPattern(1, 1),
			xyTransform: [
				[1, 0],
				[0, 1],
			],
			acquisitionSimulateDurationMs: 0,
			thermal: { backend: "fake", simulateDurationMs: 0 },
		});

		assert.equal(record.status, "success");
		assert.ok(record.autofocus);
		assert.equal(record.autofocus.zBestUm, 0);
		assert.ok(record.autofocus.finalScore > 0);
		assert.ok(record.xyCorrection);
		assert.equal(record.xyCorrection.applied, true);
		assert.ok(Math.hypot(record.xyCorrection.dxUm, record.xyCorrection.dyUm) > 0);
		assert.ok(record.thermal);
		assert.equal(record.thermal.targetTemperatureC, 42);
		assert.equal(record.thermal.stable, true);
		assert.ok(record.spectrum);
		assert.equal(record.spectrum.integrationTimeS, 1);
		assert.ok(record.artifactRefs.some((artifact) => artifact.kind === "frame"));
		assert.ok(record.artifactRefs.some((artifact) => artifact.kind === "spectrum"));

		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.microstep, "unit_completed");
		assert.equal(snapshot?.unitIndex, 0);
		assert.equal(snapshot?.nextUnitIndex, 1);
		assert.equal(snapshot?.safeToResume, true);
		assert.ok(snapshot?.artifactRefs?.some((artifact) => artifact.kind === "spectrum"));

		const state = pollRun(cwd, reserved.record.runId);
		assert.equal(state.microstep, "unit_completed");
		assert.equal(state.nextUnitIndex, 1);
		assert.ok(state.artifactRefs?.some((artifact) => artifact.kind === "spectrum"));

		const analysis = analyzeRecordedRun({
			runId: reserved.record.runId,
			summary: {
				runId: reserved.record.runId,
				experimentId: spec.experimentId,
				status: "completed",
				unitCount: 1,
				completedUnits: 1,
				stopConditionMet: false,
			},
			spec,
			events: [
				{
					schemaVersion: "1",
					type: "unit_completed",
					unit: record,
				},
			],
			artifacts: record.artifactRefs,
		});
		assert.equal(analysis.qualityMetrics.completedUnits, 1);
		assert.ok((analysis.qualityMetrics.meanFocusScore ?? 0) > 0);
		assert.ok((analysis.qualityMetrics.meanXyCorrectionUm ?? 0) > 0);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 TS orchestration writes a recovering snapshot on low-confidence XY correction", async () => {
	const cwd = tempCwd();
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = v2Spec(1.1);
		const reserved = reserveRun(cwd, spec, "raman-v2-low-confidence", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		await assert.rejects(
			() =>
				executeRamanV2RunUnit({
					cwd,
					runId: reserved.record.runId,
					commandId: "raman-v2-low-confidence",
					spec,
					point,
					bridge,
					stage: { adapter: "memory" },
					settleTimeoutMs: 0,
					fakeFocusZUm: 0,
					xyReferenceImage: shiftedPattern(0, 0),
					xyCurrentImage: shiftedPattern(1, 1),
					xyTransform: [
						[1, 0],
						[0, 1],
					],
				}),
			(error: unknown) => {
				assert.ok(error instanceof RamanV2WorkflowPauseError);
				assert.equal(error.code, "calibration_low_confidence");
				return true;
			},
		);
		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.status, "recovering");
		assert.equal(snapshot?.microstep, "recovery_required");
		assert.equal(snapshot?.safeToResume, false);
		assert.match(snapshot?.reason ?? "", /XY correction confidence/);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 TS run-unit can acquire spectra through the LabSpec file bridge lifecycle", async () => {
	const cwd = tempCwd();
	const bridgeDir = join(cwd, "labspec-bridge");
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = acquisitionOnlySpec();
		const reserved = reserveRun(cwd, spec, "raman-v2-labspec", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const running = executeRamanV2RunUnit({
			cwd,
			runId: reserved.record.runId,
			commandId: "raman-v2-labspec",
			spec,
			point,
			bridge,
			stage: { adapter: "memory" },
			settleTimeoutMs: 0,
			acquisition: {
				backend: "labspec_file_bridge",
				bridgeDir,
				timeoutS: 2,
				pollIntervalS: 0.02,
			},
		});
		const worker = await fakeLabspecWorker(bridgeDir);
		const record = await running;

		assert.equal(record.status, "success");
		assert.ok(record.spectrum);
		assert.equal(record.spectrumMetadata?.backend, "labspec_file_bridge");
		assert.equal(record.spectrumMetadata?.snrEstimate, 24);
		assert.equal(record.spectrumMetadata?.totalIntensity, 32);
		assert.equal(record.spectrumMetadata?.saturated, false);
		assert.ok(record.artifactRefs.some((artifact) => artifact.kind === "spectrum"));
		assert.match(readFileSync(worker.outputPath, "utf-8"), /raman_shift_nm,intensity/);

		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.microstep, "unit_completed");
		assert.ok(snapshot?.artifactRefs?.some((artifact) => artifact.kind === "spectrum"));

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 TS run-unit can capture autofocus and XY frames through the LabSpec file bridge", async () => {
	const cwd = tempCwd();
	const bridgeDir = join(cwd, "frame-bridge");
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = v2Spec();
		if (spec.domain?.raman?.autofocus) {
			spec.domain.raman.autofocus = { ...spec.domain.raman.autofocus, minConfidence: 0 };
		}
		const reserved = reserveRun(cwd, spec, "raman-v2-frame-bridge", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const worker = fakeLabspecVideoWorker(bridgeDir, 6);
		const record = await executeRamanV2RunUnit({
			cwd,
			runId: reserved.record.runId,
			commandId: "raman-v2-frame-bridge",
			spec,
			point,
			bridge,
			stage: { adapter: "memory" },
			settleTimeoutMs: 0,
			camera: {
				backend: "labspec_file_bridge",
				bridgeDir,
				timeoutMs: 2_000,
				imageFormat: "pgm",
				minCaptureIntervalMs: 0,
			},
			xyReferenceImage: shiftedPattern(0, 0),
			xyCurrentImage: shiftedPattern(0, 0),
			xyTransform: [
				[1, 0],
				[0, 1],
			],
			acquisitionSimulateDurationMs: 0,
			thermal: { backend: "fake", simulateDurationMs: 0 },
		});
		await worker;

		assert.equal(record.status, "success");
		assert.ok(record.autofocus);
		assert.ok(record.artifactRefs.filter((artifact) => artifact.kind === "frame").length >= 6);
		assert.ok(record.artifactRefs.some((artifact) => artifact.uri.endsWith("_xy_current.pgm")));
		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.microstep, "unit_completed");
		assert.ok(snapshot?.artifactRefs?.filter((artifact) => artifact.kind === "frame").length >= 6);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 recovery can resume after stage move before autofocus capture", async () => {
	const cwd = tempCwd();
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = v2Spec();
		const reserved = reserveRun(cwd, spec, "raman-v2-crash-before-capture", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const failing = new FailingBridge(bridge, (domain, action) => domain === "camera" && action === "capture_frame");
		await assert.rejects(
			() =>
				executeRamanV2RunUnit({
					cwd,
					runId: reserved.record.runId,
					commandId: "raman-v2-crash-before-capture",
					spec,
					point,
					bridge: failing,
					stage: { adapter: "memory" },
					settleTimeoutMs: 0,
					fakeFocusZUm: 0,
					xyTransform: [
						[1, 0],
						[0, 1],
					],
				}),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2ProtocolError);
				return true;
			},
		);
		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.microstep, "stage_position_confirmed");
		assert.equal(snapshot?.safeToResume, true);
		assert.deepEqual(snapshot?.lastKnownStagePosition, { xUm: 0, yUm: 0, zUm: -10 });
		const reconciliation = await reconcileRamanV2Hardware(cwd, reserved.record.runId, {
			getStagePosition: () => currentStagePosition(bridge),
		});
		assert.equal(reconciliation.decision, "resume");

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 recovery can resume after autofocus frame capture before score calculation", async () => {
	const cwd = tempCwd();
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = v2Spec();
		const reserved = reserveRun(cwd, spec, "raman-v2-crash-after-frame", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const failing = new FailingBridge(bridge, (domain, action) => domain === "focus_metric" && action === "calc_score");
		await assert.rejects(
			() =>
				executeRamanV2RunUnit({
					cwd,
					runId: reserved.record.runId,
					commandId: "raman-v2-crash-after-frame",
					spec,
					point,
					bridge: failing,
					stage: { adapter: "memory" },
					settleTimeoutMs: 0,
					fakeFocusZUm: 0,
					xyTransform: [
						[1, 0],
						[0, 1],
					],
				}),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2ProtocolError);
				return true;
			},
		);
		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.microstep, "autofocus_frame_captured");
		assert.equal(snapshot?.safeToResume, true);
		assert.ok(snapshot?.artifactRefs?.some((artifact) => artifact.kind === "frame"));
		const reconciliation = await reconcileRamanV2Hardware(cwd, reserved.record.runId, {
			getStagePosition: () => currentStagePosition(bridge),
		});
		assert.equal(reconciliation.decision, "resume");

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 acquisition abort cancels the unit and records a non-resumable snapshot", async () => {
	const cwd = tempCwd();
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const spec = acquisitionOnlySpec();
		const reserved = reserveRun(cwd, spec, "raman-v2-acquire-abort", loadCapabilities("hardware"));
		const [point] = getExperimentPoints(spec);
		const running = executeRamanV2RunUnit({
			cwd,
			runId: reserved.record.runId,
			commandId: "raman-v2-acquire-abort",
			spec,
			point,
			bridge,
			stage: { adapter: "memory" },
			settleTimeoutMs: 0,
			acquisitionSimulateDurationMs: 500,
		});
		let acquisitionId: string | undefined;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			await delay(20);
			const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
			acquisitionId = snapshot?.pendingAcquisitionId;
			if (acquisitionId) break;
		}
		assert.equal(typeof acquisitionId, "string");
		const cancelled = await bridge.request<Record<string, unknown>>("spectrometer", "cancel_acquisition", { acquisitionId });
		assert.equal(cancelled.status, "cancelled");
		await assert.rejects(
			() => running,
			(error: unknown) => {
				assert.ok(error instanceof RamanV2WorkflowAbortError);
				assert.equal(error.code, "aborted");
				return true;
			},
		);
		const snapshot = readResumeSnapshot(cwd, reserved.record.runId);
		assert.equal(snapshot?.status, "aborted");
		assert.equal(snapshot?.microstep, "recovery_required");
		assert.equal(snapshot?.safeToResume, false);
		assert.match(snapshot?.reason ?? "", /cancelled/);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
