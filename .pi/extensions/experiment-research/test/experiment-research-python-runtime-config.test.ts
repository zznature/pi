import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import experimentResearchExtension from "../index.ts";
import {
	clearRamanLiveRuntime,
	getRamanLiveRuntime,
	RAMAN_PYTHON_RUNTIME_CONFIG_PATH,
	type RamanLiveRuntime,
	registerRamanLiveRuntime,
	successActionResult,
} from "../runtime/raman/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../../packages/coding-agent/src/core/extensions/types.ts";

type CapturedHandler = (...args: unknown[]) => unknown;

interface CapturedExtension {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, CapturedHandler[]>;
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const path = tempRoots.pop();
		if (path) {
			clearRamanLiveRuntime(path);
			rmSync(path, { recursive: true, force: true });
		}
	}
});

function createTempCwd(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-exp-python-runtime-"));
	tempRoots.push(cwd);
	return cwd;
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

function createRuntimeConfig(enabled: boolean): Record<string, unknown> {
	return {
		enabled,
		pythonExecutable: "python",
		pythonRoot: "docs/Raman",
		stage: {
			resourceId: "stage-main",
			kind: "stage",
			runtime: "raman_python",
			driver: "mc_newton_xyz",
			config: {
				port: "COM5",
				xChannel: 1,
				yChannel: 2,
				zChannel: 3,
				baudrate: 115200,
			},
			leasePolicy: "exclusive",
			simulationAvailable: true,
			limits: {
				xRangeUm: [0, 50_000],
				yRangeUm: [0, 50_000],
				zRangeUm: [0, 5_000],
			},
		},
		frameProvider: {
			resourceId: "frame-main",
			kind: "frame_provider",
			runtime: "raman_python",
			driver: "labspec_file_bridge_frame",
			config: {
				bridgeDir: "D:\\RamanLab\\SpecBridge",
				imageFormat: "tif",
				minCaptureIntervalMs: 400,
			},
			leasePolicy: "shared-read",
			simulationAvailable: false,
		},
		spectrometer: {
			resourceId: "spectrometer-main",
			kind: "spectrometer",
			runtime: "raman_python",
			driver: "labspec_file_bridge_spectrum",
			config: {
				bridgeDir: "D:\\RamanLab\\SpecBridge",
				requestFilename: "spectrum_request.ini",
				resultFilename: "spectrum_result.ini",
			},
			leasePolicy: "exclusive",
			simulationAvailable: false,
		},
	};
}

function writeRuntimeConfig(cwd: string, enabled: boolean): void {
	const configPath = join(cwd, RAMAN_PYTHON_RUNTIME_CONFIG_PATH);
	mkdirSync(join(configPath, ".."), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(createRuntimeConfig(enabled), null, 2)}\n`, "utf-8");
}

function createNoHardwareRuntime(): RamanLiveRuntime {
	return {
		preflight() {
			return { preflightReady: true, controlAvailable: true };
		},
		stage: {
			resource: createRuntimeConfig(true).stage as RamanLiveRuntime["stage"]["resource"],
			moveAbsoluteAndWait() {
				return successActionResult("not used");
			},
		},
		autofocus: {
			runSingle() {
				return successActionResult("not used");
			},
		},
		frame: {
			resource: createRuntimeConfig(true).frameProvider as RamanLiveRuntime["frame"]["resource"],
			captureLatest() {
				return successActionResult("not used");
			},
		},
		spectrometer: {
			resource: createRuntimeConfig(true).spectrometer as RamanLiveRuntime["spectrometer"]["resource"],
			acquireSpectrum() {
				return successActionResult("not used");
			},
		},
	};
}

describe("experiment research Python Raman runtime config", () => {
	it("registers the Python live runtime from enabled workspace config without touching hardware", async () => {
		const cwd = createTempCwd();
		writeRuntimeConfig(cwd, true);
		const extension = loadExperimentExtension();
		const [sessionStart] = extension.handlers.get("session_start") ?? [];

		await sessionStart?.({ type: "session_start", reason: "startup" }, { cwd } as ExtensionContext);

		expect(getRamanLiveRuntime(cwd)).toBeDefined();
	});

	it("keeps hardware disabled when config is explicitly disabled", async () => {
		const cwd = createTempCwd();
		writeRuntimeConfig(cwd, false);
		registerRamanLiveRuntime(cwd, createNoHardwareRuntime());
		const extension = loadExperimentExtension();
		const [sessionStart] = extension.handlers.get("session_start") ?? [];

		await sessionStart?.({ type: "session_start", reason: "startup" }, { cwd } as ExtensionContext);

		expect(getRamanLiveRuntime(cwd)).toBeUndefined();
		const labState = await extension.tools
			.get("get_lab_state")
			?.execute("lab-state", {}, undefined, undefined, { cwd } as ExtensionContext);
		const details = labState?.details as Record<string, unknown>;
		const stateAfter = details.stateAfter as Record<string, unknown>;
		expect(stateAfter.canExecuteLiveSinglePointRuns).toBe(false);
	});
});
