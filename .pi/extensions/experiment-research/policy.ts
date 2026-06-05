import type { Capabilities } from "./capabilities.ts";
import type { LabState } from "./lab-state.ts";
import { getExperimentPoints } from "./spec-utils.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";

export interface PolicyContext {
	toolName: "run_preflight" | "run_experiment" | "analyze_run";
}

export interface PolicyValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

function issue(path: string, message: string): ValidationIssue {
	return { path, message };
}

function withinRange(value: number, min: number, max: number): boolean {
	return value >= min && value <= max;
}

function validateInstrumentAvailability(spec: ExperimentSpec, capabilities: Capabilities): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const instruments = new Map(capabilities.instruments.map((instrument) => [instrument.id, instrument]));

	for (const instrumentId of spec.allowedInstruments) {
		const instrument = instruments.get(instrumentId);
		if (!instrument) {
			issues.push(issue("allowedInstruments", `Unknown instrument: ${instrumentId}`));
			continue;
		}
		if (spec.mode === "simulation" && !instrument.simulationAvailable) {
			issues.push(issue("allowedInstruments", `Instrument is not available in simulation: ${instrumentId}`));
		}
		if (spec.mode === "dry_run" && !instrument.dryRunAvailable) {
			issues.push(issue("allowedInstruments", `Instrument is not available in dry run: ${instrumentId}`));
		}
	}

	return issues;
}

function validatePointLimits(spec: ExperimentSpec): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const points = getExperimentPoints(spec);

	if (points.length > spec.limits.acquisition.maxPoints) {
		issues.push(issue("limits.acquisition.maxPoints", "Experiment point count exceeds acquisition maxPoints"));
	}

	if (points.length > spec.stoppingRules.maxPoints) {
		issues.push(issue("stoppingRules.maxPoints", "Experiment point count exceeds stoppingRules maxPoints"));
	}

	for (const point of points) {
		if (!withinRange(point.xUm, spec.limits.motion.xUm.minUm, spec.limits.motion.xUm.maxUm)) {
			issues.push(issue(`points.${point.index}.xUm`, "Point xUm is outside ExperimentSpec motion limits"));
		}
		if (!withinRange(point.yUm, spec.limits.motion.yUm.minUm, spec.limits.motion.yUm.maxUm)) {
			issues.push(issue(`points.${point.index}.yUm`, "Point yUm is outside ExperimentSpec motion limits"));
		}
		if (point.zUm !== undefined && spec.limits.motion.zUm) {
			if (!withinRange(point.zUm, spec.limits.motion.zUm.minUm, spec.limits.motion.zUm.maxUm)) {
				issues.push(issue(`points.${point.index}.zUm`, "Point zUm is outside ExperimentSpec motion limits"));
			}
		}
	}

	return issues;
}

export function validatePolicy(
	spec: ExperimentSpec,
	labState: LabState,
	ctx: PolicyContext,
): PolicyValidationResult {
	const issues: ValidationIssue[] = [];

	if (ctx.toolName === "run_preflight") {
		if (spec.mode !== "simulation" && spec.mode !== "dry_run") {
			issues.push(issue("mode", "Phase 3 preflight supports simulation and dry_run modes only"));
		}
	} else if (spec.mode !== "simulation") {
		issues.push(issue("mode", `Phase 3 ${ctx.toolName} only supports simulation mode`));
	}

	if (spec.operatorApprovalRequired) {
		issues.push(issue("operatorApprovalRequired", "Phase 3 simulation and dry-run checks must not require approval"));
	}

	if (labState.mode !== "simulation") {
		issues.push(issue("labState.mode", "Lab state must be in simulation mode"));
	}

	issues.push(...validateInstrumentAvailability(spec, labState.capabilities));
	issues.push(...validatePointLimits(spec));

	return {
		valid: issues.length === 0,
		issues,
	};
}
