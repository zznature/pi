import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { EXPERIMENT_RESEARCH_PROMPT } from "../prompt.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { runExperimentTool } from "../tools/planner.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const README_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-safety-contract-"));
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

test("README, prompt, and planner surface describe the same MVP Raman launch contract", () => {
	const readme = readFileSync(README_PATH, "utf-8");
	assert.match(readme, /backend executability plus the two bounded/);
	assert.match(readme, /coordinate audits, validation records, and operator approval payloads remain/);
	assert.match(readme, /settled-position assertion/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /backend executability plus two bounded damage invariants/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /runtime bridge assertion/);
	assert.doesNotMatch(EXPERIMENT_RESEARCH_PROMPT, /coordinateAuditId/);
	assert.doesNotMatch(EXPERIMENT_RESEARCH_PROMPT, /v2ValidationId/);
	assert.equal(
		runExperimentTool.promptGuidelines.some((guideline) => guideline.includes("coordinateAuditId") || guideline.includes("v2ValidationId")),
		false,
	);
});

test("run_preflight backend preview accepts Raman MVP launch previews without approval or traceability metadata", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("raman/base/hardware-spec.json");
			const result = dispatch(
				"run_preflight",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						stagePort: "COM17",
						raman: {
							acquisitionBackend: "labspec_file_bridge",
						},
					},
				},
				{ cwd, commandId: "aligned-preflight-preview" },
			);
			assert.equal(result.status, "success");
			const launchReadiness = asRecord(asRecord(result.stateAfter).launchReadiness);
			assert.equal(launchReadiness.required, true);
			assert.equal(launchReadiness.evaluated, true);
			assert.equal(launchReadiness.ready, true);
			assert.deepEqual(launchReadiness.issues, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("launch readiness and launch execution report backend issues without reviving approval or traceability gates", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("raman/base/hardware-spec.json");
			const preview = {
				stageAdapter: "mc_newton_xyz" as const,
				stagePort: "COM17",
				raman: {
					acquisitionBackend: "fake" as const,
				},
			};
			const preflight = dispatch("run_preflight", { spec, hardwareExecution: preview }, { cwd, commandId: "backend-preview-only" });
			assert.equal(preflight.status, "warning");
			const readiness = asRecord(asRecord(preflight.stateAfter).launchReadiness);
			const readinessIssues = readiness.issues as string[];
			assert.ok(readinessIssues.some((issue) => issue.includes("acquisitionBackend")));
			assert.equal(
				readinessIssues.some((issue) => /coordinateAuditId|v2ValidationId|operator approval|dry-run preflight/i.test(issue)),
				false,
			);

			const launch = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						...preview,
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
					},
				},
				{ cwd, commandId: "backend-gate-only" },
			);
			assert.equal(launch.errorCode, "raman_launch_gate_failed");
			const launchIssues = asRecord(launch.stateAfter).issues as string[];
			assert.ok(launchIssues.some((issue) => issue.includes("acquisitionBackend")));
			assert.equal(
				launchIssues.some((issue) => /coordinateAuditId|v2ValidationId|operator approval|dry-run preflight/i.test(issue)),
				false,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
