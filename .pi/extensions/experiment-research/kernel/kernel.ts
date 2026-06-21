import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	markRunFinished,
	markRunRunning,
	readResumeSnapshot,
	readRunRecord,
	readRecordedSpec,
	relativeArtifact,
	writeResumeSnapshot,
	type ReservedRun,
	type ResumeSnapshot,
	type RunRecord,
	type RunStatus,
	type SnapshotHardwareReconcile,
	type SnapshotStagePosition,
} from "../run-store.ts";
import type { ExperimentSpec, ToolResult } from "../schemas.ts";
import { getExperimentPoints, getUnitCount } from "../spec-utils.ts";
import { simulatePoint, type SimulationPointRecord } from "./simulation.ts";

export interface RunState {
	runId: string;
	experimentId: string;
	mode: ExperimentSpec["mode"];
	status: RunStatus;
	progress: {
		completedUnits: number;
		totalUnits: number;
		unitKind: string;
	};
	nextUnitIndex: number;
	safeToResume: boolean;
	summaryAvailable: boolean;
	unitIndex?: number;
	microstep?: string;
	commandId?: string;
	lastKnownStagePosition?: SnapshotStagePosition;
	pendingAcquisitionId?: string;
	artifactRefs?: ToolResult["artifacts"];
	nextPlan?: string[];
	hardwareReconcile?: SnapshotHardwareReconcile;
	stopReason?: string;
}

interface LifecycleSummary {
	runId: string;
	experimentId: string;
	mode: "simulation";
	subjectId: string;
	objective: string;
	unitCount: number;
	progress: {
		completedUnits: number;
		totalUnits: number;
		unitKind: "point";
	};
	status: "running" | "completed" | "paused" | "aborted";
	stopConditionMet: boolean;
	meanSignal?: number;
	maxSignal?: number;
	minSignal?: number;
	stopReason?: string;
}

interface IntentEntry {
	intent: string;
	reason?: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeJsonFile(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function nonEmptyLines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
}

function nextSequence(eventsPath: string): number {
	return nonEmptyLines(eventsPath).length + 1;
}

function appendEvent(eventsPath: string, event: Record<string, unknown>): void {
	appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
}

function readIntents(intentsPath: string): IntentEntry[] {
	return nonEmptyLines(intentsPath).map((line) => {
		try {
			const parsed = JSON.parse(line) as { type?: unknown; intent?: unknown; reason?: unknown };
			const intent = typeof parsed.intent === "string" ? parsed.intent : typeof parsed.type === "string" ? parsed.type : "";
			return { intent, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
		} catch {
			return { intent: "" };
		}
	});
}

function actionableIntent(entries: IntentEntry[], watermark: number): IntentEntry | undefined {
	const fresh = entries.slice(watermark);
	for (let i = fresh.length - 1; i >= 0; i--) {
		const entry = fresh[i];
		if (entry.intent === "abort" || entry.intent === "pause" || entry.intent === "request_operator") return entry;
	}
	return undefined;
}

function readCompletedUnitRecords(eventsPath: string): SimulationPointRecord[] {
	const records: SimulationPointRecord[] = [];
	for (const line of nonEmptyLines(eventsPath)) {
		try {
			const event = JSON.parse(line) as { type?: unknown; unit?: unknown };
			if (event.type === "unit_completed" && typeof event.unit === "object" && event.unit !== null) {
				records.push(event.unit as SimulationPointRecord);
			}
		} catch {
			// Skip malformed event lines; the resume snapshot remains authoritative for progress.
		}
	}
	return records;
}

function round(value: number): number {
	return Number(value.toFixed(3));
}

function lifecycleArtifacts(runId: string): ToolResult["artifacts"] {
	const entry = (fileName: string, label: string, kind: string): ToolResult["artifacts"][number] => ({
		id: `${runId}-${kind}`,
		uri: relativeArtifact(runId, fileName),
		label,
		kind,
		producerRunId: runId,
	});
	return [
		entry("run.json", "Run record", "run"),
		entry("spec.json", "ExperimentSpec", "spec"),
		entry("events.jsonl", "Unit events", "events"),
		entry("summary.json", "Simulation summary", "summary"),
		entry("resume.snapshot.json", "Resume snapshot", "resume-snapshot"),
		entry("artifacts.json", "Artifact index", "artifacts"),
	];
}

function buildSnapshot(
	spec: ExperimentSpec,
	runId: string,
	status: LifecycleSummary["status"],
	completedUnits: number,
	nextUnitIndex: number,
	intentWatermark: number,
	stopReason: string | undefined,
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
		unitKind: spec.plan.kind === "steps" ? "step" : "point",
		nextUnitIndex,
		safeToResume: status === "paused" && nextUnitIndex < totalUnits,
		requiresOperatorApproval: spec.mode === "hardware" && status !== "completed",
		intentWatermark,
		createdAt: nowIso(),
	};
	if (nextUnitIndex < totalUnits) snapshot.resumeFrom = String(nextUnitIndex);
	if (stopReason) snapshot.reason = stopReason;
	return snapshot;
}

function summarize(
	runId: string,
	spec: ExperimentSpec,
	completed: SimulationPointRecord[],
	totalUnits: number,
	status: LifecycleSummary["status"],
	stopReason: string | undefined,
): LifecycleSummary {
	const signals = completed.map((record) => record.signal).filter((signal): signal is number => typeof signal === "number");
	const summary: LifecycleSummary = {
		runId,
		experimentId: spec.experimentId,
		mode: "simulation",
		subjectId: spec.subject.id,
		objective: spec.objective,
		unitCount: totalUnits,
		progress: { completedUnits: completed.length, totalUnits, unitKind: "point" },
		status,
		stopConditionMet: status === "paused" || status === "aborted",
	};
	if (signals.length > 0) {
		summary.meanSignal = round(signals.reduce((total, signal) => total + signal, 0) / signals.length);
		summary.maxSignal = Math.max(...signals);
		summary.minSignal = Math.min(...signals);
	}
	if (stopReason) summary.stopReason = stopReason;
	return summary;
}

function stateFrom(record: RunRecord, snapshot: ResumeSnapshot | undefined, summaryAvailable: boolean): RunState {
	const state: RunState = {
		runId: record.runId,
		experimentId: record.experimentId,
		mode: record.mode,
		status: record.status,
		progress: {
			completedUnits: snapshot?.completedUnits ?? 0,
			totalUnits: snapshot?.totalUnits ?? 0,
			unitKind: snapshot?.unitKind ?? "point",
		},
		nextUnitIndex: snapshot?.nextUnitIndex ?? 0,
		safeToResume: snapshot?.safeToResume ?? false,
		summaryAvailable,
		stopReason: snapshot?.reason,
	};
	if (snapshot?.unitIndex !== undefined) state.unitIndex = snapshot.unitIndex;
	if (snapshot?.microstep !== undefined) state.microstep = snapshot.microstep;
	if (snapshot?.commandId !== undefined) state.commandId = snapshot.commandId;
	if (snapshot?.lastKnownStagePosition !== undefined) state.lastKnownStagePosition = snapshot.lastKnownStagePosition;
	if (snapshot?.pendingAcquisitionId !== undefined) state.pendingAcquisitionId = snapshot.pendingAcquisitionId;
	if (snapshot?.artifactRefs !== undefined) state.artifactRefs = snapshot.artifactRefs;
	if (snapshot?.nextPlan !== undefined) state.nextPlan = snapshot.nextPlan;
	if (snapshot?.hardwareReconcile !== undefined) state.hardwareReconcile = snapshot.hardwareReconcile;
	return state;
}

export function pollRun(cwd: string, runId: string): RunState {
	const record = readRunRecord(cwd, runId);
	const snapshot = readResumeSnapshot(cwd, runId);
	return stateFrom(record, snapshot, existsSync(record.recordPaths.summary));
}

export function startRun(cwd: string, reserved: ReservedRun, correlationId: string): RunState {
	const spec = reserved.spec;
	const runId = reserved.record.runId;
	markRunRunning(cwd, runId);
	appendEvent(reserved.eventsPath, {
		schemaVersion: "1",
		sequence: nextSequence(reserved.eventsPath),
		type: "run_started",
		experimentId: spec.experimentId,
		runId,
		correlationId,
		timestamp: nowIso(),
		unitCount: getUnitCount(spec),
	});
	writeJsonFile(reserved.record.recordPaths.artifacts, lifecycleArtifacts(runId));
	writeResumeSnapshot(cwd, runId, buildSnapshot(spec, runId, "running", 0, 0, 0, undefined));
	return pollRun(cwd, runId);
}

export function advanceRun(cwd: string, runId: string, opts: { maxUnits?: number; correlationId?: string }): RunState {
	const record = readRunRecord(cwd, runId);
	const spec = readRecordedSpec(cwd, runId);
	if (!spec) throw new Error(`spec not found for run ${runId}`);
	const correlationId = opts.correlationId ?? runId;
	const points = getExperimentPoints(spec);
	const totalUnits = points.length;
	const eventsPath = record.recordPaths.events;
	const intentsPath = record.recordPaths.intents;
	const snapshot = readResumeSnapshot(cwd, runId);
	let nextIndex = snapshot?.nextUnitIndex ?? 0;
	let watermark = snapshot?.intentWatermark ?? 0;
	const maxUnits = opts.maxUnits !== undefined && opts.maxUnits > 0 ? opts.maxUnits : Number.POSITIVE_INFINITY;

	if (record.status === "paused") markRunRunning(cwd, runId);

	let executed = 0;
	let stop: { status: "paused" | "aborted"; reason: string } | undefined;
	while (nextIndex < totalUnits && executed < maxUnits) {
		const intents = readIntents(intentsPath);
		const actionable = actionableIntent(intents, watermark);
		watermark = intents.length;
		if (actionable) {
			const status = actionable.intent === "abort" ? "aborted" : "paused";
			stop = { status, reason: actionable.reason ?? `operator ${actionable.intent}` };
			appendEvent(eventsPath, {
				schemaVersion: "1",
				sequence: nextSequence(eventsPath),
				type: "run_stopped",
				experimentId: spec.experimentId,
				runId,
				correlationId,
				timestamp: nowIso(),
				status,
				stopReason: stop.reason,
			});
			break;
		}
		const unit = simulatePoint(points[nextIndex]);
		appendEvent(eventsPath, {
			schemaVersion: "1",
			sequence: nextSequence(eventsPath),
			type: "unit_completed",
			experimentId: spec.experimentId,
			runId,
			correlationId,
			timestamp: nowIso(),
			unitKind: "point",
			unit,
		});
		nextIndex += 1;
		executed += 1;
	}

	const completed = readCompletedUnitRecords(eventsPath);
	if (stop) {
		writeJsonFile(record.recordPaths.summary, summarize(runId, spec, completed, totalUnits, stop.status, stop.reason));
		writeResumeSnapshot(cwd, runId, buildSnapshot(spec, runId, stop.status, completed.length, nextIndex, watermark, stop.reason));
		markRunFinished(cwd, runId, stop.status);
		return pollRun(cwd, runId);
	}
	if (nextIndex >= totalUnits) {
		const summary = summarize(runId, spec, completed, totalUnits, "completed", undefined);
		appendEvent(eventsPath, {
			schemaVersion: "1",
			sequence: nextSequence(eventsPath),
			type: "run_summary",
			experimentId: spec.experimentId,
			runId,
			correlationId,
			timestamp: nowIso(),
			summary,
		});
		writeJsonFile(record.recordPaths.summary, summary);
		writeResumeSnapshot(cwd, runId, buildSnapshot(spec, runId, "completed", completed.length, nextIndex, watermark, undefined));
		markRunFinished(cwd, runId, "completed");
		return pollRun(cwd, runId);
	}
	writeResumeSnapshot(cwd, runId, buildSnapshot(spec, runId, "running", completed.length, nextIndex, watermark, undefined));
	return pollRun(cwd, runId);
}
