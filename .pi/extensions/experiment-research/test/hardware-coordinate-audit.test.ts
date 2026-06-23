import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { validateHardwareCoordinateAuditReadiness } from "../kernel/hardware-coordinate-audit.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { recordHardwareCoordinateAuditTool } from "../tools/hardware-coordinate-audit.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-coordinate-audit-"));
}

function toolContext(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
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

async function withSimulatedHardwareDisabledAsync<T>(callback: () => Promise<T>): Promise<T> {
	const previous = process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE;
	delete process.env.PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE;
	try {
		return await callback();
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

function baseHardwareExecution(coordinateAuditId?: string) {
	return {
		stageAdapter: "mc_newton_xyz" as const,
		...(coordinateAuditId ? { coordinateAuditId } : {}),
		settleTimeoutMs: 100,
		heartbeatTimeoutMs: 10_000,
		maxConsecutiveErrors: 2,
		approval: {
			approvalId: "appr-real-hardware",
			operator: "tester",
			approved: true,
			dryRunReportId: "missing-gate-preflight",
		},
	};
}

test("record_hardware_coordinate_audit writes an operator-approved coordinate audit record", async () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("hardware-spec.json");
		const result = await recordHardwareCoordinateAuditTool.execute(
			"record-coordinate-audit",
			{
				coordinateAuditId: "coord-audit-ready",
				approval: { approvalId: "appr-coord-audit-ready", operator: "tester", approved: true },
				subject: spec.subject,
				plan: spec.plan,
				observedAt: "2026-06-23T10:00:00.000Z",
				notes: "Reviewed against the calibrated stage home on site.",
			},
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(result.details.status, "success");
		const stateAfter = asRecord(result.details.stateAfter);
		assert.equal(stateAfter.coordinateAuditId, "coord-audit-ready");
		const path = String(stateAfter.path);
		assert.equal(existsSync(path), true);
		const record = asRecord(JSON.parse(readFileSync(path, "utf-8")));
		assert.equal(record.coordinateAuditId, "coord-audit-ready");
		assert.equal(asRecord(record.approval).approved, true);
		assert.equal(record.observedAt, "2026-06-23T10:00:00.000Z");
		assert.ok(result.details.nextActions.some((action) => action.includes("hardwareExecution.coordinateAuditId")));

		const readiness = validateHardwareCoordinateAuditReadiness(cwd, "coord-audit-ready", spec);
		assert.equal(readiness.ok, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("run_preflight warns when a planned real hardware launch preview lacks coordinateAuditId", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("hardware-spec.json");
			const result = dispatch(
				"run_preflight",
				{ spec, hardwareExecution: { stageAdapter: "mc_newton_xyz" } },
				{ cwd, commandId: "missing-coordinate-audit-preview" },
			);
			assert.equal(result.status, "warning");
			assert.match(result.summary, /planned real hardware launch is not ready/);
			const launchReadiness = asRecord(asRecord(result.stateAfter).launchReadiness);
			assert.equal(launchReadiness.required, true);
			assert.equal(launchReadiness.evaluated, true);
			assert.equal(launchReadiness.ready, false);
			const issues = launchReadiness.issues;
			assert.ok(Array.isArray(issues));
			assert.ok(issues.some((issue) => String(issue).includes("coordinateAuditId")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("run_experiment rejects supervised real hardware without coordinateAuditId", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("hardware-spec.json");
			const result = dispatch(
				"run_experiment",
				{ spec, hardwareExecution: baseHardwareExecution() },
				{ cwd, commandId: "missing-coordinate-audit-run" },
			);
			assert.equal(result.errorCode, "hardware_gate_failed");
			assert.match(result.summary, /coordinate audit gate/);
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("coordinateAuditId")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("run_experiment rejects coordinateAuditId records that do not match the current subject and plan", async () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabledAsync(async () => {
		try {
			const spec = loadSpec("hardware-spec.json");
			const mismatchedPlan = {
				kind: "points",
				points: [
					{ xUm: 1, yUm: 0, zUm: 0 },
					{ xUm: 10, yUm: 0, zUm: 0 },
					{ xUm: 10, yUm: 10, zUm: 0 },
					{ xUm: 0, yUm: 10, zUm: 0 },
				],
			};
			const record = await recordHardwareCoordinateAuditTool.execute(
				"record-mismatched-coordinate-audit",
				{
					coordinateAuditId: "coord-audit-mismatch",
					approval: { approvalId: "appr-coord-audit-mismatch", operator: "tester", approved: true },
					subject: spec.subject,
					plan: mismatchedPlan,
				},
				undefined,
				undefined,
				toolContext(cwd),
			);
			assert.equal(record.details.status, "success");

			const result = dispatch(
				"run_experiment",
				{ spec, hardwareExecution: baseHardwareExecution("coord-audit-mismatch") },
				{ cwd, commandId: "mismatched-coordinate-audit-run" },
			);
			assert.equal(result.errorCode, "hardware_gate_failed");
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("does not match the current hardware subject/plan coordinates")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("run_experiment gets past the coordinate audit gate when the coordinateAuditId matches the current plan", async () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabledAsync(async () => {
		try {
			const spec = loadSpec("hardware-spec.json");
			const record = await recordHardwareCoordinateAuditTool.execute(
				"record-ready-coordinate-audit",
				{
					coordinateAuditId: "coord-audit-match",
					approval: { approvalId: "appr-coord-audit-match", operator: "tester", approved: true },
					subject: spec.subject,
					plan: spec.plan,
				},
				undefined,
				undefined,
				toolContext(cwd),
			);
			assert.equal(record.details.status, "success");

			const result = dispatch(
				"run_experiment",
				{ spec, hardwareExecution: baseHardwareExecution("coord-audit-match") },
				{ cwd, commandId: "matching-coordinate-audit-run" },
			);
			assert.equal(result.errorCode, "hardware_gate_failed");
			assert.match(result.summary, /Hardware gate failed/);
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("dry-run preflight")));
			assert.equal(issues.some((issue) => issue.includes("coordinateAuditId")), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
