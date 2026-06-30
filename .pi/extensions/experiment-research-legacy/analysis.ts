import type { RecordedEvent } from "./run-store.ts";
import type { ExperimentSpec, ToolResult } from "./schemas.ts";
import { getUnitCount } from "./spec-utils.ts";

export type AnomalySeverity = "warning" | "critical";
export type StoppingRuleStatus = "passed" | "triggered" | "not_evaluable";

export interface QualityMetrics {
	unitCount: number;
	completedUnits: number;
	failedUnits: number;
	skippedUnits: number;
	completionRate: number;
	errorRate: number;
	meanSignal?: number;
	maxSignal?: number;
	minSignal?: number;
	signalRange?: number;
	meanFocusScore?: number;
	minFocusScore?: number;
	meanFocusConfidence?: number;
	meanSnrEstimate?: number;
	minSnrEstimate?: number;
	saturatedSpectra?: number;
	meanXyCorrectionUm?: number;
	artifactCount: number;
}

export interface AnomalyPoint {
	unitId: string;
	unitIndex?: number;
	severity: AnomalySeverity;
	metric: string;
	observed: string | number | boolean;
	threshold?: string | number | boolean;
	reason: string;
	artifactRefs: string[];
}

export interface StoppingRuleJudgment {
	rule: string;
	status: StoppingRuleStatus;
	triggered: boolean;
	observed?: string | number | boolean;
	limit?: string | number | boolean;
	reason: string;
}

export interface RunAnalysis {
	schemaVersion: "1";
	runId: string;
	experimentId?: string;
	status: string;
	qualityMetrics: QualityMetrics;
	anomalies: AnomalyPoint[];
	artifactRefs: ToolResult["artifacts"];
	stoppingRules: StoppingRuleJudgment[];
	stopConditionMet: boolean;
	recommendationBasis: {
		usableForReplan: boolean;
		reason: string;
	};
}

interface UnitForAnalysis {
	unitId: string;
	unitIndex?: number;
	status?: string;
	signal?: number;
	focusScore?: number;
	focusConfidence?: number;
	snrEstimate?: number;
	saturated?: boolean;
	xyCorrectionUm?: number;
	errorCode?: string;
	error?: string;
}

interface SummaryForAnalysis {
	runId: string;
	experimentId?: string;
	status: string;
	unitCount: number;
	completedUnits: number;
	meanSignal?: number;
	maxSignal?: number;
	minSignal?: number;
	stopConditionMet: boolean;
	runtimeMinutes?: number;
}

const SIGNAL_BASELINE = 105;
const LOW_POINT_SIGNAL_THRESHOLD = 100;
const MIN_FOCUS_SCORE = 0.75;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function round(value: number): number {
	return Number(value.toFixed(3));
}

function mean(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function min(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	return Math.min(...values);
}

function max(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	return Math.max(...values);
}

function readCompletedUnits(summaryRecord: Record<string, unknown>, unitCount: number): number {
	const progress = asRecord(summaryRecord.progress);
	if (progress) {
		const completedUnits = numberValue(progress, "completedUnits");
		if (completedUnits !== undefined) return completedUnits;
	}
	const completedUnits = numberValue(summaryRecord, "completedUnits");
	return completedUnits ?? unitCount;
}

function readSummary(summary: unknown, spec: ExperimentSpec | undefined): SummaryForAnalysis {
	const record = asRecord(summary);
	if (!record) {
		return {
			runId: "",
			status: "unknown",
			unitCount: spec ? getUnitCount(spec) : 0,
			completedUnits: 0,
			stopConditionMet: false,
		};
	}
	const specUnitCount = spec ? getUnitCount(spec) : 0;
	const unitCount = numberValue(record, "unitCount") ?? specUnitCount;
	return {
		runId: stringValue(record, "runId") ?? "",
		experimentId: stringValue(record, "experimentId") ?? spec?.experimentId,
		status: stringValue(record, "status") ?? "completed",
		unitCount,
		completedUnits: readCompletedUnits(record, unitCount),
		meanSignal: numberValue(record, "meanSignal"),
		maxSignal: numberValue(record, "maxSignal"),
		minSignal: numberValue(record, "minSignal"),
		stopConditionMet: record.stopConditionMet === true,
		runtimeMinutes: numberValue(record, "runtimeMinutes"),
	};
}

function readUnit(event: RecordedEvent): UnitForAnalysis | undefined {
	const unit = asRecord(event.unit);
	if (!unit) return undefined;
	const unitIndex = numberValue(unit, "index");
	const status = stringValue(unit, "status");
	const eventType = event.type === "unit_error" ? "error" : status;
	const autofocus = asRecord(unit.autofocus);
	const spectrumMetadata = asRecord(unit.spectrumMetadata);
	const xyCorrection = asRecord(unit.xyCorrection);
	const dxUm = xyCorrection ? numberValue(xyCorrection, "dxUm") : undefined;
	const dyUm = xyCorrection ? numberValue(xyCorrection, "dyUm") : undefined;
	return {
		unitId: unitIndex === undefined ? `${event.type ?? "unit"}-${event.sequence ?? "unknown"}` : `point-${unitIndex}`,
		unitIndex,
		status: eventType,
		signal: numberValue(unit, "signal"),
		focusScore: numberValue(unit, "focusScore"),
		focusConfidence: autofocus ? numberValue(autofocus, "confidence") : undefined,
		snrEstimate: spectrumMetadata ? numberValue(spectrumMetadata, "snrEstimate") : undefined,
		saturated: spectrumMetadata?.saturated === true,
		xyCorrectionUm: dxUm === undefined || dyUm === undefined ? undefined : round(Math.hypot(dxUm, dyUm)),
		errorCode: stringValue(unit, "errorCode"),
		error: stringValue(unit, "error"),
	};
}

function readArtifactRefs(artifacts: unknown[]): ToolResult["artifacts"] {
	return artifacts.filter((artifact): artifact is ToolResult["artifacts"][number] => {
		const record = asRecord(artifact);
		return record !== undefined && typeof record.uri === "string" && typeof record.label === "string";
	});
}

function computeMetrics(summary: SummaryForAnalysis, units: UnitForAnalysis[], artifactRefs: ToolResult["artifacts"]): QualityMetrics {
	const signals = units.map((unit) => unit.signal).filter((signal): signal is number => signal !== undefined);
	const focusScores = units.map((unit) => unit.focusScore).filter((focusScore): focusScore is number => focusScore !== undefined);
	const focusConfidences = units
		.map((unit) => unit.focusConfidence)
		.filter((focusConfidence): focusConfidence is number => focusConfidence !== undefined);
	const snrEstimates = units.map((unit) => unit.snrEstimate).filter((snrEstimate): snrEstimate is number => snrEstimate !== undefined);
	const xyCorrections = units
		.map((unit) => unit.xyCorrectionUm)
		.filter((xyCorrectionUm): xyCorrectionUm is number => xyCorrectionUm !== undefined);
	const failedUnits = units.filter((unit) => unit.status === "error").length;
	const skippedUnits = units.filter((unit) => unit.status === "skipped").length;
	const completedUnits = summary.completedUnits;
	const unitCount = summary.unitCount;
	const minSignal = min(signals) ?? summary.minSignal;
	const maxSignal = max(signals) ?? summary.maxSignal;
	return {
		unitCount,
		completedUnits,
		failedUnits,
		skippedUnits,
		completionRate: unitCount === 0 ? 0 : round(completedUnits / unitCount),
		errorRate: unitCount === 0 ? 0 : round(failedUnits / unitCount),
		meanSignal: mean(signals) ?? summary.meanSignal,
		maxSignal,
		minSignal,
		signalRange: minSignal === undefined || maxSignal === undefined ? undefined : round(maxSignal - minSignal),
		meanFocusScore: mean(focusScores),
		minFocusScore: min(focusScores),
		meanFocusConfidence: mean(focusConfidences),
		meanSnrEstimate: mean(snrEstimates),
		minSnrEstimate: min(snrEstimates),
		saturatedSpectra: units.filter((unit) => unit.saturated === true).length,
		meanXyCorrectionUm: mean(xyCorrections),
		artifactCount: artifactRefs.length,
	};
}

function buildAnomalies(summary: SummaryForAnalysis, metrics: QualityMetrics, units: UnitForAnalysis[]): AnomalyPoint[] {
	const anomalies: AnomalyPoint[] = [];
	if (summary.status !== "completed") {
		anomalies.push({
			unitId: "run",
			severity: "critical",
			metric: "status",
			observed: summary.status,
			threshold: "completed",
			reason: "Run did not complete normally.",
			artifactRefs: [],
		});
	}
	if (metrics.completionRate < 1) {
		anomalies.push({
			unitId: "run",
			severity: "warning",
			metric: "completionRate",
			observed: metrics.completionRate,
			threshold: 1,
			reason: "Not all planned units completed.",
			artifactRefs: [],
		});
	}
	if (metrics.meanSignal !== undefined && metrics.meanSignal < SIGNAL_BASELINE) {
		anomalies.push({
			unitId: "run",
			severity: "warning",
			metric: "meanSignal",
			observed: metrics.meanSignal,
			threshold: SIGNAL_BASELINE,
			reason: "Mean signal is below the baseline used for deterministic replanning.",
			artifactRefs: [],
		});
	}
	if (metrics.artifactCount === 0) {
		anomalies.push({
			unitId: "run",
			severity: "warning",
			metric: "artifactCount",
			observed: 0,
			threshold: ">=1",
			reason: "No artifact references were recorded for this run.",
			artifactRefs: [],
		});
	}

	for (const unit of units) {
		if (unit.status === "error") {
			anomalies.push({
				unitId: unit.unitId,
				unitIndex: unit.unitIndex,
				severity: "critical",
				metric: "unitStatus",
				observed: "error",
				threshold: "success",
				reason: unit.errorCode ?? unit.error ?? "Unit error event was recorded.",
				artifactRefs: [],
			});
		}
		if (unit.signal !== undefined && unit.signal < LOW_POINT_SIGNAL_THRESHOLD) {
			anomalies.push({
				unitId: unit.unitId,
				unitIndex: unit.unitIndex,
				severity: "warning",
				metric: "signal",
				observed: unit.signal,
				threshold: LOW_POINT_SIGNAL_THRESHOLD,
				reason: "Point signal is below the low-signal guard threshold.",
				artifactRefs: [],
			});
		}
		if (unit.focusScore !== undefined && unit.focusScore < MIN_FOCUS_SCORE) {
			anomalies.push({
				unitId: unit.unitId,
				unitIndex: unit.unitIndex,
				severity: "warning",
				metric: "focusScore",
				observed: unit.focusScore,
				threshold: MIN_FOCUS_SCORE,
				reason: "Focus score is below the deterministic quality threshold.",
				artifactRefs: [],
			});
		}
		if (unit.saturated === true) {
			anomalies.push({
				unitId: unit.unitId,
				unitIndex: unit.unitIndex,
				severity: "warning",
				metric: "saturated",
				observed: true,
				threshold: false,
				reason: "Spectrum metadata reports saturation.",
				artifactRefs: [],
			});
		}
	}

	return anomalies;
}

function buildStoppingRules(
	summary: SummaryForAnalysis,
	metrics: QualityMetrics,
	spec: ExperimentSpec | undefined,
): StoppingRuleJudgment[] {
	if (!spec) {
		return [
			{
				rule: "spec",
				status: "not_evaluable",
				triggered: false,
				reason: "ExperimentSpec was not available for stopping-rule evaluation.",
			},
		];
	}

	const maxUnitsTriggered = metrics.unitCount > spec.stoppingRules.maxUnits;
	const stopOnErrorTriggered = spec.stoppingRules.stopOnError && metrics.failedUnits > 0;
	const runtimeTriggered =
		summary.runtimeMinutes === undefined ? undefined : summary.runtimeMinutes > spec.stoppingRules.maxRuntimeMinutes;
	return [
		{
			rule: "maxUnits",
			status: maxUnitsTriggered ? "triggered" : "passed",
			triggered: maxUnitsTriggered,
			observed: metrics.unitCount,
			limit: spec.stoppingRules.maxUnits,
			reason: maxUnitsTriggered ? "Run exceeded the bounded unit limit." : "Run stayed within the bounded unit limit.",
		},
		{
			rule: "maxRuntimeMinutes",
			status: runtimeTriggered === undefined ? "not_evaluable" : runtimeTriggered ? "triggered" : "passed",
			triggered: runtimeTriggered === true,
			observed: summary.runtimeMinutes,
			limit: spec.stoppingRules.maxRuntimeMinutes,
			reason:
				runtimeTriggered === undefined
					? "Run summary does not include runtimeMinutes."
					: runtimeTriggered
						? "Run exceeded the runtime limit."
						: "Run stayed within the runtime limit.",
		},
		{
			rule: "stopOnError",
			status: stopOnErrorTriggered ? "triggered" : "passed",
			triggered: stopOnErrorTriggered,
			observed: metrics.failedUnits,
			limit: spec.stoppingRules.stopOnError,
			reason: stopOnErrorTriggered ? "Run recorded unit errors while stopOnError is enabled." : "No stop-on-error condition was met.",
		},
		{
			rule: "summaryStopCondition",
			status: summary.stopConditionMet ? "triggered" : "passed",
			triggered: summary.stopConditionMet,
			observed: summary.stopConditionMet,
			limit: false,
			reason: summary.stopConditionMet
				? "Kernel summary reports that a stop condition was met."
				: "Kernel summary did not report a stop condition.",
		},
	];
}

function recommendationBasis(anomalies: AnomalyPoint[], stopConditionMet: boolean): RunAnalysis["recommendationBasis"] {
	if (stopConditionMet) {
		return { usableForReplan: false, reason: "A stopping rule was triggered; operator or researcher review is required." };
	}
	if (anomalies.some((anomaly) => anomaly.severity === "critical")) {
		return { usableForReplan: false, reason: "Critical anomalies must be resolved before compiling a follow-up run." };
	}
	return { usableForReplan: true, reason: "Run records are complete enough for bounded replanning." };
}

export function analyzeRecordedRun(input: {
	runId: string;
	summary: unknown;
	spec?: ExperimentSpec;
	events: RecordedEvent[];
	artifacts: unknown[];
}): RunAnalysis {
	const summary = readSummary(input.summary, input.spec);
	const units = input.events.map(readUnit).filter((unit): unit is UnitForAnalysis => unit !== undefined);
	const artifactRefs = readArtifactRefs(input.artifacts);
	const qualityMetrics = computeMetrics(summary, units, artifactRefs);
	const anomalies = buildAnomalies(summary, qualityMetrics, units);
	const stoppingRules = buildStoppingRules(summary, qualityMetrics, input.spec);
	const stopConditionMet = stoppingRules.some((rule) => rule.triggered);
	return {
		schemaVersion: "1",
		runId: summary.runId || input.runId,
		experimentId: summary.experimentId ?? input.spec?.experimentId,
		status: summary.status,
		qualityMetrics,
		anomalies,
		artifactRefs,
		stoppingRules,
		stopConditionMet,
		recommendationBasis: recommendationBasis(anomalies, stopConditionMet),
	};
}
