import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createErrorResult, createSuccessResult } from "../results.ts";
import { artifactUriPath, hashExperimentSpec, readRecordedEvents, readRecordedSpec, readRecordedSummary } from "../run-store.ts";
import {
	type ExperimentSpec,
	RamanHardwareValidationParamsSchema,
	type RamanHardwareValidationParams,
	type ToolResult,
	type ValidationIssue,
	validateSchema,
} from "../schemas.ts";
import { getRamanValidationCoverage, type RamanValidationCoverage } from "../spec-utils.ts";
import { resolveRamanXyCalibration } from "./raman-calibration.ts";

interface HardwareValidationRecord {
	schemaVersion: "1";
	validationId: string;
	createdAt: string;
	approval: RamanHardwareValidationParams["approval"];
	evidence: RamanHardwareValidationParams["evidence"];
	evidenceDigest: HardwareValidationEvidenceDigest;
	validatedCoverage?: RamanValidationCoverage;
	hardwareEvidence: RamanHardwareValidationParams["hardwareEvidence"];
	checklist: RamanHardwareValidationParams["checklist"];
	issues: ValidationIssue[];
	productionReady: boolean;
	notes?: string;
}

export interface RamanHardwareValidationReadiness {
	valid: boolean;
	issues: ValidationIssue[];
	path: string;
	productionReady?: boolean;
	validatedCoverage?: RamanValidationCoverage;
	requestedCoverage?: RamanValidationCoverage;
	uncoveredCapabilities?: string[];
}

interface HardwareValidationEvidenceDigest {
	specHash: {
		preflight?: string;
		minimumRun?: string;
	};
	files: HardwareValidationEvidenceFileDigest[];
}

interface HardwareValidationEvidenceFileDigest {
	role: string;
	path: string;
	sha256?: string;
	missing?: true;
}

function readCoverage(record: Record<string, unknown>, key: string): RamanValidationCoverage | undefined {
	const value = record[key];
	if (!isRecord(value)) return undefined;
	return {
		autofocus: booleanField(value, "autofocus") === true,
		xyCorrection: booleanField(value, "xyCorrection") === true,
		thermalWait: booleanField(value, "thermalWait") === true,
		acquisition: booleanField(value, "acquisition") === true,
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function relativeToCwd(cwd: string, path: string): string {
	const result = relative(cwd, path);
	return artifactUriPath(result.startsWith("..") ? path : result);
}

function validationPath(cwd: string, validationId: string): string {
	return join(cwd, ".pi", "experiment-runs", "lab", "validations", `${validationId}.json`);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function prefixedIssues(prefix: string, issues: ValidationIssue[]): ValidationIssue[] {
	return issues.map((issue) => ({ path: `${prefix}.${issue.path}`, message: issue.message }));
}

function preflightPath(cwd: string, reportId: string): string {
	return join(cwd, ".pi", "experiment-runs", "preflights", reportId, "preflight.json");
}

function runEvidencePath(cwd: string, runId: string, fileName: string): string {
	return join(cwd, ".pi", "experiment-runs", "runs", runId, fileName);
}

function resolveEvidencePath(cwd: string, value: string): string {
	return resolve(cwd, value);
}

function sha256File(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function evidenceFileDigest(cwd: string, role: string, path: string): HardwareValidationEvidenceFileDigest {
	const sha256 = sha256File(path);
	const digest: HardwareValidationEvidenceFileDigest = {
		role,
		path: relativeToCwd(cwd, path),
	};
	if (sha256) {
		digest.sha256 = sha256;
	} else {
		digest.missing = true;
	}
	return digest;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonIfExists(path: string): unknown | undefined {
	if (!existsSync(path)) return undefined;
	return readJson(path);
}

function activeProbeArtifactPaths(cwd: string, pathValue: string): { role: string; path: string }[] {
	const path = resolveEvidencePath(cwd, pathValue);
	const parsed = readJsonIfExists(path);
	if (!isRecord(parsed) || !isRecord(parsed.result) || !Array.isArray(parsed.result.artifacts)) return [];
	const paths: { role: string; path: string }[] = [];
	for (const artifact of parsed.result.artifacts) {
		if (!isRecord(artifact) || typeof artifact.path !== "string") continue;
		const kind = typeof artifact.kind === "string" ? artifact.kind : "artifact";
		paths.push({ role: `active-probe-${kind}`, path: resolveEvidencePath(cwd, artifact.path) });
	}
	return paths;
}

function runSpectrumArtifactPaths(cwd: string, runId: string): { role: string; path: string }[] {
	const artifacts = readJsonIfExists(runEvidencePath(cwd, runId, "artifacts.json"));
	if (!Array.isArray(artifacts)) return [];
	const paths: { role: string; path: string }[] = [];
	for (const artifact of artifacts) {
		if (!isRecord(artifact) || artifact.kind !== "spectrum" || typeof artifact.uri !== "string") continue;
		const id = typeof artifact.id === "string" ? artifact.id : "spectrum";
		paths.push({ role: `minimum-run-${id}`, path: resolveEvidencePath(cwd, artifact.uri) });
	}
	return paths;
}

function runArtifactPaths(cwd: string, runId: string, kind: string): { role: string; path: string }[] {
	const artifacts = readJsonIfExists(runEvidencePath(cwd, runId, "artifacts.json"));
	if (!Array.isArray(artifacts)) return [];
	const paths: { role: string; path: string }[] = [];
	for (const artifact of artifacts) {
		if (!isRecord(artifact) || artifact.kind !== kind || typeof artifact.uri !== "string") continue;
		const id = typeof artifact.id === "string" ? artifact.id : kind;
		paths.push({ role: `minimum-run-${id}`, path: resolveEvidencePath(cwd, artifact.uri) });
	}
	return paths;
}

function collectChecklistIssues(params: RamanHardwareValidationParams): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!params.approval.approved) {
		issues.push({ path: "approval.approved", message: "Hardware validation requires approved operator approval" });
	}
	for (const [key, value] of Object.entries(params.checklist)) {
		if (key === "confirmedLaserPowerMw") continue;
		if (value !== true) {
			issues.push({ path: `checklist.${key}`, message: `${key} must be confirmed for Raman hardware validation` });
		}
	}
	return issues;
}

function collectHardwareEvidenceIssues(params: RamanHardwareValidationParams): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (params.hardwareEvidence.evidenceMode !== "hardware") {
		issues.push({ path: "hardwareEvidence.evidenceMode", message: "Production-ready validation requires hardware evidence mode" });
	}
	if (params.hardwareEvidence.operatorAttestedRealHardware !== true) {
		issues.push({
			path: "hardwareEvidence.operatorAttestedRealHardware",
			message: "Operator must attest that the evidence was observed on real Raman hardware",
		});
	}
	if (Number.isNaN(Date.parse(params.hardwareEvidence.observedAt))) {
		issues.push({ path: "hardwareEvidence.observedAt", message: "observedAt must be a valid timestamp" });
	}
	return issues;
}

function collectPreflightIssues(cwd: string, reportId: string): ValidationIssue[] {
	const path = preflightPath(cwd, reportId);
	if (!existsSync(path)) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: `Preflight report not found: ${reportId}` }];
	}
	const parsed = readJson(path);
	if (!isRecord(parsed)) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Preflight report is malformed" }];
	}
	const result = parsed.result;
	if (!isRecord(result) || result.valid !== true) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced read-only preflight did not pass" }];
	}
	const spec = parsed.spec;
	if (!isRecord(spec) || spec.mode !== "dry_run") {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced preflight must be a dry_run report" }];
	}
	if (!isRecord(spec.domain) || !isRecord(spec.domain.raman)) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced preflight must be a Raman dry-run report" }];
	}
	const liveState = result.liveState;
	if (!isRecord(liveState) || !isRecord(liveState.readOnlyProbe)) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced Raman preflight must include a read-only probe" }];
	}
	const readOnlyProbe = liveState.readOnlyProbe;
	if (readOnlyProbe.readOnly !== true) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced Raman preflight probe must be read-only" }];
	}
	if (!isRecord(readOnlyProbe.stage) || readOnlyProbe.stage.reachable !== true) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced Raman preflight must show reachable stage" }];
	}
	if (!isRecord(readOnlyProbe.labspecWorker) || readOnlyProbe.labspecWorker.reachable !== true) {
		return [{ path: "evidence.readOnlyPreflightReportId", message: "Referenced Raman preflight must show reachable LabSpec worker" }];
	}
	return [];
}

function collectActiveProbeIssues(cwd: string, pathValue: string): ValidationIssue[] {
	const path = resolveEvidencePath(cwd, pathValue);
	if (!existsSync(path)) {
		return [{ path: "evidence.activeProbeRecordPath", message: `Active probe record not found: ${pathValue}` }];
	}
	const parsed = readJson(path);
	if (!isRecord(parsed) || !isRecord(parsed.result)) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record is malformed" }];
	}
	if (parsed.result.readOnly !== false || parsed.result.requiresOperatorApproval !== true) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record must be an operator-approved active smoke probe" }];
	}
	const sideEffects = parsed.result.sideEffects;
	if (!Array.isArray(sideEffects) || sideEffects.length === 0) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record has no side effects" }];
	}
	if (sideEffects.some((sideEffect) => typeof sideEffect === "string" && sideEffect.startsWith("synthetic_"))) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record uses synthetic side effects" }];
	}
	if (!sideEffects.includes("labspec_frame_captured")) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record must include LabSpec frame capture" }];
	}
	if (!sideEffects.includes("spectrum_smoke_acquired")) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record must include spectrum smoke acquisition" }];
	}
	const artifacts = parsed.result.artifacts;
	let hasLabspecFrameArtifact = false;
	let hasLabspecSpectrumArtifact = false;
	if (Array.isArray(artifacts)) {
		for (const artifact of artifacts) {
			if (!isRecord(artifact)) continue;
			if (artifact.backend === "fake") {
				return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record uses fake backend artifacts" }];
			}
			if (artifact.kind === "frame" && artifact.backend === "labspec_file_bridge") {
				hasLabspecFrameArtifact = true;
			}
			if (artifact.kind === "spectrum" && artifact.backend === "labspec_file_bridge") {
				hasLabspecSpectrumArtifact = true;
			}
		}
	}
	if (!hasLabspecFrameArtifact) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record must include a LabSpec frame artifact" }];
	}
	if (!hasLabspecSpectrumArtifact) {
		return [{ path: "evidence.activeProbeRecordPath", message: "Active probe record must include a LabSpec spectrum artifact" }];
	}
	return [];
}

function collectRunIssues(
	cwd: string,
	runId: string,
	workflowBackend: RamanHardwareValidationParams["evidence"]["workflowBackend"],
): ValidationIssue[] {
	const summary = readRecordedSummary(cwd, runId);
	const spec = readRecordedSpec(cwd, runId);
	const events = readRecordedEvents(cwd, runId);
	const issues: ValidationIssue[] = [];
	if (!summary || !isRecord(summary)) {
		issues.push({ path: "evidence.minimumRamanRunId", message: `Run summary not found: ${runId}` });
	} else if (summary.status !== "completed") {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum Raman run must be completed" });
	}
	if (!spec) {
		issues.push({ path: "evidence.minimumRamanRunId", message: `Run spec not found: ${runId}` });
	} else if (!spec.domain?.raman) {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum run must be a Raman run" });
	}
	const runStarted = events.find((event) => event.type === "run_started");
	if (!runStarted || !isRecord(runStarted) || runStarted.stageAdapter !== "mc_newton_xyz") {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum Raman run must use the real MC.Newton stage adapter" });
	}
	const unitRecords = events
		.filter((event) => event.type === "unit_completed")
		.map((event) => event.unit)
		.filter(isRecord);
	if (unitRecords.length === 0) {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum Raman run must include at least one completed Raman unit" });
	}
	if (!unitRecords.some((unit) => isRecord(unit.spectrumMetadata) && unit.spectrumMetadata.backend === "labspec_file_bridge")) {
		issues.push({
			path: "evidence.minimumRamanRunId",
			message: "Minimum Raman run must include LabSpec file-bridge spectrum metadata",
		});
	}
	if (unitRecords.some((unit) => isRecord(unit.spectrumMetadata) && unit.spectrumMetadata.backend === "fake")) {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum Raman run uses fake acquisition backend" });
	}
	if (workflowBackend) {
		const hasExpectedWorkflowBackend = events.some((event) => isRecord(event) && event.workflowBackend === workflowBackend);
		if (!hasExpectedWorkflowBackend) {
			issues.push({
				path: "evidence.workflowBackend",
				message: `Minimum Raman run must include workflowBackend ${workflowBackend} evidence`,
			});
		}
	}
	if (workflowBackend === "v2_bridge" && spec) {
		const expectsAutofocus = spec.domain?.raman?.autofocus?.enabled === true;
		const expectsXyCorrection = spec.domain?.raman?.xyCorrection?.enabled === true;
		const expectsThermal = spec.domain?.thermal?.enabled === true && spec.domain.thermal.waitBeforeAcquisition !== false;
		if (expectsAutofocus && !unitRecords.some((unit) => isRecord(unit.autofocus))) {
			issues.push({
				path: "evidence.minimumRamanRunId",
				message: "V2 parity evidence requires minimum Raman run autofocus records when autofocus is enabled",
			});
		}
		if (expectsXyCorrection && !unitRecords.some((unit) => isRecord(unit.xyCorrection))) {
			issues.push({
				path: "evidence.minimumRamanRunId",
				message: "V2 parity evidence requires minimum Raman run XY correction records when xyCorrection is enabled",
			});
		}
		if (expectsThermal && !unitRecords.some((unit) => isRecord(unit.thermal))) {
			issues.push({
				path: "evidence.minimumRamanRunId",
				message: "V2 parity evidence requires minimum Raman run thermal records when thermal waiting is enabled",
			});
		}
		if ((expectsAutofocus || expectsXyCorrection) && runArtifactPaths(cwd, runId, "frame").length === 0) {
			issues.push({
				path: "evidence.minimumRamanRunId",
				message: "V2 parity evidence requires minimum Raman run frame artifacts for autofocus/XY diagnostics",
			});
		}
	}
	return issues;
}

function readPreflightSpecHash(cwd: string, reportId: string): string | undefined {
	const path = preflightPath(cwd, reportId);
	if (!existsSync(path)) return undefined;
	const parsed = readJson(path);
	if (!isRecord(parsed)) return undefined;
	if (typeof parsed.specHash === "string") return parsed.specHash;
	const result = parsed.result;
	if (isRecord(result) && typeof result.specHash === "string") return result.specHash;
	return undefined;
}

function collectEvidenceChainIssues(cwd: string, reportId: string, runId: string): ValidationIssue[] {
	const preflightSpecHash = readPreflightSpecHash(cwd, reportId);
	const runSpec = readRecordedSpec(cwd, runId);
	if (!preflightSpecHash || !runSpec) return [];
	if (preflightSpecHash !== hashExperimentSpec(runSpec)) {
		return [
			{
				path: "evidence",
				message: "Read-only preflight and minimum Raman run must reference the same ExperimentSpec hash",
			},
		];
	}
	return [];
}

function collectCalibrationIssues(cwd: string, calibrationId: string | undefined): ValidationIssue[] {
	if (!calibrationId) return [];
	const resolution = resolveRamanXyCalibration(cwd, calibrationId);
	return resolution.ok ? [] : resolution.issues;
}

function collectArtifactFileIssues(cwd: string, params: RamanHardwareValidationParams): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	for (const artifact of activeProbeArtifactPaths(cwd, params.evidence.activeProbeRecordPath)) {
		if (!existsSync(artifact.path)) {
			issues.push({ path: "evidence.activeProbeRecordPath", message: `Active probe artifact not found: ${artifact.path}` });
		}
	}
	const spectrumArtifacts = runSpectrumArtifactPaths(cwd, params.evidence.minimumRamanRunId);
	if (spectrumArtifacts.length === 0) {
		issues.push({ path: "evidence.minimumRamanRunId", message: "Minimum Raman run must include spectrum artifact files" });
	}
	for (const artifact of spectrumArtifacts) {
		if (!existsSync(artifact.path)) {
			issues.push({ path: "evidence.minimumRamanRunId", message: `Minimum Raman run spectrum artifact not found: ${artifact.path}` });
		}
	}
	if (params.evidence.workflowBackend === "v2_bridge") {
		for (const artifact of runArtifactPaths(cwd, params.evidence.minimumRamanRunId, "frame")) {
			if (!existsSync(artifact.path)) {
				issues.push({ path: "evidence.minimumRamanRunId", message: `Minimum Raman run frame artifact not found: ${artifact.path}` });
			}
		}
	}
	return issues;
}

function buildEvidenceDigest(cwd: string, params: RamanHardwareValidationParams): HardwareValidationEvidenceDigest {
	const files = [
		evidenceFileDigest(cwd, "read-only-preflight", preflightPath(cwd, params.evidence.readOnlyPreflightReportId)),
		evidenceFileDigest(cwd, "active-probe", resolveEvidencePath(cwd, params.evidence.activeProbeRecordPath)),
		evidenceFileDigest(cwd, "minimum-run-spec", runEvidencePath(cwd, params.evidence.minimumRamanRunId, "spec.json")),
		evidenceFileDigest(cwd, "minimum-run-summary", runEvidencePath(cwd, params.evidence.minimumRamanRunId, "summary.json")),
		evidenceFileDigest(cwd, "minimum-run-events", runEvidencePath(cwd, params.evidence.minimumRamanRunId, "events.jsonl")),
	];
	if (params.evidence.xyCalibrationId) {
		files.push(evidenceFileDigest(cwd, "xy-calibration", join(cwd, ".pi", "experiment-runs", "lab", "calibrations", `${params.evidence.xyCalibrationId}.json`)));
	}
	for (const artifact of activeProbeArtifactPaths(cwd, params.evidence.activeProbeRecordPath)) {
		files.push(evidenceFileDigest(cwd, artifact.role, artifact.path));
	}
	for (const artifact of runSpectrumArtifactPaths(cwd, params.evidence.minimumRamanRunId)) {
		files.push(evidenceFileDigest(cwd, artifact.role, artifact.path));
	}
	if (params.evidence.workflowBackend === "v2_bridge") {
		for (const artifact of runArtifactPaths(cwd, params.evidence.minimumRamanRunId, "frame")) {
			files.push(evidenceFileDigest(cwd, artifact.role, artifact.path));
		}
	}
	const runSpec = readRecordedSpec(cwd, params.evidence.minimumRamanRunId);
	const specHash: HardwareValidationEvidenceDigest["specHash"] = {};
	const preflightSpecHash = readPreflightSpecHash(cwd, params.evidence.readOnlyPreflightReportId);
	if (preflightSpecHash) specHash.preflight = preflightSpecHash;
	if (runSpec) specHash.minimumRun = hashExperimentSpec(runSpec);
	return { specHash, files };
}

function collectEvidenceDigestIssues(
	stored: unknown,
	current: HardwareValidationEvidenceDigest,
): ValidationIssue[] {
	if (!isRecord(stored)) {
		return [{ path: "raman.v2ValidationId", message: "Raman hardware validation record is missing evidenceDigest" }];
	}
	const issues: ValidationIssue[] = [];
	const storedSpecHash = isRecord(stored.specHash) ? stored.specHash : {};
	if (stringField(storedSpecHash, "preflight") !== current.specHash.preflight) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation preflight specHash no longer matches referenced evidence" });
	}
	if (stringField(storedSpecHash, "minimumRun") !== current.specHash.minimumRun) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation minimum-run specHash no longer matches referenced evidence" });
	}
	if (!Array.isArray(stored.files)) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record is missing evidenceDigest.files" });
		return issues;
	}
	const storedEntries = new Map<string, HardwareValidationEvidenceFileDigest>();
	for (const entry of stored.files) {
		if (!isRecord(entry) || typeof entry.role !== "string" || typeof entry.path !== "string") {
			issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record contains malformed evidenceDigest file entries" });
			continue;
		}
		storedEntries.set(`${entry.role}::${entry.path}`, {
			role: entry.role,
			path: entry.path,
			sha256: stringField(entry, "sha256"),
			missing: booleanField(entry, "missing") === true ? true : undefined,
		});
	}
	const currentEntries = new Map(current.files.map((entry) => [`${entry.role}::${entry.path}`, entry] satisfies [string, HardwareValidationEvidenceFileDigest]));
	for (const [key, storedEntry] of storedEntries) {
		const currentEntry = currentEntries.get(key);
		if (!currentEntry) {
			issues.push({
				path: "raman.v2ValidationId",
				message: `Raman hardware validation evidenceDigest is missing current evidence entry ${storedEntry.role}`,
			});
			continue;
		}
		if (storedEntry.sha256 !== currentEntry.sha256 || storedEntry.missing !== currentEntry.missing) {
			issues.push({
				path: "raman.v2ValidationId",
				message: `Raman hardware validation evidenceDigest no longer matches current evidence for ${storedEntry.role}`,
			});
		}
	}
	for (const [key, currentEntry] of currentEntries) {
		if (!storedEntries.has(key)) {
			issues.push({
				path: "raman.v2ValidationId",
				message: `Raman hardware validation evidenceDigest is missing stored coverage for ${currentEntry.role}`,
			});
		}
	}
	return issues;
}

function collectTargetSpecCoverageIssues(validatedSpec: ExperimentSpec | undefined, targetSpec: ExperimentSpec): ValidationIssue[] {
	if (!validatedSpec) return [];
	const validatedCoverage = getRamanValidationCoverage(validatedSpec);
	const targetCoverage = getRamanValidationCoverage(targetSpec);
	const issues: ValidationIssue[] = [];
	if (targetCoverage.autofocus && !validatedCoverage.autofocus) {
		issues.push({
			path: "raman.v2ValidationId",
			message: "Raman hardware validation record does not cover autofocus required by the requested Raman spec",
		});
	}
	if (targetCoverage.xyCorrection && !validatedCoverage.xyCorrection) {
		issues.push({
			path: "raman.v2ValidationId",
			message: "Raman hardware validation record does not cover XY correction required by the requested Raman spec",
		});
	}
	if (targetCoverage.thermalWait && !validatedCoverage.thermalWait) {
		issues.push({
			path: "raman.v2ValidationId",
			message: "Raman hardware validation record does not cover thermal waiting required by the requested Raman spec",
		});
	}
	if (targetCoverage.acquisition && !validatedCoverage.acquisition) {
		issues.push({
			path: "raman.v2ValidationId",
			message: "Raman hardware validation record does not cover Raman acquisition required by the requested Raman spec",
		});
	}
	return issues;
}

function uncoveredCapabilities(
	validatedCoverage: RamanValidationCoverage | undefined,
	targetCoverage: RamanValidationCoverage | undefined,
): string[] {
	if (!validatedCoverage || !targetCoverage) return [];
	const missing: string[] = [];
	if (targetCoverage.autofocus && !validatedCoverage.autofocus) missing.push("autofocus");
	if (targetCoverage.xyCorrection && !validatedCoverage.xyCorrection) missing.push("xyCorrection");
	if (targetCoverage.thermalWait && !validatedCoverage.thermalWait) missing.push("thermalWait");
	if (targetCoverage.acquisition && !validatedCoverage.acquisition) missing.push("acquisition");
	return missing;
}

function collectStoredCoverageIssues(stored: RamanValidationCoverage | undefined, current: RamanValidationCoverage | undefined): ValidationIssue[] {
	if (!current) return [];
	if (!stored) {
		return [{ path: "raman.v2ValidationId", message: "Raman hardware validation record is missing validatedCoverage metadata" }];
	}
	const issues: ValidationIssue[] = [];
	if (stored.autofocus !== current.autofocus) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record validatedCoverage.autofocus no longer matches the referenced minimum run spec" });
	}
	if (stored.xyCorrection !== current.xyCorrection) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record validatedCoverage.xyCorrection no longer matches the referenced minimum run spec" });
	}
	if (stored.thermalWait !== current.thermalWait) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record validatedCoverage.thermalWait no longer matches the referenced minimum run spec" });
	}
	if (stored.acquisition !== current.acquisition) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record validatedCoverage.acquisition no longer matches the referenced minimum run spec" });
	}
	return issues;
}

export function recordRamanHardwareValidation(
	params: RamanHardwareValidationParams,
	ctx: { cwd: string; commandId: string },
): ToolResult {
	const validationId = params.validationId ?? `raman-validation-${randomUUID().slice(0, 8)}`;
	const issues = [
		...collectChecklistIssues(params),
		...collectHardwareEvidenceIssues(params),
		...collectPreflightIssues(ctx.cwd, params.evidence.readOnlyPreflightReportId),
		...collectActiveProbeIssues(ctx.cwd, params.evidence.activeProbeRecordPath),
		...collectRunIssues(ctx.cwd, params.evidence.minimumRamanRunId, params.evidence.workflowBackend),
		...collectEvidenceChainIssues(ctx.cwd, params.evidence.readOnlyPreflightReportId, params.evidence.minimumRamanRunId),
		...collectCalibrationIssues(ctx.cwd, params.evidence.xyCalibrationId),
		...collectArtifactFileIssues(ctx.cwd, params),
	];
	const productionReady = issues.length === 0;
	const minimumRunSpec = readRecordedSpec(ctx.cwd, params.evidence.minimumRamanRunId);
	const record: HardwareValidationRecord = {
		schemaVersion: "1",
		validationId,
		createdAt: nowIso(),
		approval: params.approval,
		evidence: params.evidence,
		evidenceDigest: buildEvidenceDigest(ctx.cwd, params),
		validatedCoverage: minimumRunSpec ? getRamanValidationCoverage(minimumRunSpec) : undefined,
		hardwareEvidence: params.hardwareEvidence,
		checklist: params.checklist,
		issues,
		productionReady,
	};
	if (params.notes) record.notes = params.notes;
	const path = validationPath(ctx.cwd, validationId);
	mkdirSync(join(ctx.cwd, ".pi", "experiment-runs", "lab", "validations"), { recursive: true });
	writeJson(path, record);
	const result = createSuccessResult(
		ctx.commandId,
		productionReady
			? `Recorded Raman hardware validation ${validationId}; evidence is production-ready.`
			: `Recorded Raman hardware validation ${validationId}; ${issues.length} issue(s) remain.`,
		{ validationId, productionReady, issues, path, evidenceDigest: record.evidenceDigest },
		productionReady
			? ["Use this validation record as evidence for supervised Raman hardware readiness."]
			: ["Resolve validation issues before treating Raman hardware as production-ready."],
		[{ id: validationId, uri: relativeToCwd(ctx.cwd, path), label: "Raman hardware validation", kind: "hardware-validation" }],
	);
	if (productionReady) return result;
	return { ...result, status: "warning", stopConditionMet: true };
}

export function validateRamanHardwareValidationReadiness(
	cwd: string,
	validationId: string,
	workflowBackend: NonNullable<RamanHardwareValidationParams["evidence"]["workflowBackend"]>,
	targetSpec?: ExperimentSpec,
): RamanHardwareValidationReadiness {
	const path = validationPath(cwd, validationId);
	if (!existsSync(path)) {
		return {
			valid: false,
			path,
			issues: [{ path: "raman.v2ValidationId", message: `Raman hardware validation record not found: ${validationId}` }],
		};
	}
	let parsed: unknown;
	try {
		parsed = readJson(path);
	} catch {
		return {
			valid: false,
			path,
			issues: [{ path: "raman.v2ValidationId", message: "Raman hardware validation record is not valid JSON" }],
		};
	}
	if (!isRecord(parsed)) {
		return {
			valid: false,
			path,
			issues: [{ path: "raman.v2ValidationId", message: "Raman hardware validation record is malformed" }],
		};
	}
	const issues: ValidationIssue[] = [];
	const productionReady = booleanField(parsed, "productionReady");
	if (stringField(parsed, "schemaVersion") !== "1") {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record has an unsupported schemaVersion" });
	}
	if (stringField(parsed, "validationId") !== validationId) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record id does not match the requested validation id" });
	}
	if (productionReady !== true) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record is not production-ready" });
	}
	if (Array.isArray(parsed.issues) && parsed.issues.length > 0) {
		issues.push({ path: "raman.v2ValidationId", message: "Raman hardware validation record still contains unresolved issues" });
	}
	const recordParams = validateSchema(RamanHardwareValidationParamsSchema, {
		validationId,
		approval: parsed.approval,
		evidence: parsed.evidence,
		hardwareEvidence: parsed.hardwareEvidence,
		checklist: parsed.checklist,
		notes: stringField(parsed, "notes"),
	});
	if (!recordParams.valid) {
		issues.push(
			...prefixedIssues("raman.v2ValidationId", recordParams.issues).map((issue) => ({
				path: issue.path,
				message: `Raman hardware validation record is malformed: ${issue.message}`,
			})),
		);
		return { valid: false, issues, path, productionReady };
	}
	const evidence = recordParams.value.evidence;
	const minimumRunSpec = readRecordedSpec(cwd, evidence.minimumRamanRunId);
	const validatedCoverage = minimumRunSpec ? getRamanValidationCoverage(minimumRunSpec) : undefined;
	const requestedCoverage = targetSpec ? getRamanValidationCoverage(targetSpec) : undefined;
	if (evidence.workflowBackend !== workflowBackend) {
		issues.push({
			path: "raman.v2ValidationId",
			message: `Raman hardware validation record must target workflowBackend ${workflowBackend}`,
		});
	}
	issues.push(...collectChecklistIssues(recordParams.value));
	issues.push(...collectHardwareEvidenceIssues(recordParams.value));
	issues.push(...collectPreflightIssues(cwd, evidence.readOnlyPreflightReportId));
	issues.push(...collectActiveProbeIssues(cwd, evidence.activeProbeRecordPath));
	issues.push(...collectRunIssues(cwd, evidence.minimumRamanRunId, evidence.workflowBackend));
	issues.push(...collectEvidenceChainIssues(cwd, evidence.readOnlyPreflightReportId, evidence.minimumRamanRunId));
	issues.push(...collectCalibrationIssues(cwd, evidence.xyCalibrationId));
	issues.push(...collectArtifactFileIssues(cwd, recordParams.value));
	issues.push(...collectEvidenceDigestIssues(parsed.evidenceDigest, buildEvidenceDigest(cwd, recordParams.value)));
	issues.push(...collectStoredCoverageIssues(readCoverage(parsed, "validatedCoverage"), validatedCoverage));
	if (targetSpec) {
		issues.push(...collectTargetSpecCoverageIssues(minimumRunSpec, targetSpec));
	}
	return {
		valid: issues.length === 0,
		issues,
		path,
		productionReady,
		validatedCoverage,
		requestedCoverage,
		uncoveredCapabilities: uncoveredCapabilities(validatedCoverage, requestedCoverage),
	};
}

export function rejectInvalidValidationParams(commandId: string, issues: ValidationIssue[]): ToolResult {
	return createErrorResult(
		commandId,
		`Raman hardware validation parameters failed validation with ${issues.length} issue(s).`,
		"invalid_tool_params",
		["Fix validation parameters and retry."],
		{ valid: false, issues },
		true,
	);
}
