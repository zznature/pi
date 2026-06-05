import type { Capabilities } from "./capabilities.ts";
import type { LabState } from "./lab-state.ts";
import { probeLiveState, type LiveStateProbe } from "./live-state.ts";
import { getExperimentPoints } from "./spec-utils.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";

export interface PreflightResult {
	valid: boolean;
	issues: ValidationIssue[];
	pointCount: number;
	estimatedRuntimeMinutes: number;
	mode: ExperimentSpec["mode"];
	liveState?: LiveStateProbe;
	plannedRun: {
		wouldVisitPoints: number;
		wouldUseInstruments: string[];
	};
	willNotExecute: string[];
	approvalRecord?: {
		path: string;
		requiredForHardware: boolean;
	};
}

function estimateRuntimeMinutes(spec: ExperimentSpec, pointCount: number): number {
	const exposureMinutes = (spec.limits.acquisition.maxExposureMs * pointCount) / 60_000;
	return Number(exposureMinutes.toFixed(3));
}

export function preflight(spec: ExperimentSpec, capabilities: Capabilities, labState: LabState): PreflightResult {
	const issues: ValidationIssue[] = [];
	const pointCount = getExperimentPoints(spec).length;

	if (spec.mode === "simulation" && !capabilities.instruments.some((instrument) => instrument.simulationAvailable)) {
		issues.push({ path: "capabilities.instruments", message: "No simulation instruments are available" });
	}

	if (spec.mode === "dry_run" && !capabilities.instruments.some((instrument) => instrument.dryRunAvailable)) {
		issues.push({ path: "capabilities.instruments", message: "No dry-run instruments are available" });
	}

	if (labState.activeRunId !== null) {
		issues.push({ path: "labState.activeRunId", message: "A run is already active" });
	}

	const estimatedRuntimeMinutes = estimateRuntimeMinutes(spec, pointCount);
	if (estimatedRuntimeMinutes > spec.stoppingRules.maxRuntimeMinutes) {
		issues.push({ path: "stoppingRules.maxRuntimeMinutes", message: "Estimated runtime exceeds maxRuntimeMinutes" });
	}
	const liveState = spec.mode === "dry_run" ? probeLiveState(spec, capabilities) : undefined;
	if (liveState) {
		issues.push(...liveState.issues);
	}

	return {
		valid: issues.length === 0,
		issues,
		pointCount,
		estimatedRuntimeMinutes,
		mode: spec.mode,
		liveState: liveState?.probe,
		plannedRun: {
			wouldVisitPoints: pointCount,
			wouldUseInstruments: spec.allowedInstruments,
		},
		willNotExecute:
			spec.mode === "dry_run"
				? ["stage motion", "camera exposure", "Raman acquisition", "laser power change", "instrument writes"]
				: [],
		approvalRecord:
			spec.mode === "dry_run"
				? {
						path: liveState?.probe.approvalsPath.path ?? ".pi/experiment-runs/approvals.jsonl",
						requiredForHardware: true,
					}
				: undefined,
	};
}
