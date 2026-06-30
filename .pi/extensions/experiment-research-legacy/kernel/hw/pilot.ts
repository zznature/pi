import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExperimentSpec, HardwarePilotParams, RamanErrorCode } from "../../schemas.ts";
import { getExperimentPoints, type ExperimentPoint } from "../../spec-utils.ts";
import { evaluateWatchdog } from "../../watchdog.ts";
import type { StageAdapter, StagePosition } from "./stage.ts";

export interface HardwareAutofocusRecord {
	zBestUm: number;
	finalScore: number;
	confidence: number;
	curveArtifactId?: string;
}

export interface HardwareXyCorrectionRecord {
	dxUm: number;
	dyUm: number;
	confidence: number;
	applied: boolean;
}

export interface HardwareSpectrumRecord {
	artifactId: string;
	integrationTimeS: number;
	accumulations: number;
}

export interface HardwarePointRecord extends ExperimentPoint {
	status: "success" | "error" | "skipped";
	positionBefore?: StagePosition;
	positionAfter?: StagePosition;
	autofocus?: HardwareAutofocusRecord;
	xyCorrection?: HardwareXyCorrectionRecord;
	spectrum?: HardwareSpectrumRecord;
	errorCode?: RamanErrorCode;
	error?: string;
}

export interface HardwareSummary {
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
	status: "completed" | "paused" | "aborted" | "error";
	stopConditionMet: boolean;
	stopReason?: string;
	operatorOnlyMonitoring: boolean;
}

export interface HardwareRun {
	runId: string;
	spec: ExperimentSpec;
	points: HardwarePointRecord[];
	summary: HardwareSummary;
}

export interface HardwareKernelOptions {
	runId: string;
	stage: StageAdapter;
	pilot: HardwarePilotParams;
	eventsPath: string;
	startPointIndex?: number;
	nowMs?: () => number;
	correlationId?: string;
}

function appendEvent(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf-8");
}

function buildSummary(
	runId: string,
	spec: ExperimentSpec,
	points: HardwarePointRecord[],
	status: HardwareSummary["status"],
	stopReason: string | undefined,
	operatorOnlyMonitoring: boolean,
): HardwareSummary {
	return {
		runId,
		experimentId: spec.experimentId,
		mode: "hardware",
		subjectId: spec.subject.id,
		objective: spec.objective,
		unitCount: getExperimentPoints(spec).length,
		completedUnits: points.filter((point) => point.status === "success").length,
		progress: {
			completedUnits: points.filter((point) => point.status === "success").length,
			totalUnits: getExperimentPoints(spec).length,
			unitKind: "point",
		},
		status,
		stopConditionMet: status !== "completed",
		stopReason,
		operatorOnlyMonitoring,
	};
}

function statusForWatchdogIntent(intent: "pause" | "abort" | "request_operator"): HardwareSummary["status"] {
	return intent === "abort" ? "aborted" : "paused";
}

export function runHardwarePilotKernel(spec: ExperimentSpec, options: HardwareKernelOptions): HardwareRun {
	const points = getExperimentPoints(spec);
	const records: HardwarePointRecord[] = [];
	const startPointIndex = options.startPointIndex ?? 0;
	const correlationId = options.correlationId ?? options.runId;
	let sequence = 2;
	let consecutiveErrors = 0;
	let lastHeartbeatMs = options.nowMs?.() ?? Date.now();
	let status: HardwareSummary["status"] = "completed";
	let stopReason: string | undefined;

	appendEvent(options.eventsPath, {
		schemaVersion: "1",
		sequence,
		type: "run_started",
		experimentId: spec.experimentId,
		runId: options.runId,
		correlationId,
		timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
		unitCount: points.length,
		stageAdapter: options.pilot.stageAdapter,
		operatorOnlyMonitoring: options.pilot.approval?.operatorOnlyMonitoring === true,
	});
	sequence += 1;

	for (const point of points) {
		if (point.index < startPointIndex) {
			records.push({ ...point, status: "skipped" });
			continue;
		}

		const beforeDecision = evaluateWatchdog({
			nowMs: options.nowMs?.() ?? Date.now(),
			lastHeartbeatMs,
			heartbeatTimeoutMs: options.pilot.heartbeatTimeoutMs,
			consecutiveErrors,
			maxConsecutiveErrors: options.pilot.maxConsecutiveErrors,
			intentsPath: options.pilot.intentsPath,
			budgetGuard: {
				completedUnits: records.filter((record) => record.status === "success").length,
				maxUnits: spec.stoppingRules.maxUnits,
				pauseAtRatio: 1,
			},
		});
		if (beforeDecision.intent !== "none") {
			options.stage.stop();
			status = statusForWatchdogIntent(beforeDecision.intent);
			stopReason = beforeDecision.reason;
			appendEvent(options.eventsPath, {
				schemaVersion: "1",
				sequence,
				type: "run_stopped",
				experimentId: spec.experimentId,
				runId: options.runId,
				correlationId,
				timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
				status,
				stopReason,
			});
			sequence += 1;
			break;
		}

		try {
			appendEvent(options.eventsPath, {
				schemaVersion: "1",
				sequence,
				type: "unit_started",
				experimentId: spec.experimentId,
				runId: options.runId,
				correlationId,
				timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
				unitKind: "point",
				unit: point,
			});
			sequence += 1;
			const visit = options.stage.visitPoint(point, options.pilot.settleTimeoutMs);
			const record: HardwarePointRecord = {
				...point,
				status: "success",
				positionBefore: visit.before,
				positionAfter: visit.after,
			};
			records.push(record);
			consecutiveErrors = 0;
			lastHeartbeatMs = options.nowMs?.() ?? Date.now();
			appendEvent(options.eventsPath, {
				schemaVersion: "1",
				sequence,
				type: "unit_completed",
				experimentId: spec.experimentId,
				runId: options.runId,
				correlationId,
				timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
				unitKind: "point",
				unit: record,
			});
			sequence += 1;
		} catch (error) {
			consecutiveErrors += 1;
			const message = error instanceof Error ? error.message : String(error);
			const record: HardwarePointRecord = { ...point, status: "error", error: message };
			records.push(record);
			appendEvent(options.eventsPath, {
				schemaVersion: "1",
				sequence,
				type: "unit_error",
				experimentId: spec.experimentId,
				runId: options.runId,
				correlationId,
				timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
				unitKind: "point",
				unit: record,
			});
			sequence += 1;
			const errorDecision = evaluateWatchdog({
				nowMs: options.nowMs?.() ?? Date.now(),
				lastHeartbeatMs,
				heartbeatTimeoutMs: options.pilot.heartbeatTimeoutMs,
				consecutiveErrors,
				maxConsecutiveErrors: options.pilot.maxConsecutiveErrors,
				intentsPath: options.pilot.intentsPath,
				budgetGuard: {
					completedUnits: records.filter((record) => record.status === "success").length,
					maxUnits: spec.stoppingRules.maxUnits,
					pauseAtRatio: 1,
				},
			});
			if (errorDecision.intent !== "none" || spec.stoppingRules.stopOnError) {
				options.stage.stop();
				status = errorDecision.intent === "none" ? "aborted" : statusForWatchdogIntent(errorDecision.intent);
				stopReason = errorDecision.reason ?? "point error";
				appendEvent(options.eventsPath, {
					schemaVersion: "1",
					sequence,
					type: "run_stopped",
					experimentId: spec.experimentId,
					runId: options.runId,
					correlationId,
					timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
					status,
					stopReason,
				});
				sequence += 1;
				break;
			}
		}
	}

	options.stage.close();
	const summary = buildSummary(
		options.runId,
		spec,
		records,
		status,
		stopReason,
		options.pilot.approval?.operatorOnlyMonitoring === true,
	);
	appendEvent(options.eventsPath, {
		schemaVersion: "1",
		sequence,
		type: "run_summary",
		experimentId: spec.experimentId,
		runId: options.runId,
		correlationId,
		timestamp: new Date(options.nowMs?.() ?? Date.now()).toISOString(),
		summary,
	});
	return { runId: options.runId, spec, points: records, summary };
}
