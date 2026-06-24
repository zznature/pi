import type { ExperimentSpec, RamanOperationIntent } from "./schemas.ts";

export interface ExperimentPoint {
	index: number;
	xUm: number;
	yUm: number;
	zUm?: number;
}

export type ExperimentUnitKind = "point" | "step" | "batch" | "replicate";

function interpolate(start: number, stop: number, steps: number, index: number): number {
	if (steps === 1) return start;
	return start + ((stop - start) * index) / (steps - 1);
}

export function getExperimentPoints(spec: ExperimentSpec): ExperimentPoint[] {
	if (spec.plan.kind === "points") {
		return spec.plan.points.map((point, index) => ({ index, ...point }));
	}

	if (spec.plan.kind !== "grid") return [];

	const points: ExperimentPoint[] = [];
	for (let yIndex = 0; yIndex < spec.plan.grid.y.steps; yIndex++) {
		for (let xIndex = 0; xIndex < spec.plan.grid.x.steps; xIndex++) {
			points.push({
				index: points.length,
				xUm: interpolate(spec.plan.grid.x.startUm, spec.plan.grid.x.stopUm, spec.plan.grid.x.steps, xIndex),
				yUm: interpolate(spec.plan.grid.y.startUm, spec.plan.grid.y.stopUm, spec.plan.grid.y.steps, yIndex),
			});
		}
	}

	return points;
}

export function getInstrumentResourceIds(spec: ExperimentSpec): string[] {
	return spec.resources.filter((resource) => resource.kind === "instrument").map((resource) => resource.id);
}

export function getResourceIds(spec: ExperimentSpec): string[] {
	return spec.resources.map((resource) => resource.id);
}

export function getUnitCount(spec: ExperimentSpec): number {
	if (spec.plan.kind === "steps") return spec.plan.steps.length;
	return getExperimentPoints(spec).length;
}

export function deriveDryRunSpecFromHardware(spec: ExperimentSpec): ExperimentSpec {
	return {
		...spec,
		mode: "dry_run",
	};
}

export function getRamanOperationIntent(spec: ExperimentSpec): RamanOperationIntent | undefined {
	return spec.domain?.raman?.operationIntent;
}

export function ramanRequestsAutofocus(spec: ExperimentSpec): boolean {
	const intent = getRamanOperationIntent(spec);
	return intent === "autofocus_only" || intent === "autofocus_then_acquire";
}

export function ramanRequestsAcquisition(spec: ExperimentSpec): boolean {
	const intent = getRamanOperationIntent(spec);
	return intent === "acquire_only" || intent === "autofocus_then_acquire";
}

export interface RamanValidationCoverage {
	autofocus: boolean;
	xyCorrection: boolean;
	thermalWait: boolean;
	acquisition: boolean;
}

export function getRamanValidationCoverage(spec: ExperimentSpec): RamanValidationCoverage {
	return {
		autofocus: spec.domain?.raman?.autofocus?.enabled === true,
		xyCorrection: spec.domain?.raman?.xyCorrection?.enabled === true,
		thermalWait: spec.domain?.thermal?.enabled === true && spec.domain.thermal.waitBeforeAcquisition !== false,
		acquisition: !!spec.domain?.raman?.acquisition,
	};
}
