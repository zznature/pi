import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "./dispatch.ts";
import type { ExperimentSpec, ToolResult } from "./schemas.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-phase6-"));
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function runStateOf(result: ToolResult): Record<string, unknown> {
	return asRecord(asRecord(result.stateAfter).runState);
}

function progressOf(result: ToolResult): Record<string, unknown> {
	return asRecord(runStateOf(result).progress);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

test("start_run starts without executing and advance_run drives the run to completion", () => {
	const cwd = tempCwd();
	try {
		const start = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6-start" });
		assert.equal(start.status, "success");
		const runId = start.runId ?? "";
		assert.match(runId, /^sim-run-/);

		const poll0 = dispatch("poll_run", { runId }, { cwd, commandId: "p6-poll0" });
		assert.equal(runStateOf(poll0).status, "running");
		assert.equal(progressOf(poll0).completedUnits, 0);
		assert.equal(progressOf(poll0).totalUnits, 9);

		const advance1 = dispatch("advance_run", { runId, maxUnits: 3 }, { cwd, commandId: "p6-adv1" });
		assert.equal(advance1.status, "success");
		assert.equal(runStateOf(advance1).status, "running");
		assert.equal(progressOf(advance1).completedUnits, 3);

		const advance2 = dispatch("advance_run", { runId }, { cwd, commandId: "p6-adv2" });
		assert.equal(advance2.status, "success");
		assert.equal(runStateOf(advance2).status, "completed");
		assert.equal(progressOf(advance2).completedUnits, 9);

		const analysis = dispatch("analyze_run", { runId }, { cwd, commandId: "p6-analyze" });
		assert.equal(analysis.status, "success");
		const qualityMetrics = asRecord(asRecord(asRecord(analysis.stateAfter).analysis).qualityMetrics);
		assert.equal(qualityMetrics.completedUnits, 9);
		assert.equal(qualityMetrics.completionRate, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator pause stops advance_run at the next unit boundary and the run resumes", () => {
	const cwd = tempCwd();
	try {
		const start = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6r-start" });
		const runId = start.runId ?? "";

		dispatch("advance_run", { runId, maxUnits: 2 }, { cwd, commandId: "p6r-adv1" });
		dispatch("pause_run", { runId, reason: "operator hold for review" }, { cwd, commandId: "p6r-pause" });

		const paused = dispatch("advance_run", { runId }, { cwd, commandId: "p6r-adv2" });
		assert.equal(paused.status, "warning");
		assert.equal(paused.stopConditionMet, true);
		assert.equal(runStateOf(paused).status, "paused");
		assert.equal(progressOf(paused).completedUnits, 2);

		const snapshot = asRecord(readJson(join(cwd, ".pi", "experiment-runs", "runs", runId, "resume.snapshot.json")));
		assert.equal(snapshot.status, "paused");
		assert.equal(snapshot.safeToResume, true);
		assert.equal(snapshot.resumeFrom, "2");

		const resumed = dispatch("advance_run", { runId }, { cwd, commandId: "p6r-resume" });
		assert.equal(resumed.status, "success");
		assert.equal(runStateOf(resumed).status, "completed");
		assert.equal(progressOf(resumed).completedUnits, 9);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("abort_run clears a paused lifecycle run so a new run can start", () => {
	const cwd = tempCwd();
	try {
		const start = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6a-start" });
		const runId = start.runId ?? "";
		dispatch("advance_run", { runId, maxUnits: 1 }, { cwd, commandId: "p6a-adv1" });
		dispatch("pause_run", { runId, reason: "operator hold" }, { cwd, commandId: "p6a-pause" });
		const paused = dispatch("advance_run", { runId }, { cwd, commandId: "p6a-adv2" });
		assert.equal(runStateOf(paused).status, "paused");

		const abort = dispatch("abort_run", { runId, reason: "operator abort" }, { cwd, commandId: "p6a-abort" });
		assert.equal(abort.status, "success");

		const start2 = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6a-start2" });
		assert.equal(start2.status, "success");
		assert.notEqual(start2.runId, runId);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("advance_run on a completed run is rejected as not advanceable", () => {
	const cwd = tempCwd();
	try {
		const start = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6c-start" });
		const runId = start.runId ?? "";
		dispatch("advance_run", { runId }, { cwd, commandId: "p6c-adv" });

		const again = dispatch("advance_run", { runId }, { cwd, commandId: "p6c-adv-again" });
		assert.equal(again.status, "error");
		assert.equal(again.errorCode, "run_not_advanceable");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("start_run rejects a non-simulation spec and refuses a second concurrent run", () => {
	const cwd = tempCwd();
	try {
		const hardware = dispatch("start_run", { spec: loadSpec("hardware-spec.json") }, { cwd, commandId: "p6m-hw" });
		assert.equal(hardware.status, "error");
		assert.equal(hardware.errorCode, "lifecycle_mode_not_supported");

		const startA = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6m-a" });
		assert.equal(startA.status, "success");
		const startB = dispatch("start_run", { spec: loadSpec("valid-spec.json") }, { cwd, commandId: "p6m-b" });
		assert.equal(startB.status, "error");
		assert.equal(startB.errorCode, "policy_rejected");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
