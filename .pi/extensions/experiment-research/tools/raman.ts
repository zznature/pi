import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { autoFitAndRecordRamanXyCalibration, fitAndRecordRamanXyCalibration, recordRamanXyCalibration } from "../kernel/raman/calibration.ts";
import { runRamanActiveProbe } from "../kernel/raman/probe.ts";
import { recordRamanHardwareValidation, validateRamanHardwareValidationReadiness } from "../kernel/raman/validation.ts";
import { hashExperimentSpec } from "../run-store.ts";
import {
	RamanAutoXyCalibrationParamsSchema,
	RamanFitXyCalibrationParamsSchema,
	RamanHardwareValidationDraftParamsSchema,
	RamanHardwareValidationParamsSchema,
	RamanHardwareValidationReadinessParamsSchema,
	RamanRecordXyCalibrationParamsSchema,
	RamanActiveProbeParamsSchema,
	RamanValidationSpecPairParamsSchema,
	type RamanHardwareValidationDraftParams,
	type RamanHardwareValidationParams,
	type RamanHardwareValidationReadinessParams,
	type RamanValidationSpecPairParams,
	type ToolResult,
	type ValidationIssue,
	validateExperimentSpec,
	validateSchema,
} from "../schemas.ts";
import { deriveDryRunSpecFromHardware } from "../spec-utils.ts";

export const ramanRecordXyCalibrationTool = {
	name: "raman_record_xy_calibration",
	label: "Raman XY Calibration",
	description: "Record an operator-approved Raman XY pixel-to-stage calibration artifact for later transformArtifactId use.",
	promptSnippet: "Record a Raman XY calibration artifact for bounded Raman specs",
	promptGuidelines: [
		"Use raman_record_xy_calibration only as an operator maintenance action.",
		"Reference the returned calibrationId from domain.raman.xyCorrection.transformArtifactId.",
	],
	parameters: RamanRecordXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = recordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanRecordXyCalibrationParamsSchema, ToolResult>;

export const ramanFitXyCalibrationTool = {
	name: "raman_fit_xy_calibration",
	label: "Fit Raman XY Calibration",
	description: "Fit and record an operator-approved Raman XY calibration artifact from stage shifts and frame pairs.",
	promptSnippet: "Fit a Raman XY calibration matrix from approved frame pairs",
	promptGuidelines: [
		"Use raman_fit_xy_calibration only as an operator maintenance action.",
		"Provide at least two non-collinear stage shifts with matching reference/current frame pairs.",
	],
	parameters: RamanFitXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await fitAndRecordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanFitXyCalibrationParamsSchema, ToolResult>;

export const ramanAutoXyCalibrationTool = {
	name: "raman_auto_xy_calibration",
	label: "Auto Raman XY Calibration",
	description: "Run an operator-approved Raman XY calibration sequence that moves the stage, captures frames, fits, and records a calibration artifact.",
	promptSnippet: "Run an approved Raman XY calibration movement/capture sequence",
	promptGuidelines: [
		"Use raman_auto_xy_calibration only as an operator maintenance action.",
		"Use the memory/fake backend for no-hardware checks; use mc_newton_xyz and labspec_file_bridge only during supervised hardware maintenance.",
	],
	parameters: RamanAutoXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await autoFitAndRecordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanAutoXyCalibrationParamsSchema, ToolResult>;

export const ramanActiveProbeTool = {
	name: "raman_active_probe",
	label: "Raman Active Probe",
	description: "Run an operator-approved Raman maintenance smoke probe that may capture a frame or acquire a short spectrum.",
	promptSnippet: "Run an operator-approved Raman active smoke probe and record artifacts",
	promptGuidelines: [
		"Use raman_active_probe only as an operator maintenance action, not during planner-controlled dry runs.",
		"Require explicit operator approval and laser safety confirmation before spectrum smoke acquisition.",
	],
	parameters: RamanActiveProbeParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await runRamanActiveProbe(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanActiveProbeParamsSchema, ToolResult>;

export const ramanHardwareValidationTool = {
	name: "raman_record_hardware_validation",
	label: "Raman Hardware Validation",
	description: "Record operator-reviewed evidence for supervised Raman hardware readiness.",
	promptSnippet: "Record Raman hardware validation evidence after supervised hardware checks",
	promptGuidelines: [
		"Use raman_record_hardware_validation only after operator review of real hardware evidence.",
		"Set hardwareEvidence.evidenceMode to hardware only for supervised LabSpec, camera, acquirer, and MC.Newton evidence.",
		"Do not use fake regression artifacts as production-ready hardware evidence.",
	],
	parameters: RamanHardwareValidationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = recordRamanHardwareValidation(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanHardwareValidationParamsSchema, ToolResult>;

function readinessSuccessResult(toolCallId: string, params: RamanHardwareValidationReadinessParams, readiness: { path: string; productionReady?: boolean }): ToolResult {
	return {
		status: "success",
		summary: `Raman hardware validation ${params.validationId} is ready for workflowBackend ${params.workflowBackend}.`,
		nextActions:
			params.workflowBackend === "v2_bridge"
				? ["Optionally reference this validationId from hardwareExecution.raman.v2ValidationId when the lab wants explicit readiness or traceability linkage."]
				: ["Record the reviewed validationId in operator runbooks before supervised hardware execution."],
		artifacts: [
			{
				id: params.validationId,
				uri: readiness.path,
				label: "Raman hardware validation",
				kind: "hardware-validation",
			},
		],
		commandId: toolCallId,
		correlationId: toolCallId,
		stateAfter: { validationId: params.validationId, workflowBackend: params.workflowBackend, ...readiness },
		stopConditionMet: false,
	};
}

function readinessWarningResult(toolCallId: string, params: RamanHardwareValidationReadinessParams, readiness: ReturnType<typeof validateRamanHardwareValidationReadiness>): ToolResult {
	return {
		status: "warning",
		summary: `Raman hardware validation ${params.validationId} is not ready for workflowBackend ${params.workflowBackend}; ${readiness.issues.length} issue(s) remain.`,
		nextActions: [
			"Review the reported validation issues and referenced evidence files.",
			"Regenerate or re-record the Raman hardware validation evidence before real V2 hardware runs.",
		],
		artifacts: [],
		commandId: toolCallId,
		correlationId: toolCallId,
		stateAfter: { validationId: params.validationId, workflowBackend: params.workflowBackend, ...readiness },
		stopConditionMet: true,
	};
}

export const ramanHardwareValidationReadinessTool = {
	name: "raman_check_hardware_validation",
	label: "Check Raman Hardware Validation",
	description: "Read and re-verify a stored Raman hardware validation record before real hardware execution.",
	promptSnippet: "Check whether a Raman hardware validation record is still usable as real V2 readiness or traceability evidence",
	promptGuidelines: [
		"Use raman_check_hardware_validation before real V2 hardware runs or after evidence files change.",
		"Do not assume a stored productionReady record is still valid without rechecking referenced evidence.",
		"Provide spec when you need to verify that a validation record still covers the candidate real hardware run.",
	],
	parameters: RamanHardwareValidationReadinessParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const readiness = validateRamanHardwareValidationReadiness(ctx.cwd, params.validationId, params.workflowBackend, params.spec);
		const result = readiness.valid ? readinessSuccessResult(toolCallId, params, readiness) : readinessWarningResult(toolCallId, params, readiness);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanHardwareValidationReadinessParamsSchema, ToolResult>;

function normalizedTimestampToken(observedAt: string): string {
	const digits = observedAt.replace(/[^0-9]/g, "");
	return digits.length >= 8 ? digits.slice(0, 14) : "draft";
}

function defaultValidationId(params: RamanHardwareValidationDraftParams): string {
	return `raman-hardware-validation-${normalizedTimestampToken(params.observedAt)}`;
}

function draftReviewChecklist(): string[] {
	return [
		"Set approval.approved to true only after operator review is complete.",
		"Set hardwareEvidence.operatorAttestedRealHardware to true only after confirming the evidence came from real Raman hardware.",
		"Confirm the laser power and update checklist.confirmedLaserPowerMw before recording the validation record.",
		"Mark the remaining checklist booleans true only after reviewing the referenced preflight, probe, run, and artifacts.",
	];
}

function buildValidationDraft(params: RamanHardwareValidationDraftParams): RamanHardwareValidationParams {
	const validationId = params.validationId ?? defaultValidationId(params);
	return {
		validationId,
		approval: {
			approvalId: `appr-${validationId}`,
			operator: params.operator,
			approved: false,
			notes: "Draft generated by raman_prepare_hardware_validation_payload; operator review still required.",
		},
		evidence: {
			readOnlyPreflightReportId: params.evidence.readOnlyPreflightReportId,
			activeProbeRecordPath: params.evidence.activeProbeRecordPath,
			minimumRamanRunId: params.evidence.minimumRamanRunId,
			xyCalibrationId: params.evidence.xyCalibrationId,
			workflowBackend: params.evidence.workflowBackend,
		},
		hardwareEvidence: {
			evidenceMode: "hardware",
			observedAt: params.observedAt,
			operatorAttestedRealHardware: false,
			instrumentIds: params.instrumentIds,
			environmentNotes: params.environmentNotes,
		},
		checklist: {
			laserPowerConfirmed: false,
			confirmedLaserPowerMw: params.confirmedLaserPowerMw ?? 0,
			labSpecWorkerValidated: false,
			cameraStreamValidated: false,
			stageMotionValidated: false,
			windowsPowerPolicyReady: false,
			operatorReviewedArtifacts: false,
		},
		notes: params.notes,
	};
}

export const ramanHardwareValidationDraftTool = {
	name: "raman_prepare_hardware_validation_payload",
	label: "Prepare Raman Hardware Validation Payload",
	description: "Assemble a schema-valid draft payload for raman_record_hardware_validation from reviewed Raman evidence identifiers.",
	promptSnippet: "Prepare a draft Raman hardware validation payload before the operator records a real hardware validation record",
	promptGuidelines: [
		"Use raman_prepare_hardware_validation_payload after you already know the preflight report, active probe record, minimum Raman run, and instrument IDs.",
		"Review and manually confirm the approval, hardware attestation, and checklist booleans before calling raman_record_hardware_validation.",
		"Do not treat the draft payload itself as production-ready validation evidence.",
	],
	parameters: RamanHardwareValidationDraftParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params) {
		const payloadDraft = buildValidationDraft(params);
		const payloadValidation = validateSchema(RamanHardwareValidationParamsSchema, payloadDraft);
		if (!payloadValidation.valid) {
			const result: ToolResult = {
				status: "error",
				summary: `Failed to generate a schema-valid Raman hardware validation draft (${payloadValidation.issues.length} issue(s)).`,
				nextActions: ["Inspect the supplied evidence identifiers and instrument metadata, then regenerate the draft payload."],
				artifacts: [],
				commandId: toolCallId,
				correlationId: toolCallId,
				stateAfter: { valid: false, issues: payloadValidation.issues, payloadDraft },
				errorCode: "invalid_experiment_spec",
				retrySafe: true,
				stopConditionMet: false,
			};
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		}
		const result: ToolResult = {
			status: "success",
			summary: "Prepared a Raman hardware validation payload draft; operator review is still required before recording it.",
			nextActions: draftReviewChecklist(),
			artifacts: [],
			commandId: toolCallId,
			correlationId: toolCallId,
			stateAfter: {
				valid: true,
				draftReadyForRecording: false,
				reviewChecklist: draftReviewChecklist(),
				payloadDraft,
			},
			stopConditionMet: false,
		};
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanHardwareValidationDraftParamsSchema, ToolResult>;

function specPairCoverage(spec: RamanValidationSpecPairParams["spec"]): {
	autofocus: boolean;
	xyCorrection: boolean;
	thermalWait: boolean;
	acquisition: boolean;
} {
	return {
		autofocus: spec.domain?.raman?.autofocus?.enabled === true,
		xyCorrection: spec.domain?.raman?.xyCorrection?.enabled === true,
		thermalWait: spec.domain?.thermal?.enabled === true && spec.domain.thermal.waitBeforeAcquisition !== false,
		acquisition: !!spec.domain?.raman?.acquisition,
	};
}

function specPairCoverageIssues(coverage: ReturnType<typeof specPairCoverage>): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!coverage.autofocus) {
		issues.push({ path: "spec.domain.raman.autofocus", message: "minimum V2 validation spec should enable autofocus coverage" });
	}
	if (!coverage.xyCorrection) {
		issues.push({ path: "spec.domain.raman.xyCorrection", message: "minimum V2 validation spec should enable XY correction coverage" });
	}
	if (!coverage.acquisition) {
		issues.push({ path: "spec.domain.raman.acquisition", message: "minimum V2 validation spec should include Raman acquisition settings" });
	}
	return issues;
}

function specPairRuntimeIssues(spec: RamanValidationSpecPairParams["spec"]): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (spec.domain?.thermal?.enabled === true && spec.domain.thermal.waitBeforeAcquisition !== false) {
		issues.push({
			path: "spec.domain.thermal.waitBeforeAcquisition",
			message: "current real Raman runtime cannot execute thermal waiting because the thermal backend is fake-only",
		});
	}
	return issues;
}

function specPairErrorResult(toolCallId: string, summary: string, stateAfter: unknown, nextActions: string[]): ToolResult {
	return {
		status: "error",
		summary,
		nextActions,
		artifacts: [],
		commandId: toolCallId,
		correlationId: toolCallId,
		stateAfter,
		errorCode: "invalid_experiment_spec",
		retrySafe: true,
		stopConditionMet: false,
	};
}

export const ramanValidationSpecPairTool = {
	name: "raman_prepare_validation_spec_pair",
	label: "Prepare Raman Validation Spec Pair",
	description: "Derive a dry-run pair from a Raman hardware validation spec and verify canonical specHash parity.",
	promptSnippet: "Prepare a dry-run partner spec for a Raman hardware validation run",
	promptGuidelines: [
		"Use raman_prepare_validation_spec_pair before real Raman V2 validation runs to derive a matching dry-run preflight spec.",
		"Review the returned capabilityCoverage and keep the dry-run pair aligned with the minimum auditable hardware spec.",
	],
	parameters: RamanValidationSpecPairParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params) {
		const hardwareValidation = validateExperimentSpec(params.spec);
		if (!hardwareValidation.valid) {
			const result = specPairErrorResult(
				toolCallId,
				`Raman validation hardware spec failed validation with ${hardwareValidation.issues.length} issue(s).`,
				{ valid: false, issues: hardwareValidation.issues },
				["Fix the hardware spec issues before deriving a dry-run validation pair."],
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		}
		if (params.spec.mode !== "hardware") {
			const result = specPairErrorResult(
				toolCallId,
				"Raman validation spec pair preparation requires a hardware-mode ExperimentSpec.",
				{ valid: false, issues: [{ path: "spec.mode", message: "spec.mode must be hardware" }] },
				["Provide the hardware validation spec, not a dry_run or simulation spec."],
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		}
		if (!params.spec.domain?.raman) {
			const result = specPairErrorResult(
				toolCallId,
				"Raman validation spec pair preparation requires a Raman ExperimentSpec.",
				{ valid: false, issues: [{ path: "spec.domain.raman", message: "Raman domain is required" }] },
				["Provide a Raman hardware validation spec with domain.raman configured."],
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		}
		const dryRunSpec = deriveDryRunSpecFromHardware(params.spec);
		const dryRunValidation = validateExperimentSpec(dryRunSpec);
		if (!dryRunValidation.valid) {
			const result = specPairErrorResult(
				toolCallId,
				`Derived Raman dry-run spec failed validation with ${dryRunValidation.issues.length} issue(s).`,
				{ valid: false, issues: dryRunValidation.issues, dryRunSpec },
				["Fix the hardware validation spec until its derived dry-run pair validates cleanly."],
			);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		}
		const hardwareSpecHash = hashExperimentSpec(params.spec);
		const dryRunSpecHash = hashExperimentSpec(dryRunSpec);
		const capabilityCoverage = specPairCoverage(params.spec);
		const coverageIssues = specPairCoverageIssues(capabilityCoverage);
		const runtimeIssues = specPairRuntimeIssues(params.spec);
		const hashesMatch = hardwareSpecHash === dryRunSpecHash;
		const stateAfter = {
			valid: hashesMatch && coverageIssues.length === 0 && runtimeIssues.length === 0,
			hardwareSpecHash,
			dryRunSpecHash,
			hashesMatch,
			dryRunSpec,
			capabilityCoverage,
			issues: [...coverageIssues, ...runtimeIssues],
		};
		const result: ToolResult = !hashesMatch
			? {
					status: "warning",
					summary: "Derived Raman dry-run validation spec does not match the hardware spec hash family.",
					nextActions: [
						"Do not use this pair for preflight evidence until the hardware and dry-run specs hash-match.",
						"Inspect fields beyond mode that changed the canonical spec hash.",
					],
					artifacts: [],
					commandId: toolCallId,
					correlationId: toolCallId,
					stateAfter,
					stopConditionMet: true,
				}
			: runtimeIssues.length > 0
				? {
						status: "warning",
						summary: `Derived Raman dry-run validation spec hash-matches, but the current real runtime cannot execute all enabled capabilities (${runtimeIssues.length} issue(s)).`,
						nextActions: [
							"Disable thermal waiting for the current real G8.5 validation run, or implement a real thermal backend before claiming full-surface parity.",
							"Keep the returned dryRunSpec paired with the hardware spec family after adjusting unsupported runtime capabilities.",
						],
						artifacts: [],
						commandId: toolCallId,
						correlationId: toolCallId,
						stateAfter,
						stopConditionMet: true,
					}
				: coverageIssues.length > 0
					? {
							status: "warning",
							summary: `Derived Raman dry-run validation spec hash-matches, but the hardware spec is too narrow for full V2 validation coverage (${coverageIssues.length} issue(s)).`,
							nextActions: [
								"Enable autofocus, XY correction, thermal wait, and acquisition coverage before using this spec as the G8.5 minimum auditable run.",
								"Use the returned dryRunSpec only after the hardware validation spec covers the intended V2 workflow surface.",
							],
							artifacts: [],
							commandId: toolCallId,
							correlationId: toolCallId,
							stateAfter,
							stopConditionMet: true,
						}
					: {
						status: "success",
						summary: "Derived Raman dry-run validation spec matches the hardware validation spec family and covers the full V2 validation surface.",
						nextActions: [
							"Use the returned dryRunSpec with run_preflight before the real hardware validation run.",
							"Keep capabilityCoverage unchanged when adapting coordinates, IDs, or environment details on site.",
						],
						artifacts: [],
						commandId: toolCallId,
						correlationId: toolCallId,
						stateAfter,
							stopConditionMet: false,
						};
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanValidationSpecPairParamsSchema, ToolResult>;
