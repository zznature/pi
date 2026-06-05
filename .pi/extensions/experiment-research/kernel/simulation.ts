import { getExperimentPoints, type ExperimentPoint } from "../spec-utils.ts";
import type { ExperimentSpec } from "../schemas.ts";

export interface SimulationPointRecord extends ExperimentPoint {
	focusScore: number;
	signal: number;
	status: "success";
}

export interface SimulationSummary {
	runId: string;
	mode: "simulation";
	sampleId: string;
	objective: string;
	pointCount: number;
	meanSignal: number;
	maxSignal: number;
	minSignal: number;
	stopConditionMet: boolean;
}

export interface SimulationRun {
	runId: string;
	spec: ExperimentSpec;
	points: SimulationPointRecord[];
	summary: SimulationSummary;
}

let nextRunNumber = 1;

function nextRunId(): string {
	const id = `sim-run-${String(nextRunNumber).padStart(4, "0")}`;
	nextRunNumber += 1;
	return id;
}

function simulatePoint(point: ExperimentPoint): SimulationPointRecord {
	const signal = 100 + point.xUm * 0.1 + point.yUm * 0.2 + point.index;
	const focusScore = 0.9 - point.index * 0.001;
	return {
		...point,
		focusScore: Number(focusScore.toFixed(3)),
		signal: Number(signal.toFixed(3)),
		status: "success",
	};
}

function summarizeRun(runId: string, spec: ExperimentSpec, points: SimulationPointRecord[]): SimulationSummary {
	const signals = points.map((point) => point.signal);
	const totalSignal = signals.reduce((total, signal) => total + signal, 0);

	return {
		runId,
		mode: "simulation",
		sampleId: spec.sampleId,
		objective: spec.objective,
		pointCount: points.length,
		meanSignal: Number((totalSignal / points.length).toFixed(3)),
		maxSignal: Math.max(...signals),
		minSignal: Math.min(...signals),
		stopConditionMet: false,
	};
}

export function runSimulation(spec: ExperimentSpec): SimulationRun {
	const runId = nextRunId();
	const points = getExperimentPoints(spec).map(simulatePoint);
	const summary = summarizeRun(runId, spec, points);
	return { runId, spec, points, summary };
}
