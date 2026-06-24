import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { recordRamanXyCalibration } from "../kernel/raman/calibration.ts";
import { subscribeRamanHardwareRunTerminal, type RamanHardwareRunTerminalEvent } from "../kernel/raman/run.ts";
import { hashExperimentSpec } from "../records.ts";
import type { ExperimentSpec, HardwareExecutionParams } from "../schemas.ts";

process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = "1";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-v2-hardware-"));
}

function ramanV2Spec(mode: "dry_run" | "hardware"): ExperimentSpec {
	const spec = loadSpec(mode === "dry_run" ? "raman/base/dry-run-spec.json" : "raman/base/hardware-spec.json");
	return {
		...spec,
		mode,
		resources: [
			...spec.resources,
			{ id: "lab-camera", kind: "instrument", role: "camera" },
			{ id: "thermal-heating-stage", kind: "instrument", role: "sample_heating" },
		],
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
					transformArtifactId: "v2-calibration",
					minConfidence: 0,
					maxCorrectionUm: 10,
				},
			},
		},
	};
}

function baseApproval(dryRunReportId: string): HardwareExecutionParams["approval"] {
	return {
		approvalId: "appr-raman-v2-hardware",
		operator: "tester",
		approved: true,
		dryRunReportId,
		bootstrapV2ValidationRun: false,
		ramanSafety: {
			laserPowerConfirmed: true,
			confirmedLaserPowerMw: 1,
			labSpecWorkerReady: true,
			windowsPowerPolicyReady: true,
		},
	};
}

function seedPassingDryRunReport(cwd: string, spec: ExperimentSpec): string {
	const reportId = "v2-seeded-dry-run";
	const reportDir = join(cwd, ".pi", "experiment-runs", "preflights", reportId);
	mkdirSync(reportDir, { recursive: true });
	const specHash = hashExperimentSpec(spec);
	writeFileSync(
		join(reportDir, "preflight.json"),
		`${JSON.stringify(
			{
				reportId,
				spec,
				specHash,
				capabilitySnapshotId: `${reportId}-capabilities`,
				result: {
					valid: true,
					mode: "dry_run",
					issues: [],
					unitCount: 2,
					specHash,
					capabilitySnapshotId: `${reportId}-capabilities`,
					liveState: {
						readOnlyProbe: {
							readOnly: true,
							stage: { reachable: true, adapter: "memory" },
							labspecWorker: { reachable: true, latencyMs: 0 },
						},
					},
				},
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	return reportId;
}

function waitForTerminal(cwd: string, getRunId: () => string | undefined): Promise<RamanHardwareRunTerminalEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("Timed out waiting for Raman hardware terminal event"));
		}, 5_000);
		const unsubscribe = subscribeRamanHardwareRunTerminal((event) => {
			const runId = getRunId();
			if (event.cwd !== cwd || (runId && event.runId !== runId)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(event);
		});
	});
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
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

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fakeLabspecVideoWorker(bridgeDir: string, captureCount: number): Promise<void> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 5_000;
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

async function fakeLabspecSpectrumWorker(bridgeDir: string, requestCount: number): Promise<void> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 5_000;
	const handled = new Set<string>();
	let handledCount = 0;
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
				"snr_estimate=26",
				"total_intensity=33",
				"saturated=false",
				"",
			].join("\n"),
			"utf-8",
		);
		handled.add(requestFile);
		handledCount += 1;
		if (handledCount >= requestCount) return;
	}
	assert.fail(`fake LabSpec spectrum worker observed ${handledCount}/${requestCount} acquisition request(s)`);
}

test("run_experiment can execute a Raman hardware run through the V2 TS orchestrator", async () => {
	const cwd = tempCwd();
	try {
		const hardwareSpec = ramanV2Spec("hardware");
		if (hardwareSpec.domain?.raman?.autofocus) {
			hardwareSpec.domain.raman.autofocus = { ...hardwareSpec.domain.raman.autofocus, minConfidence: 0 };
		}
		const dryRunSpec = ramanV2Spec("dry_run");
		if (dryRunSpec.domain?.raman?.autofocus) {
			dryRunSpec.domain.raman.autofocus = { ...dryRunSpec.domain.raman.autofocus, minConfidence: 0 };
		}
		const calibration = recordRamanXyCalibration(
			{
				approval: { approvalId: "appr-v2-calibration", operator: "tester", approved: true },
				calibrationId: "v2-calibration",
				pixelPerUm: [
					[1, 0],
					[0, 1],
				],
				confidence: 0.9,
			},
			{ cwd, commandId: "record-v2-calibration" },
		);
		assert.equal(calibration.status, "success");
		const reportId = seedPassingDryRunReport(cwd, dryRunSpec);
		let runId: string | undefined;
		const result = dispatch(
			"run_experiment",
			{
				spec: hardwareSpec,
				hardwareExecution: {
					stageAdapter: "memory",
					settleTimeoutMs: 1,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
					raman: {
						workflowBackend: "v2_bridge",
						acquisitionBackend: "fake",
						xyTransform: [
							[1, 0],
							[0, 1],
						],
					},
					thermal: {
						backend: "fake",
						simulateDurationMs: 0,
					},
				},
			},
			{ cwd, commandId: "raman-v2-run" },
		);
		assert.equal(result.status, "success", JSON.stringify({ errorCode: result.errorCode, summary: result.summary, stateAfter: result.stateAfter }));
		runId = result.runId ?? "";
		const terminal = waitForTerminal(cwd, () => runId);
		const event = await terminal;
		assert.equal(event.runId, runId);
		assert.equal(event.status, "completed");

		const poll = dispatch("poll_run", { runId }, { cwd, commandId: "raman-v2-poll" });
		assert.equal(poll.status, "success");
		const runState = asRecord(asRecord(poll.stateAfter).runState);
		assert.equal(runState.status, "completed");
		assert.equal(runState.microstep, "unit_completed");
		assert.equal(runState.nextUnitIndex, 2);
		assert.ok(Array.isArray(runState.artifactRefs));

		const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
		const events = readFileSync(join(runDir, "events.jsonl"), "utf-8");
		assert.match(events, /"workflowBackend":"v2_bridge"/);
		assert.match(events, /"domain":"thermal"/);
		assert.match(events, /"thermal"/);
		assert.match(events, /"autofocus"/);
		assert.match(events, /"xyCorrection"/);
		const snapshot = JSON.parse(readFileSync(join(runDir, "resume.snapshot.json"), "utf-8")) as Record<string, unknown>;
		assert.equal(snapshot.microstep, "unit_completed");
		assert.equal(snapshot.safeToResume, false);
		const artifacts = JSON.parse(readFileSync(join(runDir, "artifacts.json"), "utf-8")) as Array<Record<string, unknown>>;
		assert.ok(artifacts.some((artifact) => artifact.kind === "frame"));
		assert.ok(artifacts.some((artifact) => artifact.kind === "spectrum"));

		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "raman-v2-analysis" });
		assert.equal(analysis.status, "success");
		const analysisState = asRecord(analysis.stateAfter);
		const analyzed = asRecord(analysisState.analysis);
		const metrics = asRecord(analyzed.qualityMetrics);
		assert.equal(metrics.completedUnits, 2);
		assert.ok(Number(metrics.meanFocusScore) > 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment can route V2 autofocus frames and spectra through LabSpec file bridges", async () => {
	const cwd = tempCwd();
	try {
		const hardwareSpec = ramanV2Spec("hardware");
		if (hardwareSpec.domain?.raman?.autofocus) {
			hardwareSpec.domain.raman.autofocus = { ...hardwareSpec.domain.raman.autofocus, minConfidence: 0 };
		}
		const dryRunSpec = ramanV2Spec("dry_run");
		if (dryRunSpec.domain?.raman?.autofocus) {
			dryRunSpec.domain.raman.autofocus = { ...dryRunSpec.domain.raman.autofocus, minConfidence: 0 };
		}
		const calibration = recordRamanXyCalibration(
			{
				approval: { approvalId: "appr-v2-calibration-bridge", operator: "tester", approved: true },
				calibrationId: "v2-calibration",
				pixelPerUm: [
					[1, 0],
					[0, 1],
				],
				confidence: 0.9,
			},
			{ cwd, commandId: "record-v2-calibration-bridge" },
		);
		assert.equal(calibration.status, "success");
		const reportId = seedPassingDryRunReport(cwd, dryRunSpec);
		const frameBridgeDir = join(cwd, "frame-bridge");
		const labspecBridgeDir = join(cwd, "labspec-bridge");
		const frameWorker = fakeLabspecVideoWorker(frameBridgeDir, 12);
		const spectrumWorker = fakeLabspecSpectrumWorker(labspecBridgeDir, 2);
		let runId: string | undefined;
		const result = dispatch(
			"run_experiment",
			{
				spec: hardwareSpec,
				hardwareExecution: {
					stageAdapter: "memory",
					settleTimeoutMs: 1,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
					raman: {
						workflowBackend: "v2_bridge",
						autofocusBackend: "labspec_file_bridge",
						frameBridgeDir,
						acquisitionBackend: "labspec_file_bridge",
						labspecBridgeDir,
						labspecTimeoutS: 2,
						labspecPollIntervalS: 0.02,
						xyTransform: [
							[1, 0],
							[0, 1],
						],
					},
					thermal: {
						backend: "fake",
						simulateDurationMs: 0,
					},
				},
			},
			{ cwd, commandId: "raman-v2-run-bridges" },
		);
		assert.equal(result.status, "success", JSON.stringify({ errorCode: result.errorCode, summary: result.summary, stateAfter: result.stateAfter }));
		runId = result.runId ?? "";
		const terminal = waitForTerminal(cwd, () => runId);
		await Promise.all([frameWorker, spectrumWorker]);
		const event = await terminal;
		assert.equal(event.runId, runId);
		assert.equal(event.status, "completed");

		const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
		const events = readFileSync(join(runDir, "events.jsonl"), "utf-8");
		assert.match(events, /"workflowBackend":"v2_bridge"/);
		assert.match(events, /"backend":"labspec_file_bridge"/);
		assert.match(events, /capture_frame/);
		assert.match(events, /begin_acquisition/);
		const artifacts = JSON.parse(readFileSync(join(runDir, "artifacts.json"), "utf-8")) as Array<Record<string, unknown>>;
		assert.ok(artifacts.some((artifact) => artifact.kind === "frame"));
		assert.ok(artifacts.some((artifact) => artifact.kind === "spectrum"));

		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "raman-v2-analysis-bridges" });
		assert.equal(analysis.status, "success");
		const analyzed = asRecord(asRecord(analysis.stateAfter).analysis);
		const metrics = asRecord(analyzed.qualityMetrics);
		assert.equal(metrics.completedUnits, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
