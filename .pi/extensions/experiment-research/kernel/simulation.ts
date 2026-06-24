import { getExperimentPoints, type ExperimentPoint } from "../spec-utils.ts";
import type { ExperimentSpec } from "../schemas.ts";

export interface SimulationPointRecord extends ExperimentPoint {
	focusScore: number;
	signal: number;
	status: "success";
}

export interface SimulationSummary {
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

export function simulatePoint(point: ExperimentPoint): SimulationPointRecord {
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
		experimentId: spec.experimentId,
		mode: "simulation",
		subjectId: spec.subject.id,
		objective: spec.objective,
		unitCount: points.length,
		progress: {
			completedUnits: points.length,
			totalUnits: points.length,
			unitKind: "point",
		},
		meanSignal: Number((totalSignal / points.length).toFixed(3)),
		maxSignal: Math.max(...signals),
		minSignal: Math.min(...signals),
		stopConditionMet: false,
	};
}

export function runSimulation(runId: string, spec: ExperimentSpec): SimulationRun {
	const points = getExperimentPoints(spec).map(simulatePoint);
	const summary = summarizeRun(runId, spec, points);
	return { runId, spec, points, summary };
}

export function runLabAgentKernel(runId: string, spec: ExperimentSpec): SimulationRun {
	return runSimulation(runId, spec);
}
