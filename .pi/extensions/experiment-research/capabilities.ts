import { Type, type Static } from "typebox";

const InstrumentKindSchema = Type.Union([Type.Literal("stage"), Type.Literal("camera"), Type.Literal("acquirer")]);

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
		kind: InstrumentKindSchema,
		units: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		coordinateConvention: Type.String({ minLength: 1 }),
		softwareLimits: SoftwareLimitsSchema,
		hazards: Type.Array(Type.String()),
		simulationAvailable: Type.Boolean(),
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

export const STATIC_CAPABILITIES = {
	instruments: [
		{
			id: "sim-stage",
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
		},
		{
			id: "sim-camera",
			kind: "camera",
			units: ["px", "ms"],
			coordinateConvention: "image origin at top-left",
			softwareLimits: {
				maxExposureMs: 1000,
			},
			hazards: ["simulated camera only"],
			simulationAvailable: true,
		},
		{
			id: "sim-acquirer",
			kind: "acquirer",
			units: ["mw", "ms"],
			coordinateConvention: "no spatial coordinates",
			softwareLimits: {
				maxLaserPowerMw: 1,
				maxExposureMs: 1000,
			},
			hazards: ["simulated acquisition only"],
			simulationAvailable: true,
		},
	],
} satisfies Capabilities;
