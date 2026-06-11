import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capabilities } from "./capabilities.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";
import { getInstrumentResourceIds } from "./spec-utils.ts";

export interface AdapterProbe {
	instrumentId: string;
	reachable: boolean;
	readOnly: boolean;
	calibrationAvailable: boolean;
}

export interface LiveStateProbe {
	mode: "dry_run";
	adapters: AdapterProbe[];
	readOnlyProbe?: RamanReadOnlyProbe;
	outputDirectory: {
		path: string;
		writable: boolean;
	};
	abortPath: {
		path: string;
		available: boolean;
	};
	intentsPath: {
		path: string;
		writable: boolean;
	};
	approvalsPath: {
		path: string;
		writable: boolean;
	};
}

export interface RamanReadOnlyProbe {
	stage: {
		reachable: boolean;
		idn?: string;
		adapter?: string;
	};
	labspecWorker: {
		reachable: boolean;
		latencyMs: number;
	};
	outputDirWritable: boolean;
	dependencies: Record<string, string>;
	readOnly: boolean;
}

export interface LiveStateProbeResult {
	probe: LiveStateProbe;
	issues: ValidationIssue[];
}

function createAdapterProbe(instrumentId: string, capabilities: Capabilities): AdapterProbe {
	const instrument = capabilities.instruments.find((candidate) => candidate.id === instrumentId);
	return {
		instrumentId,
		reachable: instrument?.dryRunAvailable ?? false,
		readOnly: true,
		calibrationAvailable: instrument?.dryRunAvailable ?? false,
	};
}

function readRamanBridgeProbe(cwd: string): { probe?: RamanReadOnlyProbe; issue?: ValidationIssue } {
	const extensionDir = dirname(fileURLToPath(import.meta.url));
	const bridgePath = join(extensionDir, "raman_bridge.py");
	const dryRunDir = join(cwd, ".pi", "experiment-runs", "dry-run");
	const bridgeDir = join(dryRunDir, "labspec_bridge");
	mkdirSync(bridgeDir, { recursive: true });
	const request = {
		id: "probe-0001",
		action: "probe",
		payload: {
			stage: { adapter: "memory" },
			bridgeDir,
			outputDir: dryRunDir,
		},
	};
	const result = spawnSync("python", [bridgePath, "--stage-root", resolve(cwd, "docs", "Raman")], {
		cwd,
		input: `${JSON.stringify(request)}\n`,
		encoding: "utf-8",
		timeout: 5_000,
	});
	if (result.error) {
		return { issue: { path: "liveState.readOnlyProbe", message: `Raman bridge probe failed: ${result.error.message}` } };
	}
	if (result.status !== 0 && result.status !== null) {
		return { issue: { path: "liveState.readOnlyProbe", message: `Raman bridge probe exited with status ${result.status}` } };
	}
	const line = result.stdout
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0);
	if (!line) {
		return { issue: { path: "liveState.readOnlyProbe", message: "Raman bridge probe did not return a protocol response" } };
	}
	try {
		const parsed = JSON.parse(line) as { ok?: unknown; result?: unknown; error?: { message?: unknown } };
		if (parsed.ok === true && isRamanReadOnlyProbe(parsed.result)) {
			return { probe: parsed.result };
		}
		const message = typeof parsed.error?.message === "string" ? parsed.error.message : "Raman bridge probe response was invalid";
		return { issue: { path: "liveState.readOnlyProbe", message } };
	} catch {
		return { issue: { path: "liveState.readOnlyProbe", message: "Raman bridge probe returned malformed JSON" } };
	}
}

function isRamanReadOnlyProbe(value: unknown): value is RamanReadOnlyProbe {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.stage === "object" &&
		record.stage !== null &&
		typeof record.labspecWorker === "object" &&
		record.labspecWorker !== null &&
		typeof record.outputDirWritable === "boolean" &&
		typeof record.dependencies === "object" &&
		record.dependencies !== null &&
		typeof record.readOnly === "boolean"
	);
}

export function probeLiveState(spec: ExperimentSpec, capabilities: Capabilities, cwd: string = "."): LiveStateProbeResult {
	const probe: LiveStateProbe = {
		mode: "dry_run",
		adapters: getInstrumentResourceIds(spec).map((instrumentId) => createAdapterProbe(instrumentId, capabilities)),
		outputDirectory: {
			path: ".pi/experiment-runs/dry-run",
			writable: true,
		},
		abortPath: {
			path: ".pi/experiment-runs/intents.jsonl",
			available: true,
		},
		intentsPath: {
			path: ".pi/experiment-runs/intents.jsonl",
			writable: true,
		},
		approvalsPath: {
			path: ".pi/experiment-runs/approvals.jsonl",
			writable: true,
		},
	};
	const issues: ValidationIssue[] = [];
	if (spec.domain?.raman) {
		const bridgeProbe = readRamanBridgeProbe(cwd);
		if (bridgeProbe.probe) {
			probe.readOnlyProbe = bridgeProbe.probe;
		}
		if (bridgeProbe.issue) {
			issues.push(bridgeProbe.issue);
		}
	}

	for (const adapter of probe.adapters) {
		if (!adapter.reachable) {
			issues.push({ path: "resources", message: `Adapter is not reachable: ${adapter.instrumentId}` });
		}
		if (!adapter.readOnly) {
			issues.push({ path: "resources", message: `Adapter is not read-only: ${adapter.instrumentId}` });
		}
		if (!adapter.calibrationAvailable) {
			issues.push({
				path: "resources",
				message: `Calibration is not available: ${adapter.instrumentId}`,
			});
		}
	}

	if (!probe.outputDirectory.writable) {
		issues.push({ path: "outputDirectory", message: "Output directory is not writable" });
	}
	if (!probe.abortPath.available) {
		issues.push({ path: "abortPath", message: "Abort path is not available" });
	}
	if (!probe.intentsPath.writable) {
		issues.push({ path: "intentsPath", message: "Intents path is not writable" });
	}
	if (!probe.approvalsPath.writable) {
		issues.push({ path: "approvalsPath", message: "Approvals path is not writable" });
	}

	return { probe, issues };
}
