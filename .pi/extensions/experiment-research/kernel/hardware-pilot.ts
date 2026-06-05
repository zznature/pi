import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExperimentSpec, HardwarePilotParams } from "../schemas.ts";
import { getExperimentPoints, type ExperimentPoint } from "../spec-utils.ts";
import { evaluateWatchdog } from "../watchdog.ts";
import type { StageAdapter, StagePosition } from "./stage-adapter.ts";

export interface HardwarePointRecord extends ExperimentPoint {
	status: "success" | "error" | "skipped";
	positionBefore?: StagePosition;
	positionAfter?: StagePosition;
	error?: string;
}

export interface HardwareSummary {
	runId: string;
	mode: "hardware";
	sampleId: string;
	objective: string;
	pointCount: number;
	completedPoints: number;
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
		mode: "hardware",
		sampleId: spec.sampleId,
		objective: spec.objective,
		pointCount: getExperimentPoints(spec).length,
		completedPoints: points.filter((point) => point.status === "success").length,
		status,
		stopConditionMet: status !== "completed",
		stopReason,
		operatorOnlyMonitoring,
	};
}

export function runHardwarePilotKernel(spec: ExperimentSpec, options: HardwareKernelOptions): HardwareRun {
	const points = getExperimentPoints(spec);
	const records: HardwarePointRecord[] = [];
	const startPointIndex = options.startPointIndex ?? 0;
	let consecutiveErrors = 0;
	let lastHeartbeatMs = options.nowMs?.() ?? Date.now();
	let status: HardwareSummary["status"] = "completed";
	let stopReason: string | undefined;

	appendEvent(options.eventsPath, {
		type: "hardware_run_started",
		runId: options.runId,
		pointCount: points.length,
		stageAdapter: options.pilot.stageAdapter,
		operatorOnlyMonitoring: options.pilot.approval.operatorOnlyMonitoring === true,
	});

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
		});
		if (beforeDecision.intent === "pause" || beforeDecision.intent === "abort") {
			options.stage.stop();
			status = beforeDecision.intent === "pause" ? "paused" : "aborted";
			stopReason = beforeDecision.reason;
			appendEvent(options.eventsPath, { type: "hardware_run_stopped", runId: options.runId, status, stopReason });
			break;
		}

		try {
			appendEvent(options.eventsPath, { type: "point_started", runId: options.runId, point });
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
			appendEvent(options.eventsPath, { type: "point_completed", runId: options.runId, point: record });
		} catch (error) {
			consecutiveErrors += 1;
			const message = error instanceof Error ? error.message : String(error);
			const record: HardwarePointRecord = { ...point, status: "error", error: message };
			records.push(record);
			appendEvent(options.eventsPath, { type: "point_error", runId: options.runId, point: record });
			const errorDecision = evaluateWatchdog({
				nowMs: options.nowMs?.() ?? Date.now(),
				lastHeartbeatMs,
				heartbeatTimeoutMs: options.pilot.heartbeatTimeoutMs,
				consecutiveErrors,
				maxConsecutiveErrors: options.pilot.maxConsecutiveErrors,
				intentsPath: options.pilot.intentsPath,
			});
			if (errorDecision.intent !== "none" || spec.stoppingRules.stopOnError) {
				options.stage.stop();
				status = errorDecision.intent === "pause" ? "paused" : "aborted";
				stopReason = errorDecision.reason ?? "point error";
				appendEvent(options.eventsPath, { type: "hardware_run_stopped", runId: options.runId, status, stopReason });
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
		options.pilot.approval.operatorOnlyMonitoring === true,
	);
	appendEvent(options.eventsPath, { type: "hardware_run_summary", runId: options.runId, summary });
	return { runId: options.runId, spec, points: records, summary };
}
