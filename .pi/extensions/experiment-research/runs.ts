import type { SimulationRun, SimulationSummary } from "./kernel/simulation.ts";

const runs = new Map<string, SimulationRun>();

export function saveRun(run: SimulationRun): void {
	runs.set(run.runId, run);
}

export function getRun(runId: string): SimulationRun | undefined {
	return runs.get(runId);
}

export function getRunSummary(runId: string): SimulationSummary | undefined {
	return runs.get(runId)?.summary;
}
