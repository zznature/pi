import type { ExperimentSpec } from "./schemas.ts";

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

export function getUnitCount(spec: ExperimentSpec): number {
	if (spec.plan.kind === "steps") return spec.plan.steps.length;
	return getExperimentPoints(spec).length;
}
