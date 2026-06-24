import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateHardwareGate } from "../records.ts";
import type { ExperimentSpec, HardwareExecutionParams } from "../schemas.ts";
import { validateExperimentSpec } from "../schemas.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function withLaserPower(spec: ExperimentSpec, laserPowerMw: number): HardwareExecutionParams {
	return {
		stageAdapter: "memory",
		settleTimeoutMs: 1_000,
		heartbeatTimeoutMs: 60_000,
		maxConsecutiveErrors: 2,
		raman: {
			laserPowerMw,
			acquisitionBackend: "fake",
			autofocusBackend: "fake",
			xyCorrectionBackend: "fake",
		},
	};
}

test("schema accepts Raman specs without maxExposureEnergyMj", () => {
	const spec = loadSpec("raman-hardware-spec.json");
	const result = validateExperimentSpec(spec);
	assert.equal(result.valid, true);
});

test("hardware gate rejects requested laser power above limits.powerEnergy.maxLaserPowerMw", () => {
	const spec = loadSpec("raman-hardware-spec.json");
	const gate = validateHardwareGate(spec, withLaserPower(spec, 2));
	assert.equal(gate.valid, false);
	assert.ok(gate.issues.some((issue) => issue.includes("sample_burn")));
	assert.equal(gate.requestedLaserPowerMw, 2);
	assert.equal(gate.laserCeilingMw, spec.limits.powerEnergy.maxLaserPowerMw);
});

test("hardware gate accepts requested laser power at or below limits.powerEnergy.maxLaserPowerMw", () => {
	const spec = loadSpec("raman-hardware-spec.json");
	const gate = validateHardwareGate(spec, withLaserPower(spec, 0.5));
	assert.equal(gate.valid, true);
	assert.equal(gate.requestedLaserPowerMw, 0.5);
});

test("hardware gate defaults to the spec laser ceiling when no explicit laserPowerMw is provided", () => {
	const spec = loadSpec("raman-hardware-spec.json");
	const gate = validateHardwareGate(spec, {
		stageAdapter: "memory",
		settleTimeoutMs: 1_000,
		heartbeatTimeoutMs: 60_000,
		maxConsecutiveErrors: 2,
		raman: {
			acquisitionBackend: "fake",
			autofocusBackend: "fake",
			xyCorrectionBackend: "fake",
		},
	});
	assert.equal(gate.valid, true);
	assert.equal(gate.requestedLaserPowerMw, spec.limits.powerEnergy.maxLaserPowerMw);
});
