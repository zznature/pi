import type { RunAnalysis } from "./analysis.ts";
import type { LineageEntry } from "./run-store.ts";

export type ReplanStrategy = "repeat_same" | "refine_region" | "add_replicates" | "reduce_scope" | "stop";

interface SummaryForPlanning {
	runId: string;
	experimentId: string;
	mode?: string;
	unitCount: number;
	meanSignal?: number;
	signalRange?: number;
	completionRate?: number;
	errorRate?: number;
	stopConditionMet: boolean;
	status?: string;
}

export interface PlanNextExperimentInput {
	summary: unknown;
	analysis?: RunAnalysis;
	lineage: LineageEntry[];
	objective: string;
}

export interface PlanNextExperimentResult {
	runId: string;
	experimentId: string;
	objective: string;
	strategy: ReplanStrategy;
	rationale: string;
	inputArtifacts: string[];
	history: {
		lineageDepth: number;
		repeatedStrategyCount: number;
	};
	compilerInput: {
		experimentId: string;
		parentRunId: string;
		suggestedSpecId: string;
		strategy: ReplanStrategy;
		objective: string;
		boundedChanges: string[];
		requiredValidation: string[];
		requiresOperatorApproval: boolean;
	};
}

function readSummaryForPlanning(summary: unknown): SummaryForPlanning {
	if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
		throw new Error("Run summary is not an object");
	}
	const record = summary as Record<string, unknown>;
	const runId = typeof record.runId === "string" ? record.runId : "";
	const experimentId = typeof record.experimentId === "string" ? record.experimentId : "";
	const mode = typeof record.mode === "string" ? record.mode : undefined;
	const unitCount = typeof record.unitCount === "number" ? record.unitCount : 0;
	const meanSignal = typeof record.meanSignal === "number" ? record.meanSignal : undefined;
	const stopConditionMet = record.stopConditionMet === true;
	const status = typeof record.status === "string" ? record.status : undefined;
	return { runId, experimentId, mode, unitCount, meanSignal, stopConditionMet, status };
}

function summarizeWithAnalysis(summary: unknown, analysis: RunAnalysis | undefined): SummaryForPlanning {
	const parsed = readSummaryForPlanning(summary);
	if (!analysis) return parsed;
	return {
		...parsed,
		meanSignal: analysis.qualityMetrics.meanSignal ?? parsed.meanSignal,
		signalRange: analysis.qualityMetrics.signalRange,
		completionRate: analysis.qualityMetrics.completionRate,
		errorRate: analysis.qualityMetrics.errorRate,
		stopConditionMet: parsed.stopConditionMet || analysis.stopConditionMet,
	};
}

function chooseStrategy(parsed: SummaryForPlanning, analysis: RunAnalysis | undefined): { strategy: ReplanStrategy; rationale: string } {
	if (parsed.stopConditionMet || parsed.status === "aborted" || parsed.status === "paused" || parsed.status === "error") {
		return {
			strategy: "stop",
			rationale: "The previous run met a stop condition or requires operator review before replanning.",
		};
	}

	if (analysis && !analysis.recommendationBasis.usableForReplan) {
		return {
			strategy: "stop",
			rationale: analysis.recommendationBasis.reason,
		};
	}

	if ((parsed.errorRate ?? 0) > 0) {
		return {
			strategy: "add_replicates",
			rationale: "The previous run recorded errors; add bounded replicates to separate stochastic failures from signal.",
		};
	}

	if ((parsed.completionRate ?? 1) < 1) {
		return {
			strategy: "stop",
			rationale: "The previous run did not complete all planned units; review records before another bounded run.",
		};
	}

	if ((parsed.signalRange ?? 0) > 20) {
		return {
			strategy: "add_replicates",
			rationale: "The previous run shows high signal spread; add bounded replicates before refining the region.",
		};
	}

	if (parsed.unitCount < 25 && (parsed.meanSignal ?? 0) >= 105) {
		return {
			strategy: "refine_region",
			rationale: "The previous run produced sufficient signal with room to refine the bounded region.",
		};
	}

	if ((parsed.meanSignal ?? 0) < 105) {
		return {
			strategy: "repeat_same",
			rationale: "The previous run signal is low; repeat before changing strategy.",
		};
	}

	return {
		strategy: "reduce_scope",
		rationale: "The previous run has enough units; reduce scope around informative conditions.",
	};
}

function countRepeatedStrategy(lineage: LineageEntry[], strategy: ReplanStrategy): number {
	let count = 0;
	for (const entry of lineage.slice().reverse()) {
		if (entry.strategy !== strategy) break;
		count += 1;
	}
	return count;
}

function stabilizeRepeatedStrategy(
	lineage: LineageEntry[],
	choice: { strategy: ReplanStrategy; rationale: string },
): { strategy: ReplanStrategy; rationale: string } {
	const repeatedStrategyCount = countRepeatedStrategy(lineage, choice.strategy);
	if (choice.strategy !== "stop" && repeatedStrategyCount >= 2) {
		return {
			strategy: "reduce_scope",
			rationale: "The same strategy has repeated across recent lineage; reduce scope before continuing.",
		};
	}
	return choice;
}

function artifactUris(analysis: RunAnalysis | undefined, runId: string): string[] {
	const base = [`.pi/experiment-runs/runs/${runId}/summary.json`];
	if (!analysis) return base;
	return [
		...base,
		`.pi/experiment-runs/runs/${runId}/analysis.json`,
		...analysis.artifactRefs.map((artifact) => artifact.uri),
	];
}

function boundedChanges(strategy: ReplanStrategy): string[] {
	switch (strategy) {
		case "repeat_same":
			return ["preserve plan shape and limits", "repeat within the same bounded unit count"];
		case "refine_region":
			return ["narrow the region around informative units", "keep unit count within stoppingRules.maxUnits"];
		case "add_replicates":
			return ["add bounded replicates for informative units", "do not expand hardware capability"];
		case "reduce_scope":
			return ["remove low-value units", "keep the same experimentId and subject"];
		case "stop":
			return ["do not compile a follow-up ExperimentSpec until reviewed"];
	}
}

function suggestedSpecId(runId: string, strategy: ReplanStrategy, lineageDepth: number): string {
	return `${runId}-${strategy}-next-${lineageDepth + 1}`;
}

export function planNextExperiment(input: PlanNextExperimentInput): PlanNextExperimentResult {
	const parsed = summarizeWithAnalysis(input.summary, input.analysis);
	const initialChoice = chooseStrategy(parsed, input.analysis);
	const choice = stabilizeRepeatedStrategy(input.lineage, initialChoice);
	const repeatedStrategyCount = countRepeatedStrategy(input.lineage, choice.strategy);
	const inputArtifacts = artifactUris(input.analysis, parsed.runId);
	return {
		runId: parsed.runId,
		experimentId: parsed.experimentId,
		objective: input.objective,
		strategy: choice.strategy,
		rationale: choice.rationale,
		inputArtifacts,
		history: {
			lineageDepth: input.lineage.length,
			repeatedStrategyCount,
		},
		compilerInput: {
			experimentId: parsed.experimentId,
			parentRunId: parsed.runId,
			suggestedSpecId: suggestedSpecId(parsed.runId, choice.strategy, input.lineage.length),
			strategy: choice.strategy,
			objective: input.objective,
			boundedChanges: boundedChanges(choice.strategy),
			requiredValidation: ["validate_experiment_spec", "run_preflight", "hardware_gate_if_hardware"],
			requiresOperatorApproval: parsed.mode === "hardware",
		},
	};
}
