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

const RamanSafetyConfirmationSchema = Type.Object(
	{
		laserPowerConfirmed: Type.Boolean(),
		confirmedLaserPowerMw: Type.Number({ minimum: 0 }),
		labSpecWorkerReady: Type.Optional(Type.Boolean()),
		windowsPowerPolicyReady: Type.Optional(Type.Boolean()),
		notes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const Matrix2x2Schema = Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), {
	minItems: 2,
	maxItems: 2,
});

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

const RamanAutofocusEverySchema = Type.Union([
	Type.Literal("once"),
	Type.Literal("onQualityDrop"),
	Type.Object(
		{
			kind: Type.Literal("everyNPoints"),
			n: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
]);

const RamanFocusMetricSchema = Type.Union([
	Type.Literal("tenengrad"),
	Type.Literal("laplacian_variance"),
	Type.Literal("brenner"),
	Type.Literal("normalized_variance"),
	Type.Literal("labspec_spot_compactness"),
]);

const RamanFailurePolicySchema = Type.Union([Type.Literal("skip_point"), Type.Literal("pause"), Type.Literal("abort")]);

const RamanAutofocusSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		every: RamanAutofocusEverySchema,
		zMinUm: Type.Number(),
		zMaxUm: Type.Number(),
		coarseRangeUm: Type.Number({ minimum: 0 }),
		coarseStepUm: Type.Number({ exclusiveMinimum: 0 }),
		fineRangeUm: Type.Number({ minimum: 0 }),
		fineStepUm: Type.Number({ exclusiveMinimum: 0 }),
		metric: RamanFocusMetricSchema,
		minConfidence: Type.Number({ minimum: 0, maximum: 1 }),
		onFailure: RamanFailurePolicySchema,
	},
	{ additionalProperties: false },
);

const RamanXyCorrectionSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		phase: Type.Union([Type.Literal("preCorrection"), Type.Literal("postFocusCorrection"), Type.Literal("both")]),
		transformArtifactId: Type.String({ minLength: 1 }),
		minConfidence: Type.Number({ minimum: 0, maximum: 1 }),
		maxCorrectionUm: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);

const RamanAcquisitionSchema = Type.Object(
	{
		integrationTimeS: Type.Number({ exclusiveMinimum: 0 }),
		accumulations: Type.Integer({ minimum: 1 }),
		fromNm: Type.Number({ minimum: 0 }),
		toNm: Type.Number({ minimum: 0 }),
		saveFormat: Type.Union([Type.Literal("txt"), Type.Literal("csv")]),
	},
	{ additionalProperties: false },
);

const RamanDomainSchema = Type.Object(
	{
		autofocus: Type.Optional(RamanAutofocusSchema),
		xyCorrection: Type.Optional(RamanXyCorrectionSchema),
		acquisition: Type.Optional(RamanAcquisitionSchema),
	},
	{ additionalProperties: false },
);

const DomainSchema = Type.Object(
	{
		raman: Type.Optional(RamanDomainSchema),
	},
	{ additionalProperties: false },
);

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
		ramanSafety: Type.Optional(RamanSafetyConfirmationSchema),
		notes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RamanActiveProbeApprovalSchema = Type.Object(
	{
		approvalId: Type.String({ minLength: 1 }),
		operator: Type.String({ minLength: 1 }),
		approved: Type.Boolean(),
		ramanSafety: Type.Optional(RamanSafetyConfirmationSchema),
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
		raman: Type.Optional(
			Type.Object(
				{
					acquisitionBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("labspec_file_bridge")])),
					autofocusBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("labspec_file_bridge")])),
					xyCorrectionBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("phase_correlation")])),
					labspecBridgeDir: Type.Optional(Type.String({ minLength: 1 })),
					frameBridgeDir: Type.Optional(Type.String({ minLength: 1 })),
					labspecTimeoutS: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
					labspecPollIntervalS: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
					xyReferenceFramePath: Type.Optional(Type.String({ minLength: 1 })),
					xyCurrentFramePath: Type.Optional(Type.String({ minLength: 1 })),
					xyTransform: Type.Optional(Matrix2x2Schema),
					xyApplyCorrection: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
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
		domain: Type.Optional(DomainSchema),
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
	Type.Literal("bridge_crashed"),
	Type.Literal("protocol_corruption"),
	Type.Literal("tool_not_found"),
]);

export const RamanErrorCodeSchema = Type.Union([
	Type.Literal("stage_connection_error"),
	Type.Literal("stage_command_error"),
	Type.Literal("stage_timeout"),
	Type.Literal("frame_timeout"),
	Type.Literal("autofocus_no_peak"),
	Type.Literal("autofocus_low_confidence"),
	Type.Literal("autofocus_out_of_range"),
	Type.Literal("calibration_low_confidence"),
	Type.Literal("calibration_singular_transform"),
	Type.Literal("acquisition_failed"),
	Type.Literal("aborted"),
	Type.Literal("bridge_crashed"),
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

export const RamanActiveProbeParamsSchema = Type.Object(
	{
		approval: RamanActiveProbeApprovalSchema,
		outputDir: Type.Optional(Type.String({ minLength: 1 })),
		stagePython: Type.Optional(Type.String({ minLength: 1 })),
		captureFrame: Type.Optional(Type.Boolean()),
		acquireSpectrumSmoke: Type.Optional(Type.Boolean()),
		frameBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("labspec_file_bridge")])),
		acquisitionBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("labspec_file_bridge")])),
		frameBridgeDir: Type.Optional(Type.String({ minLength: 1 })),
		labspecBridgeDir: Type.Optional(Type.String({ minLength: 1 })),
		timeoutS: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		pollIntervalS: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	},
	{ additionalProperties: false },
);

export const RamanRecordXyCalibrationParamsSchema = Type.Object(
	{
		approval: Type.Object(
			{
				approvalId: Type.String({ minLength: 1 }),
				operator: Type.String({ minLength: 1 }),
				approved: Type.Boolean(),
				notes: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		calibrationId: Type.Optional(Type.String({ minLength: 1 })),
		pixelPerUm: Matrix2x2Schema,
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		validUntil: Type.Optional(Type.String({ minLength: 1 })),
		objective: Type.Optional(Type.String({ minLength: 1 })),
		magnification: Type.Optional(Type.String({ minLength: 1 })),
		sourceNotes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RamanXyCalibrationMeasurementSchema = Type.Object(
	{
		referenceFramePath: Type.String({ minLength: 1 }),
		currentFramePath: Type.String({ minLength: 1 }),
		stageShift: Type.Object(
			{
				dxUm: Type.Number(),
				dyUm: Type.Number(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const RamanFitXyCalibrationParamsSchema = Type.Object(
	{
		approval: Type.Object(
			{
				approvalId: Type.String({ minLength: 1 }),
				operator: Type.String({ minLength: 1 }),
				approved: Type.Boolean(),
				notes: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		calibrationId: Type.Optional(Type.String({ minLength: 1 })),
		measurements: Type.Array(RamanXyCalibrationMeasurementSchema, { minItems: 2 }),
		minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		validUntil: Type.Optional(Type.String({ minLength: 1 })),
		objective: Type.Optional(Type.String({ minLength: 1 })),
		magnification: Type.Optional(Type.String({ minLength: 1 })),
		sourceNotes: Type.Optional(Type.String()),
		stagePython: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const RamanXyCalibrationShiftSchema = Type.Object(
	{
		dxUm: Type.Number(),
		dyUm: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RamanAutoXyCalibrationParamsSchema = Type.Object(
	{
		approval: Type.Object(
			{
				approvalId: Type.String({ minLength: 1 }),
				operator: Type.String({ minLength: 1 }),
				approved: Type.Boolean(),
				notes: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		calibrationId: Type.Optional(Type.String({ minLength: 1 })),
		stageAdapter: Type.Union([Type.Literal("memory"), Type.Literal("mc_newton_xyz")]),
		stagePort: Type.Optional(Type.String({ minLength: 1 })),
		stagePython: Type.Optional(Type.String({ minLength: 1 })),
		frameBackend: Type.Optional(Type.Union([Type.Literal("fake"), Type.Literal("labspec_file_bridge")])),
		frameBridgeDir: Type.Optional(Type.String({ minLength: 1 })),
		outputDir: Type.Optional(Type.String({ minLength: 1 })),
		stepUm: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		shifts: Type.Optional(Type.Array(RamanXyCalibrationShiftSchema, { minItems: 2 })),
		fakePixelPerUm: Type.Optional(Matrix2x2Schema),
		minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		settleTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		frameTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		validUntil: Type.Optional(Type.String({ minLength: 1 })),
		objective: Type.Optional(Type.String({ minLength: 1 })),
		magnification: Type.Optional(Type.String({ minLength: 1 })),
		sourceNotes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const RamanHardwareValidationInstrumentIdsSchema = Type.Object(
	{
		labspecWorkstation: Type.String({ minLength: 1 }),
		stageController: Type.String({ minLength: 1 }),
		camera: Type.String({ minLength: 1 }),
		acquirer: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const RamanHardwareEvidenceSchema = Type.Object(
	{
		evidenceMode: Type.Union([Type.Literal("simulated"), Type.Literal("hardware")]),
		observedAt: Type.String({ minLength: 1 }),
		operatorAttestedRealHardware: Type.Boolean(),
		instrumentIds: RamanHardwareValidationInstrumentIdsSchema,
		environmentNotes: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RamanHardwareValidationParamsSchema = Type.Object(
	{
		validationId: Type.Optional(Type.String({ minLength: 1 })),
		approval: Type.Object(
			{
				approvalId: Type.String({ minLength: 1 }),
				operator: Type.String({ minLength: 1 }),
				approved: Type.Boolean(),
				notes: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		evidence: Type.Object(
			{
				readOnlyPreflightReportId: Type.String({ minLength: 1 }),
				activeProbeRecordPath: Type.String({ minLength: 1 }),
				minimumRamanRunId: Type.String({ minLength: 1 }),
				xyCalibrationId: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
		hardwareEvidence: RamanHardwareEvidenceSchema,
		checklist: Type.Object(
			{
				laserPowerConfirmed: Type.Boolean(),
				confirmedLaserPowerMw: Type.Number({ minimum: 0 }),
				labSpecWorkerValidated: Type.Boolean(),
				cameraStreamValidated: Type.Boolean(),
				stageMotionValidated: Type.Boolean(),
				windowsPowerPolicyReady: Type.Boolean(),
				operatorReviewedArtifacts: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		notes: Type.Optional(Type.String()),
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
export type RamanErrorCode = Static<typeof RamanErrorCodeSchema>;
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
export type RamanActiveProbeParams = Static<typeof RamanActiveProbeParamsSchema>;
export type RamanRecordXyCalibrationParams = Static<typeof RamanRecordXyCalibrationParamsSchema>;
export type RamanFitXyCalibrationParams = Static<typeof RamanFitXyCalibrationParamsSchema>;
export type RamanAutoXyCalibrationParams = Static<typeof RamanAutoXyCalibrationParamsSchema>;
export type RamanHardwareValidationParams = Static<typeof RamanHardwareValidationParamsSchema>;
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

function getPlanPointCount(spec: ExperimentSpec): number {
	if (spec.plan.kind === "steps") return spec.plan.steps.length;
	if (spec.plan.kind === "points") return spec.plan.points.length;
	return spec.plan.grid.x.steps * spec.plan.grid.y.steps;
}

function getPlanZValues(spec: ExperimentSpec): number[] {
	if (spec.plan.kind === "points") return spec.plan.points.map((point) => point.zUm ?? 0);
	if (spec.plan.kind === "grid") return [0];
	return [];
}

function validateRamanDomainSemantics(spec: ExperimentSpec): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	const raman = spec.domain?.raman;
	if (!raman) return issues;

	const autofocus = raman.autofocus;
	if (autofocus?.enabled) {
		if (autofocus.zMinUm > autofocus.zMaxUm) {
			issues.push({ path: "domain.raman.autofocus", message: "zMinUm must be less than or equal to zMaxUm" });
		}
		if (!spec.limits.motion.zUm) {
			issues.push({ path: "limits.motion.zUm", message: "Raman autofocus requires explicit zUm motion limits" });
		} else {
			if (autofocus.zMinUm < spec.limits.motion.zUm.minUm || autofocus.zMaxUm > spec.limits.motion.zUm.maxUm) {
				issues.push({ path: "domain.raman.autofocus", message: "autofocus z range must fit inside zUm motion limits" });
			}
			for (const zUm of getPlanZValues(spec)) {
				if (zUm - autofocus.coarseRangeUm < spec.limits.motion.zUm.minUm || zUm + autofocus.coarseRangeUm > spec.limits.motion.zUm.maxUm) {
					issues.push({ path: "domain.raman.autofocus.coarseRangeUm", message: "autofocus coarse scan window exceeds zUm motion limits" });
					break;
				}
			}
		}
	}

	const xyCorrection = raman.xyCorrection;
	if (xyCorrection?.enabled) {
		const xSpan = spec.limits.motion.xUm.maxUm - spec.limits.motion.xUm.minUm;
		const ySpan = spec.limits.motion.yUm.maxUm - spec.limits.motion.yUm.minUm;
		const maxUsableCorrection = Math.min(xSpan, ySpan) / 2;
		if (xyCorrection.maxCorrectionUm > maxUsableCorrection) {
			issues.push({ path: "domain.raman.xyCorrection.maxCorrectionUm", message: "maxCorrectionUm exceeds XY motion limit margin" });
		}
	}

	const acquisition = raman.acquisition;
	if (acquisition) {
		if (acquisition.fromNm > acquisition.toNm) {
			issues.push({ path: "domain.raman.acquisition", message: "fromNm must be less than or equal to toNm" });
		}
		if (acquisition.integrationTimeS * 1000 > spec.limits.acquisition.maxExposureMs) {
			issues.push({ path: "domain.raman.acquisition.integrationTimeS", message: "integrationTimeS exceeds acquisition maxExposureMs" });
		}
		const estimatedMinutes = (acquisition.integrationTimeS * acquisition.accumulations * getPlanPointCount(spec)) / 60;
		if (estimatedMinutes > spec.stoppingRules.maxRuntimeMinutes) {
			issues.push({ path: "stoppingRules.maxRuntimeMinutes", message: "Raman acquisition estimate exceeds maxRuntimeMinutes" });
		}
	}

	return issues;
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
	issues.push(...validateRamanDomainSemantics(spec));

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
