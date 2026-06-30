import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	HardwareBridgeV2Client,
	HardwareBridgeV2ProtocolError,
	HardwareBridgeV2RequestError,
	type HardwareBridgeV2Event,
} from "../kernel/hw/bridge-v2.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIniRecord(text: string): Record<string, string> {
	const record: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		const separator = trimmed.indexOf("=");
		if (!trimmed || trimmed.startsWith("#") || separator < 0) continue;
		record[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
	}
	return record;
}

async function fakeLabspecWorker(bridgeDir: string): Promise<{ requestId: string; outputPath: string }> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 2_000;
	const handled = new Set<string>();
	while (Date.now() < deadline) {
		let entries: string[] = [];
		try {
			entries = await readdir(requestsDir);
		} catch {
			await delay(20);
			continue;
		}
		const requestFile = entries.find((entry) => entry.endsWith(".ini") && !handled.has(entry));
		if (!requestFile) {
			await delay(20);
			continue;
		}
		const request = readIniRecord(await readFile(join(requestsDir, requestFile), "utf-8"));
		const requestId = request.request_id;
		assert.ok(requestId);
		const outputPath = request.output_path;
		assert.ok(outputPath);
		await mkdir(resultsDir, { recursive: true });
		await writeFile(outputPath, "raman_shift_nm,intensity\n100,10\n200,20\n", "utf-8");
		await writeFile(
			join(resultsDir, requestFile),
			[
				`request_id=${requestId}`,
				"status=ok",
				`output_path=${outputPath}`,
				"snr_estimate=22",
				"total_intensity=30",
				"saturated=false",
				"",
			].join("\n"),
			"utf-8",
		);
		handled.add(requestFile);
		return { requestId, outputPath };
	}
	assert.fail("fake LabSpec worker did not observe a V2 acquisition request");
}

async function fakeLabspecVideoWorker(bridgeDir: string): Promise<{ requestId: string; outputPath: string }> {
	const requestsDir = join(bridgeDir, "requests");
	const resultsDir = join(bridgeDir, "results");
	const deadline = Date.now() + 2_000;
	const handled = new Set<string>();
	while (Date.now() < deadline) {
		let entries: string[] = [];
		try {
			entries = await readdir(requestsDir);
		} catch {
			await delay(20);
			continue;
		}
		const requestFile = entries.find((entry) => entry.endsWith(".ini") && !handled.has(entry));
		if (!requestFile) {
			await delay(20);
			continue;
		}
		const request = readIniRecord(await readFile(join(requestsDir, requestFile), "utf-8"));
		const requestId = request.request_id;
		assert.ok(requestId);
		await mkdir(resultsDir, { recursive: true });
		if (request.action === "start_video") {
			await writeFile(join(resultsDir, requestFile), [`request_id=${requestId}`, "status=ok", ""].join("\n"), "utf-8");
			handled.add(requestFile);
			continue;
		}
		if (request.action === "capture_frame") {
			const outputPath = request.output_path;
			assert.ok(outputPath);
			await writeFile(outputPath, "P2\n3 3\n255\n0 10 0\n20 200 20\n0 10 0\n", "utf-8");
			await writeFile(
				join(resultsDir, requestFile),
				[`request_id=${requestId}`, "status=ok", `frame_path=${outputPath}`, ""].join("\n"),
				"utf-8",
			);
			handled.add(requestFile);
			return { requestId, outputPath };
		}
		handled.add(requestFile);
	}
	assert.fail("fake LabSpec video worker did not observe a capture_frame request");
}

test("hardware bridge v2 lists contracts, keeps diagnostics on stderr, and round-trips fake requests", async () => {
	const events: HardwareBridgeV2Event[] = [];
	const stderr: string[] = [];
	const bridge = new HardwareBridgeV2Client({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
		onStderr: (chunk) => stderr.push(chunk),
	});
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		assert.ok(
			contracts.some(
				(contract) =>
					contract.domain === "fake" &&
					contract.action === "echo" &&
					contract.sideEffectLevel === "read" &&
					contract.safeToRetry === true &&
					contract.cancelBehavior === "none" &&
					contract.emitsProgress === false,
			),
		);

		const echoed = await bridge.request<Record<string, unknown>>("fake", "echo", { hello: "world" });
		assert.deepEqual(asRecord(echoed.payload), { hello: "world" });

		await bridge.request("fake", "emit_progress", { message: "checkpoint" });
		assert.ok(
			events.some(
				(event) =>
					event.event === "progress" &&
					event.domain === "fake" &&
					event.action === "emit_progress" &&
					event.message === "checkpoint",
			),
		);
		assert.match(stderr.join(""), /hardware_bridge_v2 ready/);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 returns standard request errors for unknown actions", async () => {
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		await assert.rejects(
			() => bridge.request("missing", "nope", {}),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "unknown_action");
				assert.deepEqual(error.detail, { domain: "missing", action: "nope" });
				return true;
			},
		);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 maps protocol damage to bridge_crashed", async () => {
	const bridge = new HardwareBridgeV2Client({
		cwd: process.cwd(),
		bridgePath: join(FIXTURES, "bad-hardware-bridge-v2.py"),
		requestTimeoutMs: 1_000,
	});
	try {
		await assert.rejects(
			() => bridge.request("fake", "echo", {}),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2ProtocolError);
				assert.equal(error.code, "bridge_crashed");
				assert.match(error.message, /non-JSON stdout|process is closed|exited/);
				return true;
			},
		);
	} finally {
		bridge.close();
	}
});

test("hardware bridge v2 exposes no-hardware Raman algorithm primitives", async () => {
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		assert.ok(contracts.some((contract) => contract.domain === "focus_metric" && contract.action === "calc_score"));
		assert.ok(contracts.some((contract) => contract.domain === "drift_correction" && contract.action === "phase_correlation"));
		assert.ok(contracts.some((contract) => contract.domain === "calibration" && contract.action === "fit_matrix"));

		const focus = await bridge.request<Record<string, unknown>>("focus_metric", "calc_score", {
			metric: "tenengrad",
			image: [
				[0, 0, 0, 0],
				[0, 10, 10, 0],
				[0, 10, 10, 0],
				[0, 0, 0, 0],
			],
		});
		assert.equal(focus.metric, "tenengrad");
		assert.equal(typeof focus.score, "number");
		assert.ok((focus.score as number) > 0);

		const reference = [
			[0, 0, 0, 0, 0],
			[0, 9, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
		];
		const current = [
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 9, 0, 0],
			[0, 0, 0, 0, 0],
			[0, 0, 0, 0, 0],
		];
		const shift = await bridge.request<Record<string, unknown>>("drift_correction", "phase_correlation", {
			reference,
			current,
			maxShiftPx: 2,
		});
		// FFT phase correlation returns sub-pixel shift; exact value varies with the
		// numpy version, so assert against an integer pixel target within tolerance.
		const pixelShift = asRecord(shift.pixelShift);
		assert.ok(Math.abs(Number(pixelShift.dx) - 1) < 0.05, `dx ~= 1, got ${pixelShift.dx}`);
		assert.ok(Math.abs(Number(pixelShift.dy) - 1) < 0.05, `dy ~= 1, got ${pixelShift.dy}`);
		assert.equal(typeof shift.confidence, "number");

		const fit = await bridge.request<Record<string, unknown>>("calibration", "fit_matrix", {
			measurements: [
				{ stageShift: { dxUm: 10, dyUm: 0 }, pixelShift: { dx: 20, dy: 0 } },
				{ stageShift: { dxUm: 0, dyUm: 10 }, pixelShift: { dx: 0, dy: 30 } },
			],
		});
		assert.deepEqual(fit.pixelPerUm, [
			[2, 0],
			[0, 3],
		]);
		assert.equal(fit.residualRmsPx, 0);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 returns structured algorithm dependency errors without traceback text", async () => {
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		await assert.rejects(
			() => bridge.request("focus_metric", "calc_score", { imagePath: "/definitely/missing/image.png" }),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.ok(error.code === "algorithm_dependency_unavailable" || error.code === "invalid_request");
				assert.doesNotMatch(error.message, /Traceback/i);
				return true;
			},
		);
		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 stage primitives move, settle, report position, and stop memory stage", async () => {
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		const moveContract = contracts.find((contract) => contract.domain === "stage" && contract.action === "move_absolute");
		assert.ok(moveContract);
		assert.equal(moveContract.sideEffectLevel, "motion");
		assert.deepEqual(moveContract.resourcesTouched, ["stage_session", "stage_motion"]);
		assert.equal(moveContract.cancelBehavior, "best_effort");

		const connected = await bridge.request<Record<string, unknown>>("stage", "connect", {
			adapter: "memory",
			initialPosition: { xUm: 1, yUm: 2, zUm: 3 },
		});
		assert.deepEqual(asRecord(asRecord(connected.stage).position), { xUm: 1, yUm: 2, zUm: 3 });

		const moved = await bridge.request<Record<string, unknown>>("stage", "move_absolute", { xUm: 4, yUm: 5, zUm: 6 });
		assert.deepEqual(asRecord(moved.before), { xUm: 1, yUm: 2, zUm: 3 });
		assert.deepEqual(asRecord(moved.position), { xUm: 4, yUm: 5, zUm: 6 });

		const settled = await bridge.request<Record<string, unknown>>("stage", "wait_settled", { timeoutMs: 100 });
		assert.equal(settled.settled, true);
		assert.deepEqual(asRecord(settled.position), { xUm: 4, yUm: 5, zUm: 6 });

		const position = await bridge.request<Record<string, unknown>>("stage", "get_position");
		assert.deepEqual(asRecord(position.position), { xUm: 4, yUm: 5, zUm: 6 });

		const stopped = await bridge.request<Record<string, unknown>>("stage", "stop");
		assert.equal(stopped.stopped, true);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 camera primitive captures fake frames for TS orchestration", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "hardware-bridge-v2-camera-"));
	const events: HardwareBridgeV2Event[] = [];
	const bridge = new HardwareBridgeV2Client({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
	});
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		const captureContract = contracts.find((contract) => contract.domain === "camera" && contract.action === "capture_frame");
		assert.ok(captureContract);
		assert.equal(captureContract.sideEffectLevel, "read");
		assert.deepEqual(captureContract.resourcesTouched, ["camera_session"]);
		assert.equal(captureContract.emitsProgress, true);

		await bridge.request("stage", "connect", { adapter: "memory", initialPosition: { xUm: 1, yUm: 2, zUm: 3 } });
		const framePath = join(tempDir, "frame.pgm");
		const frame = await bridge.request<Record<string, unknown>>("camera", "capture_frame", {
			backend: "fake",
			fakeFocusZUm: 3,
			savePath: framePath,
		});
		assert.equal(frame.backend, "fake");
		assert.equal(frame.outputPath, framePath);
		assert.equal(frame.width, 8);
		assert.equal(frame.height, 8);
		assert.ok(Array.isArray(frame.image));
		assert.match(await readFile(framePath, "utf-8"), /^P2\r?\n8 8\r?\n255\r?\n/);
		assert.ok(events.some((event) => event.domain === "camera" && event.action === "capture_frame"));

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("hardware bridge v2 camera primitive captures LabSpec file-bridge frames", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "hardware-bridge-v2-camera-labspec-"));
	const bridgeDir = join(tempDir, "frame-bridge");
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		await bridge.request("stage", "connect", { adapter: "memory" });
		const worker = fakeLabspecVideoWorker(bridgeDir);
		const savePath = join(await realpath(tempDir), "frames", "capture.pgm");
		const captured = await bridge.request<Record<string, unknown>>("camera", "capture_frame", {
			backend: "labspec_file_bridge",
			bridgeDir,
			timeoutMs: 2_000,
			imageFormat: "pgm",
			savePath,
		});
		const workerResult = await worker;
		assert.equal(captured.backend, "labspec_file_bridge");
		assert.equal(captured.outputPath, savePath);
		assert.equal(captured.width, 3);
		assert.equal(captured.height, 3);
		assert.deepEqual(captured.image, [
			[0, 10, 0],
			[20, 200, 20],
			[0, 10, 0],
		]);
		assert.equal(workerResult.outputPath.endsWith(".pgm"), true);
		assert.match(await readFile(savePath, "utf-8"), /P2/);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("hardware bridge v2 thermal primitive waits for fake heating stage stability", async () => {
	const events: HardwareBridgeV2Event[] = [];
	const bridge = new HardwareBridgeV2Client({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
	});
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		const waitContract = contracts.find((contract) => contract.domain === "thermal" && contract.action === "wait_stable");
		assert.ok(waitContract);
		assert.equal(waitContract.sideEffectLevel, "environment");
		assert.deepEqual(waitContract.resourcesTouched, ["thermal_session", "thermal_heating"]);
		assert.equal(waitContract.emitsProgress, true);

		const target = await bridge.request<Record<string, unknown>>("thermal", "set_target_temp", {
			targetTemperatureC: 42,
			toleranceC: 0.2,
			simulateDurationMs: 50,
		});
		assert.equal(target.targetTemperatureC, 42);
		assert.equal(target.stable, false);

		const stable = await bridge.request<Record<string, unknown>>("thermal", "wait_stable", { timeoutS: 1, pollIntervalS: 0.02 });
		assert.equal(stable.stable, true);
		assert.equal(stable.targetTemperatureC, 42);
		assert.equal(stable.currentTemperatureC, 42);

		const current = await bridge.request<Record<string, unknown>>("thermal", "get_current_temp");
		assert.equal(current.stable, true);
		assert.equal(current.targetTemperatureC, 42);
		assert.ok(events.some((event) => event.domain === "thermal" && event.action === "wait_stable"));

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 rejects concurrent stage motion and allows stop to interrupt", async () => {
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		await bridge.request("stage", "connect", { adapter: "memory" });
		const moving = bridge.request<Record<string, unknown>>(
			"stage",
			"move_absolute",
			{ xUm: 10, simulateDurationMs: 500 },
			2_000,
		);

		await assert.rejects(
			() => bridge.request("stage", "move_absolute", { xUm: 20 }, 1_000),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "resource_busy");
				const detail = asRecord(error.detail);
				assert.deepEqual(detail.resources, ["stage_session", "stage_motion"]);
				return true;
			},
		);

		const stopped = await bridge.request<Record<string, unknown>>("stage", "stop", {}, 1_000);
		assert.equal(stopped.stopped, true);

		await assert.rejects(
			() => moving,
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "aborted");
				return true;
			},
		);

		const position = await bridge.request<Record<string, unknown>>("stage", "get_position");
		assert.deepEqual(asRecord(position.position), { xUm: 10, yUm: 0, zUm: 0 });

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
	}
});

test("hardware bridge v2 spectrometer lifecycle reports progress, writes artifacts, and keeps legacy compatibility", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "hardware-bridge-v2-spectrum-"));
	const events: HardwareBridgeV2Event[] = [];
	const bridge = new HardwareBridgeV2Client({
		cwd: process.cwd(),
		requestTimeoutMs: 5_000,
		onEvent: (event) => events.push(event),
	});
	let shutdown = false;
	try {
		const contracts = await bridge.listActions();
		const beginContract = contracts.find((contract) => contract.domain === "spectrometer" && contract.action === "begin_acquisition");
		assert.ok(beginContract);
		assert.equal(beginContract.sideEffectLevel, "acquisition");
		assert.deepEqual(beginContract.resourcesTouched, ["spectrometer_session", "spectrometer_acquisition"]);
		assert.equal(beginContract.cancelBehavior, "best_effort");
		assert.ok(contracts.some((contract) => contract.domain === "spectrometer" && contract.action === "acquire_point"));

		const savePath = join(tempDir, "spectrum.txt");
		const begun = await bridge.request<Record<string, unknown>>("spectrometer", "begin_acquisition", {
			backend: "fake",
			integrationTimeS: 0.01,
			accumulations: 2,
			simulateDurationMs: 80,
			savePath,
		});
		assert.equal(begun.status, "running");
		assert.equal(typeof begun.acquisitionId, "string");
		const acquisitionId = String(begun.acquisitionId);

		await assert.rejects(
			() => bridge.request("spectrometer", "begin_acquisition", { backend: "fake", simulateDurationMs: 1 }),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "resource_busy");
				return true;
			},
		);

		await assert.rejects(
			() => bridge.request("spectrometer", "collect_result", { acquisitionId }),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "acquisition_not_ready");
				return true;
			},
		);

		let poll: Record<string, unknown> = {};
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await delay(20);
			poll = await bridge.request<Record<string, unknown>>("spectrometer", "poll_acquisition", { acquisitionId });
			if (poll.status === "completed") break;
		}
		assert.equal(poll.status, "completed");
		assert.equal(poll.progress, 1);

		const collected = await bridge.request<Record<string, unknown>>("spectrometer", "collect_result", { acquisitionId });
		assert.equal(collected.status, "collected");
		assert.equal(collected.outputPath, savePath);
		assert.deepEqual(asRecord(collected.artifact), { kind: "spectrum", path: savePath, format: "txt" });
		const spectrumText = await readFile(savePath, "utf-8");
		assert.match(spectrumText, /fake Raman spectrum generated by hardware_bridge_v2\.py/);

		const legacyPath = join(tempDir, "legacy-spectrum.txt");
		const legacy = await bridge.request<Record<string, unknown>>("spectrometer", "acquire_point", {
			backend: "fake",
			time: 0.01,
			accums: 1,
			simulateDurationMs: 0,
			savePath: legacyPath,
		});
		assert.equal(legacy.status, "collected");
		assert.equal(legacy.outputPath, legacyPath);
		assert.match(await readFile(legacyPath, "utf-8"), /raman_shift_nm,intensity/);

		assert.ok(events.some((event) => event.domain === "spectrometer" && event.action === "begin_acquisition"));
		assert.ok(events.some((event) => event.domain === "spectrometer" && event.action === "poll_acquisition"));

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("hardware bridge v2 spectrometer lifecycle supports LabSpec file-bridge requests", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "hardware-bridge-v2-labspec-"));
	const bridgeDir = join(tempDir, "labspec-bridge");
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const savePath = join(await realpath(tempDir), "spectra", "point-0.txt");
		const begun = await bridge.request<Record<string, unknown>>("spectrometer", "begin_acquisition", {
			backend: "labspec_file_bridge",
			bridgeDir,
			integrationTimeS: 0.01,
			accumulations: 1,
			fromNm: 100,
			toNm: 200,
			timeoutS: 2,
			pollIntervalS: 0.02,
			savePath,
		});
		assert.equal(begun.status, "running");
		assert.equal(begun.backend, "labspec_file_bridge");
		const acquisitionId = String(begun.acquisitionId);
		const fileBridge = asRecord(begun.fileBridge);
		assert.equal(fileBridge.requestId, acquisitionId);
		assert.match(String(fileBridge.requestPath), /[/\\]requests[/\\]acq_\d+\.ini$/);
		assert.match(String(fileBridge.resultPath), /[/\\]results[/\\]acq_\d+\.ini$/);

		const worker = await fakeLabspecWorker(bridgeDir);
		assert.equal(worker.requestId, acquisitionId);
		assert.equal(worker.outputPath, savePath);

		let poll: Record<string, unknown> = {};
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await delay(20);
			poll = await bridge.request<Record<string, unknown>>("spectrometer", "poll_acquisition", { acquisitionId });
			if (poll.status === "completed") break;
		}
		assert.equal(poll.status, "completed");
		assert.equal(poll.backend, "labspec_file_bridge");

		const collected = await bridge.request<Record<string, unknown>>("spectrometer", "collect_result", { acquisitionId });
		assert.equal(collected.status, "collected");
		assert.equal(collected.outputPath, savePath);
		assert.deepEqual(asRecord(collected.artifact), { kind: "spectrum", path: savePath, format: "txt" });
		const metadata = asRecord(collected.metadata);
		assert.equal(metadata.backend, "labspec_file_bridge");
		assert.equal(metadata.snrEstimate, 22);
		assert.equal(metadata.totalIntensity, 30);
		assert.equal(metadata.saturated, false);
		assert.match(await readFile(savePath, "utf-8"), /raman_shift_nm,intensity/);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		await rm(tempDir, { recursive: true, force: true });
	}
});

test("hardware bridge v2 spectrometer cancel releases acquisition and prevents collection", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "hardware-bridge-v2-cancel-"));
	const bridge = new HardwareBridgeV2Client({ cwd: process.cwd(), requestTimeoutMs: 5_000 });
	let shutdown = false;
	try {
		const begun = await bridge.request<Record<string, unknown>>("spectrometer", "begin_acquisition", {
			backend: "fake",
			integrationTimeS: 1,
			simulateDurationMs: 500,
			savePath: join(tempDir, "cancelled.txt"),
		});
		const acquisitionId = String(begun.acquisitionId);
		const cancelled = await bridge.request<Record<string, unknown>>("spectrometer", "cancel_acquisition", { acquisitionId });
		assert.equal(cancelled.cancelled, true);
		assert.equal(cancelled.status, "cancelled");

		const poll = await bridge.request<Record<string, unknown>>("spectrometer", "poll_acquisition", { acquisitionId });
		assert.equal(poll.status, "cancelled");

		await assert.rejects(
			() => bridge.request("spectrometer", "collect_result", { acquisitionId }),
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "acquisition_cancelled");
				return true;
			},
		);

		const next = await bridge.request<Record<string, unknown>>("spectrometer", "begin_acquisition", {
			backend: "fake",
			simulateDurationMs: 0,
			savePath: join(tempDir, "next.txt"),
		});
		assert.equal(next.status, "completed");
		const collected = await bridge.request<Record<string, unknown>>("spectrometer", "collect_result", {
			acquisitionId: String(next.acquisitionId),
		});
		assert.equal(collected.status, "collected");

		const legacyRunning = bridge.request<Record<string, unknown>>(
			"spectrometer",
			"acquire_point",
			{
				backend: "fake",
				simulateDurationMs: 500,
				pollIntervalS: 0.02,
				savePath: join(tempDir, "legacy-cancelled.txt"),
			},
			2_000,
		);
		await delay(50);
		const legacyCancelled = await bridge.request<Record<string, unknown>>("spectrometer", "cancel_acquisition");
		assert.equal(legacyCancelled.cancelled, true);
		await assert.rejects(
			() => legacyRunning,
			(error: unknown) => {
				assert.ok(error instanceof HardwareBridgeV2RequestError);
				assert.equal(error.code, "aborted");
				return true;
			},
		);

		await bridge.shutdown();
		shutdown = true;
	} finally {
		if (!shutdown) bridge.close();
		await rm(tempDir, { recursive: true, force: true });
	}
});
