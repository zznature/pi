import type { SimulationSummary } from "./kernel/simulation.ts";

export type ReplanStrategy = "repeat_same" | "increase_resolution" | "reduce_range" | "stop";

export interface PlanNextExperimentResult {
	runId: string;
	objective: string;
	strategy: ReplanStrategy;
	rationale: string;
}

export function planNextExperiment(summary: SimulationSummary, objective: string): PlanNextExperimentResult {
	if (summary.stopConditionMet) {
		return {
			runId: summary.runId,
			objective,
			strategy: "stop",
			rationale: "The previous run met its stop condition.",
		};
	}

	if (summary.pointCount < 25 && summary.meanSignal >= 105) {
		return {
			runId: summary.runId,
			objective,
			strategy: "increase_resolution",
			rationale: "The previous run produced sufficient signal with room to increase point density.",
		};
	}

	if (summary.meanSignal < 105) {
		return {
			runId: summary.runId,
			objective,
			strategy: "repeat_same",
			rationale: "The previous run signal is low; repeat before changing the search region.",
		};
	}

	return {
		runId: summary.runId,
		objective,
		strategy: "reduce_range",
		rationale: "The previous run has enough points; narrow the next bounded region around informative areas.",
	};
}
