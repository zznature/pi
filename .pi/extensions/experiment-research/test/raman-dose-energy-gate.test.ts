import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { hashExperimentSpec, validateHardwareGate } from "../records.ts";
import type { ExperimentSpec } from "../schemas.ts";
import { validateExperimentSpec } from "../schemas.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-dose-energy-"));
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function withExposureLimit(spec: ExperimentSpec, maxExposureEnergyMj: number): ExperimentSpec {
	return {
		...spec,
		limits: {
			...spec.limits,
			powerEnergy: {
				...spec.limits.powerEnergy,
				maxExposureEnergyMj,
			},
		},
	};
}

function seedDryRunPreflight(cwd: string, spec: ExperimentSpec, reportId: string): void {
	const capabilitySnapshotId = `${reportId}-capabilities`;
	writeJson(join(cwd, ".pi", "experiment-runs", "preflights", reportId, "preflight.json"), {
		reportId,
		spec,
		result: {
			valid: true,
			mode: "dry_run",
			liveState: {
				readOnlyProbe: {
					readOnly: true,
					stage: { reachable: true },
					labspecWorker: { reachable: true },
				},
			},
			specHash: hashExperimentSpec(spec),
			capabilitySnapshotId,
		},
		specHash: hashExperimentSpec(spec),
		capabilitySnapshotId,
	});
}

test("schema rejects Raman acquisition energy above maxExposureEnergyMj", () => {
	const spec = withExposureLimit(loadSpec("raman-hardware-spec.json"), 0.5);
	const result = validateExperimentSpec(spec);
	assert.equal(result.valid, false);
	if (!result.valid) {
		assert.ok(result.issues.some((issue) => issue.path === "limits.powerEnergy.maxExposureEnergyMj"));
	}
});

test("hardware gate rejects confirmed exposure energy above maxExposureEnergyMj", () => {
	const cwd = tempCwd();
	try {
		const reportId = "dose-energy-preflight";
		const dryRunSpec = withExposureLimit(loadSpec("raman-dry-run-spec.json"), 0.5);
		const hardwareSpec = withExposureLimit(loadSpec("raman-hardware-spec.json"), 0.5);
		seedDryRunPreflight(cwd, dryRunSpec, reportId);

		const gate = validateHardwareGate(
			hardwareSpec,
			{
				approvalId: "appr-dose-energy-too-high",
				operator: "tester",
				approved: true,
				dryRunReportId: reportId,
				ramanSafety: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 1,
					confirmedExposureEnergyMj: 1,
				},
			},
			cwd,
		);
		assert.equal(gate.valid, false);
		assert.ok(gate.issues.some((issue) => issue.includes("exposure energy exceeds")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("hardware gate accepts confirmed exposure energy within maxExposureEnergyMj", () => {
	const cwd = tempCwd();
	try {
		const reportId = "dose-energy-preflight-ok";
		const dryRunSpec = withExposureLimit(loadSpec("raman-dry-run-spec.json"), 0.5);
		const hardwareSpec = withExposureLimit(loadSpec("raman-hardware-spec.json"), 0.5);
		seedDryRunPreflight(cwd, dryRunSpec, reportId);

		const gate = validateHardwareGate(
			hardwareSpec,
			{
				approvalId: "appr-dose-energy-ok",
				operator: "tester",
				approved: true,
				dryRunReportId: reportId,
				ramanSafety: {
					laserPowerConfirmed: true,
					confirmedLaserPowerMw: 0.4,
					confirmedExposureEnergyMj: 0.4,
				},
			},
			cwd,
		);
		assert.equal(gate.valid, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
