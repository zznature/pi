import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities } from "./capabilities.ts";
import type { HardwareRun } from "./kernel/hardware-pilot.ts";
import type { SimulationRun, SimulationSummary } from "./kernel/simulation.ts";
import type { PreflightResult } from "./preflight.ts";
import type { ExperimentSpec, HardwarePilotParams, ToolResult } from "./schemas.ts";
import { getExperimentPoints, getUnitCount } from "./spec-utils.ts";
import {
	hashExperimentSpec,
	artifactUriPath,
	markRunFinished,
	readRecordedSummary as readStoredSummary,
	relativeArtifact,
	writeResumeSnapshot,
	type ReservedRun,
	type ResumeSnapshot,
} from "./run-store.ts";

export { hashExperimentSpec } from "./run-store.ts";

export interface RunRecordRefs {
	runDir: string;
	runJsonPath: string;
	specPath: string;
	preflightPath: string;
	capabilitiesSnapshotPath: string;
	eventsPath: string;
	summaryPath: string;
	artifactsPath: string;
	artifacts: ToolResult["artifacts"];
}

export interface PreflightRecordRefs {
	reportId: string;
	reportDir: string;
	reportPath: string;
	approvalsPath: string;
	specHash: string;
	capabilitySnapshotId: string;
	artifacts: ToolResult["artifacts"];
}

function nextPreflightId(mode: ExperimentSpec["mode"]): string {
	const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
	return `${mode}-preflight-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function toJsonLine(value: unknown): string {
	return JSON.stringify(value);
}

function artifact(runId: string, fileName: string, label: string, kind: string): ToolResult["artifacts"][number] {
	return {
		id: `${runId}-${kind}`,
		uri: relativeArtifact(runId, fileName),
		label,
		kind,
		producerRunId: runId,
	};
}

function appendRunEvent(path: string, value: Record<string, unknown>): void {
	appendFileSync(path, `${toJsonLine(value)}\n`, "utf-8");
}

export function appendRunRecords(run: SimulationRun, reserved: ReservedRun, commandId: string, cwd: string): RunRecordRefs {
	const artifacts: ToolResult["artifacts"] = [
		artifact(run.runId, "run.json", "Run record", "run"),
		artifact(run.runId, "spec.json", "ExperimentSpec", "spec"),
		artifact(run.runId, "events.jsonl", "Unit events", "events"),
		artifact(run.runId, "summary.json", "Simulation summary", "summary"),
		artifact(run.runId, "resume.snapshot.json", "Resume snapshot", "resume-snapshot"),
		artifact(run.runId, "artifacts.json", "Artifact index", "artifacts"),
	];
	appendRunEvent(reserved.record.recordPaths.events, {
		schemaVersion: "1",
		sequence: 2,
		type: "run_started",
		experimentId: run.spec.experimentId,
		runId: run.runId,
		correlationId: commandId,
		timestamp: new Date().toISOString(),
		unitCount: run.points.length,
	});
	for (const [offset, point] of run.points.entries()) {
		appendRunEvent(reserved.record.recordPaths.events, {
			schemaVersion: "1",
			sequence: offset + 3,
			type: "unit_completed",
			experimentId: run.spec.experimentId,
			runId: run.runId,
			correlationId: commandId,
			timestamp: new Date().toISOString(),
			unitKind: "point",
			unit: point,
		});
	}
	appendRunEvent(reserved.record.recordPaths.events, {
		schemaVersion: "1",
		sequence: run.points.length + 3,
		type: "run_summary",
		experimentId: run.spec.experimentId,
		runId: run.runId,
		correlationId: commandId,
		timestamp: new Date().toISOString(),
		summary: run.summary,
	});
	writeJson(reserved.record.recordPaths.summary, run.summary);
	writeResumeSnapshot(cwd, run.runId, buildResumeSnapshot(run.runId, run.spec, "completed", run.points.length, run.points.length));
	writeJson(reserved.record.recordPaths.artifacts, artifacts);
	markRunFinished(cwd, run.runId, "completed");

	return {
		runDir: reserved.record.recordPaths.runDir,
		runJsonPath: reserved.record.recordPaths.runJson,
		specPath: reserved.record.recordPaths.spec,
		preflightPath: reserved.record.recordPaths.preflight,
		capabilitiesSnapshotPath: reserved.record.recordPaths.capabilitiesSnapshot,
		eventsPath: reserved.record.recordPaths.events,
		summaryPath: reserved.record.recordPaths.summary,
		artifactsPath: reserved.record.recordPaths.artifacts,
		artifacts,
	};
}

export function appendPreflightReport(
	spec: ExperimentSpec,
	result: PreflightResult,
	capabilities: Capabilities,
	cwd: string,
): PreflightRecordRefs {
	const reportId = nextPreflightId(spec.mode);
	const reportDir = join(cwd, ".pi", "experiment-runs", "preflights", reportId);
	const approvalsPath = join(cwd, ".pi", "experiment-runs", "approvals.jsonl");
	mkdirSync(reportDir, { recursive: true });
	mkdirSync(join(cwd, ".pi", "experiment-runs"), { recursive: true });

	const specHash = hashExperimentSpec(spec);
	const capabilitySnapshotId = `${reportId}-capabilities`;
	const reportPath = join(reportDir, "preflight.json");
	const capabilitySnapshotPath = join(reportDir, "capabilities.snapshot.json");
	const relativeReportDir = join(".pi", "experiment-runs", "preflights", reportId);
	const artifacts: ToolResult["artifacts"] = [
		{ id: `${reportId}-preflight`, uri: artifactUriPath(join(relativeReportDir, "preflight.json")), label: "Preflight report", kind: "preflight" },
		{
			id: `${reportId}-capabilities`,
			uri: artifactUriPath(join(relativeReportDir, "capabilities.snapshot.json")),
			label: "Capability snapshot",
			kind: "capabilities",
		},
		{ id: "approvals-log", uri: artifactUriPath(join(".pi", "experiment-runs", "approvals.jsonl")), label: "Approval log", kind: "approvals" },
	];

	const recordedResult = { ...result, specHash, capabilitySnapshotId };
	writeJson(capabilitySnapshotPath, capabilities);
	writeJson(reportPath, { reportId, spec, result: recordedResult, specHash, capabilitySnapshotId });
	appendFileSync(
		approvalsPath,
		`${toJsonLine({
			type: "preflight_recorded",
			reportId,
			mode: spec.mode,
			hardwareApprovalRequired: spec.mode === "dry_run",
			specHash,
			capabilitySnapshotId,
		})}\n`,
		"utf-8",
	);

	return { reportId, reportDir, reportPath, approvalsPath, specHash, capabilitySnapshotId, artifacts };
}

export interface HardwareGateResult {
	valid: boolean;
	issues: string[];
	specHash?: string;
	collisionCeilingUm?: number;
	maxPlannedZUm?: number;
	laserCeilingMw?: number;
	requestedLaserPowerMw?: number;
}

type HardwareGateInput = HardwarePilotParams | NonNullable<HardwarePilotParams["approval"]>;

function maxPlannedRamanZUm(spec: ExperimentSpec): number | undefined {
	const points = getExperimentPoints(spec);
	if (points.length === 0) return undefined;
	const autofocus = spec.domain?.raman?.autofocus?.enabled === true ? spec.domain.raman.autofocus : undefined;
	let maxPlannedZ = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		maxPlannedZ = Math.max(maxPlannedZ, point.zUm ?? 0);
		if (autofocus) {
			maxPlannedZ = Math.max(maxPlannedZ, autofocus.zMaxUm);
		}
	}
	return Number.isFinite(maxPlannedZ) ? maxPlannedZ : undefined;
}

function normalizeHardwareGateInput(input: HardwareGateInput): Partial<HardwarePilotParams> {
	if ("stageAdapter" in input) return input;
	return { approval: input };
}

export function validateHardwareGate(spec: ExperimentSpec, hardwareGateInput: HardwareGateInput, _cwd?: string): HardwareGateResult {
	const hardwareExecution = normalizeHardwareGateInput(hardwareGateInput);
	const issues: string[] = [];
	const specHash = hashExperimentSpec(spec);
	const collisionCeilingUm = spec.limits.motion.zUm?.maxUm;
	const maxPlannedZUm = spec.domain?.raman ? maxPlannedRamanZUm(spec) : undefined;
	const laserCeilingMw = spec.limits.powerEnergy.maxLaserPowerMw;
	const requestedLaserPowerMw = spec.domain?.raman
		? (hardwareExecution.raman?.laserPowerMw ?? laserCeilingMw)
		: undefined;

	if (spec.domain?.raman) {
		if (collisionCeilingUm === undefined) {
			issues.push("Raman hardware execution requires limits.motion.zUm.maxUm as the Raman objective collision ceiling.");
		}
		if (collisionCeilingUm !== undefined && maxPlannedZUm !== undefined && maxPlannedZUm > collisionCeilingUm) {
			issues.push(
				`objective_collision: planned Z ${maxPlannedZUm} um exceeds limits.motion.zUm.maxUm = ${collisionCeilingUm} um (Raman objective collision ceiling).`,
			);
		}
		if (requestedLaserPowerMw !== undefined && requestedLaserPowerMw > laserCeilingMw) {
			issues.push(
				`sample_burn: requested laser power ${requestedLaserPowerMw} mW exceeds limits.powerEnergy.maxLaserPowerMw = ${laserCeilingMw} mW.`,
			);
		}
	}

	return { valid: issues.length === 0, issues, specHash, collisionCeilingUm, maxPlannedZUm, laserCeilingMw, requestedLaserPowerMw };
}

export interface HardwareRunRecordRefs extends RunRecordRefs {
	approvalsPath: string;
	intentsPath: string;
}

export function appendHardwareRunRecords(
	run: HardwareRun,
	pilot: HardwarePilotParams,
	reserved: ReservedRun,
	cwd: string,
): HardwareRunRecordRefs {
	const artifacts: ToolResult["artifacts"] = [
		artifact(run.runId, "run.json", "Run record", "run"),
		artifact(run.runId, "spec.json", "ExperimentSpec", "spec"),
		artifact(run.runId, "events.jsonl", "Hardware unit events", "events"),
		artifact(run.runId, "intents.jsonl", "Operator intents", "intents"),
		artifact(run.runId, "summary.json", "Hardware summary", "summary"),
		artifact(run.runId, "resume.snapshot.json", "Resume snapshot", "resume-snapshot"),
		artifact(run.runId, "approvals.jsonl", "Hardware approval", "approvals"),
		artifact(run.runId, "artifacts.json", "Artifact index", "artifacts"),
	];

	writeJson(reserved.record.recordPaths.summary, run.summary);
	writeResumeSnapshot(
		cwd,
		run.runId,
		buildResumeSnapshot(
			run.runId,
			run.spec,
			run.summary.status,
			run.summary.completedUnits,
			nextHardwareUnitIndex(run.points),
			run.summary.stopReason,
		),
	);
	writeJson(reserved.record.recordPaths.artifacts, artifacts);
	appendFileSync(
		reserved.record.recordPaths.approvals,
		`${toJsonLine({
			type: "hardware_approval_recorded",
			runId: run.runId,
			approval: pilot.approval,
			operatorOnlyMonitoring: pilot.approval?.operatorOnlyMonitoring === true,
			specHash: hashExperimentSpec(run.spec),
		})}\n`,
		"utf-8",
	);
	markRunFinished(cwd, run.runId, run.summary.status === "completed" ? "completed" : run.summary.status === "paused" ? "paused" : "aborted");

	return {
		runDir: reserved.record.recordPaths.runDir,
		runJsonPath: reserved.record.recordPaths.runJson,
		specPath: reserved.record.recordPaths.spec,
		preflightPath: reserved.record.recordPaths.preflight,
		capabilitiesSnapshotPath: reserved.record.recordPaths.capabilitiesSnapshot,
		eventsPath: reserved.record.recordPaths.events,
		summaryPath: reserved.record.recordPaths.summary,
		artifactsPath: reserved.record.recordPaths.artifacts,
		approvalsPath: reserved.record.recordPaths.approvals,
		intentsPath: reserved.record.recordPaths.intents,
		artifacts,
	};
}

export type OperatorIntentType = "pause" | "abort" | "request_operator";

export interface OperatorIntentRef {
	intentsPath: string;
	relativeIntentsPath: string;
}

export function appendOperatorIntent(
	runId: string,
	intent: OperatorIntentType,
	reason: string,
	cwd: string,
): OperatorIntentRef {
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const intentsPath = join(runDir, "intents.jsonl");
	const relativeIntentsPath = artifactUriPath(join(".pi", "experiment-runs", "runs", runId, "intents.jsonl"));
	appendFileSync(intentsPath, `${toJsonLine({ type: intent, intent, runId, reason, timestamp: new Date().toISOString() })}\n`, "utf-8");
	return { intentsPath, relativeIntentsPath };
}

export function readRecordedSummary(runId: string, cwd: string): SimulationSummary | undefined {
	const summary = readStoredSummary(cwd, runId);
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) return undefined;
	return summary as SimulationSummary;
}

function buildResumeSnapshot(
	runId: string,
	spec: ExperimentSpec,
	status: string,
	completedUnits: number,
	nextUnitIndex: number,
	reason?: string,
): ResumeSnapshot {
	const totalUnits = getUnitCount(spec);
	const safeToResume = status === "paused" && nextUnitIndex < totalUnits;
	const snapshot: ResumeSnapshot = {
		schemaVersion: "1",
		runId,
		experimentId: spec.experimentId,
		mode: spec.mode,
		status,
		completedUnits,
		totalUnits,
		unitKind: spec.plan.kind === "steps" ? "step" : "point",
		nextUnitIndex,
		safeToResume,
		requiresOperatorApproval: false,
		createdAt: new Date().toISOString(),
	};
	if (nextUnitIndex < totalUnits) {
		snapshot.resumeFrom = String(nextUnitIndex);
	}
	if (reason) {
		snapshot.reason = reason;
	}
	return snapshot;
}

function nextHardwareUnitIndex(points: HardwareRun["points"]): number {
	const completedIndexes = points
		.filter((point) => point.status === "success")
		.map((point) => point.index);
	if (completedIndexes.length === 0) return 0;
	return Math.max(...completedIndexes) + 1;
}
