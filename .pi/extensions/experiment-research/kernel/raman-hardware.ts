import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	markRunFinished,
	markRunRunning,
	relativeArtifact,
	writeResumeSnapshot,
	type RecordedEvent,
	type ReservedRun,
	type ResumeSnapshot,
	type RunStatus,
} from "../run-store.ts";
import type { ExperimentSpec, HardwarePilotParams, RamanErrorCode, ToolResult } from "../schemas.ts";
import { getExperimentPoints, getUnitCount, type ExperimentPoint } from "../spec-utils.ts";
import { evaluateWatchdog } from "../watchdog.ts";
import { resolveRamanXyCalibration } from "./raman-calibration.ts";
import { RamanBridgeClient, RamanBridgeProtocolError, RamanBridgeRequestError, type RamanBridgeEvent } from "./raman-bridge.ts";
import type { RunState } from "./kernel.ts";

export interface RamanHardwareRunStart {
	runState: RunState;
	artifacts: ToolResult["artifacts"];
}

type RamanHardwareTerminalStatus = "completed" | "paused" | "aborted" | "failed";

export interface RamanHardwareRunTerminalEvent {
	cwd: string;
	runId: string;
	experimentId: string;
	status: RamanHardwareTerminalStatus;
	summary: RamanHardwareSummary;
	artifacts: ToolResult["artifacts"];
	records: {
		runDir: string;
		eventsPath: string;
		summaryPath: string;
		resumeSnapshotPath: string;
		artifactsPath: string;
	};
}

export type RamanHardwareRunTerminalListener = (event: RamanHardwareRunTerminalEvent) => void;

export interface RamanHardwareSummary {
	runId: string;
	experimentId: string;
	mode: "hardware";
	subjectId: string;
	objective: string;
	unitCount: number;
	completedUnits: number;
	progress: {
		completedUnits: number;
		totalUnits: number;
		unitKind: "point";
	};
	status: "running" | "completed" | "paused" | "aborted" | "failed";
	stopConditionMet: boolean;
	stopReason?: string;
	operatorOnlyMonitoring: boolean;
}

interface BridgeUnitRecord extends ExperimentPoint {
	status?: string;
	positionBefore?: unknown;
	positionAfter?: unknown;
	spectrum?: unknown;
	spectrumMetadata?: unknown;
	errorCode?: string;
	error?: string;
}

interface SpectrumArtifactPlan {
	pointIndex: number;
	artifactId: string;
	absolutePath: string;
	relativePath: string;
	format: string;
}

const activeRamanBridges = new Map<string, RamanBridgeClient>();
const terminalListeners = new Set<RamanHardwareRunTerminalListener>();

export function subscribeRamanHardwareRunTerminal(listener: RamanHardwareRunTerminalListener): () => void {
	terminalListeners.add(listener);
	return () => {
		terminalListeners.delete(listener);
	};
}

function emitRamanHardwareRunTerminal(event: RamanHardwareRunTerminalEvent): void {
	for (const listener of terminalListeners) {
		try {
			listener(event);
		} catch {
			// Notification handlers must not affect kernel cleanup or persisted run state.
		}
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function appendJsonLine(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
}

function nonEmptyLines(path: string): string[] {
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
}

function nextSequence(eventsPath: string): number {
	return nonEmptyLines(eventsPath).length + 1;
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

function buildSpectrumArtifactPlans(spec: ExperimentSpec, reserved: ReservedRun): SpectrumArtifactPlan[] {
	const acquisition = spec.domain?.raman?.acquisition;
	if (!acquisition) return [];
	return getExperimentPoints(spec).map((point) => {
		const fileName = `artifacts/spectra/point_${point.index}.${acquisition.saveFormat}`;
		return {
			pointIndex: point.index,
			artifactId: `${reserved.record.runId}-spectrum-point-${point.index}`,
			absolutePath: join(reserved.runDir, fileName),
			relativePath: relativeArtifact(reserved.record.runId, fileName),
			format: acquisition.saveFormat,
		};
	});
}

function baseArtifacts(runId: string, spectrumArtifacts: SpectrumArtifactPlan[]): ToolResult["artifacts"] {
	const artifacts: ToolResult["artifacts"] = [
		artifact(runId, "run.json", "Run record", "run"),
		artifact(runId, "spec.json", "ExperimentSpec", "spec"),
		artifact(runId, "events.jsonl", "Hardware unit events", "events"),
		artifact(runId, "intents.jsonl", "Operator intents", "intents"),
		artifact(runId, "summary.json", "Hardware summary", "summary"),
		artifact(runId, "resume.snapshot.json", "Resume snapshot", "resume-snapshot"),
		artifact(runId, "approvals.jsonl", "Hardware approval", "approvals"),
		artifact(runId, "artifacts.json", "Artifact index", "artifacts"),
	];
	for (const spectrum of spectrumArtifacts) {
		artifacts.push({
			id: spectrum.artifactId,
			uri: spectrum.relativePath,
			label: `Raman spectrum point ${spectrum.pointIndex}`,
			kind: "spectrum",
			producerRunId: runId,
		});
	}
	return artifacts;
}

function buildSnapshot(
	spec: ExperimentSpec,
	runId: string,
	status: RunStatus | string,
	completedUnits: number,
	nextUnitIndex: number,
	reason?: string,
): ResumeSnapshot {
	const totalUnits = getUnitCount(spec);
	const snapshot: ResumeSnapshot = {
		schemaVersion: "1",
		runId,
		experimentId: spec.experimentId,
		mode: spec.mode,
		status,
		completedUnits,
		totalUnits,
		unitKind: "point",
		nextUnitIndex,
		safeToResume: status === "paused" && nextUnitIndex < totalUnits,
		requiresOperatorApproval: status !== "completed",
		createdAt: nowIso(),
	};
	if (nextUnitIndex < totalUnits) {
		snapshot.resumeFrom = String(nextUnitIndex);
	}
	if (reason) {
		snapshot.reason = reason;
	}
	return snapshot;
}

function stateFromSnapshot(runId: string, spec: ExperimentSpec, status: RunStatus, snapshot: ResumeSnapshot): RunState {
	return {
		runId,
		experimentId: spec.experimentId,
		mode: spec.mode,
		status,
		progress: {
			completedUnits: snapshot.completedUnits,
			totalUnits: snapshot.totalUnits,
			unitKind: "point",
		},
		nextUnitIndex: snapshot.nextUnitIndex,
		safeToResume: snapshot.safeToResume,
		summaryAvailable: false,
		stopReason: snapshot.reason,
	};
}

function buildSummary(
	runId: string,
	spec: ExperimentSpec,
	status: RamanHardwareSummary["status"],
	completedUnits: number,
	stopReason: string | undefined,
	operatorOnlyMonitoring: boolean,
): RamanHardwareSummary {
	const unitCount = getUnitCount(spec);
	const summary: RamanHardwareSummary = {
		runId,
		experimentId: spec.experimentId,
		mode: "hardware",
		subjectId: spec.subject.id,
		objective: spec.objective,
		unitCount,
		completedUnits,
		progress: { completedUnits, totalUnits: unitCount, unitKind: "point" },
		status,
		stopConditionMet: status !== "completed",
		operatorOnlyMonitoring,
	};
	if (stopReason) {
		summary.stopReason = stopReason;
	}
	return summary;
}

function readCompletedUnitRecords(eventsPath: string): BridgeUnitRecord[] {
	const records: BridgeUnitRecord[] = [];
	for (const line of nonEmptyLines(eventsPath)) {
		try {
			const parsed = JSON.parse(line) as RecordedEvent;
			if (parsed.type === "unit_completed" && typeof parsed.unit === "object" && parsed.unit !== null && !Array.isArray(parsed.unit)) {
				records.push(parsed.unit as BridgeUnitRecord);
			}
		} catch {
			// Ignore malformed lines; the current run will surface corruption through analysis.
		}
	}
	return records;
}

function normalizeStatus(status: string | undefined): "success" | "error" | "skipped" {
	if (status === "success" || status === "error" || status === "skipped") return status;
	return "error";
}

function toErrorRecord(point: ExperimentPoint, code: RamanErrorCode, message: string): BridgeUnitRecord {
	return {
		...point,
		status: "error",
		errorCode: code,
		error: message,
	};
}

function isRamanErrorCode(value: string): value is RamanErrorCode {
	return (
		value === "stage_connection_error" ||
		value === "stage_command_error" ||
		value === "stage_timeout" ||
		value === "frame_timeout" ||
		value === "autofocus_no_peak" ||
		value === "autofocus_low_confidence" ||
		value === "autofocus_out_of_range" ||
		value === "calibration_low_confidence" ||
		value === "calibration_singular_transform" ||
		value === "acquisition_failed" ||
		value === "aborted" ||
		value === "bridge_crashed"
	);
}

function errorCodeFrom(error: unknown): RamanErrorCode {
	if (error instanceof RamanBridgeRequestError && isRamanErrorCode(error.code)) {
		return error.code;
	}
	if (error instanceof RamanBridgeProtocolError) {
		return "bridge_crashed";
	}
	return "bridge_crashed";
}

function messageFrom(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function requestTimeoutMs(spec: ExperimentSpec, pilot: HardwarePilotParams): number {
	const acquisition = spec.domain?.raman?.acquisition;
	const acquisitionMs = acquisition ? acquisition.integrationTimeS * acquisition.accumulations * 1000 : 0;
	return Math.max(pilot.heartbeatTimeoutMs * 2, pilot.settleTimeoutMs + acquisitionMs + 30_000);
}

function stagePayload(pilot: HardwarePilotParams): Record<string, unknown> {
	if (pilot.stageAdapter === "memory") {
		return { adapter: "memory" };
	}
	return {
		adapter: "mc_newton_xyz",
		port: pilot.stagePort,
	};
}

function acquisitionPayload(
	spec: ExperimentSpec,
	pilot: HardwarePilotParams,
	reserved: ReservedRun,
	spectrum: SpectrumArtifactPlan | undefined,
): Record<string, unknown> | undefined {
	const acquisition = spec.domain?.raman?.acquisition;
	if (!acquisition || !spectrum) return undefined;
	const backend =
		pilot.raman?.acquisitionBackend ?? (pilot.stageAdapter === "memory" ? "fake" : "labspec_file_bridge");
	return {
		...acquisition,
		backend,
		bridgeDir: pilot.raman?.labspecBridgeDir ?? join(reserved.runDir, "labspec_bridge"),
		timeoutS: pilot.raman?.labspecTimeoutS,
		pollIntervalS: pilot.raman?.labspecPollIntervalS,
		savePath: spectrum.absolutePath,
		artifactId: spectrum.artifactId,
	};
}

function autofocusPayload(spec: ExperimentSpec, pilot: HardwarePilotParams): Record<string, unknown> | undefined {
	const autofocus = spec.domain?.raman?.autofocus;
	if (!autofocus?.enabled) return undefined;
	return {
		...autofocus,
		backend: pilot.raman?.autofocusBackend ?? "fake",
		bridgeDir: pilot.raman?.frameBridgeDir ?? pilot.raman?.labspecBridgeDir,
		stageTimeoutMs: pilot.settleTimeoutMs,
	};
}

function xyCorrectionPayload(cwd: string, spec: ExperimentSpec, pilot: HardwarePilotParams): Record<string, unknown> | undefined {
	const xyCorrection = spec.domain?.raman?.xyCorrection;
	if (!xyCorrection?.enabled) return undefined;
	const payload: Record<string, unknown> = {
		...xyCorrection,
		backend: pilot.raman?.xyCorrectionBackend ?? "fake",
		bridgeDir: pilot.raman?.frameBridgeDir ?? pilot.raman?.labspecBridgeDir,
		stageTimeoutMs: pilot.settleTimeoutMs,
	};
	if (pilot.raman?.xyReferenceFramePath) {
		payload.referenceFramePath = pilot.raman.xyReferenceFramePath;
	}
	if (pilot.raman?.xyCurrentFramePath) {
		payload.currentFramePath = pilot.raman.xyCurrentFramePath;
	}
	if (pilot.raman?.xyTransform) {
		payload.transform = pilot.raman.xyTransform;
	} else {
		const resolution = resolveRamanXyCalibration(cwd, xyCorrection.transformArtifactId);
		if (!resolution.ok) {
			throw new Error(resolution.issues.map((issue) => issue.message).join("; "));
		}
		payload.transform = resolution.artifact.pixelPerUm;
	}
	if (pilot.raman?.xyApplyCorrection !== undefined) {
		payload.applied = pilot.raman.xyApplyCorrection;
	}
	return payload;
}

function appendRunEvent(
	reserved: ReservedRun,
	commandId: string,
	sequence: number,
	type: string,
	extra: Record<string, unknown>,
): void {
	appendJsonLine(reserved.eventsPath, {
		schemaVersion: "1",
		sequence,
		type,
		experimentId: reserved.spec.experimentId,
		runId: reserved.record.runId,
		correlationId: commandId,
		timestamp: nowIso(),
		...extra,
	});
}

function recordApproval(reserved: ReservedRun, pilot: HardwarePilotParams, spec: ExperimentSpec): void {
	appendJsonLine(reserved.record.recordPaths.approvals, {
		type: "hardware_approval_recorded",
		runId: reserved.record.runId,
		approval: pilot.approval,
		operatorOnlyMonitoring: pilot.approval.operatorOnlyMonitoring === true,
		specHash: reserved.specHash,
		raman: spec.domain?.raman !== undefined,
	});
}

function finishRun(
	cwd: string,
	reserved: ReservedRun,
	spec: ExperimentSpec,
	status: RamanHardwareSummary["status"],
	nextUnitIndex: number,
	stopReason: string | undefined,
	operatorOnlyMonitoring: boolean,
): RamanHardwareSummary {
	const completedUnits = readCompletedUnitRecords(reserved.eventsPath).length;
	const summary = buildSummary(
		reserved.record.runId,
		spec,
		status,
		completedUnits,
		stopReason,
		operatorOnlyMonitoring,
	);
	appendRunEvent(reserved, reserved.record.runId, nextSequence(reserved.eventsPath), "run_summary", { summary });
	writeJson(reserved.record.recordPaths.summary, summary);
	writeResumeSnapshot(cwd, reserved.record.runId, buildSnapshot(spec, reserved.record.runId, status, completedUnits, nextUnitIndex, stopReason));
	markRunFinished(cwd, reserved.record.runId, status === "failed" ? "failed" : status === "completed" ? "completed" : status === "paused" ? "paused" : "aborted");
	return summary;
}

async function executeRamanHardwareRun(
	cwd: string,
	spec: ExperimentSpec,
	pilot: HardwarePilotParams,
	reserved: ReservedRun,
	commandId: string,
	startPointIndex: number,
	spectra: SpectrumArtifactPlan[],
	artifacts: ToolResult["artifacts"],
): Promise<void> {
	let sequence = nextSequence(reserved.eventsPath);
	let consecutiveErrors = 0;
	let lastHeartbeatMs = Date.now();
	let bridge: RamanBridgeClient | undefined;
	let nextUnitIndex = startPointIndex;
	let terminalStatus: RamanHardwareTerminalStatus = "completed";
	let stopReason: string | undefined;
	const spectraByPoint = new Map(spectra.map((spectrum) => [spectrum.pointIndex, spectrum]));
	const points = getExperimentPoints(spec);
	try {
		bridge = new RamanBridgeClient({
			cwd,
			python: pilot.stagePython,
			requestTimeoutMs: requestTimeoutMs(spec, pilot),
			onEvent: (event: RamanBridgeEvent) => {
				lastHeartbeatMs = Date.now();
				appendRunEvent(reserved, commandId, nextSequence(reserved.eventsPath), "bridge_event", { bridgeEvent: event });
			},
			onStderr: (chunk) => {
				appendRunEvent(reserved, commandId, nextSequence(reserved.eventsPath), "bridge_stderr", { message: chunk });
			},
		});
		activeRamanBridges.set(reserved.record.runId, bridge);
		await bridge.request("connect", { stage: stagePayload(pilot) });
		appendRunEvent(reserved, commandId, sequence, "run_started", {
			unitCount: points.length,
			stageAdapter: pilot.stageAdapter,
			raman: true,
		});
		sequence += 1;

		for (const point of points) {
			if (point.index < startPointIndex) {
				nextUnitIndex = point.index + 1;
				continue;
			}
			const decision = evaluateWatchdog({
				nowMs: Date.now(),
				lastHeartbeatMs,
				heartbeatTimeoutMs: pilot.heartbeatTimeoutMs,
				consecutiveErrors,
				maxConsecutiveErrors: pilot.maxConsecutiveErrors,
				intentsPath: pilot.intentsPath,
				budgetGuard: {
					completedUnits: readCompletedUnitRecords(reserved.eventsPath).length,
					maxUnits: spec.stoppingRules.maxUnits,
					pauseAtRatio: 1,
				},
			});
			if (decision.intent !== "none") {
				if (decision.intent === "abort") {
					await bridge.stop().catch(() => undefined);
				}
				terminalStatus = decision.intent === "abort" ? "aborted" : "paused";
				stopReason = decision.reason;
				appendRunEvent(reserved, commandId, sequence, "run_stopped", { status: terminalStatus, stopReason });
				sequence += 1;
				break;
			}

			appendRunEvent(reserved, commandId, sequence, "unit_started", { unitKind: "point", unit: point });
			sequence += 1;
			try {
				const spectrum = spectraByPoint.get(point.index);
				const unit = await bridge.request<BridgeUnitRecord>("run_unit", {
					stage: stagePayload(pilot),
					point,
					settleTimeoutMs: pilot.settleTimeoutMs,
					autofocus: autofocusPayload(spec, pilot),
					xyCorrection: xyCorrectionPayload(cwd, spec, pilot),
					acquisition: acquisitionPayload(spec, pilot, reserved, spectrum),
				});
				const record: BridgeUnitRecord = {
					...point,
					...unit,
					status: normalizeStatus(unit.status),
				};
				appendRunEvent(reserved, commandId, sequence, "unit_completed", { unitKind: "point", unit: record });
				sequence += 1;
				consecutiveErrors = 0;
				nextUnitIndex = point.index + 1;
				writeResumeSnapshot(
					cwd,
					reserved.record.runId,
					buildSnapshot(spec, reserved.record.runId, "running", readCompletedUnitRecords(reserved.eventsPath).length, nextUnitIndex),
				);
			} catch (error) {
				consecutiveErrors += 1;
				const errorCode = errorCodeFrom(error);
				const record = toErrorRecord(point, errorCode, messageFrom(error));
				appendRunEvent(reserved, commandId, sequence, "unit_error", { unitKind: "point", unit: record });
				sequence += 1;
				nextUnitIndex = point.index;
				if (spec.stoppingRules.stopOnError || consecutiveErrors >= pilot.maxConsecutiveErrors || errorCode === "bridge_crashed") {
					terminalStatus = errorCode === "bridge_crashed" ? "failed" : "aborted";
					stopReason = messageFrom(error);
					appendRunEvent(reserved, commandId, sequence, "run_stopped", { status: terminalStatus, stopReason });
					sequence += 1;
					break;
				}
			}
		}
	} catch (error) {
		terminalStatus = "failed";
		stopReason = messageFrom(error);
		appendRunEvent(reserved, commandId, nextSequence(reserved.eventsPath), "run_stopped", { status: terminalStatus, stopReason });
	} finally {
		activeRamanBridges.delete(reserved.record.runId);
		if (bridge) {
			await bridge.shutdown().catch(() => bridge?.close());
		}
		const summary = finishRun(cwd, reserved, spec, terminalStatus, nextUnitIndex, stopReason, pilot.approval.operatorOnlyMonitoring === true);
		emitRamanHardwareRunTerminal({
			cwd,
			runId: reserved.record.runId,
			experimentId: spec.experimentId,
			status: terminalStatus,
			summary,
			artifacts,
			records: {
				runDir: reserved.runDir,
				eventsPath: reserved.eventsPath,
				summaryPath: reserved.record.recordPaths.summary,
				resumeSnapshotPath: reserved.record.recordPaths.resumeSnapshot,
				artifactsPath: reserved.record.recordPaths.artifacts,
			},
		});
	}
}

export function startRamanHardwareRun(
	cwd: string,
	spec: ExperimentSpec,
	pilot: HardwarePilotParams,
	reserved: ReservedRun,
	commandId: string,
	startPointIndex: number,
): RamanHardwareRunStart {
	const spectra = buildSpectrumArtifactPlans(spec, reserved);
	const artifacts = baseArtifacts(reserved.record.runId, spectra);
	writeJson(reserved.record.recordPaths.artifacts, artifacts);
	recordApproval(reserved, pilot, spec);
	markRunRunning(cwd, reserved.record.runId);
	const snapshot = buildSnapshot(spec, reserved.record.runId, "running", 0, startPointIndex);
	writeResumeSnapshot(cwd, reserved.record.runId, snapshot);
	void executeRamanHardwareRun(cwd, spec, pilot, reserved, commandId, startPointIndex, spectra, artifacts);
	return {
		runState: stateFromSnapshot(reserved.record.runId, spec, "running", snapshot),
		artifacts,
	};
}

export function requestRamanHardwareStop(runId: string): void {
	const bridge = activeRamanBridges.get(runId);
	if (!bridge) return;
	void bridge.stop().catch(() => undefined);
}
