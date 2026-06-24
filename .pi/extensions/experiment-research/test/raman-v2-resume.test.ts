import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadCapabilities } from "../capabilities.ts";
import { pollRun } from "../kernel/run.ts";
import {
	reconcileRamanV2Hardware,
	writeRamanV2MicrostepSnapshot,
	type RamanV2HardwareReconcileProbe,
} from "../kernel/raman/v2-resume.ts";
import { readResumeSnapshot, relativeArtifact, reserveRun } from "../run-store.ts";
import type { ExperimentSpec, ToolResult } from "../schemas.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-v2-resume-"));
}

function artifactRef(runId: string, fileName: string): ToolResult["artifacts"][number] {
	return {
		id: `${runId}-spectrum-point-0`,
		uri: relativeArtifact(runId, fileName),
		label: "Raman spectrum point 0",
		kind: "spectrum",
		producerRunId: runId,
	};
}

function reserveRamanRun(cwd: string): { spec: ExperimentSpec; runId: string } {
	const spec = loadSpec("raman/base/hardware-spec.json");
	const reserved = reserveRun(cwd, spec, "raman-v2-resume-reserve", loadCapabilities("hardware"));
	return { spec, runId: reserved.record.runId };
}

test("raman v2 microstep snapshot keeps poll_run compatible while exposing recovery fields", () => {
	const cwd = tempCwd();
	try {
		const { spec, runId } = reserveRamanRun(cwd);
		const spectrum = artifactRef(runId, "artifacts/spectra/point_0.txt");
		writeRamanV2MicrostepSnapshot(cwd, {
			spec,
			runId,
			status: "running",
			completedUnits: 0,
			unitIndex: 0,
			nextUnitIndex: 0,
			microstep: "acquisition_started",
			commandId: "v2-0003",
			lastKnownStagePosition: { xUm: 1, yUm: 2, zUm: 3 },
			pendingAcquisitionId: "acq-001",
			artifactRefs: [spectrum],
			nextPlan: ["poll spectrometer acquisition", "collect spectrum artifact"],
			safeToResume: true,
		});

		const snapshot = readResumeSnapshot(cwd, runId);
		assert.equal(snapshot?.unitIndex, 0);
		assert.equal(snapshot?.microstep, "acquisition_started");
		assert.equal(snapshot?.commandId, "v2-0003");
		assert.deepEqual(snapshot?.lastKnownStagePosition, { xUm: 1, yUm: 2, zUm: 3 });
		assert.equal(snapshot?.pendingAcquisitionId, "acq-001");
		assert.deepEqual(snapshot?.artifactRefs, [spectrum]);
		assert.equal(snapshot?.safeToResume, true);

		const state = pollRun(cwd, runId);
		assert.equal(state.progress.completedUnits, 0);
		assert.equal(state.nextUnitIndex, 0);
		assert.equal(state.microstep, "acquisition_started");
		assert.equal(state.pendingAcquisitionId, "acq-001");
		assert.deepEqual(state.artifactRefs, [spectrum]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("raman v2 reconcile resumes only when stage, acquisition, and artifacts match the snapshot", async () => {
	const cwd = tempCwd();
	try {
		const { spec, runId } = reserveRamanRun(cwd);
		const spectrumPath = "artifacts/spectra/point_0.txt";
		const spectrum = artifactRef(runId, spectrumPath);
		const absoluteSpectrumPath = join(cwd, spectrum.uri);
		mkdirSync(dirname(absoluteSpectrumPath), { recursive: true });
		writeFileSync(absoluteSpectrumPath, "raman_shift_nm,intensity\n100,10\n", "utf-8");
		writeRamanV2MicrostepSnapshot(cwd, {
			spec,
			runId,
			status: "running",
			completedUnits: 0,
			unitIndex: 0,
			microstep: "acquisition_started",
			commandId: "v2-0004",
			lastKnownStagePosition: { xUm: 10, yUm: 20, zUm: 0 },
			pendingAcquisitionId: "acq-running",
			artifactRefs: [spectrum],
			safeToResume: true,
		});
		const probe: RamanV2HardwareReconcileProbe = {
			getStagePosition: () => ({ xUm: 10.1, yUm: 20, zUm: 0 }),
			pollAcquisition: () => ({ status: "running", progress: 0.5 }),
			stagePositionToleranceUm: 0.5,
		};

		const decision = await reconcileRamanV2Hardware(cwd, runId, probe);
		assert.equal(decision.decision, "resume");
		assert.equal(decision.safeToResume, true);
		assert.equal(decision.reason, "snapshot and hardware state reconciled");
		const snapshot = readResumeSnapshot(cwd, runId);
		assert.equal(snapshot?.hardwareReconcile?.decision, "resume");
		assert.equal(snapshot?.safeToResume, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("raman v2 reconcile pauses on physical mismatch and aborts cancelled acquisitions", async () => {
	const cwd = tempCwd();
	try {
		const { spec, runId } = reserveRamanRun(cwd);
		writeRamanV2MicrostepSnapshot(cwd, {
			spec,
			runId,
			status: "running",
			completedUnits: 0,
			unitIndex: 0,
			microstep: "stage_position_confirmed",
			commandId: "v2-0005",
			lastKnownStagePosition: { xUm: 0, yUm: 0, zUm: 0 },
			safeToResume: true,
		});
		const mismatch = await reconcileRamanV2Hardware(cwd, runId, {
			getStagePosition: () => ({ xUm: 5, yUm: 0, zUm: 0 }),
			stagePositionToleranceUm: 0.5,
		});
		assert.equal(mismatch.decision, "pause");
		assert.equal(mismatch.safeToResume, false);
		assert.match(mismatch.reason, /stage position/);

		writeRamanV2MicrostepSnapshot(cwd, {
			spec,
			runId,
			status: "running",
			completedUnits: 0,
			unitIndex: 0,
			microstep: "acquisition_started",
			commandId: "v2-0006",
			pendingAcquisitionId: "acq-cancelled",
			safeToResume: true,
		});
		const cancelled = await reconcileRamanV2Hardware(cwd, runId, {
			pollAcquisition: () => ({ status: "cancelled" }),
		});
		assert.equal(cancelled.decision, "abort");
		assert.equal(cancelled.safeToResume, false);
		assert.match(cancelled.reason, /cancelled/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
