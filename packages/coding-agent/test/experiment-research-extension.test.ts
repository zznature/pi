import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import experimentResearchExtension from "../../../.pi/extensions/experiment-research/index.ts";
import { validateExperimentSpec } from "../../../.pi/extensions/experiment-research/schemas.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const fixturesDir = join(repoRoot, ".pi", "extensions", "experiment-research", "fixtures");

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
}

function readFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf-8"));
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
	} as unknown as ExtensionAPI;

	experimentResearchExtension(api);
	return { tools, handlers };
}

function asRecord(value: unknown): Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	return value as Record<string, unknown>;
}

describe("experiment research extension", () => {
	it("loads the project-local extension module and registers Phase 0 tools", () => {
		const extension = loadExperimentExtension();
		const [beforeAgentStart] = extension.handlers.get("before_agent_start") ?? [];

		expect(extension.tools.has("get_lab_state")).toBe(true);
		expect(extension.tools.has("validate_experiment_spec")).toBe(true);
		expect(extension.handlers.get("before_agent_start")).toHaveLength(1);

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
	});

	it("accepts the valid fixture and rejects the invalid fixture", () => {
		const valid = validateExperimentSpec(readFixture("valid-spec.json"));
		const invalid = validateExperimentSpec(readFixture("invalid-spec.json"));

		expect(valid.valid).toBe(true);
		expect(invalid.valid).toBe(false);
		if (!invalid.valid) {
			expect(invalid.issues.map((issue) => issue.path)).toEqual(
				expect.arrayContaining(["objective", "sampleId", "mode", "allowedInstruments", "root"]),
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
});
