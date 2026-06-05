import type { Capabilities } from "./capabilities.ts";
import type { ExperimentSpec, ValidationIssue } from "./schemas.ts";

export interface AdapterProbe {
	instrumentId: string;
	reachable: boolean;
	readOnly: boolean;
	calibrationAvailable: boolean;
}

export interface LiveStateProbe {
	mode: "dry_run";
	adapters: AdapterProbe[];
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

export function probeLiveState(spec: ExperimentSpec, capabilities: Capabilities): LiveStateProbeResult {
	const probe: LiveStateProbe = {
		mode: "dry_run",
		adapters: spec.allowedInstruments.map((instrumentId) => createAdapterProbe(instrumentId, capabilities)),
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

	for (const adapter of probe.adapters) {
		if (!adapter.reachable) {
			issues.push({ path: "allowedInstruments", message: `Adapter is not reachable: ${adapter.instrumentId}` });
		}
		if (!adapter.readOnly) {
			issues.push({ path: "allowedInstruments", message: `Adapter is not read-only: ${adapter.instrumentId}` });
		}
		if (!adapter.calibrationAvailable) {
			issues.push({
				path: "allowedInstruments",
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
