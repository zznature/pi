import type { Capabilities } from "./capabilities.ts";
import type { LabState } from "./lab-state.ts";
import { getExperimentPoints, getInstrumentResourceIds } from "./spec-utils.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";

export interface PolicyContext {
	toolName: "run_preflight" | "run_experiment" | "analyze_run";
}

export interface PolicyValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

function isEffectfulRunContext(ctx: PolicyContext): boolean {
	return ctx.toolName === "run_experiment";
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

	for (const instrumentId of getInstrumentResourceIds(spec)) {
		const instrument = instruments.get(instrumentId);
		if (!instrument) {
			issues.push(issue("resources", `Unknown instrument resource: ${instrumentId}`));
			continue;
		}
		if (spec.mode === "simulation" && !instrument.simulationAvailable) {
			issues.push(issue("resources", `Instrument is not available in simulation: ${instrumentId}`));
		}
		if (spec.mode === "dry_run" && !instrument.dryRunAvailable) {
			issues.push(issue("resources", `Instrument is not available in dry run: ${instrumentId}`));
		}
		if (spec.mode === "hardware" && !instrument.hardwarePilotAvailable) {
			issues.push(issue("resources", `Instrument is not available for gated hardware execution: ${instrumentId}`));
		}
	}

	return issues;
}

function validateHardwarePilotScope(spec: ExperimentSpec): ValidationIssue[] {
	const issues: ValidationIssue[] = [];

	if (spec.mode !== "hardware") return issues;
	const instrumentIds = getInstrumentResourceIds(spec);
	const raman = spec.domain?.raman;
	if (raman) {
		const hasLabSpecWorkstation = spec.resources.some((resource) => resource.kind === "workspace" && resource.id === "labspec-workstation");
		if (!instrumentIds.includes("mc-newton-xyz-stage")) {
			issues.push(issue("resources", "Raman hardware runs require mc-newton-xyz-stage"));
		}
		if (!hasLabSpecWorkstation) {
			issues.push(issue("resources", "Raman hardware runs require labspec-workstation workspace lease"));
		}
		if (raman.acquisition && !instrumentIds.includes("lab-acquirer")) {
			issues.push(issue("resources", "Raman acquisition requires lab-acquirer"));
		}
		const requiresFrames = raman.autofocus?.enabled === true || raman.xyCorrection?.enabled === true;
		if (requiresFrames && !instrumentIds.includes("lab-camera")) {
			issues.push(issue("resources", "Raman autofocus or XY correction requires lab-camera"));
		}
		if (spec.domain?.thermal?.enabled === true && !instrumentIds.includes("thermal-heating-stage")) {
			issues.push(issue("resources", "Thermal heating stage waits require thermal-heating-stage"));
		}
		if (!spec.limits.motion.zUm) {
			issues.push(issue("limits.motion.zUm", "Raman hardware runs require explicit zUm limits"));
		}
		return issues;
	}

	if (instrumentIds.length !== 1 || instrumentIds[0] !== "mc-newton-xyz-stage") {
		issues.push(issue("resources", "Non-Raman hardware execution only supports mc-newton-xyz-stage"));
	}
	if (spec.plan.kind !== "points") {
		issues.push(issue("plan", "Non-Raman hardware execution requires explicit points and does not accept grids"));
	}
	if (getExperimentPoints(spec).length > 4) {
		issues.push(issue("plan.points", "Non-Raman hardware execution is limited to 4 points"));
	}
	if (!spec.limits.motion.zUm) {
		issues.push(issue("limits.motion.zUm", "Non-Raman hardware execution requires explicit zUm limits"));
	}

	return issues;
}

function validatePointLimits(spec: ExperimentSpec): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const points = getExperimentPoints(spec);

	if (points.length > spec.limits.acquisition.maxUnits) {
		issues.push(issue("limits.acquisition.maxUnits", "Experiment unit count exceeds acquisition maxUnits"));
	}

	if (points.length > spec.stoppingRules.maxUnits) {
		issues.push(issue("stoppingRules.maxUnits", "Experiment unit count exceeds stoppingRules maxUnits"));
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
		if (spec.mode !== "simulation" && spec.mode !== "dry_run" && spec.mode !== "hardware") {
			issues.push(issue("mode", "Preflight supports simulation, dry_run, and hardware modes only"));
		}
	} else if (ctx.toolName === "run_experiment") {
		if (spec.mode !== "simulation" && spec.mode !== "hardware") {
			issues.push(issue("mode", "run_experiment supports simulation and approved hardware modes only"));
		}
	} else if (spec.mode !== "simulation") {
		issues.push(issue("mode", `${ctx.toolName} only supports simulation mode`));
	}

	if (isEffectfulRunContext(ctx) && spec.mode === "hardware") {
		if (!spec.operatorApprovalRequired) {
			issues.push(issue("operatorApprovalRequired", "Hardware execution requires operatorApprovalRequired to be true"));
		}
	} else if (isEffectfulRunContext(ctx) && spec.operatorApprovalRequired) {
		issues.push(issue("operatorApprovalRequired", "Simulation and dry-run checks must not require approval"));
	}

	if (isEffectfulRunContext(ctx) && labState.activeRunId !== null) {
		issues.push(
			issue(
				"labState.activeRunId",
				`Another run (${labState.activeRunId}) is ${labState.mode}; abort or resume it before starting a new run.`,
			),
		);
	}

	issues.push(...validateInstrumentAvailability(spec, labState.capabilities));
	issues.push(...validatePointLimits(spec));
	issues.push(...validateHardwarePilotScope(spec));

	return {
		valid: issues.length === 0,
		issues,
	};
}
