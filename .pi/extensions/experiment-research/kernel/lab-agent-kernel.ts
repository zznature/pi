import type { ExperimentSpec } from "../schemas.ts";
import { runSimulation, type SimulationRun } from "./simulation.ts";

export function runLabAgentKernel(spec: ExperimentSpec): SimulationRun {
	return runSimulation(spec);
}
