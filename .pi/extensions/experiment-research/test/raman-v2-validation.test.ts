import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { dispatch } from "../dispatch.ts";
import { recordRamanXyCalibration } from "../kernel/raman-calibration.ts";
import { recordRamanHardwareValidation, validateRamanHardwareValidationReadiness } from "../kernel/raman-validation.ts";
import { hashExperimentSpec } from "../run-store.ts";
import {
	RamanHardwareValidationParamsSchema,
	RamanActiveProbeParamsSchema,
	RunExperimentParamsSchema,
	RunPreflightParamsSchema,
	type ExperimentSpec,
	type RamanHardwareValidationParams,
	validateExperimentSpec,
	validateSchema,
} from "../schemas.ts";
import {
	ramanHardwareValidationDraftTool,
	ramanHardwareValidationReadinessTool,
	ramanValidationSpecPairTool,
} from "../tools/raman-validation.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadSpec(name: string): ExperimentSpec {
	return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as ExperimentSpec;
}

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-raman-v2-validation-"));
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

function toolContext(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function dryRunVariant(spec: ExperimentSpec): ExperimentSpec {
	return {
		...spec,
		mode: "dry_run",
		operatorApprovalRequired: false,
	};
}

function seedPreflight(cwd: string, reportId: string, spec: ExperimentSpec = loadSpec("raman-dry-run-spec.json")): void {
	writeJson(join(cwd, ".pi", "experiment-runs", "preflights", reportId, "preflight.json"), {
		reportId,
		spec,
		specHash: hashExperimentSpec(spec),
		capabilitySnapshotId: "seeded-capability-snapshot",
		result: {
			valid: true,
			specHash: hashExperimentSpec(spec),
			capabilitySnapshotId: "seeded-capability-snapshot",
			liveState: {
				readOnlyProbe: {
					readOnly: true,
					stage: { reachable: true },
					labspecWorker: { reachable: true },
				},
			},
		},
	});
}

function seedActiveProbe(cwd: string): string {
	const framePath = join(cwd, "frame.png");
	const spectrumPath = join(cwd, "smoke-spectrum.txt");
	writeFileSync(framePath, "seeded frame artifact\n", "utf-8");
	writeFileSync(spectrumPath, "seeded spectrum artifact\n", "utf-8");
	const recordPath = join(cwd, ".pi", "experiment-runs", "maintenance", "active-probes", "seeded-v2-probe", "active-probe.json");
	writeJson(recordPath, {
		probeId: "seeded-v2-probe",
		commandId: "seeded-v2-probe",
		createdAt: "2026-06-21T00:00:00.000Z",
		approval: { approvalId: "appr-seeded-v2-probe", operator: "tester", approved: true },
		result: {
			readOnly: false,
			requiresOperatorApproval: true,
			artifacts: [
				{ path: framePath, kind: "frame", backend: "labspec_file_bridge", sideEffect: "labspec_frame_captured" },
				{ path: spectrumPath, kind: "spectrum", backend: "labspec_file_bridge", sideEffect: "spectrum_smoke_acquired" },
			],
			sideEffects: ["labspec_frame_captured", "spectrum_smoke_acquired"],
		},
	});
	return recordPath;
}

function seedCalibration(cwd: string): void {
	const result = recordRamanXyCalibration(
		{
			approval: { approvalId: "appr-v2-validation-calibration", operator: "tester", approved: true },
			calibrationId: "v2-validation-calibration",
			pixelPerUm: [
				[1, 0],
				[0, 1],
			],
			confidence: 0.95,
			sourceNotes: "seeded V2 validation calibration",
		},
		{ cwd, commandId: "seed-v2-validation-calibration" },
	);
	assert.equal(result.status, "success");
}

function paritySpec(): ExperimentSpec {
	return loadSpec("raman-v2-validation-hardware-spec.json");
}

function seedRamanRun(
	cwd: string,
	runId: string,
	options: {
		workflowBackend?: "v1_bridge" | "v2_bridge";
		spec?: ExperimentSpec;
		includeFrameArtifact?: boolean;
		unit?: Record<string, unknown>;
	} = {},
): void {
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
	const spectrumRelativePath = join(".pi", "experiment-runs", "runs", runId, "artifacts", "spectra", "point_0.txt");
	const spectrumPath = join(cwd, spectrumRelativePath);
	const frameRelativePath = join(".pi", "experiment-runs", "runs", runId, "artifacts", "frames", "point_0_autofocus_0.pgm");
	const framePath = join(cwd, frameRelativePath);
	mkdirSync(dirname(spectrumPath), { recursive: true });
	writeFileSync(spectrumPath, "raman_shift_nm,intensity\n100,10\n200,20\n", "utf-8");
	if (options.includeFrameArtifact) {
		mkdirSync(dirname(framePath), { recursive: true });
		writeFileSync(framePath, "P2\n3 3\n255\n0 10 0\n20 200 20\n0 10 0\n", "utf-8");
	}
	writeJson(join(runDir, "summary.json"), {
		runId,
		experimentId: "exp-raman-001",
		status: "completed",
		unitCount: 1,
		completedUnits: 1,
	});
	writeJson(join(runDir, "spec.json"), options.spec ?? loadSpec("raman-hardware-spec.json"));
	writeFileSync(
		join(runDir, "events.jsonl"),
		[
			JSON.stringify({
				schemaVersion: "1",
				sequence: 1,
				type: "run_started",
				runId,
				stageAdapter: "mc_newton_xyz",
				workflowBackend: options.workflowBackend,
			}),
			JSON.stringify({
				schemaVersion: "1",
				sequence: 2,
				type: "unit_completed",
				runId,
				unitKind: "point",
				workflowBackend: options.workflowBackend,
				unit: {
					index: 0,
					xUm: 0,
					yUm: 0,
					status: "success",
					spectrumMetadata: { backend: "labspec_file_bridge", snrEstimate: 25, saturated: false },
					...options.unit,
				},
			}),
			"",
		].join("\n"),
		"utf-8",
	);
	const artifacts: Record<string, unknown>[] = [
		{
			id: `${runId}-spectrum-point-0`,
			uri: spectrumRelativePath,
			label: "Raman spectrum point 0",
			kind: "spectrum",
			producerRunId: runId,
		},
	];
	if (options.includeFrameArtifact) {
		artifacts.push({
			id: `${runId}-frame-point-0`,
			uri: frameRelativePath,
			label: "Raman autofocus frame point 0",
			kind: "frame",
			producerRunId: runId,
		});
	}
	writeJson(join(runDir, "artifacts.json"), artifacts);
}

function hardwareEvidence(): RamanHardwareValidationParams["hardwareEvidence"] {
	return {
		evidenceMode: "hardware",
		observedAt: "2026-06-21T00:00:00.000Z",
		operatorAttestedRealHardware: true,
		instrumentIds: {
			labspecWorkstation: "labspec-workstation-main",
			stageController: "mc-newton-xyz-stage-main",
			camera: "lab-camera-main",
			acquirer: "lab-acquirer-main",
		},
	};
}

function v2ParityUnit(): Record<string, unknown> {
	return {
		autofocus: {
			bestZUm: 0.5,
			confidence: 0.92,
			frameArtifactIds: ["frame-point-0"],
		},
		xyCorrection: {
			dxUm: 0.4,
			dyUm: -0.2,
			confidence: 0.94,
		},
		thermal: {
			targetTemperatureC: 60,
			stableAt: "2026-06-21T00:00:10.000Z",
			timeoutS: 60,
		},
	};
}

function validationParams(
	activeProbeRecordPath: string,
	minimumRamanRunId: string,
	workflowBackend?: "v1_bridge" | "v2_bridge",
	validationId?: string,
): RamanHardwareValidationParams {
	return {
		validationId,
		approval: { approvalId: "appr-v2-validation", operator: "tester", approved: true },
		evidence: {
			readOnlyPreflightReportId: "seeded-v2-preflight",
			activeProbeRecordPath,
			minimumRamanRunId,
			xyCalibrationId: "v2-validation-calibration",
			workflowBackend,
		},
		hardwareEvidence: hardwareEvidence(),
		checklist: {
			laserPowerConfirmed: true,
			confirmedLaserPowerMw: 1,
			labSpecWorkerValidated: true,
			cameraStreamValidated: true,
			stageMotionValidated: true,
			windowsPowerPolicyReady: true,
			operatorReviewedArtifacts: true,
		},
	};
}

test("Raman V2 validation requires explicit v2_bridge workflow evidence when requested", () => {
	const cwd = tempCwd();
	try {
		seedPreflight(cwd, "seeded-v2-preflight");
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-general-hardware-run");
		seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });

		const generalValidation = recordRamanHardwareValidation(validationParams(activeProbeRecordPath, "seeded-general-hardware-run"), {
			cwd,
			commandId: "general-validation",
		});
		assert.equal(generalValidation.status, "success");

		const missingV2Validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-general-hardware-run", "v2_bridge"),
			{ cwd, commandId: "missing-v2-validation" },
		);
		assert.equal(missingV2Validation.status, "warning");
		const missingV2Issues = asRecord(missingV2Validation.stateAfter).issues as Record<string, unknown>[];
		assert.ok(missingV2Issues.some((issue) => String(issue.message).includes("workflowBackend v2_bridge")));

		const v2Validation = recordRamanHardwareValidation(validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge"), {
			cwd,
			commandId: "v2-validation",
		});
		assert.equal(v2Validation.status, "success");
		const v2RecordPath = String(asRecord(v2Validation.stateAfter).path);
		assert.equal(existsSync(v2RecordPath), true);
		const v2Record = asRecord(JSON.parse(readFileSync(v2RecordPath, "utf-8")));
		assert.equal(asRecord(v2Record.evidence).workflowBackend, "v2_bridge");

		const v2ValidationId = String(asRecord(v2Validation.stateAfter).validationId);
		assert.equal(validateRamanHardwareValidationReadiness(cwd, v2ValidationId, "v2_bridge").valid, true);
		assert.equal(validateRamanHardwareValidationReadiness(cwd, "missing-v2-validation", "v2_bridge").valid, false);
		assert.equal(validateRamanHardwareValidationReadiness(cwd, String(asRecord(generalValidation.stateAfter).validationId), "v2_bridge").valid, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 validation enforces parity evidence for autofocus, XY correction, thermal, and frame artifacts", () => {
	const cwd = tempCwd();
	try {
		const spec = paritySpec();
		seedPreflight(cwd, "seeded-v2-preflight", dryRunVariant(spec));
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-parity-missing", {
			workflowBackend: "v2_bridge",
			spec,
		});
		seedRamanRun(cwd, "seeded-v2-parity-ready", {
			workflowBackend: "v2_bridge",
			spec,
			includeFrameArtifact: true,
			unit: v2ParityUnit(),
		});

		const missingParity = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-parity-missing", "v2_bridge", "missing-v2-parity"),
			{ cwd, commandId: "missing-v2-parity" },
		);
		assert.equal(missingParity.status, "warning");
		const missingIssues = (asRecord(missingParity.stateAfter).issues as Record<string, unknown>[]).map((issue) => String(issue.message));
		assert.ok(missingIssues.some((issue) => issue.includes("autofocus records")));
		assert.ok(missingIssues.some((issue) => issue.includes("XY correction records")));
		assert.ok(missingIssues.some((issue) => issue.includes("thermal records")));
		assert.ok(missingIssues.some((issue) => issue.includes("frame artifacts")));

		const readyParity = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-parity-ready", "v2_bridge", "ready-v2-parity"),
			{ cwd, commandId: "ready-v2-parity" },
		);
		assert.equal(readyParity.status, "success");
		const readyState = asRecord(readyParity.stateAfter);
		const readyRecord = asRecord(JSON.parse(readFileSync(String(readyState.path), "utf-8")));
		const evidenceDigest = asRecord(readyRecord.evidenceDigest);
		const digestFiles = evidenceDigest.files;
		assert.ok(Array.isArray(digestFiles));
		assert.ok(digestFiles.some((entry) => asRecord(entry).role === "minimum-run-seeded-v2-parity-ready-frame-point-0"));
		assert.equal(validateRamanHardwareValidationReadiness(cwd, "ready-v2-parity", "v2_bridge").valid, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 validation spec fixtures stay schema-valid and semantically aligned", () => {
	const hardwareSpec = loadSpec("raman-v2-validation-hardware-spec.json");
	const dryRunSpec = loadSpec("raman-v2-validation-dry-run-spec.json");
	const realHardwareSpec = loadSpec("raman-v2-real-validation-hardware-spec.json");
	const realDryRunSpec = loadSpec("raman-v2-real-validation-dry-run-spec.json");
	const realValidationDraft = JSON.parse(readFileSync(join(FIXTURES, "raman-v2-real-validation-payload.draft.json"), "utf-8")) as unknown;
	const realPreflightInput = JSON.parse(readFileSync(join(FIXTURES, "raman-v2-real-validation-preflight-input.json"), "utf-8")) as unknown;
	const realActiveProbeInput = JSON.parse(readFileSync(join(FIXTURES, "raman-v2-real-validation-active-probe-input.json"), "utf-8")) as unknown;
	const realBootstrapRunInput = JSON.parse(readFileSync(join(FIXTURES, "raman-v2-real-validation-bootstrap-run-input.json"), "utf-8")) as unknown;

	const hardwareValidation = validateExperimentSpec(hardwareSpec);
	assert.equal(hardwareValidation.valid, true);

	const dryRunValidation = validateExperimentSpec(dryRunSpec);
	assert.equal(dryRunValidation.valid, true);
	assert.equal(validateExperimentSpec(realHardwareSpec).valid, true);
	assert.equal(validateExperimentSpec(realDryRunSpec).valid, true);

	assert.equal(hardwareSpec.mode, "hardware");
	assert.equal(dryRunSpec.mode, "dry_run");
	assert.equal(hardwareSpec.operatorApprovalRequired, true);
	assert.equal(dryRunSpec.operatorApprovalRequired, false);
	assert.equal(hardwareSpec.domain?.raman?.autofocus?.enabled, true);
	assert.equal(dryRunSpec.domain?.raman?.autofocus?.enabled, true);
	assert.equal(hardwareSpec.domain?.raman?.xyCorrection?.enabled, true);
	assert.equal(dryRunSpec.domain?.raman?.xyCorrection?.enabled, true);
	assert.equal(hardwareSpec.domain?.thermal?.enabled, true);
	assert.equal(dryRunSpec.domain?.thermal?.enabled, true);
	assert.equal(hardwareSpec.domain?.thermal?.waitBeforeAcquisition, true);
	assert.equal(dryRunSpec.domain?.thermal?.waitBeforeAcquisition, true);
	assert.equal(realHardwareSpec.domain?.thermal, undefined);
	assert.equal(realDryRunSpec.domain?.thermal, undefined);
	assert.equal(validateSchema(RamanHardwareValidationParamsSchema, realValidationDraft).valid, true);
	const realValidationDraftRecord = asRecord(realValidationDraft);
	assert.equal(asRecord(realValidationDraftRecord.approval).approved, false);
	assert.equal(asRecord(realValidationDraftRecord.hardwareEvidence).operatorAttestedRealHardware, false);
	assert.equal(asRecord(realValidationDraftRecord.evidence).workflowBackend, "v2_bridge");
	assert.equal(asRecord(realValidationDraftRecord.checklist).laserPowerConfirmed, false);

	assert.equal(validateSchema(RunPreflightParamsSchema, realPreflightInput).valid, true);
	const preflightInputRecord = asRecord(realPreflightInput);
	assert.equal(hashExperimentSpec(preflightInputRecord.spec as ExperimentSpec), hashExperimentSpec(realDryRunSpec));

	assert.equal(validateSchema(RamanActiveProbeParamsSchema, realActiveProbeInput).valid, true);
	const activeProbeInputRecord = asRecord(realActiveProbeInput);
	assert.equal(asRecord(activeProbeInputRecord.approval).approved, true);
	assert.equal(activeProbeInputRecord.frameBackend, "labspec_file_bridge");
	assert.equal(activeProbeInputRecord.acquisitionBackend, "labspec_file_bridge");

	assert.equal(validateSchema(RunExperimentParamsSchema, realBootstrapRunInput).valid, true);
	const bootstrapRunInputRecord = asRecord(realBootstrapRunInput);
	assert.equal(hashExperimentSpec(bootstrapRunInputRecord.spec as ExperimentSpec), hashExperimentSpec(realHardwareSpec));
	const hardwareExecution = asRecord(bootstrapRunInputRecord.hardwareExecution);
	assert.equal(asRecord(hardwareExecution.raman).workflowBackend, "v2_bridge");
	assert.equal(asRecord(hardwareExecution.approval).bootstrapV2ValidationRun, true);
});

test("Raman validation spec pair tool derives a hash-matched dry-run partner for the hardware fixture", async () => {
	const cwd = tempCwd();
	try {
		const hardwareSpec = loadSpec("raman-v2-real-validation-hardware-spec.json");
		const result = await ramanValidationSpecPairTool.execute(
			"prepare-validation-spec-pair",
			{ spec: hardwareSpec },
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(result.details.status, "success");
		const stateAfter = asRecord(result.details.stateAfter);
		assert.equal(stateAfter.valid, true);
		assert.equal(stateAfter.hashesMatch, true);
		assert.equal(String(stateAfter.hardwareSpecHash), String(stateAfter.dryRunSpecHash));
		const dryRunSpec = asRecord(stateAfter.dryRunSpec);
		assert.equal(dryRunSpec.mode, "dry_run");
		assert.equal(dryRunSpec.operatorApprovalRequired, false);
		const capabilityCoverage = asRecord(stateAfter.capabilityCoverage);
		assert.equal(capabilityCoverage.autofocus, true);
		assert.equal(capabilityCoverage.xyCorrection, true);
		assert.equal(capabilityCoverage.thermalWait, false);
		assert.equal(capabilityCoverage.acquisition, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman validation spec pair tool warns when a hardware spec is too narrow for full V2 validation coverage", async () => {
	const cwd = tempCwd();
	try {
		const hardwareSpec = loadSpec("raman-hardware-spec.json");
		const result = await ramanValidationSpecPairTool.execute(
			"prepare-thin-validation-spec-pair",
			{ spec: hardwareSpec },
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(result.details.status, "warning");
		const stateAfter = asRecord(result.details.stateAfter);
		assert.equal(stateAfter.hashesMatch, true);
		assert.equal(stateAfter.valid, false);
		const capabilityCoverage = asRecord(stateAfter.capabilityCoverage);
		assert.equal(capabilityCoverage.autofocus, false);
		assert.equal(capabilityCoverage.xyCorrection, false);
		assert.equal(capabilityCoverage.thermalWait, false);
		assert.equal(capabilityCoverage.acquisition, true);
		const issues = stateAfter.issues;
		assert.ok(Array.isArray(issues));
		assert.ok(issues.some((issue) => asRecord(issue).message === "minimum V2 validation spec should enable autofocus coverage"));
		assert.ok(issues.some((issue) => asRecord(issue).message === "minimum V2 validation spec should enable XY correction coverage"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman validation spec pair tool warns when the spec enables thermal waiting beyond the current real runtime surface", async () => {
	const cwd = tempCwd();
	try {
		const hardwareSpec = loadSpec("raman-v2-validation-hardware-spec.json");
		const result = await ramanValidationSpecPairTool.execute(
			"prepare-full-surface-validation-spec-pair",
			{ spec: hardwareSpec },
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(result.details.status, "warning");
		const stateAfter = asRecord(result.details.stateAfter);
		assert.equal(stateAfter.hashesMatch, true);
		assert.equal(stateAfter.valid, false);
		const issues = stateAfter.issues;
		assert.ok(Array.isArray(issues));
		assert.ok(
			issues.some(
				(issue) =>
					asRecord(issue).message ===
					"current real Raman runtime cannot execute thermal waiting because the thermal backend is fake-only",
			),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware validation draft tool prepares a schema-valid operator draft payload", async () => {
	const cwd = tempCwd();
	try {
		const result = await ramanHardwareValidationDraftTool.execute(
			"prepare-hardware-validation-draft",
			{
				validationId: "raman-v2-prod-20260621-a",
				operator: "tester",
				observedAt: "2026-06-21T10:00:00.000Z",
				evidence: {
					readOnlyPreflightReportId: "seeded-v2-preflight",
					activeProbeRecordPath: ".pi/experiment-runs/maintenance/active-probes/seeded-v2-probe/active-probe.json",
					minimumRamanRunId: "seeded-v2-run",
					xyCalibrationId: "v2-validation-calibration",
					workflowBackend: "v2_bridge",
				},
				instrumentIds: {
					labspecWorkstation: "labspec-workstation-main",
					stageController: "mc-newton-xyz-stage-main",
					camera: "lab-camera-main",
					acquirer: "lab-acquirer-main",
				},
				environmentNotes: "Prepared near the Raman workstation after the supervised run.",
				notes: "Draft only; operator review pending.",
				confirmedLaserPowerMw: 1,
			},
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(result.details.status, "success");
		const stateAfter = asRecord(result.details.stateAfter);
		assert.equal(stateAfter.valid, true);
		assert.equal(stateAfter.draftReadyForRecording, false);
		const payloadDraft = asRecord(stateAfter.payloadDraft);
		assert.equal(validateSchema(RamanHardwareValidationParamsSchema, payloadDraft).valid, true);
		assert.equal(asRecord(payloadDraft.approval).approved, false);
		assert.equal(asRecord(payloadDraft.evidence).workflowBackend, "v2_bridge");
		assert.equal(asRecord(payloadDraft.hardwareEvidence).operatorAttestedRealHardware, false);
		const checklist = asRecord(payloadDraft.checklist);
		assert.equal(checklist.laserPowerConfirmed, false);
		assert.equal(checklist.confirmedLaserPowerMw, 1);
		const reviewChecklist = stateAfter.reviewChecklist;
		assert.ok(Array.isArray(reviewChecklist));
		assert.ok(reviewChecklist.some((entry) => String(entry).includes("approval.approved")));
		assert.ok(reviewChecklist.some((entry) => String(entry).includes("operatorAttestedRealHardware")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman hardware validation draft payload can be reviewed into a production-ready V2 validation record", async () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("raman-v2-real-validation-hardware-spec.json");
		seedPreflight(cwd, "seeded-v2-preflight", dryRunVariant(spec));
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-real-capable-run", {
			workflowBackend: "v2_bridge",
			spec,
			includeFrameArtifact: true,
			unit: {
				autofocus: {
					bestZUm: 0.5,
					confidence: 0.92,
					frameArtifactIds: ["frame-point-0"],
				},
				xyCorrection: {
					dxUm: 0.4,
					dyUm: -0.2,
					confidence: 0.94,
				},
			},
		});

		const draftResult = await ramanHardwareValidationDraftTool.execute(
			"prepare-reviewed-v2-draft",
			{
				validationId: "reviewed-v2-draft-validation",
				operator: "tester",
				observedAt: "2026-06-21T10:00:00.000Z",
				evidence: {
					readOnlyPreflightReportId: "seeded-v2-preflight",
					activeProbeRecordPath,
					minimumRamanRunId: "seeded-v2-real-capable-run",
					xyCalibrationId: "v2-validation-calibration",
					workflowBackend: "v2_bridge",
				},
				instrumentIds: hardwareEvidence().instrumentIds,
				environmentNotes: "Reviewed at the Raman workstation after the minimum auditable V2 run.",
				notes: "Prepared for operator review.",
				confirmedLaserPowerMw: 1,
			},
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(draftResult.details.status, "success");
		const draftState = asRecord(draftResult.details.stateAfter);
		const payloadDraft = asRecord(draftState.payloadDraft);

		const reviewedPayloadCheck = validateSchema(RamanHardwareValidationParamsSchema, {
			validationId: payloadDraft.validationId,
			approval: {
				...asRecord(payloadDraft.approval),
				approved: true,
				notes: "Operator reviewed all referenced Raman validation evidence.",
			},
			evidence: payloadDraft.evidence,
			hardwareEvidence: {
				...asRecord(payloadDraft.hardwareEvidence),
				operatorAttestedRealHardware: true,
			},
			checklist: {
				...asRecord(payloadDraft.checklist),
				laserPowerConfirmed: true,
				labSpecWorkerValidated: true,
				cameraStreamValidated: true,
				stageMotionValidated: true,
				windowsPowerPolicyReady: true,
				operatorReviewedArtifacts: true,
			},
			notes: payloadDraft.notes,
		});
		assert.equal(reviewedPayloadCheck.valid, true);

		const validation = recordRamanHardwareValidation(reviewedPayloadCheck.value, {
			cwd,
			commandId: "record-reviewed-v2-draft-validation",
		});
		assert.equal(validation.status, "success");

		const readiness = validateRamanHardwareValidationReadiness(cwd, "reviewed-v2-draft-validation", "v2_bridge", spec);
		assert.equal(readiness.valid, true);
		assert.equal(readiness.productionReady, true);
		assert.equal(readiness.validatedCoverage?.autofocus, true);
		assert.equal(readiness.validatedCoverage?.xyCorrection, true);
		assert.equal(readiness.validatedCoverage?.thermalWait, false);
		assert.deepEqual(readiness.uncoveredCapabilities ?? [], []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 validation readiness rejects tampered evidence digests", () => {
	const cwd = tempCwd();
	try {
		seedPreflight(cwd, "seeded-v2-preflight");
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
		const validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "tamper-check-v2-validation"),
			{ cwd, commandId: "record-tamper-check-v2-validation" },
		);
		assert.equal(validation.status, "success");
		assert.equal(validateRamanHardwareValidationReadiness(cwd, "tamper-check-v2-validation", "v2_bridge").valid, true);

		writeFileSync(
			join(cwd, ".pi", "experiment-runs", "runs", "seeded-v2-hardware-run", "artifacts", "spectra", "point_0.txt"),
			"tampered spectrum artifact\n",
			"utf-8",
		);

		const readiness = validateRamanHardwareValidationReadiness(cwd, "tamper-check-v2-validation", "v2_bridge");
		assert.equal(readiness.valid, false);
		assert.ok(readiness.issues.some((issue) => issue.message.includes("evidenceDigest")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman validation readiness tool reports production-ready and tampered records", async () => {
	const cwd = tempCwd();
	try {
		seedPreflight(cwd, "seeded-v2-preflight");
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
		const validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "tool-check-v2-validation"),
			{ cwd, commandId: "record-tool-check-v2-validation" },
		);
		assert.equal(validation.status, "success");

		const successResult = await ramanHardwareValidationReadinessTool.execute(
			"check-tool-ready",
			{ validationId: "tool-check-v2-validation", workflowBackend: "v2_bridge" },
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(successResult.details.status, "success");
		assert.equal(asRecord(successResult.details.stateAfter).valid, true);

		writeFileSync(
			join(cwd, ".pi", "experiment-runs", "runs", "seeded-v2-hardware-run", "artifacts", "spectra", "point_0.txt"),
			"tampered spectrum artifact\n",
			"utf-8",
		);

		const warningResult = await ramanHardwareValidationReadinessTool.execute(
			"check-tool-tampered",
			{ validationId: "tool-check-v2-validation", workflowBackend: "v2_bridge" },
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(warningResult.details.status, "warning");
		const warningState = asRecord(warningResult.details.stateAfter);
		assert.equal(warningState.valid, false);
		const issues = warningState.issues;
		assert.ok(Array.isArray(issues));
		assert.ok(issues.some((issue) => asRecord(issue).message === "Raman hardware validation evidenceDigest no longer matches current evidence for minimum-run-seeded-v2-hardware-run-spectrum-point-0"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman validation readiness tool warns when the candidate real spec exceeds validation coverage", async () => {
	const cwd = tempCwd();
	try {
		seedPreflight(cwd, "seeded-v2-preflight");
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
		const validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "thin-tool-check-v2-validation"),
			{ cwd, commandId: "record-thin-tool-check-v2-validation" },
		);
		assert.equal(validation.status, "success");

		const warningResult = await ramanHardwareValidationReadinessTool.execute(
			"check-tool-coverage-gap",
			{
				validationId: "thin-tool-check-v2-validation",
				workflowBackend: "v2_bridge",
				spec: loadSpec("raman-v2-real-validation-hardware-spec.json"),
			},
			undefined,
			undefined,
			toolContext(cwd),
		);
		assert.equal(warningResult.details.status, "warning");
		const warningState = asRecord(warningResult.details.stateAfter);
		assert.equal(warningState.valid, false);
		const validatedCoverage = asRecord(warningState.validatedCoverage);
		assert.equal(validatedCoverage.autofocus, false);
		assert.equal(validatedCoverage.xyCorrection, false);
		const requestedCoverage = asRecord(warningState.requestedCoverage);
		assert.equal(requestedCoverage.autofocus, true);
		assert.equal(requestedCoverage.xyCorrection, true);
		const uncovered = warningState.uncoveredCapabilities;
		assert.ok(Array.isArray(uncovered));
		assert.ok(uncovered.includes("autofocus"));
		assert.ok(uncovered.includes("xyCorrection"));
		const issues = warningState.issues;
		assert.ok(Array.isArray(issues));
		assert.ok(issues.some((issue) => asRecord(issue).message === "Raman hardware validation record does not cover autofocus required by the requested Raman spec"));
		assert.ok(issues.some((issue) => asRecord(issue).message === "Raman hardware validation record does not cover XY correction required by the requested Raman spec"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("Raman V2 validation readiness rejects tampered validatedCoverage metadata", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("raman-v2-real-validation-hardware-spec.json");
		seedPreflight(cwd, "seeded-v2-preflight", dryRunVariant(spec));
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-real-capable-run", {
			workflowBackend: "v2_bridge",
			spec,
			includeFrameArtifact: true,
			unit: {
				autofocus: { bestZUm: 0.5, confidence: 0.92 },
				xyCorrection: { dxUm: 0.4, dyUm: -0.2, confidence: 0.94 },
			},
		});
		const validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-real-capable-run", "v2_bridge", "coverage-tamper-v2-validation"),
			{ cwd, commandId: "record-coverage-tamper-v2-validation" },
		);
		assert.equal(validation.status, "success");
		assert.equal(validateRamanHardwareValidationReadiness(cwd, "coverage-tamper-v2-validation", "v2_bridge").valid, true);

		const recordPath = join(cwd, ".pi", "experiment-runs", "lab", "validations", "coverage-tamper-v2-validation.json");
		const record = asRecord(JSON.parse(readFileSync(recordPath, "utf-8")));
		record.validatedCoverage = {
			autofocus: false,
			xyCorrection: false,
			thermalWait: false,
			acquisition: true,
		};
		writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");

		const readiness = validateRamanHardwareValidationReadiness(cwd, "coverage-tamper-v2-validation", "v2_bridge");
		assert.equal(readiness.valid, false);
		assert.ok(readiness.issues.some((issue) => issue.message.includes("validatedCoverage.autofocus")));
		assert.ok(readiness.issues.some((issue) => issue.message.includes("validatedCoverage.xyCorrection")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("real Raman V2 dispatch requires production-ready V2 validation evidence before hardware gate", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			seedPreflight(cwd, "seeded-v2-preflight");
			const activeProbeRecordPath = seedActiveProbe(cwd);
			seedCalibration(cwd);
			seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
			const validation = recordRamanHardwareValidation(
				validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "ready-v2-validation"),
				{ cwd, commandId: "record-ready-v2-validation" },
			);
			assert.equal(validation.status, "success");

			const spec = loadSpec("raman-hardware-spec.json");
			const hardwareExecution = {
				stageAdapter: "mc_newton_xyz",
				raman: {
					workflowBackend: "v2_bridge",
					acquisitionBackend: "labspec_file_bridge",
					autofocusBackend: "labspec_file_bridge",
					xyCorrectionBackend: "phase_correlation",
				},
				settleTimeoutMs: 100,
				heartbeatTimeoutMs: 10_000,
				maxConsecutiveErrors: 2,
				approval: {
					approvalId: "appr-v2-real-run",
					operator: "tester",
					approved: true,
					dryRunReportId: "missing-gate-preflight",
					ramanSafety: {
						laserPowerConfirmed: true,
						confirmedLaserPowerMw: 1,
						labSpecWorkerReady: true,
						windowsPowerPolicyReady: true,
					},
				},
			};

			const missingValidation = dispatch("run_experiment", { spec, hardwareExecution }, { cwd, commandId: "missing-v2-evidence" });
			assert.equal(missingValidation.errorCode, "simulated_hardware_not_allowed");
			assert.match(missingValidation.summary, /V2 parity evidence gate/);
			const missingIssues = asRecord(missingValidation.stateAfter).issues as string[];
			assert.ok(missingIssues.some((issue) => issue.includes("v2ValidationId")));

			const withValidation = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						...hardwareExecution,
						raman: { ...hardwareExecution.raman, v2ValidationId: "ready-v2-validation" },
					},
				},
				{ cwd, commandId: "ready-v2-evidence" },
			);
			assert.equal(withValidation.errorCode, "hardware_gate_failed");
			const gateIssues = asRecord(withValidation.stateAfter).issues as string[];
			assert.ok(gateIssues.some((issue) => issue.includes("dry-run preflight")));
			assert.equal(gateIssues.some((issue) => issue.includes("v2ValidationId")), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("real Raman V2 dispatch allows an operator-approved bootstrap validation run before the first v2ValidationId exists", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("raman-v2-real-validation-hardware-spec.json");
			const result = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						raman: {
							workflowBackend: "v2_bridge",
							acquisitionBackend: "labspec_file_bridge",
							autofocusBackend: "labspec_file_bridge",
							xyCorrectionBackend: "phase_correlation",
						},
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: {
							approvalId: "appr-v2-bootstrap-run",
							operator: "tester",
							approved: true,
							dryRunReportId: "missing-bootstrap-preflight",
							bootstrapV2ValidationRun: true,
							ramanSafety: {
								laserPowerConfirmed: true,
								confirmedLaserPowerMw: 1,
								labSpecWorkerReady: true,
								windowsPowerPolicyReady: true,
							},
						},
					},
				},
				{ cwd, commandId: "bootstrap-v2-validation-run" },
			);
			assert.equal(result.errorCode, "hardware_gate_failed");
			const gateIssues = asRecord(result.stateAfter).issues as string[];
			assert.ok(gateIssues.some((issue) => issue.includes("dry-run preflight")));
			assert.equal(gateIssues.some((issue) => issue.includes("v2ValidationId")), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("real Raman V2 dispatch rejects tampered validation evidence before the hardware gate", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			seedPreflight(cwd, "seeded-v2-preflight");
			const activeProbeRecordPath = seedActiveProbe(cwd);
			seedCalibration(cwd);
			seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
			const validation = recordRamanHardwareValidation(
				validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "tampered-v2-validation"),
				{ cwd, commandId: "record-tampered-v2-validation" },
			);
			assert.equal(validation.status, "success");

			writeFileSync(
				join(cwd, ".pi", "experiment-runs", "runs", "seeded-v2-hardware-run", "artifacts", "spectra", "point_0.txt"),
				"tampered spectrum artifact\n",
				"utf-8",
			);

			const spec = loadSpec("raman-hardware-spec.json");
			const result = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						raman: {
							workflowBackend: "v2_bridge",
							v2ValidationId: "tampered-v2-validation",
							acquisitionBackend: "labspec_file_bridge",
							autofocusBackend: "labspec_file_bridge",
							xyCorrectionBackend: "phase_correlation",
						},
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: {
							approvalId: "appr-v2-real-run-tampered",
							operator: "tester",
							approved: true,
							dryRunReportId: "missing-gate-preflight",
							ramanSafety: {
								laserPowerConfirmed: true,
								confirmedLaserPowerMw: 1,
								labSpecWorkerReady: true,
								windowsPowerPolicyReady: true,
							},
						},
					},
				},
				{ cwd, commandId: "tampered-v2-evidence" },
			);
			assert.equal(result.errorCode, "simulated_hardware_not_allowed");
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("evidenceDigest")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("real Raman V2 dispatch rejects thermal waiting until a real thermal backend exists", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			const spec = loadSpec("raman-v2-validation-hardware-spec.json");
			const result = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						raman: {
							workflowBackend: "v2_bridge",
							acquisitionBackend: "labspec_file_bridge",
							autofocusBackend: "labspec_file_bridge",
							xyCorrectionBackend: "phase_correlation",
						},
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: {
							approvalId: "appr-v2-real-run-thermal",
							operator: "tester",
							approved: true,
							dryRunReportId: "missing-gate-preflight",
							ramanSafety: {
								laserPowerConfirmed: true,
								confirmedLaserPowerMw: 1,
								labSpecWorkerReady: true,
								windowsPowerPolicyReady: true,
							},
						},
					},
				},
				{ cwd, commandId: "thermal-v2-evidence" },
			);
			assert.equal(result.errorCode, "simulated_hardware_not_allowed");
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("thermal waiting is not yet supported")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("real Raman V2 dispatch rejects validation evidence that does not cover the requested real-capable spec", () => {
	const cwd = tempCwd();
	return withSimulatedHardwareDisabled(() => {
		try {
			seedPreflight(cwd, "seeded-v2-preflight");
			const activeProbeRecordPath = seedActiveProbe(cwd);
			seedCalibration(cwd);
			seedRamanRun(cwd, "seeded-v2-hardware-run", { workflowBackend: "v2_bridge" });
			const validation = recordRamanHardwareValidation(
				validationParams(activeProbeRecordPath, "seeded-v2-hardware-run", "v2_bridge", "thin-v2-validation"),
				{ cwd, commandId: "record-thin-v2-validation" },
			);
			assert.equal(validation.status, "success");

			const spec = loadSpec("raman-v2-real-validation-hardware-spec.json");
			const result = dispatch(
				"run_experiment",
				{
					spec,
					hardwareExecution: {
						stageAdapter: "mc_newton_xyz",
						raman: {
							workflowBackend: "v2_bridge",
							v2ValidationId: "thin-v2-validation",
							acquisitionBackend: "labspec_file_bridge",
							autofocusBackend: "labspec_file_bridge",
							xyCorrectionBackend: "phase_correlation",
						},
						settleTimeoutMs: 100,
						heartbeatTimeoutMs: 10_000,
						maxConsecutiveErrors: 2,
						approval: {
							approvalId: "appr-v2-real-run-thin",
							operator: "tester",
							approved: true,
							dryRunReportId: "missing-gate-preflight",
							ramanSafety: {
								laserPowerConfirmed: true,
								confirmedLaserPowerMw: 1,
								labSpecWorkerReady: true,
								windowsPowerPolicyReady: true,
							},
						},
					},
				},
				{ cwd, commandId: "thin-v2-evidence" },
			);
			assert.equal(result.errorCode, "simulated_hardware_not_allowed");
			const issues = asRecord(result.stateAfter).issues as string[];
			assert.ok(issues.some((issue) => issue.includes("does not cover autofocus")));
			assert.ok(issues.some((issue) => issue.includes("does not cover XY correction")));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("Raman validation readiness returns structured coverage metadata for matching real-capable validation evidence", () => {
	const cwd = tempCwd();
	try {
		const spec = loadSpec("raman-v2-real-validation-hardware-spec.json");
		seedPreflight(cwd, "seeded-v2-preflight", dryRunVariant(spec));
		const activeProbeRecordPath = seedActiveProbe(cwd);
		seedCalibration(cwd);
		seedRamanRun(cwd, "seeded-v2-real-capable-run", {
			workflowBackend: "v2_bridge",
			spec,
			includeFrameArtifact: true,
			unit: {
				autofocus: { bestZUm: 0.5, confidence: 0.92 },
				xyCorrection: { dxUm: 0.4, dyUm: -0.2, confidence: 0.94 },
			},
		});
		const validation = recordRamanHardwareValidation(
			validationParams(activeProbeRecordPath, "seeded-v2-real-capable-run", "v2_bridge", "coverage-shape-v2-validation"),
			{ cwd, commandId: "record-coverage-shape-v2-validation" },
		);
		assert.equal(validation.status, "success");

		const readiness = validateRamanHardwareValidationReadiness(cwd, "coverage-shape-v2-validation", "v2_bridge", spec);
		assert.equal(readiness.valid, true);
		assert.deepEqual(readiness.uncoveredCapabilities, []);
		assert.deepEqual(readiness.validatedCoverage, {
			autofocus: true,
			xyCorrection: true,
			thermalWait: false,
			acquisition: true,
		});
		assert.deepEqual(readiness.requestedCoverage, {
			autofocus: true,
			xyCorrection: true,
			thermalWait: false,
			acquisition: true,
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
