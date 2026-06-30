import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { getLabState } from "../lab-state.ts";
import { validatePolicy } from "../policy.ts";
import { validateHardwareGate } from "../records.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { validateExperimentSpec } from "../schemas.ts";

process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE = "1";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-operation-intent-"));
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

function autofocusOnlySpec(mode: "dry_run" | "hardware"): ExperimentSpec {
	const base = loadSpec("raman/base/hardware-spec.json");
	return {
		...base,
		mode,
		specId: `spec-raman-autofocus-only-${mode}`,
		objective: "Laser-assisted autofocus only without Raman spectrum acquisition.",
		resources: [
			{ id: "mc-newton-xyz-stage", kind: "instrument", role: "stage" },
			{ id: "lab-camera", kind: "instrument", role: "camera" },
			{ id: "labspec-workstation", kind: "workspace", role: "exclusive_lab_station" },
		],
		domain: {
			raman: {
				operationIntent: "autofocus_only",
				autofocus: {
					enabled: true,
					every: "once",
					zMinUm: -10,
					zMaxUm: 10,
					coarseRangeUm: 4,
					coarseStepUm: 2,
					fineRangeUm: 2,
					fineStepUm: 1,
					metric: "tenengrad",
					minConfidence: 0,
					onFailure: "pause",
				},
			},
		},
	};
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

test("schema accepts explicit autofocus_only Raman specs without acquisition", () => {
	const result = validateExperimentSpec(autofocusOnlySpec("hardware"));
	assert.equal(result.valid, true);
});

test("schema rejects autofocus_only specs that still include acquisition settings", () => {
	const spec = autofocusOnlySpec("hardware");
	spec.domain = {
		raman: {
			...spec.domain.raman,
			acquisition: {
				integrationTimeS: 1,
				accumulations: 1,
				fromNm: 100,
				toNm: 3500,
				saveFormat: "txt",
			},
		},
	};
	const result = validateExperimentSpec(spec);
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.ok(result.issues.some((issue) => issue.message.includes("autofocus_only does not allow Raman acquisition settings")));
	}
});

test("policy accepts autofocus_only hardware specs without lab-acquirer", () => {
	const result = validatePolicy(autofocusOnlySpec("hardware"), getLabState(), { toolName: "run_experiment" });
	assert.equal(result.valid, true);
});

test("damage approval derivation is explicit for autofocus_only and only turns on for bounded damage risks", () => {
	const safeGate = validateHardwareGate(autofocusOnlySpec("hardware"), {
		stageAdapter: "memory",
		settleTimeoutMs: 100,
		heartbeatTimeoutMs: 10_000,
		maxConsecutiveErrors: 2,
		raman: {
			laserPowerMw: 0.5,
		},
	});
	assert.equal(safeGate.valid, true);
	assert.equal(safeGate.approvalAssessment?.operationIntent, "autofocus_only");
	assert.equal(safeGate.approvalAssessment?.required, false);
	assert.deepEqual(safeGate.approvalAssessment?.damageRisks, []);

	const riskyGate = validateHardwareGate(autofocusOnlySpec("hardware"), {
		stageAdapter: "memory",
		settleTimeoutMs: 100,
		heartbeatTimeoutMs: 10_000,
		maxConsecutiveErrors: 2,
		raman: {
			laserPowerMw: 2,
		},
	});
	assert.equal(riskyGate.valid, false);
	assert.equal(riskyGate.approvalAssessment?.required, true);
	assert.deepEqual(riskyGate.approvalAssessment?.damageRisks, ["sample_burn"]);
});

test("real Raman preflight accepts autofocus_only launch previews without acquisition backends", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = autofocusOnlySpec("hardware");
			const result = dispatch(
				"run_preflight",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						stagePort: "COM_TEST",
						raman: {
							workflowBackend: "v2_bridge",
							autofocusBackend: "labspec_file_bridge",
						},
					},
				},
				{ cwd, commandId: "autofocus-only-preflight" },
			);
			assert.equal(result.status, "success");
			const launchReadiness = asRecord(asRecord(result.stateAfter).launchReadiness);
			assert.equal(launchReadiness.ready, true);
			assert.deepEqual(launchReadiness.issues, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("runtime records distinguish autofocus_only runs from acquisition runs", async () => {
	const cwd = tempCwd();
	try {
		const result = dispatch(
			"run_experiment",
			{
				spec: autofocusOnlySpec("hardware"),
				hardwareExecution: {
					stageAdapter: "memory",
					raman: {
						workflowBackend: "v2_bridge",
					},
					settleTimeoutMs: 100,
					heartbeatTimeoutMs: 10_000,
					maxConsecutiveErrors: 2,
				},
			},
			{ cwd, commandId: "autofocus-only-run" },
		);
		assert.equal(result.status, "success");
		const runId = result.runId ?? "";
		await waitForRunStatus(cwd, runId, "completed");

		const summary = asRecord(JSON.parse(readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "summary.json"), "utf-8")));
		assert.equal(summary.operationIntent, "autofocus_only");

		const events = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "events.jsonl"), "utf-8");
		assert.match(events, /"operationIntent":"autofocus_only"/);

		const artifacts = JSON.parse(readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "artifacts.json"), "utf-8")) as Array<Record<string, unknown>>;
		assert.ok(artifacts.some((artifact) => artifact.kind === "frame"));
		assert.equal(artifacts.some((artifact) => artifact.kind === "spectrum"), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
