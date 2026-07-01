import { describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import { buildExperimentIntent } from "../planner/intent-builder.ts";
import { buildProcedureProposal } from "../planner/procedure-spec-builder.ts";
import {
	ExperimentIntentValidator,
	ProcedureSpecValidator,
} from "../schemas/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../../packages/coding-agent/src/core/extensions/types.ts";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
}

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, CapturedHandler[]>();
	const api = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: CapturedHandler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
		},
		getActiveTools() {
			return ["read"];
		},
		setActiveTools() {},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers };
}

function buildIntent() {
	return buildExperimentIntent({
		intentId: "intent-planner-001",
		experimentId: "exp-planner-001",
		objective: "Find bounded Raman conditions and then map a small approved region.",
		successCriteria: ["No saturation", "Target peak visible"],
	});
}

function commonBuilderInput() {
	return {
		intent: buildIntent(),
		resources: {
			stageResourceId: "stage-main",
			frameProviderResourceId: "frame-main",
			spectrometerResourceId: "spectrometer-main",
		},
		limits: {
			maxLaserPowerMw: 1,
			minObjectiveClearanceUm: 200,
			xRangeUm: { minUm: 0, maxUm: 50_000 },
			yRangeUm: { minUm: 0, maxUm: 50_000 },
		},
		autofocus: {
			enabled: true,
			roi: { x: 100, y: 100, width: 64, height: 64 },
		},
		acquisition: {
			integrationTimeMs: 5_000,
			laserPowerMw: 0.5,
			accumulations: 1,
		},
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(value).toBeTypeOf("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

describe("experiment research planner proposal flow", () => {
	it("builds a valid ExperimentIntent and bounded ProcedureSpec proposals for all MVP planner procedures", () => {
		const intent = buildIntent();
		expect(ExperimentIntentValidator.Check(intent)).toBe(true);

		const singlePoint = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_single_point_probe",
			point: { xUm: 1_000, yUm: 2_000 },
		});
		const parameterSearch = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_parameter_search",
			point: { xUm: 1_000, yUm: 2_000 },
			parameterSearch: {
				maxAttempts: 3,
				laserPowerMw: { min: 0.2, max: 0.8 },
				integrationTimeMs: { min: 1_000, max: 5_000 },
				accumulations: [1, 2],
			},
		});
		const gridMapping = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_grid_mapping",
			grid: {
				origin: { xUm: 1_000, yUm: 2_000 },
				rows: 2,
				cols: 3,
				pitchXUm: 10,
				pitchYUm: 15,
				order: "snake",
			},
		});

		expect(ProcedureSpecValidator.Check(singlePoint.spec)).toBe(true);
		expect(ProcedureSpecValidator.Check(parameterSearch.spec)).toBe(true);
		expect(ProcedureSpecValidator.Check(gridMapping.spec)).toBe(true);
		expect(parameterSearch.spec.domain.raman.parameterSearch?.maxAttempts).toBe(3);
		expect(singlePoint.preview.requiresConfirmation).toBe(true);
		expect(parameterSearch.preview.unitCount).toBe(3);
		expect(gridMapping.preview.unitCount).toBe(6);
		expect(gridMapping.preview.risks.some((risk) => risk.code === "multi_point_mapping")).toBe(true);
	});

	it("builds current-position single-point proposals without placeholder coordinates", () => {
		const currentPosition = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_single_point_probe",
		});

		expect(ProcedureSpecValidator.Check(currentPosition.spec)).toBe(true);
		expect(currentPosition.spec.plan).toEqual({
			kind: "current_position",
			perPoint: [
				{ kind: "move_to_point" },
				{ kind: "autofocus" },
				{ kind: "capture_frame" },
				{ kind: "acquire_spectrum" },
			],
		});
		expect(currentPosition.preview.unitCount).toBe(1);
	});

	it("registers validation and preflight planner tools that summarize bounded proposal state", async () => {
		const extension = loadExperimentExtension();
		const context = {} as ExtensionContext;
		const proposal = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_grid_mapping",
			grid: {
				origin: { xUm: 1_000, yUm: 2_000 },
				rows: 2,
				cols: 2,
				pitchXUm: 10,
				pitchYUm: 10,
				order: "snake",
			},
		});

		const validateResult = await extension.tools
			.get("validate_procedure_spec")
			?.execute("validate", { spec: proposal.spec }, undefined, undefined, context);
		const validateDetails = asRecord(validateResult?.details);
		const validateState = asRecord(validateDetails.stateAfter);
		expect(validateDetails.status).toBe("success");
		expect(validateState.procedureId).toBe("raman_grid_mapping");
		expect(validateState.unitCount).toBe(4);
		expect(validateState.savePath).toEqual(expect.stringContaining(proposal.spec.procedureSpecId));

		const preflightResult = await extension.tools
			.get("run_preflight")
			?.execute("preflight", { spec: proposal.spec }, undefined, undefined, context);
		const preflightDetails = asRecord(preflightResult?.details);
		const preflightState = asRecord(preflightDetails.stateAfter);
		expect(preflightDetails.status).toBe("success");
		expect(preflightState.readyForApproval).toBe(true);
		expect(preflightState.requiresConfirmation).toBe(true);
		expect(preflightState.canProposeRun).toBe(true);
	});

	it("surfaces forbidden preflight risks when the proposed laser power exceeds limits", async () => {
		const extension = loadExperimentExtension();
		const context = {} as ExtensionContext;
		const proposal = buildProcedureProposal({
			...commonBuilderInput(),
			procedureId: "raman_single_point_probe",
			acquisition: {
				integrationTimeMs: 5_000,
				laserPowerMw: 2,
				accumulations: 1,
			},
			point: { xUm: 1_000, yUm: 2_000 },
		});

		const preflightResult = await extension.tools
			.get("run_preflight")
			?.execute("preflight-warning", { spec: proposal.spec }, undefined, undefined, context);
		const preflightDetails = asRecord(preflightResult?.details);
		const preflightState = asRecord(preflightDetails.stateAfter);
		const risks = preflightState.risks as Array<Record<string, unknown>>;

		expect(preflightDetails.status).toBe("warning");
		expect(preflightState.readyForApproval).toBe(false);
		expect(risks.some((risk) => risk.code === "laser_power_limit_exceeded")).toBe(true);
	});
});
