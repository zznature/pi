import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzeRecordedRun } from "../analysis.ts";
import { dispatch } from "../dispatch.ts";
import { runRamanActiveProbe } from "../kernel/raman-active-probe.ts";
import {
	autoFitAndRecordRamanXyCalibration,
	fitAndRecordRamanXyCalibration,
	recordRamanXyCalibration,
	resolveRamanXyCalibration,
} from "../kernel/raman-calibration.ts";
import { recordRamanHardwareValidation } from "../kernel/raman-validation.ts";
import { RamanBridgeClient, type RamanBridgeEvent } from "../kernel/raman-bridge.ts";
import { getLabState } from "../lab-state.ts";
import { validatePolicy } from "../policy.ts";
import { hashExperimentSpec, validateHardwareGate } from "../records.ts";
import type { ExperimentSpec, RamanHardwareValidationParams } from "../schemas.ts";
import { validateExperimentSpec } from "../schemas.ts";

process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = "1";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-phase7-"));
}

function withSimulatedHardwareDisabled<T>(callback: () => T): T {
	const previous = process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE;
	delete process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE;
	try {
		return callback();
	} finally {
		if (previous === undefined) {
			delete process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE;
		} else {
			process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = previous;
		}
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function baseApproval(dryRunReportId: string) {
	return {
		approvalId: "appr-raman-phase7",
		operator: "tester",
		approved: true,
		dryRunReportId,
		ramanSafety: {
			laserPowerConfirmed: true,
			confirmedLaserPowerMw: 1,
			labSpecWorkerReady: true,
			windowsPowerPolicyReady: true,
		},
	};
}

function hardwareEvidence(
	evidenceMode: RamanHardwareValidationParams["hardwareEvidence"]["evidenceMode"] = "hardware",
): RamanHardwareValidationParams["hardwareEvidence"] {
	return {
		evidenceMode,
		observedAt: "2026-06-11T00:00:00.000Z",
		operatorAttestedRealHardware: evidenceMode === "hardware",
		instrumentIds: {
			labspecWorkstation: "labspec-workstation-main",
			stageController: "mc-newton-xyz-stage-main",
			camera: "lab-camera-main",
			acquirer: "lab-acquirer-main",
		},
	};
}

function recordFakeCalibration(cwd: string, calibrationId = "fake-calibration"): void {
	const result = recordRamanXyCalibration(
		{
			approval: { approvalId: `appr-${calibrationId}`, operator: "tester", approved: true },
			calibrationId,
			pixelPerUm: [
				[1, 0],
				[0, 1],
			],
			confidence: 0.95,
			sourceNotes: "phase7 synthetic calibration",
		},
		{ cwd, commandId: `record-${calibrationId}` },
	);
	assert.equal(result.status, "success");
}

function focusCorrectionSpec(mode: "dry_run" | "hardware"): ExperimentSpec {
	const spec = loadSpec(mode === "dry_run" ? "raman-dry-run-spec.json" : "raman-hardware-spec.json");
	return {
		...spec,
		mode,
		resources: [...spec.resources, { id: "lab-camera", kind: "instrument", role: "camera" }],
		domain: {
			raman: {
				...spec.domain?.raman,
				autofocus: {
					enabled: true,
					every: { kind: "everyNPoints", n: 1 },
					zMinUm: -20,
					zMaxUm: 20,
					coarseRangeUm: 10,
					coarseStepUm: 5,
					fineRangeUm: 4,
					fineStepUm: 1,
					metric: "labspec_spot_compactness",
					minConfidence: 0.2,
					onFailure: "pause",
				},
				xyCorrection: {
					enabled: true,
					phase: "postFocusCorrection",
					transformArtifactId: "fake-calibration",
					minConfidence: 0.4,
					maxCorrectionUm: 10,
				},
			},
		},
	};
}

function seedNonFakeActiveProbeRecord(
	cwd: string,
	options: { includeFrame?: boolean; includeSpectrum?: boolean; probeId?: string } = {},
): string {
	const probeId = options.probeId ?? "seeded-hardware-probe";
	const artifacts: Record<string, unknown>[] = [];
	const sideEffects: string[] = [];
	if (options.includeFrame !== false) {
		const framePath = join(cwd, "frame.png");
		writeFileSync(framePath, "seeded frame artifact\n", "utf-8");
		artifacts.push({ path: framePath, kind: "frame", backend: "labspec_file_bridge", sideEffect: "labspec_frame_captured" });
		sideEffects.push("labspec_frame_captured");
	}
	if (options.includeSpectrum !== false) {
		const spectrumPath = join(cwd, "spectrum.txt");
		writeFileSync(spectrumPath, "seeded spectrum artifact\n", "utf-8");
		artifacts.push({
			path: spectrumPath,
			kind: "spectrum",
			backend: "labspec_file_bridge",
			sideEffect: "spectrum_smoke_acquired",
		});
		sideEffects.push("spectrum_smoke_acquired");
	}
	const recordPath = join(cwd, ".pi", "experiment-runs", "maintenance", "active-probes", probeId, "active-probe.json");
	writeJson(recordPath, {
		probeId,
		commandId: probeId,
		createdAt: "2026-06-11T00:00:00.000Z",
		approval: {
			approvalId: "appr-seeded-hardware-probe",
			operator: "tester",
			approved: true,
		},
		result: {
			readOnly: false,
			requiresOperatorApproval: true,
			artifacts,
			sideEffects,
		},
	});
	return recordPath;
}

function seedNonFakeRamanRun(
	cwd: string,
	runId: string,
	options: { includeSpectrumArtifact?: boolean; includeSpectrumMetadata?: boolean; spec?: ExperimentSpec } = {},
): void {
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
	const spectrumRelativePath = join(".pi", "experiment-runs", "runs", runId, "artifacts", "spectra", "point_0.txt");
	const spectrumPath = join(cwd, spectrumRelativePath);
	const unit: Record<string, unknown> = {
		index: 0,
		xUm: 0,
		yUm: 0,
		status: "success",
	};
	if (options.includeSpectrumMetadata !== false) {
		unit.spectrumMetadata = { backend: "labspec_file_bridge", snrEstimate: 25, saturated: false };
	}
	if (options.includeSpectrumArtifact !== false) {
		mkdirSync(dirname(spectrumPath), { recursive: true });
		writeFileSync(spectrumPath, "raman_shift_nm,intensity\n100,10\n200,20\n", "utf-8");
	}
	writeJson(join(runDir, "summary.json"), {
		runId,
		experimentId: "exp-raman-001",
		status: "completed",
		unitCount: 1,
		completedUnits: 1,
	});
	writeJson(join(runDir, "spec.json"), options.spec ?? loadSpec("raman-hardware-spec.json"));
	writeFileSync(
		join(runDir, "events.jsonl"),
		[
			JSON.stringify({
				schemaVersion: "1",
				sequence: 1,
				type: "run_started",
				runId,
				stageAdapter: "mc_newton_xyz",
			}),
			JSON.stringify({
				schemaVersion: "1",
				sequence: 2,
				type: "unit_completed",
				runId,
				unitKind: "point",
				unit,
			}),
			"",
		].join("\n"),
		"utf-8",
	);
	writeJson(join(runDir, "artifacts.json"), [
		{
			id: `${runId}-spectrum-point-0`,
			uri: spectrumRelativePath,
			label: "Raman spectrum point 0",
			kind: "spectrum",
			producerRunId: runId,
		},
	]);
}

async function waitForRunStatus(cwd: string, runId: string, status: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 5_000;
	let lastState: Record<string, unknown> | undefined;
	while (Date.now() < deadline) {
		const poll = dispatch("poll_run", { runId }, { cwd, commandId: `poll-${Date.now()}` });
		lastState = asRecord(asRecord(poll.stateAfter).runState);
		if (lastState.status === status) return lastState;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`run ${runId} did not reach ${status}; last state ${JSON.stringify(lastState)}`);
}

async function fakeLabspecWorker(bridgeDir: string, requestCount = 1): Promise<void> {
	const deadline = Date.now() + 3_000;
	const requestsDir = join(bridgeDir, "requests");
	const handled = new Set<string>();
	while (Date.now() < deadline) {
		if (existsSync(requestsDir)) {
			const [requestFile] = readdirSync(requestsDir).filter((entry) => entry.endsWith(".ini") && !handled.has(entry));
			if (requestFile) {
				const request = readIniRecord(join(requestsDir, requestFile));
				const outputPath = String(request.output_path);
				mkdirSync(dirname(outputPath), { recursive: true });
				writeFileSync(outputPath, "raman_shift_nm,intensity\n100,10\n200,20\n", "utf-8");
				writeFileSync(
					join(bridgeDir, "results", requestFile),
					[
						`request_id=${String(request.request_id)}`,
						"status=ok",
						`output_path=${outputPath}`,
						"snr_estimate=21",
						"total_intensity=30",
						"saturated=false",
						"",
					].join("\n"),
					"utf-8",
				);
				handled.add(requestFile);
				if (handled.size >= requestCount) return;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`fake LabSpec worker observed ${handled.size}/${requestCount} acquisition request(s)`);
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

function writePgm(path: string, pixels: number[][]): void {
	const height = pixels.length;
	const width = pixels[0]?.length ?? 0;
	const body = pixels.map((row) => row.join(" ")).join("\n");
	writeFileSync(path, `P2\n${width} ${height}\n255\n${body}\n`, "utf-8");
}

function shiftedPattern(width: number, height: number, dx: number, dy: number): number[][] {
	const pixels = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
	for (const [x0, y0, size, value] of [
		[9, 10, 5, 220],
		[21, 6, 3, 160],
	]) {
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const yy = y0 + y + dy;
				const xx = x0 + x + dx;
				if (yy >= 0 && yy < height && xx >= 0 && xx < width) {
					pixels[yy][xx] = value;
				}
			}
		}
	}
	return pixels;
}

test("schema accepts typed Raman acquisition domain", () => {
	const result = validateExperimentSpec(loadSpec("raman-hardware-spec.json"));
	assert.equal(result.valid, true);
});

test("schema rejects Raman acquisition that exceeds max exposure", () => {
	const spec = loadSpec("raman-hardware-spec.json");
	const raman = spec.domain?.raman;
	assert.ok(raman?.acquisition);
	const result = validateExperimentSpec({
		...spec,
		domain: {
			raman: {
				...raman,
				acquisition: {
					...raman.acquisition,
					integrationTimeS: 20,
				},
			},
		},
	});
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.ok(result.issues.some((issue) => issue.path === "domain.raman.acquisition.integrationTimeS"));
	}
});

test("policy accepts minimal Raman hardware resources and rejects a missing acquirer", () => {
	const valid = validatePolicy(loadSpec("raman-hardware-spec.json"), getLabState(), { toolName: "run_experiment" });
	assert.equal(valid.valid, true);

	const spec = loadSpec("raman-hardware-spec.json");
	const missingAcquirer = {
		...spec,
		resources: spec.resources.filter((resource) => resource.id !== "lab-acquirer"),
	};
	const invalid = validatePolicy(missingAcquirer, getLabState(), { toolName: "run_experiment" });
	assert.equal(invalid.valid, false);
	assert.ok(invalid.issues.some((issue) => issue.message.includes("lab-acquirer")));

	const missingWorkstation = {
		...spec,
		resources: spec.resources.filter((resource) => resource.id !== "labspec-workstation"),
	};
	const missingLease = validatePolicy(missingWorkstation, getLabState(), { toolName: "run_experiment" });
	assert.equal(missingLease.valid, false);
	assert.ok(missingLease.issues.some((issue) => issue.message.includes("labspec-workstation")));
});

test("Raman dry-run preflight records a read-only readiness report", () => {
	const cwd = tempCwd();
	try {
		const result = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-preflight" });
		assert.equal(result.status, "success");
		const stateAfter = asRecord(result.stateAfter);
		assert.equal(stateAfter.estimatedRuntimeMinutes, 0.033);
		const liveState = asRecord(stateAfter.liveState);
		const adapters = liveState.adapters;
		assert.equal(Array.isArray(adapters), true);
		assert.equal((adapters as unknown[]).length, 2);
		const readOnlyProbe = asRecord(liveState.readOnlyProbe);
		assert.equal(asRecord(readOnlyProbe.stage).reachable, true);
		assert.equal(asRecord(readOnlyProbe.labspecWorker).reachable, true);
		assert.equal(readOnlyProbe.readOnly, true);
		const records = asRecord(stateAfter.records);
		assert.match(String(records.reportId), /^dry_run-preflight-/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman preflight rejects missing XY calibration artifacts", () => {
	const cwd = tempCwd();
	try {
		const result = dispatch("run_preflight", { spec: focusCorrectionSpec("dry_run") }, { cwd, commandId: "phase7-missing-calibration" });
		assert.equal(result.status, "error");
		assert.equal(result.errorCode, "preflight_failed");
		const issues = asRecord(result.stateAfter).issues as Record<string, unknown>[];
		assert.ok(issues.some((issue) => String(issue.message).includes("Calibration artifact not found")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware and dry-run specs hash identically for the hardware gate", () => {
	assert.equal(hashExperimentSpec(loadSpec("raman-hardware-spec.json")), hashExperimentSpec(loadSpec("raman-dry-run-spec.json")));
});

test("Raman hardware gate rejects hardware-mode preflight reports", () => {
	const cwd = tempCwd();
	try {
		const hardwarePreflight = dispatch("run_preflight", { spec: loadSpec("raman-hardware-spec.json") }, { cwd, commandId: "phase7-hw-preflight" });
		assert.equal(hardwarePreflight.status, "success");
		const reportId = String(asRecord(asRecord(hardwarePreflight.stateAfter).records).reportId);
		const gate = validateHardwareGate(loadSpec("raman-hardware-spec.json"), baseApproval(reportId), cwd);
		assert.equal(gate.valid, false);
		assert.ok(gate.issues.some((issue) => issue.includes("dry_run")));
		assert.ok(gate.issues.some((issue) => issue.includes("read-only probe")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware gate requires laser safety confirmation", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-gate-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);
		const spec = loadSpec("raman-hardware-spec.json");
		const missingSafety = validateHardwareGate(
			spec,
			{ approvalId: "appr-missing-safety", operator: "tester", approved: true, dryRunReportId: reportId },
			cwd,
		);
		assert.equal(missingSafety.valid, false);
		assert.ok(missingSafety.issues.some((issue) => issue.includes("ramanSafety")));

		const tooMuchPower = validateHardwareGate(
			spec,
			{
				...baseApproval(reportId),
				ramanSafety: { ...baseApproval(reportId).ramanSafety, confirmedLaserPowerMw: 2 },
			},
			cwd,
		);
		assert.equal(tooMuchPower.valid, false);
		assert.ok(tooMuchPower.issues.some((issue) => issue.includes("laser power exceeds")));

		const valid = validateHardwareGate(spec, baseApproval(reportId), cwd);
		assert.equal(valid.valid, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment rejects real Raman hardware fake or missing real-capable backends", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-real-backend-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);

		const fakeAcquisition = withSimulatedHardwareDisabled(() =>
			dispatch(
				"run_experiment",
				{
					spec: loadSpec("raman-hardware-spec.json"),
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						stagePort: "COM_TEST",
						raman: { acquisitionBackend: "fake" },
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: baseApproval(reportId),
					},
				},
				{ cwd, commandId: "phase7-real-fake-acquisition" },
			),
		);
		assert.equal(fakeAcquisition.status, "error");
		assert.equal(fakeAcquisition.errorCode, "simulated_hardware_not_allowed");
		const fakeIssues = asRecord(fakeAcquisition.stateAfter).issues as string[];
		assert.ok(fakeIssues.some((issue) => issue.includes("labspec_file_bridge")));

		recordFakeCalibration(cwd);
		const focusDryRun = dispatch("run_preflight", { spec: focusCorrectionSpec("dry_run") }, { cwd, commandId: "phase7-real-focus-preflight" });
		assert.equal(focusDryRun.status, "success");
		const focusReportId = String(asRecord(asRecord(focusDryRun.stateAfter).records).reportId);
		const missingFocusBackends = withSimulatedHardwareDisabled(() =>
			dispatch(
				"run_experiment",
				{
					spec: focusCorrectionSpec("hardware"),
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						stagePort: "COM_TEST",
						raman: { acquisitionBackend: "labspec_file_bridge" },
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: baseApproval(focusReportId),
					},
				},
				{ cwd, commandId: "phase7-real-missing-focus-backends" },
			),
		);
		assert.equal(missingFocusBackends.status, "error");
		assert.equal(missingFocusBackends.errorCode, "simulated_hardware_not_allowed");
		const missingIssues = asRecord(missingFocusBackends.stateAfter).issues as string[];
		assert.ok(missingIssues.some((issue) => issue.includes("autofocusBackend")));
		assert.ok(missingIssues.some((issue) => issue.includes("xyCorrectionBackend")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge client probes and runs a fake acquisition unit", async () => {
	const cwd = tempCwd();
	const events: RamanBridgeEvent[] = [];
	const bridge = new RamanBridgeClient({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
	});
	let shutdown = false;
	try {
		const probe = await bridge.request<Record<string, unknown>>("probe", {
			stage: { adapter: "memory" },
			bridgeDir: cwd,
			outputDir: cwd,
		});
		assert.equal(asRecord(probe.stage).reachable, true);
		assert.equal(probe.outputDirWritable, true);

		const spectrumPath = join(cwd, "point_0.txt");
		const unit = await bridge.request<Record<string, unknown>>("run_unit", {
			stage: { adapter: "memory" },
			point: { index: 0, xUm: 1, yUm: 2, zUm: 3 },
			settleTimeoutMs: 100,
			acquisition: {
				integrationTimeS: 1,
				accumulations: 1,
				fromNm: 100,
				toNm: 3500,
				saveFormat: "txt",
				savePath: spectrumPath,
				artifactId: "point-0-spectrum",
			},
		});
		assert.equal(unit.status, "success");
		assert.deepEqual(asRecord(unit.positionAfter), { xUm: 1, yUm: 2, zUm: 3 });
		assert.equal(asRecord(unit.spectrum).artifactId, "point-0-spectrum");
		assert.equal(existsSync(spectrumPath), true);
		assert.ok(events.some((event) => event.event === "progress" && event.action === "visit_point"));
		assert.ok(events.some((event) => event.event === "progress" && event.action === "acquire_spectrum"));
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge supports LabSpec file-bridge acquisition backend", async () => {
	const cwd = tempCwd();
	const events: RamanBridgeEvent[] = [];
	const bridge = new RamanBridgeClient({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
	});
	let shutdown = false;
	try {
		const bridgeDir = join(cwd, "labspec_bridge");
		const spectrumPath = join(cwd, "labspec_point_0.txt");
		const [result] = await Promise.all([
			bridge.request<Record<string, unknown>>("acquire_spectrum", {
				acquisition: {
					backend: "labspec_file_bridge",
					bridgeDir,
					integrationTimeS: 1,
					accumulations: 1,
					fromNm: 100,
					toNm: 3500,
					saveFormat: "txt",
					savePath: spectrumPath,
					timeoutS: 3,
					pollIntervalS: 0.05,
				},
			}),
			fakeLabspecWorker(bridgeDir),
		]);
		assert.equal(result.outputPath, spectrumPath);
		assert.equal(asRecord(result.metadata).backend, "labspec_file_bridge");
		assert.equal(asRecord(result.metadata).snrEstimate, 21);
		assert.equal(existsSync(spectrumPath), true);
		assert.ok(events.some((event) => event.event === "progress" && event.action === "acquire_spectrum"));
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge active_probe records explicit smoke artifacts", async () => {
	const cwd = tempCwd();
	const bridge = new RamanBridgeClient({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const result = await bridge.request<Record<string, unknown>>("active_probe", {
			outputDir: cwd,
			captureFrame: true,
			acquireSpectrumSmoke: true,
			acquisition: { backend: "fake", saveFormat: "txt" },
		});
		assert.equal(result.readOnly, false);
		assert.equal(result.requiresOperatorApproval, true);
		const artifacts = result.artifacts as Record<string, unknown>[];
		assert.equal(artifacts.length, 2);
		assert.equal(existsSync(join(cwd, "active_probe_frame.pgm")), true);
		assert.equal(existsSync(join(cwd, "active_probe_spectrum.txt")), true);
		assert.deepEqual(result.sideEffects, ["synthetic_frame_written", "spectrum_smoke_acquired"]);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator Raman active probe tool writes an audited maintenance record", async () => {
	const cwd = tempCwd();
	try {
		const rejected = await runRamanActiveProbe(
			{
				approval: { approvalId: "appr-active-probe", operator: "tester", approved: true },
				acquireSpectrumSmoke: true,
			},
			{ cwd, commandId: "phase7-active-probe-rejected" },
		);
		assert.equal(rejected.status, "error");
		assert.equal(rejected.errorCode, "hardware_gate_failed");

		const result = await runRamanActiveProbe(
			{
				approval: {
					approvalId: "appr-active-probe",
					operator: "tester",
					approved: true,
					ramanSafety: {
						laserPowerConfirmed: true,
						confirmedLaserPowerMw: 1,
						labSpecWorkerReady: true,
						windowsPowerPolicyReady: true,
					},
				},
				captureFrame: true,
				acquireSpectrumSmoke: true,
			},
			{ cwd, commandId: "phase7-active-probe" },
		);
		assert.equal(result.status, "success");
		assert.ok(result.artifacts.some((artifact) => artifact.kind === "active-probe"));
		const stateAfter = asRecord(result.stateAfter);
		assert.match(String(stateAfter.probeId), /^raman-active-probe-/);
		assert.equal(String(stateAfter.recordPath).startsWith(cwd), true);
		assert.equal(existsSync(String(stateAfter.recordPath)), true);
		const record = asRecord(JSON.parse(readFileSync(String(stateAfter.recordPath), "utf-8")));
		assert.equal(record.commandId, "phase7-active-probe");
		const probeResult = asRecord(record.result);
		assert.deepEqual(probeResult.sideEffects, ["synthetic_frame_written", "spectrum_smoke_acquired"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator Raman XY calibration tool writes a resolvable artifact", () => {
	const cwd = tempCwd();
	try {
		const rejected = recordRamanXyCalibration(
			{
				approval: { approvalId: "appr-cal", operator: "tester", approved: true },
				calibrationId: "bad-calibration",
				pixelPerUm: [
					[1, 0],
					[1, 0],
				],
				confidence: 0.9,
			},
			{ cwd, commandId: "phase7-bad-calibration" },
		);
		assert.equal(rejected.status, "error");
		assert.equal(rejected.errorCode, "invalid_tool_params");

		recordFakeCalibration(cwd, "phase7-calibration");
		const resolved = resolveRamanXyCalibration(cwd, "phase7-calibration");
		assert.equal(resolved.ok, true);
		if (resolved.ok) {
			assert.deepEqual(resolved.artifact.pixelPerUm, [
				[1, 0],
				[0, 1],
			]);
			assert.equal(existsSync(resolved.path), true);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge records fake autofocus and XY correction metadata", async () => {
	const cwd = tempCwd();
	const bridge = new RamanBridgeClient({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const unit = await bridge.request<Record<string, unknown>>("run_unit", {
			stage: { adapter: "memory" },
			point: { index: 0, xUm: 1, yUm: 2, zUm: 3 },
			settleTimeoutMs: 100,
			autofocus: {
				enabled: true,
				backend: "fake",
				zMinUm: -20,
				zMaxUm: 20,
				minConfidence: 0.2,
			},
			xyCorrection: {
				enabled: true,
				backend: "fake",
				minConfidence: 0.4,
				maxCorrectionUm: 10,
			},
		});
		assert.equal(asRecord(unit.autofocus).confidence, 0.85);
		assert.equal(asRecord(unit.xyCorrection).applied, false);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge supports phase-correlation XY correction backend", async () => {
	const cwd = tempCwd();
	const referencePath = join(cwd, "reference.pgm");
	const currentPath = join(cwd, "current.pgm");
	writePgm(referencePath, shiftedPattern(40, 40, 0, 0));
	writePgm(currentPath, shiftedPattern(40, 40, 2, 1));
	const bridge = new RamanBridgeClient({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const result = await bridge.request<Record<string, unknown>>("xy_correct", {
			xyCorrection: {
				backend: "phase_correlation",
				referenceFramePath: referencePath,
				currentFramePath: currentPath,
				transform: [
					[1, 0],
					[0, 1],
				],
				minConfidence: 0,
				maxCorrectionUm: 10,
				applied: true,
			},
		});
		assert.equal(result.applied, true);
		assert.equal(typeof result.dxUm, "number");
		assert.equal(typeof result.dyUm, "number");
		assert.ok(Math.max(Math.abs(Number(result.dxUm)), Math.abs(Number(result.dyUm))) > 0.5);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge fits XY calibration from frame pairs", async () => {
	const cwd = tempCwd();
	const refX = join(cwd, "reference-x.pgm");
	const curX = join(cwd, "current-x.pgm");
	const refY = join(cwd, "reference-y.pgm");
	const curY = join(cwd, "current-y.pgm");
	writePgm(refX, shiftedPattern(48, 48, 0, 0));
	writePgm(curX, shiftedPattern(48, 48, 4, 0));
	writePgm(refY, shiftedPattern(48, 48, 0, 0));
	writePgm(curY, shiftedPattern(48, 48, 0, 3));
	const bridge = new RamanBridgeClient({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const result = await bridge.request<Record<string, unknown>>("calibrate_xy", {
			minConfidence: 0,
			measurements: [
				{ referenceFramePath: refX, currentFramePath: curX, stageShift: { dxUm: 2, dyUm: 0 } },
				{ referenceFramePath: refY, currentFramePath: curY, stageShift: { dxUm: 0, dyUm: 3 } },
			],
		});
		const matrix = result.pixelPerUm as number[][];
		assert.ok(Math.abs(matrix[0]?.[0] - 2) < 0.25);
		assert.ok(Math.abs(matrix[1]?.[1] - 1) < 0.25);
		assert.equal(result.rank, 2);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman bridge runs automatic XY calibration sequence with fake frames", async () => {
	const cwd = tempCwd();
	const bridge = new RamanBridgeClient({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const result = await bridge.request<Record<string, unknown>>("calibrate_xy_sequence", {
			stage: { adapter: "memory" },
			frameBackend: "fake",
			outputDir: cwd,
			settleTimeoutMs: 100,
			minConfidence: 0,
			fakePixelPerUm: [
				[2, 0],
				[0, 1],
			],
			shifts: [
				{ dxUm: 2, dyUm: 0 },
				{ dxUm: 0, dyUm: 3 },
			],
		});
		const matrix = result.pixelPerUm as number[][];
		assert.ok(Math.abs(matrix[0]?.[0] - 2) < 0.25);
		assert.ok(Math.abs(matrix[1]?.[1] - 1) < 0.25);
		assert.equal(existsSync(join(cwd, "calibration_reference.pgm")), true);
		assert.equal(existsSync(join(cwd, "calibration_current_0.pgm")), true);
		assert.deepEqual(result.sideEffects, ["synthetic_calibration_frames_written"]);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator Raman XY calibration fit tool records fitted artifact", async () => {
	const cwd = tempCwd();
	try {
		const refX = join(cwd, "reference-x.pgm");
		const curX = join(cwd, "current-x.pgm");
		const refY = join(cwd, "reference-y.pgm");
		const curY = join(cwd, "current-y.pgm");
		writePgm(refX, shiftedPattern(48, 48, 0, 0));
		writePgm(curX, shiftedPattern(48, 48, 4, 0));
		writePgm(refY, shiftedPattern(48, 48, 0, 0));
		writePgm(curY, shiftedPattern(48, 48, 0, 3));
		const result = await fitAndRecordRamanXyCalibration(
			{
				approval: { approvalId: "appr-fit-cal", operator: "tester", approved: true },
				calibrationId: "fit-calibration",
				minConfidence: 0,
				measurements: [
					{ referenceFramePath: refX, currentFramePath: curX, stageShift: { dxUm: 2, dyUm: 0 } },
					{ referenceFramePath: refY, currentFramePath: curY, stageShift: { dxUm: 0, dyUm: 3 } },
				],
				sourceNotes: "phase7 fitted calibration",
			},
			{ cwd, commandId: "phase7-fit-calibration" },
		);
		assert.equal(result.status, "success");
		const resolved = resolveRamanXyCalibration(cwd, "fit-calibration");
		assert.equal(resolved.ok, true);
		if (resolved.ok) {
			assert.ok(Math.abs(resolved.artifact.pixelPerUm[0][0] - 2) < 0.25);
			assert.ok(Math.abs(resolved.artifact.pixelPerUm[1][1] - 1) < 0.25);
		}
		const fit = asRecord(asRecord(result.stateAfter).fit);
		assert.equal(fit.rank, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator Raman automatic XY calibration tool records fitted artifact", async () => {
	const cwd = tempCwd();
	try {
		const outputDir = join(cwd, "auto-calibration-frames");
		const result = await autoFitAndRecordRamanXyCalibration(
			{
				approval: { approvalId: "appr-auto-cal", operator: "tester", approved: true },
				calibrationId: "auto-calibration",
				stageAdapter: "memory",
				frameBackend: "fake",
				outputDir,
				settleTimeoutMs: 100,
				minConfidence: 0,
				fakePixelPerUm: [
					[2, 0],
					[0, 1],
				],
				shifts: [
					{ dxUm: 2, dyUm: 0 },
					{ dxUm: 0, dyUm: 3 },
				],
				sourceNotes: "phase7 automatic calibration",
			},
			{ cwd, commandId: "phase7-auto-calibration" },
		);
		assert.equal(result.status, "success");
		assert.ok(result.artifacts.some((artifact) => artifact.kind === "calibration-frame"));
		const resolved = resolveRamanXyCalibration(cwd, "auto-calibration");
		assert.equal(resolved.ok, true);
		if (resolved.ok) {
			assert.ok(Math.abs(resolved.artifact.pixelPerUm[0][0] - 2) < 0.25);
			assert.ok(Math.abs(resolved.artifact.pixelPerUm[1][1] - 1) < 0.25);
		}
		assert.equal(existsSync(join(outputDir, "calibration_reference.pgm")), true);
		const fit = asRecord(asRecord(result.stateAfter).fit);
		assert.deepEqual(fit.sideEffects, ["synthetic_calibration_frames_written"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator Raman hardware validation records readiness evidence", async () => {
	const cwd = tempCwd();
	try {
		const incomplete = recordRamanHardwareValidation(
			{
				validationId: "incomplete-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: "missing-preflight",
					activeProbeRecordPath: "missing-active-probe.json",
					minimumRamanRunId: "missing-run",
				},
				hardwareEvidence: hardwareEvidence("simulated"),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: false,
					cameraStreamValidated: false,
					stageMotionValidated: false,
					windowsPowerPolicyReady: false,
					operatorReviewedArtifacts: false,
				},
			},
			{ cwd, commandId: "phase7-incomplete-validation" },
		);
		assert.equal(incomplete.status, "warning");
		assert.equal(asRecord(incomplete.stateAfter).productionReady, false);

		recordFakeCalibration(cwd, "validation-calibration");
		const dryRun = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-validation-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);
		const activeProbe = await runRamanActiveProbe(
			{
				approval: {
					approvalId: "appr-validation-active",
					operator: "tester",
					approved: true,
					ramanSafety: {
						laserPowerConfirmed: true,
						confirmedLaserPowerMw: 1,
						labSpecWorkerReady: true,
						windowsPowerPolicyReady: true,
					},
				},
				captureFrame: true,
				acquireSpectrumSmoke: true,
			},
			{ cwd, commandId: "phase7-validation-active-probe" },
		);
		assert.equal(activeProbe.status, "success");
		const activeProbeRecordPath = String(asRecord(activeProbe.stateAfter).recordPath);
		const start = dispatch(
			"run_experiment",
			{
				spec: loadSpec("raman-hardware-spec.json"),
				hardwarePilot: {
					stageAdapter: "memory",
					raman: { acquisitionBackend: "fake" },
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd, commandId: "phase7-validation-run" },
		);
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		await waitForRunStatus(cwd, runId, "completed");
		const simulatedValidation = recordRamanHardwareValidation(
			{
				validationId: "simulated-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath,
					minimumRamanRunId: runId,
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-simulated-validation" },
		);
		assert.equal(simulatedValidation.status, "warning");
		const simulatedIssues = asRecord(simulatedValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(simulatedIssues.some((issue) => String(issue.message).includes("synthetic side effects")));
		assert.ok(simulatedIssues.some((issue) => String(issue.message).includes("real MC.Newton stage adapter")));
		assert.ok(simulatedIssues.some((issue) => String(issue.message).includes("fake acquisition backend")));

		const seededActiveProbePath = seedNonFakeActiveProbeRecord(cwd);
		seedNonFakeRamanRun(cwd, "hw-run-active-probe-evidence");
		const frameMissingActiveProbePath = seedNonFakeActiveProbeRecord(cwd, {
			includeFrame: false,
			probeId: "seeded-hardware-probe-missing-frame",
		});
		const missingFrameValidation = recordRamanHardwareValidation(
			{
				validationId: "missing-frame-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: frameMissingActiveProbePath,
					minimumRamanRunId: "hw-run-active-probe-evidence",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-missing-frame-validation" },
		);
		assert.equal(missingFrameValidation.status, "warning");
		const missingFrameIssues = asRecord(missingFrameValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(missingFrameIssues.some((issue) => String(issue.message).includes("LabSpec frame capture")));

		const spectrumMissingActiveProbePath = seedNonFakeActiveProbeRecord(cwd, {
			includeSpectrum: false,
			probeId: "seeded-hardware-probe-missing-spectrum",
		});
		const missingSmokeValidation = recordRamanHardwareValidation(
			{
				validationId: "missing-smoke-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: spectrumMissingActiveProbePath,
					minimumRamanRunId: "hw-run-active-probe-evidence",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-missing-smoke-validation" },
		);
		assert.equal(missingSmokeValidation.status, "warning");
		const missingSmokeIssues = asRecord(missingSmokeValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(missingSmokeIssues.some((issue) => String(issue.message).includes("spectrum smoke acquisition")));

		const nonRamanDryRun = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd, commandId: "phase7-non-raman-preflight" });
		assert.equal(nonRamanDryRun.status, "success");
		const nonRamanReportId = String(asRecord(asRecord(nonRamanDryRun.stateAfter).records).reportId);
		const nonRamanPreflightValidation = recordRamanHardwareValidation(
			{
				validationId: "non-raman-preflight-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: nonRamanReportId,
					activeProbeRecordPath: seededActiveProbePath,
					minimumRamanRunId: "hw-run-active-probe-evidence",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-non-raman-preflight-validation" },
		);
		assert.equal(nonRamanPreflightValidation.status, "warning");
		const nonRamanPreflightIssues = asRecord(nonRamanPreflightValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(nonRamanPreflightIssues.some((issue) => String(issue.message).includes("Raman dry-run report")));

		seedNonFakeRamanRun(cwd, "hw-run-mismatched-spec", {
			spec: {
				...loadSpec("raman-hardware-spec.json"),
				specId: "spec-raman-mismatched-validation",
			},
		});
		const mismatchedSpecValidation = recordRamanHardwareValidation(
			{
				validationId: "mismatched-spec-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: seededActiveProbePath,
					minimumRamanRunId: "hw-run-mismatched-spec",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-mismatched-spec-validation" },
		);
		assert.equal(mismatchedSpecValidation.status, "warning");
		const mismatchedSpecIssues = asRecord(mismatchedSpecValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(mismatchedSpecIssues.some((issue) => String(issue.message).includes("same ExperimentSpec hash")));

		seedNonFakeRamanRun(cwd, "hw-run-missing-spectrum-metadata", { includeSpectrumMetadata: false });
		const missingSpectrumMetadataValidation = recordRamanHardwareValidation(
			{
				validationId: "missing-spectrum-metadata-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: seededActiveProbePath,
					minimumRamanRunId: "hw-run-missing-spectrum-metadata",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-missing-spectrum-metadata-validation" },
		);
		assert.equal(missingSpectrumMetadataValidation.status, "warning");
		const missingSpectrumIssues = asRecord(missingSpectrumMetadataValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(missingSpectrumIssues.some((issue) => String(issue.message).includes("LabSpec file-bridge spectrum metadata")));

		seedNonFakeRamanRun(cwd, "hw-run-missing-spectrum-artifact", { includeSpectrumArtifact: false });
		const missingSpectrumArtifactValidation = recordRamanHardwareValidation(
			{
				validationId: "missing-spectrum-artifact-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: seededActiveProbePath,
					minimumRamanRunId: "hw-run-missing-spectrum-artifact",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-missing-spectrum-artifact-validation" },
		);
		assert.equal(missingSpectrumArtifactValidation.status, "warning");
		const missingSpectrumArtifactIssues = asRecord(missingSpectrumArtifactValidation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(missingSpectrumArtifactIssues.some((issue) => String(issue.message).includes("spectrum artifact not found")));

		seedNonFakeRamanRun(cwd, "hw-run-seeded-hardware");
		const validation = recordRamanHardwareValidation(
			{
				validationId: "complete-validation",
				approval: { approvalId: "appr-validation", operator: "tester", approved: true },
				evidence: {
					readOnlyPreflightReportId: reportId,
					activeProbeRecordPath: seededActiveProbePath,
					minimumRamanRunId: "hw-run-seeded-hardware",
					xyCalibrationId: "validation-calibration",
				},
				hardwareEvidence: hardwareEvidence(),
				checklist: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					labSpecWorkerValidated: true,
					cameraStreamValidated: true,
					stageMotionValidated: true,
					windowsPowerPolicyReady: true,
					operatorReviewedArtifacts: true,
				},
			},
			{ cwd, commandId: "phase7-complete-validation" },
		);
		assert.equal(validation.status, "success");
		const stateAfter = asRecord(validation.stateAfter);
		assert.equal(stateAfter.productionReady, true);
		assert.equal(existsSync(String(stateAfter.path)), true);
		const record = asRecord(JSON.parse(readFileSync(String(stateAfter.path), "utf-8")));
		assert.equal(record.productionReady, true);
		assert.equal(asRecord(record.hardwareEvidence).evidenceMode, "hardware");
		const evidenceDigest = asRecord(record.evidenceDigest);
		const specHash = asRecord(evidenceDigest.specHash);
		assert.equal(specHash.preflight, hashExperimentSpec(loadSpec("raman-dry-run-spec.json")));
		assert.equal(specHash.minimumRun, hashExperimentSpec(loadSpec("raman-hardware-spec.json")));
		const evidenceFiles = evidenceDigest.files as Record<string, unknown>[];
		for (const role of [
			"read-only-preflight",
			"active-probe",
			"minimum-run-spec",
			"minimum-run-summary",
			"minimum-run-events",
			"active-probe-frame",
			"active-probe-spectrum",
			"minimum-run-hw-run-seeded-hardware-spectrum-point-0",
			"xy-calibration",
		]) {
			const digest = evidenceFiles.find((entry) => entry.role === role);
			assert.ok(digest, `missing digest for ${role}`);
			assert.match(String(digest.sha256), /^[a-f0-9]{64}$/);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("analysis aggregates Raman spectrum, focus, and correction metadata", () => {
	const analysis = analyzeRecordedRun({
		runId: "hw-run-raman-analysis",
		summary: {
			runId: "hw-run-raman-analysis",
			experimentId: "exp-raman-001",
			status: "completed",
			unitCount: 1,
			completedUnits: 1,
			stopConditionMet: false,
		},
		spec: loadSpec("raman-hardware-spec.json"),
		events: [
			{
				type: "unit_completed",
				sequence: 1,
				unit: {
					index: 0,
					status: "success",
					autofocus: { zBestUm: 0, finalScore: 1.2, confidence: 0.8 },
					xyCorrection: { dxUm: 3, dyUm: 4, confidence: 0.9, applied: true },
					spectrumMetadata: { snrEstimate: 12, saturated: false },
				},
			},
		],
		artifacts: [{ uri: ".pi/experiment-runs/runs/hw-run-raman-analysis/artifacts/spectra/point_0.txt", label: "Spectrum" }],
	});
	assert.equal(analysis.qualityMetrics.meanFocusConfidence, 0.8);
	assert.equal(analysis.qualityMetrics.meanSnrEstimate, 12);
	assert.equal(analysis.qualityMetrics.saturatedSpectra, 0);
	assert.equal(analysis.qualityMetrics.meanXyCorrectionUm, 5);
});

test("run_experiment starts a Raman hardware run and poll_run observes completion", async () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-raman-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);

		const start = dispatch(
			"run_experiment",
			{
				spec: loadSpec("raman-hardware-spec.json"),
				hardwarePilot: {
					stageAdapter: "memory",
					raman: { acquisitionBackend: "fake" },
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd, commandId: "phase7-raman-run" },
		);
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		assert.match(runId, /^hw-run-/);
		assert.equal(asRecord(asRecord(start.stateAfter).runState).status, "running");

		const completed = await waitForRunStatus(cwd, runId, "completed");
		assert.equal(asRecord(completed.progress).completedUnits, 2);

		const summary = asRecord(JSON.parse(readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "summary.json"), "utf-8")));
		assert.equal(summary.status, "completed");
		assert.equal(existsSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "artifacts", "spectra", "point_0.txt")), true);

		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "phase7-raman-analysis" });
		assert.equal(analysis.status, "success");
		const qualityMetrics = asRecord(asRecord(asRecord(analysis.stateAfter).analysis).qualityMetrics);
		assert.equal(qualityMetrics.meanSnrEstimate, 12);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware run archives LabSpec request and result files", async () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("raman-dry-run-spec.json") }, { cwd, commandId: "phase7-labspec-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);
		const bridgeDir = join(cwd, "external_labspec_bridge");
		const start = dispatch(
			"run_experiment",
			{
				spec: loadSpec("raman-hardware-spec.json"),
				hardwarePilot: {
					stageAdapter: "memory",
					raman: {
						acquisitionBackend: "labspec_file_bridge",
						labspecBridgeDir: bridgeDir,
						labspecTimeoutS: 3,
						labspecPollIntervalS: 0.05,
					},
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd, commandId: "phase7-labspec-run" },
		);
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		await fakeLabspecWorker(bridgeDir, 2);
		await waitForRunStatus(cwd, runId, "completed");

		const artifacts = JSON.parse(readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "artifacts.json"), "utf-8")) as Record<
			string,
			unknown
		>[];
		const requestArtifact = artifacts.find((artifact) => artifact.kind === "labspec-request");
		const resultArtifact = artifacts.find((artifact) => artifact.kind === "labspec-result");
		assert.ok(requestArtifact);
		assert.ok(resultArtifact);
		assert.equal(String(requestArtifact.uri).includes("\\"), false);
		assert.equal(String(resultArtifact.uri).includes("\\"), false);
		assert.equal(existsSync(join(cwd, String(requestArtifact.uri))), true);
		assert.equal(existsSync(join(cwd, String(resultArtifact.uri))), true);
		const events = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "events.jsonl"), "utf-8");
		assert.match(events, /"archiveRequestPath"/);
		assert.match(events, /"archiveResultPath"/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware run propagates autofocus and XY correction through analysis", async () => {
	const cwd = tempCwd();
	try {
		recordFakeCalibration(cwd);
		const dryRun = dispatch("run_preflight", { spec: focusCorrectionSpec("dry_run") }, { cwd, commandId: "phase7-focus-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);
		const start = dispatch(
			"run_experiment",
			{
				spec: focusCorrectionSpec("hardware"),
				hardwarePilot: {
					stageAdapter: "memory",
					raman: { acquisitionBackend: "fake" },
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd, commandId: "phase7-focus-run" },
		);
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		await waitForRunStatus(cwd, runId, "completed");
		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "phase7-focus-analysis" });
		assert.equal(analysis.status, "success");
		const qualityMetrics = asRecord(asRecord(asRecord(analysis.stateAfter).analysis).qualityMetrics);
		assert.equal(qualityMetrics.meanFocusConfidence, 0.85);
		assert.equal(qualityMetrics.meanXyCorrectionUm, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware run can use phase-correlation XY payloads", async () => {
	const cwd = tempCwd();
	try {
		recordFakeCalibration(cwd);
		const referencePath = join(cwd, "reference.pgm");
		const currentPath = join(cwd, "current.pgm");
		writePgm(referencePath, shiftedPattern(40, 40, 0, 0));
		writePgm(currentPath, shiftedPattern(40, 40, 2, 1));
		const dryRun = dispatch("run_preflight", { spec: focusCorrectionSpec("dry_run") }, { cwd, commandId: "phase7-xy-preflight" });
		assert.equal(dryRun.status, "success");
		const reportId = String(asRecord(asRecord(dryRun.stateAfter).records).reportId);
		const start = dispatch(
			"run_experiment",
			{
				spec: focusCorrectionSpec("hardware"),
				hardwarePilot: {
					stageAdapter: "memory",
					raman: {
						acquisitionBackend: "fake",
						xyCorrectionBackend: "phase_correlation",
						xyReferenceFramePath: referencePath,
						xyCurrentFramePath: currentPath,
						xyApplyCorrection: false,
					},
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd, commandId: "phase7-xy-run" },
		);
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		await waitForRunStatus(cwd, runId, "completed");
		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "phase7-xy-analysis" });
		assert.equal(analysis.status, "success");
		const qualityMetrics = asRecord(asRecord(asRecord(analysis.stateAfter).analysis).qualityMetrics);
		assert.ok(Number(qualityMetrics.meanXyCorrectionUm) > 0.5);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
