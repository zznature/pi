import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { appendOperatorIntent } from "../records.ts";
import type { ExperimentSpec, HardwarePilotParams } from "../schemas.ts";
import { evaluateWatchdog } from "../watchdog.ts";

process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = "1";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-phase5-"));
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function baseApproval(dryRunReportId: string): HardwarePilotParams["approval"] {
	return { approvalId: "appr-phase5", operator: "tester", approved: true, dryRunReportId };
}

test("analyze_run writes deterministic Phase 5 quality analysis", () => {
	const cwd = tempCwd();
	try {
		const run = dispatch("run_experiment", { spec: loadSpec("sim/spec.json") }, { cwd, commandId: "phase5-run" });
		assert.equal(run.status, "success");
		const runId = run.runId ?? "";

		const analysisResult = dispatch("analyze_run", { runId }, { cwd, commandId: "phase5-analyze" });
		assert.equal(analysisResult.status, "success");
		assert.equal(analysisResult.stopConditionMet, false);
		const stateAfter = asRecord(analysisResult.stateAfter);
		const analysis = asRecord(stateAfter.analysis);
		const qualityMetrics = asRecord(analysis.qualityMetrics);
		assert.equal(qualityMetrics.unitCount, 9);
		assert.equal(qualityMetrics.completedUnits, 9);
		assert.equal(qualityMetrics.completionRate, 1);
		assert.equal(qualityMetrics.meanSignal, 107);
		assert.equal(Array.isArray(analysis.stoppingRules), true);
		assert.equal(existsSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "analysis.json")), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("plan_next_experiment records decision audit and links follow-up run to its parent", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("sim/spec.json");
		const run = dispatch("run_experiment", { spec }, { cwd, commandId: "phase5-parent-run" });
		const parentRunId = run.runId ?? "";
		dispatch("analyze_run", { runId: parentRunId }, { cwd, commandId: "phase5-parent-analysis" });

		const next = dispatch(
			"plan_next_experiment",
			{ runId: parentRunId, objective: "Refine the calibration wafer region with bounded units" },
			{ cwd, commandId: "phase5-plan-next" },
		);
		assert.equal(next.status, "success");
		const nextState = asRecord(next.stateAfter);
		assert.equal(nextState.strategy, "refine_region");
		assert.equal(existsSync(String(nextState.lineagePath)), true);
		assert.equal(existsSync(String(nextState.decisionsPath)), true);
		const compilerInput = asRecord(nextState.compilerInput);
		const followUpSpec = {
			...spec,
			specId: String(compilerInput.suggestedSpecId),
			objective: "Refine the calibration wafer region with bounded units",
		};
		const followUp = dispatch("run_experiment", { spec: followUpSpec }, { cwd, commandId: "phase5-follow-up-run" });
		const followUpRunId = followUp.runId ?? "";
		const runRecord = asRecord(readJson(join(cwd, ".pi", "experiment-runs", "runs", followUpRunId, "run.json")));
		assert.equal(runRecord.parentRunId, parentRunId);

		const experimentState = dispatch(
			"plan_next_experiment",
			{ runId: followUpRunId, objective: "Continue only if history supports it" },
			{ cwd, commandId: "phase5-second-plan" },
		);
		const secondPlan = asRecord(experimentState.stateAfter);
		const history = asRecord(secondPlan.history);
		assert.equal(history.lineageDepth, 1);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("watchdog rule library requests operator for quality and pauses on budget", () => {
	const qualityDecision = evaluateWatchdog({
		nowMs: 1_000,
		lastHeartbeatMs: 1_000,
		heartbeatTimeoutMs: 15_000,
		consecutiveErrors: 0,
		maxConsecutiveErrors: 3,
		qualityMetrics: [{ name: "signal", value: 70, baseline: 100, minRatio: 0.8 }],
	});
	assert.equal(qualityDecision.intent, "request_operator");

	const budgetDecision = evaluateWatchdog({
		nowMs: 1_000,
		lastHeartbeatMs: 1_000,
		heartbeatTimeoutMs: 15_000,
		consecutiveErrors: 0,
		maxConsecutiveErrors: 3,
		budgetGuard: { completedUnits: 10, maxUnits: 10 },
	});
	assert.equal(budgetDecision.intent, "pause");
});

test("hardware request_operator writes a resume snapshot at the next safe unit boundary", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("hw/dry-run-spec.json") }, { cwd });
		const dryRunState = asRecord(dryRun.stateAfter);
		const dryRunRecords = asRecord(dryRunState.records);
		const reportId = String(dryRunRecords.reportId);
		const intents = appendOperatorIntent("phase5-operator-intent", "request_operator", "operator review before motion", cwd);
		const result = dispatch(
			"run_experiment",
			{
				spec: loadSpec("hw/spec.json"),
				hardwarePilot: {
					stageAdapter: "memory",
					settleTimeoutMs: 1_000,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					intentsPath: intents.intentsPath,
					approval: baseApproval(reportId),
				},
			},
			{ cwd },
		);
		assert.equal(result.status, "warning");
		const runId = result.runId ?? "";
		const snapshot = asRecord(readJson(join(cwd, ".pi", "experiment-runs", "runs", runId, "resume.snapshot.json")));
		assert.equal(snapshot.status, "paused");
		assert.equal(snapshot.resumeFrom, "0");
		assert.equal(snapshot.safeToResume, true);
		assert.equal(snapshot.requiresOperatorApproval, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
