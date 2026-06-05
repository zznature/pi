import type { ExperimentSpec } from "./schemas.ts";

export interface ExperimentPoint {
	index: number;
	xUm: number;
	yUm: number;
	zUm?: number;
}

function interpolate(start: number, stop: number, steps: number, index: number): number {
	if (steps === 1) return start;
	return start + ((stop - start) * index) / (steps - 1);
}

export function getExperimentPoints(spec: ExperimentSpec): ExperimentPoint[] {
	if (spec.points) {
		return spec.points.map((point, index) => ({ index, ...point }));
	}

	if (!spec.grid) return [];

	const points: ExperimentPoint[] = [];
	for (let yIndex = 0; yIndex < spec.grid.y.steps; yIndex++) {
		for (let xIndex = 0; xIndex < spec.grid.x.steps; xIndex++) {
			points.push({
				index: points.length,
				xUm: interpolate(spec.grid.x.startUm, spec.grid.x.stopUm, spec.grid.x.steps, xIndex),
				yUm: interpolate(spec.grid.y.startUm, spec.grid.y.stopUm, spec.grid.y.steps, yIndex),
			});
		}
	}

	return points;
}
