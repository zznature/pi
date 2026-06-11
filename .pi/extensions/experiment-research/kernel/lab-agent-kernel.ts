import type { ExperimentSpec } from "../schemas.ts";
import { runSimulation, type SimulationRun } from "./simulation.ts";

export function runLabAgentKernel(runId: string, spec: ExperimentSpec): SimulationRun {
	return runSimulation(runId, spec);
}
