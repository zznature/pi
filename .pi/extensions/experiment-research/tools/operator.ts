import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getRamanLiveRuntime, type ActionResult, type RamanLiveRuntime } from "../runtime/raman/index.ts";

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

const StageAxisSchema = Type.Union([
	Type.Literal("x"),
	Type.Literal("y"),
	Type.Literal("z"),
]);

const StageRelativeMoveParamsSchema = Type.Object(
	{
		axis: StageAxisSchema,
		deltaUm: Type.Number(),
		confirmed: Type.Optional(Type.Boolean()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
		minObjectiveClearanceUm: Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

type StageRelativeMoveParams = Static<typeof StageRelativeMoveParamsSchema>;
type StageAxis = Static<typeof StageAxisSchema>;

interface OperatorToolDetails {
	status: "success" | "warning" | "error";
	summary: string;
	errorCode?: string;
	retrySafe?: boolean;
	needsOperator?: boolean;
	stateAfter: Record<string, unknown>;
}

interface StagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

function success(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "success",
			summary,
			stateAfter,
		},
	};
}

function warning(summary: string, stateAfter: Record<string, unknown>): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "warning",
			summary,
			needsOperator: true,
			stateAfter,
		},
	};
}

function error(
	summary: string,
	errorCode: string,
	stateAfter: Record<string, unknown> = {},
	retrySafe = true,
): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return {
		content: [{ type: "text", text: summary }],
		details: {
			status: "error",
			summary,
			errorCode,
			retrySafe,
			needsOperator: true,
			stateAfter,
		},
	};
}

function runtimeUnavailableState(): { content: [{ type: "text"; text: string }]; details: OperatorToolDetails } {
	return error("No live Raman runtime is registered for this workspace.", "live_runtime_unavailable", {
		realRuntimeRegistered: false,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
}

function positionFromActionResult(result: ActionResult): StagePosition | undefined {
	const payload = result.payload;
	if (!isRecord(payload)) {
		return undefined;
	}
	const position = payload.position;
	if (!isRecord(position)) {
		return undefined;
	}
	const xUm = readNumber(position, "xUm");
	const yUm = readNumber(position, "yUm");
	const zUm = readNumber(position, "zUm");
	if (xUm === undefined || yUm === undefined || zUm === undefined) {
		return undefined;
	}
	return { xUm, yUm, zUm };
}

async function readStagePosition(runtime: RamanLiveRuntime, timeoutMs: number): Promise<ActionResult> {
	return runtime.stage.getPosition({
		action: "stage.get_position",
		resourceId: runtime.stage.resource.resourceId,
		timeoutMs,
	});
}

function targetFromDelta(position: StagePosition, axis: StageAxis, deltaUm: number): StagePosition {
	return {
		xUm: axis === "x" ? position.xUm + deltaUm : position.xUm,
		yUm: axis === "y" ? position.yUm + deltaUm : position.yUm,
		zUm: axis === "z" ? position.zUm + deltaUm : position.zUm,
	};
}

function axisLimitFor(runtime: RamanLiveRuntime, axis: StageAxis): [number, number] {
	switch (axis) {
		case "x":
			return runtime.stage.resource.limits.xRangeUm;
		case "y":
			return runtime.stage.resource.limits.yRangeUm;
		case "z":
			return runtime.stage.resource.limits.zRangeUm;
	}
}

function positionValue(position: StagePosition, axis: StageAxis): number {
	switch (axis) {
		case "x":
			return position.xUm;
		case "y":
			return position.yUm;
		case "z":
			return position.zUm;
	}
}

function checkMoveLimits(
	runtime: RamanLiveRuntime,
	target: StagePosition,
	axis: StageAxis,
	minObjectiveClearanceUm: number | undefined,
): { ok: true } | { ok: false; code: string; message: string; state: Record<string, unknown> } {
	const [minimum, maximum] = axisLimitFor(runtime, axis);
	const requested = positionValue(target, axis);
	if (requested < minimum || requested > maximum) {
		return {
			ok: false,
			code: "motion_out_of_bounds",
			message: `Requested ${axis.toUpperCase()} position ${requested} um is outside the stage resource limits.`,
			state: {
				axis,
				target,
				limits: { minUm: minimum, maxUm: maximum },
			},
		};
	}
	if (minObjectiveClearanceUm !== undefined && target.zUm < minObjectiveClearanceUm) {
		return {
			ok: false,
			code: "objective_clearance_violation",
			message: `Requested Z position ${target.zUm} um violates minObjectiveClearanceUm ${minObjectiveClearanceUm} um.`,
			state: {
				axis,
				target,
				minObjectiveClearanceUm,
			},
		};
	}
	return { ok: true };
}

export const ramanGetHardwareStatusTool = {
	name: "raman_get_hardware_status",
	label: "Raman Hardware Status",
	description: "Read live Raman runtime readiness and hardware status without starting a run.",
	promptSnippet: "Check current Raman hardware readiness through the registered live runtime",
	promptGuidelines: [
		"Use this for operator status questions such as whether the Raman hardware is connected.",
		"Do not construct a ProcedureSpec just to answer read-only hardware status questions.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const preflight = await runtime.preflight();
		const positionResult = await readStagePosition(runtime, 10_000);
		const position = positionResult.status === "success" ? positionFromActionResult(positionResult) : undefined;
		const stateAfter: Record<string, unknown> = {
			realRuntimeRegistered: true,
			preflightReady: preflight.preflightReady,
			controlAvailable: preflight.controlAvailable,
			livePreflightDetails: preflight.details ?? {},
			stageResourceId: runtime.stage.resource.resourceId,
			frameProviderResourceId: runtime.frame.resource.resourceId,
			spectrometerResourceId: runtime.spectrometer.resource.resourceId,
			stagePosition: position,
			stagePositionReadStatus: positionResult.status,
			stagePositionSummary: positionResult.summary,
		};

		if (positionResult.status !== "success") {
			return warning("Raman runtime is registered, but stage position could not be read.", stateAfter);
		}
		if (!preflight.preflightReady || !preflight.controlAvailable) {
			return warning("Raman runtime is registered but not ready for live controlled execution.", stateAfter);
		}
		return success("Raman hardware status is ready and stage position was read.", stateAfter);
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanGetStagePositionTool = {
	name: "raman_get_stage_position",
	label: "Raman Stage Position",
	description: "Read the current Raman stage position through the registered live runtime.",
	promptSnippet: "Read current Raman stage X/Y/Z position",
	promptGuidelines: [
		"Use this for read-only position checks.",
		"Do not use legacy bridges or a ProcedureSpec for position reads when this tool is available.",
	],
	parameters: EmptyParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const positionResult = await readStagePosition(runtime, 10_000);
		if (positionResult.status !== "success") {
			return error(positionResult.summary, positionResult.errorCode ?? "stage_position_read_failed", {
				stageResourceId: runtime.stage.resource.resourceId,
				actionStatus: positionResult.status,
				payload: positionResult.payload ?? {},
			}, positionResult.retrySafe);
		}

		const position = positionFromActionResult(positionResult);
		if (!position) {
			return error("Stage position result did not include xUm, yUm, and zUm.", "invalid_stage_position_result", {
				stageResourceId: runtime.stage.resource.resourceId,
				payload: positionResult.payload ?? {},
			}, false);
		}

		return success("Stage position read.", {
			stageResourceId: runtime.stage.resource.resourceId,
			position,
		});
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, OperatorToolDetails>;

export const ramanStageMoveRelativeTool = {
	name: "raman_stage_move_relative",
	label: "Raman Stage Move Relative",
	description: "Prepare or execute a confirmed relative Raman stage move through the live runtime.",
	promptSnippet: "Move the Raman stage by a small relative delta after explicit operator confirmation",
	promptGuidelines: [
		"Use this for operator-requested stage nudges, not Raman acquisition runs.",
		"Call first without confirmed=true to present the target and safety envelope, then call with confirmed=true only after explicit confirmation.",
	],
	parameters: StageRelativeMoveParamsSchema,
	executionMode: "sequential",
	async execute(_toolCallId, params: StageRelativeMoveParams, _signal, _onUpdate, ctx) {
		const runtime = getRamanLiveRuntime(ctx.cwd);
		if (!runtime) {
			return runtimeUnavailableState();
		}

		const timeoutMs = params.timeoutMs ?? 15_000;
		const positionResult = await readStagePosition(runtime, 10_000);
		if (positionResult.status !== "success") {
			return error(positionResult.summary, positionResult.errorCode ?? "stage_position_read_failed", {
				stageResourceId: runtime.stage.resource.resourceId,
				actionStatus: positionResult.status,
				payload: positionResult.payload ?? {},
			}, positionResult.retrySafe);
		}

		const current = positionFromActionResult(positionResult);
		if (!current) {
			return error("Stage position result did not include xUm, yUm, and zUm.", "invalid_stage_position_result", {
				stageResourceId: runtime.stage.resource.resourceId,
				payload: positionResult.payload ?? {},
			}, false);
		}

		const target = targetFromDelta(current, params.axis, params.deltaUm);
		const limitCheck = checkMoveLimits(runtime, target, params.axis, params.minObjectiveClearanceUm);
		if (!limitCheck.ok) {
			return error(limitCheck.message, limitCheck.code, {
				stageResourceId: runtime.stage.resource.resourceId,
				current,
				...limitCheck.state,
			}, false);
		}

		const proposalState = {
			stageResourceId: runtime.stage.resource.resourceId,
			axis: params.axis,
			deltaUm: params.deltaUm,
			current,
			target,
			stageLimits: runtime.stage.resource.limits,
			requiresConfirmation: true,
			confirmed: params.confirmed === true,
		};
		if (params.confirmed !== true) {
			return warning("Stage relative move requires explicit confirmation before execution.", proposalState);
		}

		const moveResult = await runtime.stage.moveAbsoluteAndWait({
			action: "stage.move_absolute_and_wait",
			resourceId: runtime.stage.resource.resourceId,
			target,
			timeoutMs,
		});
		if (moveResult.status !== "success") {
			return error(moveResult.summary, moveResult.errorCode ?? "stage_move_failed", {
				...proposalState,
				actionStatus: moveResult.status,
				payload: moveResult.payload ?? {},
			}, moveResult.retrySafe);
		}

		return success("Stage relative move completed.", {
			...proposalState,
			payload: moveResult.payload ?? {},
		});
	},
} satisfies ToolDefinition<typeof StageRelativeMoveParamsSchema, OperatorToolDetails>;
