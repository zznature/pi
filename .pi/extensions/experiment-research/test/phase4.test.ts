import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { runHardwarePilotKernel } from "../kernel/hardware-pilot.ts";
import { MemoryStageAdapter } from "../kernel/stage-adapter.ts";
import { getLabState } from "../lab-state.ts";
import { validatePolicy } from "../policy.ts";
import { appendOperatorIntent, hashExperimentSpec, validateHardwareGate } from "../records.ts";
import type { ExperimentSpec, HardwarePilotParams } from "../schemas.ts";
import { evaluateWatchdog } from "../watchdog.ts";

process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = "1";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-phase4-"));
}

function baseApproval(dryRunReportId: string): HardwarePilotParams["approval"] {
	return { approvalId: "appr-1", operator: "tester", approved: true, dryRunReportId };
}

// PLACEHOLDER_TESTS

test("watchdog aborts on heartbeat timeout", () => {
	const decision = evaluateWatchdog({
		nowMs: 20_000,
		lastHeartbeatMs: 0,
		heartbeatTimeoutMs: 15_000,
		consecutiveErrors: 0,
		maxConsecutiveErrors: 3,
	});
	assert.equal(decision.intent, "abort");
	assert.match(decision.reason ?? "", /heartbeat/);
});

test("watchdog aborts on consecutive errors", () => {
	const decision = evaluateWatchdog({
		nowMs: 1_000,
		lastHeartbeatMs: 1_000,
		heartbeatTimeoutMs: 15_000,
		consecutiveErrors: 3,
		maxConsecutiveErrors: 3,
	});
	assert.equal(decision.intent, "abort");
});

test("watchdog returns none when healthy", () => {
	const decision = evaluateWatchdog({
		nowMs: 1_000,
		lastHeartbeatMs: 1_000,
		heartbeatTimeoutMs: 15_000,
		consecutiveErrors: 0,
		maxConsecutiveErrors: 3,
	});
	assert.equal(decision.intent, "none");
});

test("watchdog reads operator abort intent from file and overrides health", () => {
	const cwd = tempCwd();
	try {
		const ref = appendOperatorIntent("hw-run-test", "abort", "operator stop", cwd);
		const decision = evaluateWatchdog({
			nowMs: 1_000,
			lastHeartbeatMs: 1_000,
			heartbeatTimeoutMs: 15_000,
			consecutiveErrors: 0,
			maxConsecutiveErrors: 3,
			intentsPath: ref.intentsPath,
		});
		assert.equal(decision.intent, "abort");
		assert.match(decision.reason ?? "", /operator stop/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("policy rejects hardware spec without operator approval flag", () => {
	const spec = { ...loadSpec("hardware-spec.json"), operatorApprovalRequired: false };
	const result = validatePolicy(spec, getLabState(), { toolName: "run_experiment" });
	assert.equal(result.valid, false);
	assert.ok(result.issues.some((issue) => issue.path === "operatorApprovalRequired"));
});

test("policy allows hardware preflight without operator approval flag", () => {
	const spec = { ...loadSpec("hardware-spec.json"), operatorApprovalRequired: false };
	const result = validatePolicy(spec, getLabState(), { toolName: "run_preflight" });
	assert.equal(result.valid, true);
});

test("policy rejects hardware spec with extra instruments", () => {
	const spec = {
		...loadSpec("hardware-spec.json"),
		resources: [
			{ id: "mc-newton-xyz-stage", kind: "instrument" as const, role: "stage" },
			{ id: "lab-camera", kind: "instrument" as const, role: "camera" },
		],
	};
	const result = validatePolicy(spec, getLabState(), { toolName: "run_experiment" });
	assert.equal(result.valid, false);
	assert.ok(result.issues.some((issue) => issue.path === "resources"));
});

test("policy rejects hardware spec exceeding the 4-point pilot cap", () => {
	const spec = loadSpec("hardware-spec.json");
	const overPoints = spec.plan.kind === "points" ? [...spec.plan.points, { xUm: 20, yUm: 20, zUm: 0 }] : [];
	const result = validatePolicy({ ...spec, plan: { kind: "points", points: overPoints } }, getLabState(), {
		toolName: "run_experiment",
	});
	assert.equal(result.valid, false);
	assert.ok(result.issues.some((issue) => issue.path === "plan.points"));
});

test("policy accepts the canonical hardware pilot spec", () => {
	const result = validatePolicy(loadSpec("hardware-spec.json"), getLabState(), { toolName: "run_experiment" });
	assert.equal(result.valid, true);
});

test("hardware gate fails without a matching dry-run report", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("hardware-spec.json");
		const gate = validateHardwareGate(spec, baseApproval("missing-report"), cwd);
		assert.equal(gate.valid, false);
		assert.ok(gate.issues.some((issue) => issue.includes("not found")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware gate passes after a matching dry-run preflight", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd });
		assert.equal(dryRun.status, "success");
		const reportId = (dryRun.stateAfter as { records: { reportId: string } }).records.reportId;
		const gate = validateHardwareGate(loadSpec("hardware-spec.json"), baseApproval(reportId), cwd);
		assert.equal(gate.valid, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware gate rejects hardware-mode preflight reports", () => {
	const cwd = tempCwd();
	try {
		const hardwarePreflight = dispatch("run_preflight", { spec: loadSpec("hardware-spec.json") }, { cwd, commandId: "hardware-mode-preflight" });
		assert.equal(hardwarePreflight.status, "success");
		const reportId = (hardwarePreflight.stateAfter as { records: { reportId: string } }).records.reportId;
		const gate = validateHardwareGate(loadSpec("hardware-spec.json"), baseApproval(reportId), cwd);
		assert.equal(gate.valid, false);
		assert.ok(gate.issues.some((issue) => issue.includes("dry_run")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_preflight accepts hardware spec without operator approval flag", () => {
	const cwd = tempCwd();
	try {
		const spec = { ...loadSpec("hardware-spec.json"), operatorApprovalRequired: false };
		const result = dispatch("run_preflight", { spec }, { cwd, commandId: "hardware-readonly-preflight" });
		assert.equal(result.status, "success");
		assert.equal((result.stateAfter as { mode: string }).mode, "hardware");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("dry-run preflight records use non-overwriting ids and portable artifact URIs", () => {
	const cwd = tempCwd();
	try {
		const first = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd, commandId: "preflight-one" });
		const second = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd, commandId: "preflight-two" });
		assert.equal(first.status, "success");
		assert.equal(second.status, "success");
		const firstRecords = (first.stateAfter as { records: { reportId: string } }).records;
		const secondRecords = (second.stateAfter as { records: { reportId: string } }).records;
		assert.notEqual(firstRecords.reportId, secondRecords.reportId);
		assert.match(firstRecords.reportId, /^dry_run-preflight-\d{8}T\d{9}Z-[a-f0-9]{8}$/);
		for (const artifact of first.artifacts) {
			assert.equal(artifact.uri.includes("\\"), false);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware gate rejects an unapproved operator", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd });
		const reportId = (dryRun.stateAfter as { records: { reportId: string } }).records.reportId;
		const approval = { ...baseApproval(reportId), approved: false };
		const gate = validateHardwareGate(loadSpec("hardware-spec.json"), approval, cwd);
		assert.equal(gate.valid, false);
		assert.ok(gate.issues.some((issue) => issue.includes("not approved")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware kernel completes all points with the memory adapter", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("hardware-spec.json");
		const stage = new MemoryStageAdapter();
		const pilot: HardwarePilotParams = {
			stageAdapter: "memory",
			settleTimeoutMs: 1_000,
			heartbeatTimeoutMs: 60_000,
			maxConsecutiveErrors: 2,
			approval: baseApproval("ignored"),
		};
		const run = runHardwarePilotKernel(spec, {
			runId: "hw-run-mem",
			stage,
			pilot,
			eventsPath: join(cwd, "events.jsonl"),
			nowMs: () => 1_000,
		});
		assert.equal(run.summary.status, "completed");
		assert.equal(run.summary.completedUnits, 4);
		assert.equal(run.summary.stopConditionMet, false);
		assert.deepEqual(run.points.at(-1)?.positionAfter, { xUm: 0, yUm: 10, zUm: 0 });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware kernel aborts when a pre-existing abort intent is present", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("hardware-spec.json");
		const intentsRef = appendOperatorIntent("hw-run-abort", "abort", "pre-run abort", cwd);
		const stage = new MemoryStageAdapter();
		const pilot: HardwarePilotParams = {
			stageAdapter: "memory",
			settleTimeoutMs: 1_000,
			heartbeatTimeoutMs: 60_000,
			maxConsecutiveErrors: 2,
			intentsPath: intentsRef.intentsPath,
			approval: baseApproval("ignored"),
		};
		const run = runHardwarePilotKernel(spec, {
			runId: "hw-run-abort",
			stage,
			pilot,
			eventsPath: join(cwd, "events.jsonl"),
			nowMs: () => 1_000,
		});
		assert.equal(run.summary.status, "aborted");
		assert.equal(run.summary.completedUnits, 0);
		assert.equal(stage.stopped, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware kernel resumes from a completed point index", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("hardware-spec.json");
		const stage = new MemoryStageAdapter();
		const pilot: HardwarePilotParams = {
			stageAdapter: "memory",
			settleTimeoutMs: 1_000,
			heartbeatTimeoutMs: 60_000,
			maxConsecutiveErrors: 2,
			approval: baseApproval("ignored"),
		};
		const run = runHardwarePilotKernel(spec, {
			runId: "hw-run-resume",
			stage,
			pilot,
			eventsPath: join(cwd, "events.jsonl"),
			startPointIndex: 2,
			nowMs: () => 1_000,
		});
		assert.equal(run.points.filter((point) => point.status === "skipped").length, 2);
		assert.equal(run.points.filter((point) => point.status === "success").length, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("operator intent dispatch records an abort intent for a run", () => {
	const cwd = tempCwd();
	try {
		const result = dispatch("abort_run", { runId: "hw-run-op", reason: "manual abort" }, { cwd });
		assert.equal(result.status, "success");
		const written = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", "hw-run-op", "intents.jsonl"), "utf-8");
		assert.match(written, /"intent":"abort"/);
		assert.match(written, /manual abort/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment in hardware mode requires the hardware gate", () => {
	const cwd = tempCwd();
	try {
		const result = dispatch(
			"run_experiment",
			{
				spec: loadSpec("hardware-spec.json"),
				hardwarePilot: {
					stageAdapter: "memory",
					settleTimeoutMs: 1_000,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval("missing-report"),
				},
			},
			{ cwd },
		);
		assert.equal(result.status, "error");
		assert.equal(result.errorCode, "hardware_gate_failed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment rejects ambiguous hardware execution parameter aliases", () => {
	const cwd = tempCwd();
	try {
		const approval = baseApproval("missing-report");
		const result = dispatch(
			"run_experiment",
			{
				spec: loadSpec("hardware-spec.json"),
				hardwareExecution: {
					stageAdapter: "memory",
					settleTimeoutMs: 1_000,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval,
				},
				hardwarePilot: {
					stageAdapter: "memory",
					settleTimeoutMs: 1_000,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval,
				},
			},
			{ cwd },
		);
		assert.equal(result.status, "error");
		assert.equal(result.errorCode, "invalid_tool_params");
		assert.match(result.summary, /hardwareExecution or legacy hardwarePilot/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment rejects invalid hardware resumeFrom values", () => {
	const cwd = tempCwd();
	try {
		const baseParams = {
			spec: loadSpec("hardware-spec.json"),
			hardwareExecution: {
				stageAdapter: "memory",
				settleTimeoutMs: 1_000,
				heartbeatTimeoutMs: 60_000,
				maxConsecutiveErrors: 2,
				approval: baseApproval("missing-report"),
			},
		};
		const negative = dispatch("run_experiment", { ...baseParams, resumeFrom: -1 }, { cwd, commandId: "resume-negative" });
		assert.equal(negative.status, "error");
		assert.equal(negative.errorCode, "invalid_tool_params");
		const fractional = dispatch("run_experiment", { ...baseParams, resumeFrom: 1.5 }, { cwd, commandId: "resume-fractional" });
		assert.equal(fractional.status, "error");
		assert.equal(fractional.errorCode, "invalid_tool_params");
		const outOfRange = dispatch("run_experiment", { ...baseParams, resumeFrom: 5 }, { cwd, commandId: "resume-out-of-range" });
		assert.equal(outOfRange.status, "error");
		assert.equal(outOfRange.errorCode, "invalid_resume_from");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_experiment completes a gated hardware run end to end with the memory adapter", () => {
	const cwd = tempCwd();
	try {
		const dryRun = dispatch("run_preflight", { spec: loadSpec("hardware-dry-run-spec.json") }, { cwd });
		const reportId = (dryRun.stateAfter as { records: { reportId: string } }).records.reportId;
		const result = dispatch(
			"run_experiment",
			{
				spec: loadSpec("hardware-spec.json"),
				hardwareExecution: {
					stageAdapter: "memory",
					settleTimeoutMs: 1_000,
					heartbeatTimeoutMs: 60_000,
					maxConsecutiveErrors: 2,
					approval: baseApproval(reportId),
				},
			},
			{ cwd },
		);
		assert.equal(result.status, "success");
		const runId = result.runId ?? "";
		assert.match(runId, /^hw-run-/);
		const summary = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "summary.json"), "utf-8");
		assert.match(summary, /"status": "completed"/);
		const runRecord = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "run.json"), "utf-8");
		assert.match(runRecord, /"specHash"/);
		const approvals = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "approvals.jsonl"), "utf-8");
		assert.match(approvals, /hardware_approval_recorded/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("specs that differ only in mode and approval hash identically", () => {
	assert.equal(hashExperimentSpec(loadSpec("hardware-spec.json")), hashExperimentSpec(loadSpec("hardware-dry-run-spec.json")));
});
