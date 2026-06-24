import type { Capabilities } from "./capabilities.ts";
import { resolveRamanXyCalibration } from "./kernel/raman-calibration.ts";
import type { LabState } from "./lab-state.ts";
import { probeLiveState, type LiveStateProbe } from "./live-state.ts";
import { getResourceIds, getUnitCount } from "./spec-utils.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";

export interface PreflightResult {
	valid: boolean;
	issues: ValidationIssue[];
	unitCount: number;
	estimatedRuntimeMinutes: number;
	mode: ExperimentSpec["mode"];
	specHash?: string;
	capabilitySnapshotId?: string;
	liveState?: LiveStateProbe;
	plannedRun: {
		wouldVisitUnits: number;
		wouldUseResources: string[];
	};
	willNotExecute: string[];
	approvalRecord?: {
		path: string;
		requiredForHardware: boolean;
		requiredSafetyConfirmations?: string[];
	};
	calibrationArtifacts?: {
		id: string;
		path: string;
		confidence: number;
		validUntil?: string;
	}[];
}

function estimateRuntimeMinutes(spec: ExperimentSpec, unitCount: number): number {
	const ramanAcquisition = spec.domain?.raman?.acquisition;
	if (ramanAcquisition) {
		return Number(((ramanAcquisition.integrationTimeS * ramanAcquisition.accumulations * unitCount) / 60).toFixed(3));
	}
	const exposureMinutes = (spec.limits.acquisition.maxExposureMs * unitCount) / 60_000;
	return Number(exposureMinutes.toFixed(3));
}

function getRequiredRamanSafetyConfirmations(spec: ExperimentSpec): string[] | undefined {
	if (!spec.domain?.raman) return undefined;
	return ["limits.motion.zUm.maxUm", "limits.powerEnergy.maxLaserPowerMw"];
}

export function preflight(spec: ExperimentSpec, capabilities: Capabilities, labState: LabState, cwd: string = "."): PreflightResult {
	const issues: ValidationIssue[] = [];
	const unitCount = getUnitCount(spec);

	if (spec.mode === "simulation" && !capabilities.instruments.some((instrument) => instrument.simulationAvailable)) {
		issues.push({ path: "capabilities.instruments", message: "No simulation instruments are available" });
	}

	if (spec.mode === "dry_run" && !capabilities.instruments.some((instrument) => instrument.dryRunAvailable)) {
		issues.push({ path: "capabilities.instruments", message: "No dry-run instruments are available" });
	}

	if (labState.activeRunId !== null) {
		issues.push({ path: "labState.activeRunId", message: "A run is already active" });
	}

	const estimatedRuntimeMinutes = estimateRuntimeMinutes(spec, unitCount);
	if (estimatedRuntimeMinutes > spec.stoppingRules.maxRuntimeMinutes) {
		issues.push({ path: "stoppingRules.maxRuntimeMinutes", message: "Estimated runtime exceeds maxRuntimeMinutes" });
	}
	const liveState = spec.mode === "dry_run" ? probeLiveState(spec, capabilities, cwd) : undefined;
	if (liveState) {
		issues.push(...liveState.issues);
	}
	const calibrationArtifacts: PreflightResult["calibrationArtifacts"] = [];
	const xyCorrection = spec.domain?.raman?.xyCorrection;
	if (spec.mode !== "simulation" && xyCorrection?.enabled) {
		const resolution = resolveRamanXyCalibration(cwd, xyCorrection.transformArtifactId);
		if (!resolution.ok) {
			issues.push(...resolution.issues);
		} else {
			const artifact = resolution.artifact;
			calibrationArtifacts.push({
				id: artifact.calibrationId,
				path: resolution.path,
				confidence: artifact.confidence,
				validUntil: artifact.validUntil,
			});
		}
	}

	return {
		valid: issues.length === 0,
		issues,
		unitCount,
		estimatedRuntimeMinutes,
		mode: spec.mode,
		liveState: liveState?.probe,
		plannedRun: {
			wouldVisitUnits: unitCount,
			wouldUseResources: getResourceIds(spec),
		},
		willNotExecute:
			spec.mode === "dry_run"
				? ["stage motion", "camera exposure", "Raman acquisition", "laser power change", "instrument writes"]
				: [],
		approvalRecord:
			spec.mode === "dry_run"
				? {
						path: liveState?.probe.approvalsPath.path ?? ".pi/experiment-runs/approvals.jsonl",
						requiredForHardware: false,
						requiredSafetyConfirmations: getRequiredRamanSafetyConfirmations(spec),
					}
				: undefined,
		calibrationArtifacts: calibrationArtifacts.length > 0 ? calibrationArtifacts : undefined,
	};
}
