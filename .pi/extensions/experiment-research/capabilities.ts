import { Type, type Static } from "typebox";

const InstrumentKindSchema = Type.Union([Type.Literal("stage"), Type.Literal("camera"), Type.Literal("acquirer")]);
const LeasePolicySchema = Type.Union([Type.Literal("exclusive"), Type.Literal("shared-read"), Type.Literal("operator-only")]);

const SoftwareLimitsSchema = Type.Object(
	{
		xUm: Type.Optional(Type.Object({ minUm: Type.Number(), maxUm: Type.Number() }, { additionalProperties: false })),
		yUm: Type.Optional(Type.Object({ minUm: Type.Number(), maxUm: Type.Number() }, { additionalProperties: false })),
		zUm: Type.Optional(Type.Object({ minUm: Type.Number(), maxUm: Type.Number() }, { additionalProperties: false })),
		maxLaserPowerMw: Type.Optional(Type.Number({ minimum: 0 })),
		maxExposureMs: Type.Optional(Type.Number({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const InstrumentCapabilitySchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		resourceKind: Type.Literal("instrument"),
		kind: InstrumentKindSchema,
		units: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		coordinateConvention: Type.String({ minLength: 1 }),
		softwareLimits: SoftwareLimitsSchema,
		hazards: Type.Array(Type.String()),
		simulationAvailable: Type.Boolean(),
		dryRunAvailable: Type.Boolean(),
		hardwarePilotAvailable: Type.Optional(Type.Boolean()),
		leasePolicy: LeasePolicySchema,
	},
	{ additionalProperties: false },
);

export const CapabilitiesSchema = Type.Object(
	{
		instruments: Type.Array(InstrumentCapabilitySchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type Capabilities = Static<typeof CapabilitiesSchema>;

const SIMULATION_CAPABILITIES = {
	instruments: [
		{
			id: "sim-stage",
			resourceKind: "instrument",
			kind: "stage",
			units: ["um"],
			coordinateConvention: "right-handed sample coordinates, origin at configured simulation home",
			softwareLimits: {
				xUm: { minUm: 0, maxUm: 1000 },
				yUm: { minUm: 0, maxUm: 1000 },
				zUm: { minUm: -100, maxUm: 100 },
			},
			hazards: ["simulated motion only"],
			simulationAvailable: true,
			dryRunAvailable: false,
			leasePolicy: "exclusive",
		},
		{
			id: "sim-camera",
			resourceKind: "instrument",
			kind: "camera",
			units: ["px", "ms"],
			coordinateConvention: "image origin at top-left",
			softwareLimits: {
				maxExposureMs: 1000,
			},
			hazards: ["simulated camera only"],
			simulationAvailable: true,
			dryRunAvailable: false,
			leasePolicy: "exclusive",
		},
		{
			id: "sim-acquirer",
			resourceKind: "instrument",
			kind: "acquirer",
			units: ["mw", "ms"],
			coordinateConvention: "no spatial coordinates",
			softwareLimits: {
				maxLaserPowerMw: 1,
				maxExposureMs: 1000,
			},
			hazards: ["simulated acquisition only"],
			simulationAvailable: true,
			dryRunAvailable: false,
			leasePolicy: "exclusive",
		},
	],
} satisfies Capabilities;

const DRY_RUN_CAPABILITIES = {
	instruments: [
		{
			id: "mc-newton-xyz-stage",
			resourceKind: "instrument",
			kind: "stage",
			units: ["um"],
			coordinateConvention: "right-handed sample coordinates, origin at calibrated hardware home",
			softwareLimits: {
				xUm: { minUm: 0, maxUm: 500 },
				yUm: { minUm: 0, maxUm: 500 },
				zUm: { minUm: -50, maxUm: 50 },
			},
			hazards: ["real stage adapter probed read-only"],
			simulationAvailable: false,
			dryRunAvailable: true,
			hardwarePilotAvailable: true,
			leasePolicy: "exclusive",
		},
		{
			id: "lab-camera",
			resourceKind: "instrument",
			kind: "camera",
			units: ["px", "ms"],
			coordinateConvention: "image origin at top-left",
			softwareLimits: {
				maxExposureMs: 500,
			},
			hazards: ["real camera adapter probed read-only"],
			simulationAvailable: false,
			dryRunAvailable: true,
			hardwarePilotAvailable: false,
			leasePolicy: "shared-read",
		},
		{
			id: "lab-acquirer",
			resourceKind: "instrument",
			kind: "acquirer",
			units: ["mw", "ms"],
			coordinateConvention: "no spatial coordinates",
			softwareLimits: {
				maxLaserPowerMw: 2,
				maxExposureMs: 500,
			},
			hazards: ["real acquirer adapter probed read-only"],
			simulationAvailable: false,
			dryRunAvailable: true,
			hardwarePilotAvailable: false,
			leasePolicy: "shared-read",
		},
	],
} satisfies Capabilities;

export type CapabilityMode = "all" | "simulation" | "dry_run" | "hardware";

export function loadCapabilities(mode: CapabilityMode = "all"): Capabilities {
	if (mode === "simulation") return SIMULATION_CAPABILITIES;
	if (mode === "dry_run" || mode === "hardware") return DRY_RUN_CAPABILITIES;

	return {
		instruments: [...SIMULATION_CAPABILITIES.instruments, ...DRY_RUN_CAPABILITIES.instruments],
	};
}

export const STATIC_CAPABILITIES = loadCapabilities();
