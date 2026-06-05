import { loadCapabilities, type Capabilities } from "./capabilities.ts";

export interface LabState {
	mode: "simulation";
	capabilities: Capabilities;
	activeRunId: null;
	dryRunAvailable: true;
	hardwareAvailable: false;
	notes: string[];
}

export function getLabState(): LabState {
	return {
		mode: "simulation",
		capabilities: loadCapabilities(),
		activeRunId: null,
		dryRunAvailable: true,
		hardwareAvailable: false,
		notes: [
			"Phase 3 exposes schema validation, simulation runs, dry-run preflight, and read-only live state probes.",
			"No persistent records, watchdog, hardware motion, acquisition, or power changes are connected.",
		],
	};
}
