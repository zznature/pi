import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Type, type Static, type TSchema } from "typebox";

const ExperimentModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("dry_run"),
	Type.Literal("hardware"),
]);

const StatusSchema = Type.Union([Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]);

const ExperimentTypeSchema = Type.Union([
	Type.Literal("spatial_mapping"),
	Type.Literal("synthesis_screen"),
	Type.Literal("assay"),
	Type.Literal("generic_protocol"),
]);

const SubjectSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		kind: Type.String({ minLength: 1 }),
		label: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const ResourceKindSchema = Type.Union([
	Type.Literal("instrument"),
	Type.Literal("sample_slot"),
	Type.Literal("workspace"),
	Type.Literal("budget"),
	Type.Literal("operator_attention"),
]);

const ResourceRefSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		kind: ResourceKindSchema,
		role: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const CoordinateRangeSchema = Type.Object(
	{
		minUm: Type.Number({ description: "Minimum allowed coordinate in micrometers" }),
		maxUm: Type.Number({ description: "Maximum allowed coordinate in micrometers" }),
	},
	{ additionalProperties: false },
);

const MotionLimitsSchema = Type.Object(
	{
		xUm: CoordinateRangeSchema,
		yUm: CoordinateRangeSchema,
		zUm: Type.Optional(CoordinateRangeSchema),
	},
	{ additionalProperties: false },
);

const PowerEnergyLimitsSchema = Type.Object(
	{
		maxLaserPowerMw: Type.Number({ minimum: 0 }),
		maxExposureEnergyMj: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

const AcquisitionLimitsSchema = Type.Object(
	{
		maxExposureMs: Type.Number({ minimum: 1 }),
		maxUnits: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const LimitsSchema = Type.Object(
	{
		motion: MotionLimitsSchema,
		powerEnergy: PowerEnergyLimitsSchema,
		acquisition: AcquisitionLimitsSchema,
		duration: Type.Optional(Type.Object({ maxRuntimeMinutes: Type.Number({ minimum: 0 }) }, { additionalProperties: false })),
		sampleBudget: Type.Optional(Type.Object({ maxUnits: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);

const GridAxisSchema = Type.Object(
	{
		startUm: Type.Number(),
		stopUm: Type.Number(),
		steps: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const GridSchema = Type.Object(
	{
		x: GridAxisSchema,
		y: GridAxisSchema,
	},
	{ additionalProperties: false },
);

const PointSchema = Type.Object(
	{
		xUm: Type.Number(),
		yUm: Type.Number(),
		zUm: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

const GridPlanSchema = Type.Object(
	{
		kind: Type.Literal("grid"),
		grid: GridSchema,
	},
	{ additionalProperties: false },
);

const PointsPlanSchema = Type.Object(
	{
		kind: Type.Literal("points"),
		points: Type.Array(PointSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const StepPlanSchema = Type.Object(
	{
		kind: Type.Literal("steps"),
		steps: Type.Array(
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					description: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

const PlanSchema = Type.Union([GridPlanSchema, PointsPlanSchema, StepPlanSchema]);

const StoppingRulesSchema = Type.Object(
	{
		maxRuntimeMinutes: Type.Number({ minimum: 0 }),
		maxUnits: Type.Integer({ minimum: 1 }),
		stopOnError: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const OperatorApprovalSchema = Type.Object(
	{
		approvalId: Type.String({ minLength: 1 }),
		operator: Type.String({ minLength: 1 }),
		approved: Type.Boolean(),
		dryRunReportId: Type.String({ minLength: 1 }),
		operatorOnlyMonitoring: Type.Optional(Type.Boolean()),
		notes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const HardwarePilotSchema = Type.Object(
	{
		stageAdapter: Type.Union([Type.Literal("memory"), Type.Literal("mc_newton_xyz")]),
		stagePort: Type.Optional(Type.String({ minLength: 1 })),
		stagePython: Type.Optional(
			Type.String({ minLength: 1, description: "Python interpreter for the stage bridge; defaults to 'python' on PATH" }),
		),
		settleTimeoutMs: Type.Integer({ minimum: 1 }),
		heartbeatTimeoutMs: Type.Integer({ minimum: 1 }),
		maxConsecutiveErrors: Type.Integer({ minimum: 1 }),
		intentsPath: Type.Optional(Type.String({ minLength: 1 })),
		approval: OperatorApprovalSchema,
	},
	{ additionalProperties: false },
);

export const ExperimentSpecSchema = Type.Object(
	{
		schemaVersion: Type.String({ minLength: 1 }),
		experimentId: Type.String({ minLength: 1 }),
		specId: Type.String({ minLength: 1 }),
		experimentType: ExperimentTypeSchema,
		objective: Type.String({ minLength: 1 }),
		subject: SubjectSchema,
		mode: ExperimentModeSchema,
		resources: Type.Array(ResourceRefSchema, { minItems: 1 }),
		limits: LimitsSchema,
		plan: PlanSchema,
		stoppingRules: StoppingRulesSchema,
		operatorApprovalRequired: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ArtifactRefSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1 })),
		uri: Type.String({ minLength: 1 }),
		label: Type.String({ minLength: 1 }),
		kind: Type.Optional(Type.String({ minLength: 1 })),
		contentHash: Type.Optional(Type.String({ minLength: 1 })),
		producerRunId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const ErrorCodeSchema = Type.Union([
	Type.Literal("invalid_tool_params"),
	Type.Literal("invalid_experiment_spec"),
	Type.Literal("policy_rejected"),
	Type.Literal("preflight_failed"),
	Type.Literal("hardware_pilot_params_required"),
	Type.Literal("hardware_gate_failed"),
	Type.Literal("invalid_resume_from"),
	Type.Literal("dry_run_execution_not_supported"),
	Type.Literal("resume_not_supported"),
	Type.Literal("run_not_found"),
	Type.Literal("run_active_conflict"),
	Type.Literal("run_not_advanceable"),
	Type.Literal("lifecycle_mode_not_supported"),
	Type.Literal("simulated_hardware_not_allowed"),
	Type.Literal("tool_not_found"),
]);

export const ToolResultSchema = Type.Object(
	{
		status: StatusSchema,
		summary: Type.String(),
		nextActions: Type.Array(Type.String()),
		artifacts: Type.Array(ArtifactRefSchema),
		experimentId: Type.Optional(Type.String()),
		runId: Type.Optional(Type.String()),
		commandId: Type.String(),
		correlationId: Type.String(),
		stateBefore: Type.Optional(Type.Unknown()),
		stateAfter: Type.Unknown(),
		errorCode: Type.Optional(ErrorCodeSchema),
		retrySafe: Type.Optional(Type.Boolean()),
		stopConditionMet: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ValidateExperimentSpecParamsSchema = Type.Object(
	{
		spec: Type.Unknown({ description: "ExperimentSpec candidate to validate" }),
	},
	{ additionalProperties: false },
);

export const RunPreflightParamsSchema = Type.Object(
	{
		spec: Type.Unknown({ description: "ExperimentSpec candidate to preflight" }),
	},
	{ additionalProperties: false },
);

export const RunExperimentParamsSchema = Type.Object(
	{
		spec: Type.Unknown({ description: "Validated ExperimentSpec to execute in simulation or approved hardware mode" }),
		resumeFrom: Type.Optional(Type.String({ minLength: 1 })),
		hardwarePilot: Type.Optional(HardwarePilotSchema),
	},
	{ additionalProperties: false },
);

export const AnalyzeRunParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const PlanNextExperimentParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1 }),
		objective: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export const StartRunParamsSchema = Type.Object(
	{
		spec: Type.Unknown({ description: "Validated simulation ExperimentSpec to start under the async run lifecycle" }),
	},
	{ additionalProperties: false },
);

export const AdvanceRunParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1, description: "Run id returned by start_run" }),
		maxUnits: Type.Optional(
			Type.Integer({ minimum: 1, description: "Maximum units to execute before yielding control back to the planner" }),
		),
	},
	{ additionalProperties: false },
);

export const PollRunParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1, description: "Run id to read live RunState for" }),
	},
	{ additionalProperties: false },
);

export const OperatorIntentParamsSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1, description: "Hardware run id whose intents log receives the operator intent" }),
		reason: Type.String({ minLength: 1, description: "Operator-supplied reason recorded with the intent" }),
	},
	{ additionalProperties: false },
);

export const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

export const GetExperimentStateParamsSchema = Type.Object(
	{
		experimentId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type ExperimentSpec = Static<typeof ExperimentSpecSchema>;
export type ToolResult = Static<typeof ToolResultSchema>;
export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ValidateExperimentSpecParams = Static<typeof ValidateExperimentSpecParamsSchema>;
export type RunPreflightParams = Static<typeof RunPreflightParamsSchema>;
export type RunExperimentParams = Static<typeof RunExperimentParamsSchema>;
export type HardwarePilotParams = Static<typeof HardwarePilotSchema>;
export type AnalyzeRunParams = Static<typeof AnalyzeRunParamsSchema>;
export type PlanNextExperimentParams = Static<typeof PlanNextExperimentParamsSchema>;
export type StartRunParams = Static<typeof StartRunParamsSchema>;
export type AdvanceRunParams = Static<typeof AdvanceRunParamsSchema>;
export type PollRunParams = Static<typeof PollRunParamsSchema>;
export type OperatorIntentParams = Static<typeof OperatorIntentParamsSchema>;
export type GetExperimentStateParams = Static<typeof GetExperimentStateParamsSchema>;

export interface ValidationIssue {
	path: string;
	message: string;
}

export type SchemaValidationResult<T> =
	| {
			valid: true;
			value: T;
			issues: [];
	  }
	| {
			valid: false;
			issues: ValidationIssue[];
	  };

const experimentSpecValidator = Compile(ExperimentSpecSchema);

function getRequiredProperty(params: unknown): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const requiredProperties = (params as { requiredProperties?: unknown }).requiredProperties;
	if (!Array.isArray(requiredProperties)) return undefined;
	const [property] = requiredProperties;
	return typeof property === "string" ? property : undefined;
}

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperty = getRequiredProperty(error.params);
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}

	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function toValidationIssues(errors: TLocalizedValidationError[]): ValidationIssue[] {
	return errors.map((error) => ({
		path: formatValidationPath(error),
		message: error.message,
	}));
}

function validateCoordinateRange(path: string, range: Static<typeof CoordinateRangeSchema>): ValidationIssue[] {
	if (range.minUm <= range.maxUm) return [];
	return [{ path, message: "minUm must be less than or equal to maxUm" }];
}

function validateGridOrPointsPresence(value: unknown): ValidationIssue[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const record = value as Record<string, unknown>;
	const plan = record.plan;
	if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return [];
	const planRecord = plan as Record<string, unknown>;
	const kind = planRecord.kind;
	if (kind === "grid" && Object.hasOwn(planRecord, "grid")) return [];
	if (kind === "points" && Object.hasOwn(planRecord, "points")) return [];
	if (kind === "steps" && Object.hasOwn(planRecord, "steps")) return [];
	return [{ path: "plan", message: "plan.kind must match its payload" }];
}

function validateExperimentSpecSemantics(spec: ExperimentSpec): ValidationIssue[] {
	const issues = validateGridOrPointsPresence(spec);

	issues.push(...validateCoordinateRange("limits.motion.xUm", spec.limits.motion.xUm));
	issues.push(...validateCoordinateRange("limits.motion.yUm", spec.limits.motion.yUm));
	if (spec.limits.motion.zUm) {
		issues.push(...validateCoordinateRange("limits.motion.zUm", spec.limits.motion.zUm));
	}

	if (spec.plan.kind === "steps") {
		issues.push({ path: "plan.kind", message: "Current kernels require spatial grid or points plans" });
	}

	return issues;
}

export function validateSchema<T extends TSchema>(
	schema: T,
	value: unknown,
): SchemaValidationResult<Static<T>> {
	const validator = Compile(schema);
	if (validator.Check(value)) {
		return { valid: true, value, issues: [] };
	}

	return { valid: false, issues: toValidationIssues(validator.Errors(value)) };
}

export function validateExperimentSpec(value: unknown): SchemaValidationResult<ExperimentSpec> {
	if (!experimentSpecValidator.Check(value)) {
		return {
			valid: false,
			issues: [...toValidationIssues(experimentSpecValidator.Errors(value)), ...validateGridOrPointsPresence(value)],
		};
	}

	const issues = validateExperimentSpecSemantics(value);
	if (issues.length > 0) {
		return { valid: false, issues };
	}

	return { valid: true, value, issues: [] };
}
