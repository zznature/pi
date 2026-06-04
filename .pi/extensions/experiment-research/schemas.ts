import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Type, type Static, type TSchema } from "typebox";

const ExperimentModeSchema = Type.Union([
	Type.Literal("simulation"),
	Type.Literal("dry_run"),
	Type.Literal("hardware"),
]);

const StatusSchema = Type.Union([Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]);

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
		maxPoints: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const LimitsSchema = Type.Object(
	{
		motion: MotionLimitsSchema,
		powerEnergy: PowerEnergyLimitsSchema,
		acquisition: AcquisitionLimitsSchema,
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

const StoppingRulesSchema = Type.Object(
	{
		maxRuntimeMinutes: Type.Number({ minimum: 0 }),
		maxPoints: Type.Integer({ minimum: 1 }),
		stopOnError: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ExperimentSpecSchema = Type.Object(
	{
		objective: Type.String({ minLength: 1 }),
		sampleId: Type.String({ minLength: 1 }),
		mode: ExperimentModeSchema,
		allowedInstruments: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		limits: LimitsSchema,
		grid: Type.Optional(GridSchema),
		points: Type.Optional(Type.Array(PointSchema, { minItems: 1 })),
		stoppingRules: StoppingRulesSchema,
		operatorApprovalRequired: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const ArtifactRefSchema = Type.Object(
	{
		uri: Type.String({ minLength: 1 }),
		label: Type.String({ minLength: 1 }),
		kind: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const ToolResultSchema = Type.Object(
	{
		status: StatusSchema,
		summary: Type.String(),
		nextActions: Type.Array(Type.String()),
		artifacts: Type.Array(ArtifactRefSchema),
		runId: Type.Optional(Type.String()),
		commandId: Type.String(),
		stateBefore: Type.Unknown(),
		stateAfter: Type.Unknown(),
		errorCode: Type.Optional(Type.String()),
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

export const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

export type ExperimentSpec = Static<typeof ExperimentSpecSchema>;
export type ToolResult = Static<typeof ToolResultSchema>;
export type ValidateExperimentSpecParams = Static<typeof ValidateExperimentSpecParamsSchema>;

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
	const hasGrid = Object.hasOwn(record, "grid") && record.grid !== undefined;
	const hasPoints = Object.hasOwn(record, "points") && record.points !== undefined;

	if (hasGrid !== hasPoints) return [];
	return [{ path: "root", message: "Exactly one of grid or points is required" }];
}

function validateExperimentSpecSemantics(spec: ExperimentSpec): ValidationIssue[] {
	const issues = validateGridOrPointsPresence(spec);

	issues.push(...validateCoordinateRange("limits.motion.xUm", spec.limits.motion.xUm));
	issues.push(...validateCoordinateRange("limits.motion.yUm", spec.limits.motion.yUm));
	if (spec.limits.motion.zUm) {
		issues.push(...validateCoordinateRange("limits.motion.zUm", spec.limits.motion.zUm));
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
