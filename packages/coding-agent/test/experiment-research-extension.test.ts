import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dispatch } from "../../../.pi/extensions/experiment-research/dispatch.ts";
import experimentResearchExtension from "../../../.pi/extensions/experiment-research/index.ts";
import { validateExperimentSpec } from "../../../.pi/extensions/experiment-research/schemas.ts";
import type {
	CustomToolCallEvent,
	CustomToolResultEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const fixturesDir = join(repoRoot, ".pi", "extensions", "experiment-research", "fixtures");

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
	getActiveTools(): string[];
	messages: CapturedMessage[];
}

interface CapturedMessage {
	customType: string;
	content?: unknown;
	display?: boolean;
	details?: unknown;
}

function readFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
}

function loadExperimentExtension(): CapturedExtension {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, CapturedHandler[]>();
	let activeTools = ["read", "write"];
	const messages: CapturedMessage[] = [];
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
			return activeTools;
		},
		setActiveTools(toolNames: string[]) {
			activeTools = toolNames;
		},
		sendMessage(message: CapturedMessage) {
			messages.push(message);
		},
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers, getActiveTools: () => activeTools, messages };
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

function asString(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error(`Expected string, got ${typeof value}`);
	}
	return value;
}

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exp-test-"));
	try {
		return await fn(cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("experiment research extension", () => {
	it("loads the project-local extension module and registers experiment management tools", async () => {
		const extension = loadExperimentExtension();
		const [beforeAgentStart] = extension.handlers.get("before_agent_start") ?? [];
		const [sessionStart] = extension.handlers.get("session_start") ?? [];

		expect(extension.tools.has("get_lab_state")).toBe(true);
		expect(extension.tools.has("get_experiment_state")).toBe(true);
		expect(extension.tools.has("validate_experiment_spec")).toBe(true);
		expect(extension.tools.has("run_preflight")).toBe(true);
		expect(extension.tools.has("run_experiment")).toBe(true);
		expect(extension.tools.has("analyze_run")).toBe(true);
		expect(extension.tools.has("plan_next_experiment")).toBe(true);
		expect(extension.handlers.get("session_start")).toHaveLength(1);
		expect(extension.handlers.get("before_agent_start")).toHaveLength(1);

		await sessionStart?.({ type: "session_start", sessionId: "test-session" }, {} as ExtensionContext);
		expect(extension.getActiveTools()).toEqual(
			expect.arrayContaining([
				"read",
				"get_lab_state",
				"get_experiment_state",
				"validate_experiment_spec",
				"run_preflight",
				"run_experiment",
				"analyze_run",
				"plan_next_experiment",
			]),
		);

		const promptResult = asRecord(
			beforeAgentStart?.({
				type: "before_agent_start",
				prompt: "plan an experiment",
				systemPrompt: "base prompt",
				systemPromptOptions: {},
			}),
		);
		expect(promptResult.systemPrompt).toContain("base prompt");
		expect(promptResult.systemPrompt).toContain("experiment research agent");
		expect(promptResult.systemPrompt).toContain("run_preflight");
		expect(promptResult.systemPrompt).toContain("dry_run");
		expect(promptResult.systemPrompt).toContain("plan_next_experiment");
	});

	it("accepts the valid fixture and rejects the invalid fixture", () => {
		const valid = validateExperimentSpec(readFixture("valid-spec.json"));
		const dryRun = validateExperimentSpec(readFixture("dry-run-spec.json"));
		const invalid = validateExperimentSpec(readFixture("invalid-spec.json"));

		expect(valid.valid).toBe(true);
		expect(dryRun.valid).toBe(true);
		expect(invalid.valid).toBe(false);
		if (!invalid.valid) {
			expect(invalid.issues.map((issue) => issue.path)).toEqual(
				expect.arrayContaining(["experimentId", "specId", "objective", "subject.id", "mode", "plan"]),
			);
		}
	});

	it("exposes callable read-only tools with structured ToolResult details", async () => {
		const extension = loadExperimentExtension();
		const labStateTool = extension.tools.get("get_lab_state");
		const validateSpecTool = extension.tools.get("validate_experiment_spec");

		expect(labStateTool).toBeDefined();
		expect(validateSpecTool).toBeDefined();

		const context = {} as ExtensionContext;
		const labState = await labStateTool?.execute("lab-state", {}, undefined, undefined, context);
		const labStateDetails = asRecord(labState?.details);
		const labStateAfter = asRecord(labStateDetails.stateAfter);

		expect(labStateDetails.status).toBe("success");
		expect(labStateAfter.mode).toBe("simulation");
		expect(labStateAfter.dryRunAvailable).toBe(true);

		const invalidResult = await validateSpecTool?.execute(
			"validate-spec",
			{ spec: readFixture("invalid-spec.json") },
			undefined,
			undefined,
			context,
		);
		const invalidDetails = asRecord(invalidResult?.details);

		expect(invalidDetails.status).toBe("error");
		expect(invalidDetails.errorCode).toBe("invalid_experiment_spec");
		expect(invalidDetails.retrySafe).toBe(true);
	});

	it("runs the simulation closed loop through registered tools", async () => {
		await withTempCwd(async (cwd) => {
			const extension = loadExperimentExtension();
			const spec = readFixture("valid-spec.json");
			const context = { cwd } as ExtensionContext;

			const preflight = await extension.tools
				.get("run_preflight")
				?.execute("preflight", { spec }, undefined, undefined, context);
			const preflightDetails = asRecord(preflight?.details);
			const preflightState = asRecord(preflightDetails.stateAfter);
			expect(preflightDetails.status).toBe("success");
			expect(preflightState.unitCount).toBe(9);

			const run = await extension.tools
				.get("run_experiment")
				?.execute("run", { spec }, undefined, undefined, context);
			const runDetails = asRecord(run?.details);
			const runState = asRecord(runDetails.stateAfter);
			const runSummary = asRecord(runState.summary);
			const records = asRecord(runState.records);
			const runId = asString(runDetails.runId);
			expect(runDetails.status).toBe("success");
			expect(runId).toMatch(/^sim-run-/);
			expect(runSummary.unitCount).toBe(9);
			expect(runSummary.meanSignal).toBe(107);
			expect(runDetails.experimentId).toBe("exp-sim-001");
			expect(existsSync(asString(records.runJsonPath))).toBe(true);
			expect(existsSync(asString(records.specPath))).toBe(true);
			expect(existsSync(asString(records.capabilitiesSnapshotPath))).toBe(true);
			expect(existsSync(asString(records.summaryPath))).toBe(true);
			expect(existsSync(asString(records.artifactsPath))).toBe(true);
			const eventsPath = asString(records.eventsPath);
			expect(existsSync(eventsPath)).toBe(true);
			const events = readFileSync(eventsPath, "utf-8");
			expect(events).toContain('"run_reserved"');
			expect(events).toContain('"unit_completed"');

			const analysis = await extension.tools
				.get("analyze_run")
				?.execute("analyze", { runId }, undefined, undefined, context);
			const analysisDetails = asRecord(analysis?.details);
			const analysisState = asRecord(analysisDetails.stateAfter);
			const analysisSummary = asRecord(analysisState.summary);
			const analysisResult = asRecord(analysisState.analysis);
			const qualityMetrics = asRecord(analysisResult.qualityMetrics);
			expect(analysisDetails.status).toBe("success");
			expect(analysisSummary.runId).toBe(runId);
			expect(analysisSummary.meanSignal).toBe(107);
			expect(qualityMetrics.unitCount).toBe(9);

			const nextPlan = await extension.tools
				.get("plan_next_experiment")
				?.execute(
					"plan-next",
					{ runId, objective: "Increase spatial resolution after a good signal run" },
					undefined,
					undefined,
					context,
				);
			const nextPlanDetails = asRecord(nextPlan?.details);
			const nextPlanState = asRecord(nextPlanDetails.stateAfter);
			expect(nextPlanDetails.status).toBe("success");
			expect(nextPlanState.runId).toBe(runId);
			expect(nextPlanState.strategy).toBe("refine_region");
			expect(existsSync(asString(nextPlanState.lineagePath))).toBe(true);

			const experimentState = await extension.tools
				.get("get_experiment_state")
				?.execute("experiment-state", { experimentId: "exp-sim-001" }, undefined, undefined, context);
			const experimentDetails = asRecord(experimentState?.details);
			const experimentAfter = asRecord(experimentDetails.stateAfter);
			expect(experimentDetails.status).toBe("success");
			expect(experimentAfter.runs).toHaveLength(1);
		});
	});

	it("runs Phase 3 dry-run readiness preflight without executing an experiment", async () => {
		await withTempCwd(async (cwd) => {
			const extension = loadExperimentExtension();
			const spec = readFixture("dry-run-spec.json");
			const context = { cwd } as ExtensionContext;

			const preflight = await extension.tools
				.get("run_preflight")
				?.execute("dry-preflight", { spec }, undefined, undefined, context);
			const preflightDetails = asRecord(preflight?.details);
			const preflightState = asRecord(preflightDetails.stateAfter);
			const liveState = asRecord(preflightState.liveState);
			const plannedRun = asRecord(preflightState.plannedRun);
			const approvalRecord = asRecord(preflightState.approvalRecord);
			const records = asRecord(preflightState.records);

			expect(preflightDetails.status).toBe("success");
			expect(preflightState.mode).toBe("dry_run");
			expect(preflightState.unitCount).toBe(4);
			expect(preflightState.specHash).toEqual(expect.any(String));
			expect(preflightState.capabilitySnapshotId).toEqual(expect.any(String));
			expect(plannedRun.wouldVisitUnits).toBe(4);
			expect(liveState.mode).toBe("dry_run");
			expect(approvalRecord.path).toBe(".pi/experiment-runs/approvals.jsonl");
			expect(existsSync(asString(records.reportPath))).toBe(true);
			const approvalsPath = asString(records.approvalsPath);
			expect(existsSync(approvalsPath)).toBe(true);
			expect(readFileSync(approvalsPath, "utf-8")).toContain('"preflight_recorded"');
			expect(preflightState.willNotExecute).toEqual(
				expect.arrayContaining(["stage motion", "camera exposure", "Raman acquisition", "laser power change"]),
			);

			const run = await extension.tools
				.get("run_experiment")
				?.execute("dry-run", { spec }, undefined, undefined, context);
			const runDetails = asRecord(run?.details);
			expect(runDetails.status).toBe("error");
			expect(runDetails.errorCode).toBe("dry_run_execution_not_supported");
		});
	});

	it("blocks unsafe tool calls and surfaces Phase 2 recovery hooks", async () => {
		const extension = loadExperimentExtension();
		const context = { cwd: repoRoot } as ExtensionContext;
		const [toolCall] = extension.handlers.get("tool_call") ?? [];
		const [toolResult] = extension.handlers.get("tool_result") ?? [];

		const lowLevelResult = asRecord(
			await toolCall?.(
				{
					type: "tool_call",
					toolCallId: "move-call",
					toolName: "move_z",
					input: {},
				} satisfies CustomToolCallEvent,
				context,
			),
		);
		expect(lowLevelResult.block).toBe(true);
		expect(lowLevelResult.reason).toContain("low-level hardware tools");

		const dryRunExecutionResult = asRecord(
			await toolCall?.(
				{
					type: "tool_call",
					toolCallId: "run-call",
					toolName: "run_experiment",
					input: { spec: { mode: "dry_run" } },
				} satisfies CustomToolCallEvent,
				context,
			),
		);
		expect(dryRunExecutionResult.block).toBe(true);
		expect(dryRunExecutionResult.reason).toContain("approved hardware mode");

		const errorDetails = {
			status: "error",
			summary: "ExperimentSpec failed validation.",
			nextActions: ["Fix the reported schema issues."],
			artifacts: [],
			commandId: "phase2-test-error",
			correlationId: "phase2-test-error",
			stateAfter: {},
			errorCode: "invalid_experiment_spec",
			retrySafe: true,
			stopConditionMet: false,
		};
		const recoveryResult = asRecord(
			await toolResult?.(
				{
					type: "tool_result",
					toolCallId: "error-call",
					toolName: "run_preflight",
					input: {},
					content: [{ type: "text", text: "base" }],
					isError: true,
					details: errorDetails,
				} satisfies CustomToolResultEvent,
				context,
			),
		);
		expect(JSON.stringify(recoveryResult.content)).toContain("Recovery:");
		const recoveryDetails = asRecord(recoveryResult.details);
		const recovery = asRecord(recoveryDetails.recovery);
		expect(recovery.retrySafe).toBe(true);

		const successDetails = {
			status: "success",
			summary: "Simulation run sim-run-test completed.",
			nextActions: ["Call analyze_run with the returned runId."],
			artifacts: [],
			runId: "sim-run-test",
			commandId: "phase2-test-success",
			correlationId: "phase2-test-success",
			stateAfter: { summary: { runId: "sim-run-test" } },
			stopConditionMet: false,
		};
		const successResult = await toolResult?.(
			{
				type: "tool_result",
				toolCallId: "success-call",
				toolName: "run_experiment",
				input: {},
				content: [{ type: "text", text: "done" }],
				isError: false,
				details: successDetails,
			} satisfies CustomToolResultEvent,
			context,
		);
		expect(successResult).toBeUndefined();
		expect(extension.messages).toHaveLength(1);
		expect(extension.messages[0]?.customType).toBe("experiment-run-summary");
		expect(extension.messages[0]?.content).toBe("Simulation run sim-run-test completed.");
	});

	it("returns normalized errors for policy rejection and invalid dispatch params", () => {
		const hardwareSpec = { ...asRecord(readFixture("valid-spec.json")), mode: "hardware" };
		const policyResult = dispatch("run_preflight", { spec: hardwareSpec });
		expect(policyResult.status).toBe("error");
		expect(policyResult.errorCode).toBe("policy_rejected");
		expect(policyResult.retrySafe).toBe(true);

		const paramsResult = dispatch("analyze_run", {});
		expect(paramsResult.status).toBe("error");
		expect(paramsResult.errorCode).toBe("invalid_tool_params");
		expect(paramsResult.retrySafe).toBe(true);

		const missingToolResult = dispatch("missing_tool", {});
		expect(missingToolResult.status).toBe("error");
		expect(missingToolResult.errorCode).toBe("tool_not_found");
		expect(missingToolResult.retrySafe).toBe(false);
	});
});
