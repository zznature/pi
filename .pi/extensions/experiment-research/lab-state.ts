import { loadCapabilities, type Capabilities } from "./capabilities.ts";

export interface LabState {
	mode: "simulation";
	capabilities: Capabilities;
	activeRunId: null;
	dryRunAvailable: true;
	hardwareAvailable: true;
	notes: string[];
}

export function getLabState(): LabState {
	return {
		mode: "simulation",
		capabilities: loadCapabilities(),
		activeRunId: null,
		dryRunAvailable: true,
		hardwareAvailable: true,
		notes: [
			"Phase 4 exposes schema validation, simulation runs, dry-run preflight, and a stage-only hardware pilot.",
			"Hardware pilot is limited to the MC.Newton XYZ stage path with no camera, Raman acquisition, laser, or LLM runtime parameter changes.",
		],
	};
}
