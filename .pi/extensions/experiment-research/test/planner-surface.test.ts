import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import experimentResearchExtension from "../index.ts";
import { EXPERIMENT_RESEARCH_PROMPT } from "../prompt.ts";
import { getLabCapabilitiesTool, getLabStateTool, runPreflightTool, validateExperimentSpecTool } from "../tools/planner.ts";

function tempCwd(): string {
	return mkdtempSync(join(tmpdir(), "exp-planner-surface-"));
}

function toolContext(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.equal(typeof value, "object");
	assert.notEqual(value, null);
	assert.equal(Array.isArray(value), false);
	return value as Record<string, unknown>;
}

function extensionHarness(initialActiveTools: string[] = []) {
	let activeTools = [...initialActiveTools];
	const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();
	const registeredTools: string[] = [];
	const pi = {
		registerTool(tool: { name: string }) {
			registeredTools.push(tool.name);
		},
		on(eventName: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(nextActiveTools: string[]) {
			activeTools = [...nextActiveTools];
		},
		sendMessage() {},
	};
	experimentResearchExtension(pi as never);
	return {
		activeTools: () => activeTools,
		registeredTools,
		emit(eventName: string) {
			for (const handler of handlers.get(eventName) ?? []) handler();
		},
	};
}

test("planner lab tools separate static capabilities from dynamic activity state", async () => {
	const cwd = tempCwd();
	try {
		const capabilitiesResult = await getLabCapabilitiesTool.execute("planner-lab-capabilities", {}, undefined, undefined, toolContext(cwd));
		assert.equal(capabilitiesResult.details.status, "success");
		assert.match(capabilitiesResult.details.summary, /Static lab capabilities loaded/);
		const capabilitiesState = asRecord(capabilitiesResult.details.stateAfter);
		assert.equal(Object.hasOwn(capabilitiesState, "capabilities"), true);
		assert.equal(Object.hasOwn(capabilitiesState, "activeRunId"), false);
		const planningConstraints = asRecord(capabilitiesState.planningConstraints);
		assert.equal(planningConstraints.hardwareRequiresAuditedAbsoluteCoordinates, true);
		assert.equal(planningConstraints.plannerMustRequestMissingCoordinates, true);
		assert.equal(planningConstraints.supervisedRealHardwareRequiresCoordinateAuditId, true);

		const activityResult = await getLabStateTool.execute("planner-lab-state", {}, undefined, undefined, toolContext(cwd));
		assert.equal(activityResult.details.status, "success");
		assert.match(activityResult.details.summary, /No run is currently active/);
		const activityState = asRecord(activityResult.details.stateAfter);
		assert.equal(Object.hasOwn(activityState, "capabilities"), false);
		assert.equal(activityState.activeRunId, null);
		assert.ok(activityResult.details.nextActions.some((action) => action.includes("get_lab_capabilities")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("planner active tools include approved Raman frame probe", () => {
	const harness = extensionHarness(["read"]);
	harness.emit("session_start");
	const activeTools = harness.activeTools();
	assert.ok(harness.registeredTools.includes("raman_active_probe"));
	assert.ok(activeTools.includes("raman_active_probe"));
	assert.ok(activeTools.includes("read"));
	assert.equal(activeTools.includes("pause_run"), false);
	assert.equal(activeTools.includes("record_hardware_coordinate_audit"), false);
});

test("planner prompt and tool guidance forbid placeholder hardware specs and redundant dynamic state reads", () => {
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /get_lab_capabilities/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /Reuse the latest get_lab_capabilities result/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /Use get_lab_state only when current active-run, pause, or recovery state may affect the next action/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /contract-gated read-only hardware_bridge_v2_read/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /operator-audited absolute coordinates/);
	assert.match(EXPERIMENT_RESEARCH_PROMPT, /placeholder origin points/);

	assert.ok(
		getLabCapabilitiesTool.promptGuidelines.some((guideline) => guideline.includes("Do not re-call get_lab_capabilities")),
	);
	assert.ok(
		getLabStateTool.promptGuidelines.some((guideline) => guideline.includes("Do not use get_lab_state as the default static capability lookup")),
	);
	assert.ok(
		validateExperimentSpecTool.promptGuidelines.some((guideline) =>
			guideline.includes("collect operator-audited absolute coordinates"),
		),
	);
	assert.ok(
		runPreflightTool.promptGuidelines.some((guideline) => guideline.includes("placeholder hardware specs")),
	);
});
