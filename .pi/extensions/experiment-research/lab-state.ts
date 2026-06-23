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

export interface LabCapabilitiesState {
	capabilities: Capabilities;
	dryRunAvailable: true;
	hardwareAvailable: true;
	notes: string[];
	planningConstraints: {
		hardwareRequiresAuditedAbsoluteCoordinates: true;
		plannerMustRequestMissingCoordinates: true;
		supervisedRealHardwareRequiresCoordinateAuditId: true;
	};
}

export interface LabActivityState {
	mode: "simulation" | "active" | "paused" | "recovering";
	activeRunId: string | null;
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
			"Available workflows include schema validation, simulation runs, dry-run preflight, structured run analysis, bounded replanning, and gated hardware execution.",
			"Hardware execution supports a constrained non-Raman MC.Newton stage path plus typed Raman runs through the long-lived bridge; Raman acquisition still requires explicit operator safety approval.",
		],
	};
}

export function getLabCapabilities(): LabCapabilitiesState {
	return {
		capabilities: loadCapabilities(),
		dryRunAvailable: true,
		hardwareAvailable: true,
		notes: [
			"Static lab capabilities include simulation instruments, dry-run reachability, coordinate conventions, software limits, and gated hardware surfaces.",
			"Real hardware planning must stop at parameter collection until operator-audited absolute coordinates are available.",
		],
		planningConstraints: {
			hardwareRequiresAuditedAbsoluteCoordinates: true,
			plannerMustRequestMissingCoordinates: true,
			supervisedRealHardwareRequiresCoordinateAuditId: true,
		},
	};
}

export function getLabActivityState(cwd = "."): LabActivityState {
	const state = getLabState(cwd);
	return {
		mode: state.mode,
		activeRunId: state.activeRunId,
		notes: [
			state.activeRunId
				? `Current run activity is dynamic; activeRunId ${state.activeRunId} may change as the run advances or stops.`
				: "No run is currently active; call get_lab_state again only if run activity may have changed.",
		],
	};
}
