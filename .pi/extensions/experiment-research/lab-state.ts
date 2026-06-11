import { loadCapabilities, type Capabilities } from "./capabilities.ts";
import { findActiveRun } from "./run-store.ts";

export interface LabState {
	mode: "simulation" | "active" | "paused" | "recovering";
	capabilities: Capabilities;
	activeRunId: string | null;
	dryRunAvailable: true;
	hardwareAvailable: true;
	notes: string[];
}

export function getLabState(cwd = "."): LabState {
	const activeRun = findActiveRun(cwd);
	const mode = activeRun?.status === "paused" ? "paused" : activeRun?.status === "recovering" ? "recovering" : activeRun ? "active" : "simulation";
	return {
		mode,
		capabilities: loadCapabilities(),
		activeRunId: activeRun?.runId ?? null,
		dryRunAvailable: true,
		hardwareAvailable: true,
		notes: [
			"Phase 5 exposes schema validation, simulation runs, dry-run preflight, structured run analysis, bounded replanning, and hardware-pilot execution.",
			"Hardware execution supports the original stage-only pilot path plus typed Raman runs through the long-lived bridge; Raman acquisition still requires explicit operator safety approval.",
		],
	};
}
