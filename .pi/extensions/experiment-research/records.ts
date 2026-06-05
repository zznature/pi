import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HardwareRun } from "./kernel/hardware-pilot.ts";
import type { SimulationRun, SimulationSummary } from "./kernel/simulation.ts";
import type { PreflightResult } from "./preflight.ts";
import type { ExperimentSpec, HardwarePilotParams, ToolResult } from "./schemas.ts";

export interface RunRecordRefs {
	runDir: string;
	specPath: string;
	eventsPath: string;
	summaryPath: string;
	artifactsPath: string;
	artifacts: ToolResult["artifacts"];
}

export interface PreflightRecordRefs {
	reportId: string;
	reportDir: string;
	reportPath: string;
	approvalsPath: string;
	artifacts: ToolResult["artifacts"];
}

let nextPreflightNumber = 1;
let nextHardwareRunNumber = 1;

function nextPreflightId(mode: ExperimentSpec["mode"]): string {
	const id = `${mode}-preflight-${String(nextPreflightNumber).padStart(4, "0")}`;
	nextPreflightNumber += 1;
	return id;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function toJsonLine(value: unknown): string {
	return JSON.stringify(value);
}

function nextHardwareRunId(): string {
	const id = `hw-run-${String(nextHardwareRunNumber).padStart(4, "0")}`;
	nextHardwareRunNumber += 1;
	return id;
}

function normalizeSpecForGate(spec: ExperimentSpec): unknown {
	return {
		...spec,
		mode: "hardware_gate",
		operatorApprovalRequired: true,
	};
}

export function hashExperimentSpec(spec: ExperimentSpec): string {
	return createHash("sha256").update(JSON.stringify(normalizeSpecForGate(spec))).digest("hex");
}

export function appendRunRecords(run: SimulationRun, cwd: string): RunRecordRefs {
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", run.runId);
	mkdirSync(runDir, { recursive: true });

	const specPath = join(runDir, "spec.json");
	const eventsPath = join(runDir, "events.jsonl");
	const summaryPath = join(runDir, "summary.json");
	const artifactsPath = join(runDir, "artifacts.json");
	const relativeRunDir = join(".pi", "experiment-runs", "runs", run.runId);
	const artifacts: ToolResult["artifacts"] = [
		{ uri: join(relativeRunDir, "spec.json"), label: "ExperimentSpec", kind: "spec" },
		{ uri: join(relativeRunDir, "events.jsonl"), label: "Point events", kind: "events" },
		{ uri: join(relativeRunDir, "summary.json"), label: "Simulation summary", kind: "summary" },
		{ uri: join(relativeRunDir, "artifacts.json"), label: "Artifact index", kind: "artifacts" },
	];
	const events = [
		toJsonLine({ type: "run_started", runId: run.runId, mode: run.summary.mode, pointCount: run.points.length }),
		...run.points.map((point) => toJsonLine({ type: "point_completed", runId: run.runId, point })),
		toJsonLine({ type: "run_completed", runId: run.runId, summary: run.summary }),
	].join("\n");

	writeJson(specPath, run.spec);
	writeFileSync(eventsPath, `${events}\n`, "utf-8");
	writeJson(summaryPath, run.summary);
	writeJson(artifactsPath, artifacts);

	return { runDir, specPath, eventsPath, summaryPath, artifactsPath, artifacts };
}

export function appendPreflightReport(spec: ExperimentSpec, result: PreflightResult, cwd: string): PreflightRecordRefs {
	const reportId = nextPreflightId(spec.mode);
	const reportDir = join(cwd, ".pi", "experiment-runs", "preflights", reportId);
	const approvalsPath = join(cwd, ".pi", "experiment-runs", "approvals.jsonl");
	mkdirSync(reportDir, { recursive: true });
	mkdirSync(join(cwd, ".pi", "experiment-runs"), { recursive: true });

	const reportPath = join(reportDir, "preflight.json");
	const relativeReportDir = join(".pi", "experiment-runs", "preflights", reportId);
	const artifacts: ToolResult["artifacts"] = [
		{ uri: join(relativeReportDir, "preflight.json"), label: "Preflight report", kind: "preflight" },
		{ uri: join(".pi", "experiment-runs", "approvals.jsonl"), label: "Approval log", kind: "approvals" },
	];

	writeJson(reportPath, { reportId, spec, result });
	appendFileSync(
		approvalsPath,
		`${toJsonLine({
			type: "preflight_recorded",
			reportId,
			mode: spec.mode,
			hardwareApprovalRequired: spec.mode === "dry_run",
			specHash: hashExperimentSpec(spec),
		})}\n`,
		"utf-8",
	);

	return { reportId, reportDir, reportPath, approvalsPath, artifacts };
}

export interface HardwareGateResult {
	valid: boolean;
	issues: string[];
	dryRunReportPath?: string;
}

export function validateHardwareGate(spec: ExperimentSpec, approval: HardwarePilotParams["approval"], cwd: string): HardwareGateResult {
	const issues: string[] = [];
	if (!approval.approved) {
		issues.push("operator approval is not approved");
	}

	const reportPath = join(cwd, ".pi", "experiment-runs", "preflights", approval.dryRunReportId, "preflight.json");
	try {
		const parsed = JSON.parse(readFileSync(reportPath, "utf-8")) as { spec?: ExperimentSpec; result?: { valid?: boolean } };
		if (parsed.result?.valid !== true) {
			issues.push("referenced dry-run preflight did not pass");
		}
		if (!parsed.spec || hashExperimentSpec(parsed.spec) !== hashExperimentSpec(spec)) {
			issues.push("referenced dry-run preflight does not match the hardware ExperimentSpec");
		}
	} catch {
		issues.push("referenced dry-run preflight report was not found");
	}

	return { valid: issues.length === 0, issues, dryRunReportPath: reportPath };
}

export interface HardwareRunRecordRefs extends RunRecordRefs {
	approvalsPath: string;
	intentsPath: string;
}

export function createHardwareRunRecordPaths(cwd: string): { runId: string; runDir: string; eventsPath: string; intentsPath: string } {
	const runId = nextHardwareRunId();
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	return {
		runId,
		runDir,
		eventsPath: join(runDir, "events.jsonl"),
		intentsPath: join(runDir, "intents.jsonl"),
	};
}

export function appendHardwareRunRecords(
	run: HardwareRun,
	pilot: HardwarePilotParams,
	paths: { runDir: string; eventsPath: string; intentsPath: string },
): HardwareRunRecordRefs {
	const specPath = join(paths.runDir, "spec.json");
	const summaryPath = join(paths.runDir, "summary.json");
	const artifactsPath = join(paths.runDir, "artifacts.json");
	const approvalsPath = join(paths.runDir, "approvals.jsonl");
	const relativeRunDir = join(".pi", "experiment-runs", "runs", run.runId);
	const artifacts: ToolResult["artifacts"] = [
		{ uri: join(relativeRunDir, "spec.json"), label: "ExperimentSpec", kind: "spec" },
		{ uri: join(relativeRunDir, "events.jsonl"), label: "Hardware point events", kind: "events" },
		{ uri: join(relativeRunDir, "intents.jsonl"), label: "Operator intents", kind: "intents" },
		{ uri: join(relativeRunDir, "summary.json"), label: "Hardware summary", kind: "summary" },
		{ uri: join(relativeRunDir, "approvals.jsonl"), label: "Hardware approval", kind: "approvals" },
		{ uri: join(relativeRunDir, "artifacts.json"), label: "Artifact index", kind: "artifacts" },
	];

	writeJson(specPath, run.spec);
	writeJson(summaryPath, run.summary);
	writeJson(artifactsPath, artifacts);
	appendFileSync(
		approvalsPath,
		`${toJsonLine({
			type: "hardware_approval_recorded",
			runId: run.runId,
			approval: pilot.approval,
			operatorOnlyMonitoring: pilot.approval.operatorOnlyMonitoring === true,
			specHash: hashExperimentSpec(run.spec),
		})}\n`,
		"utf-8",
	);

	return {
		runDir: paths.runDir,
		specPath,
		eventsPath: paths.eventsPath,
		summaryPath,
		artifactsPath,
		approvalsPath,
		intentsPath: paths.intentsPath,
		artifacts,
	};
}

export type OperatorIntentType = "pause" | "abort" | "request_operator";

export interface OperatorIntentRef {
	intentsPath: string;
	relativeIntentsPath: string;
}

export function appendOperatorIntent(
	runId: string,
	intent: OperatorIntentType,
	reason: string,
	cwd: string,
): OperatorIntentRef {
	const runDir = join(cwd, ".pi", "experiment-runs", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const intentsPath = join(runDir, "intents.jsonl");
	const relativeIntentsPath = join(".pi", "experiment-runs", "runs", runId, "intents.jsonl");
	appendFileSync(intentsPath, `${toJsonLine({ type: intent, intent, runId, reason })}\n`, "utf-8");
	return { intentsPath, relativeIntentsPath };
}

export function readRecordedSummary(runId: string, cwd: string): SimulationSummary | undefined {
	try {
		const raw = readFileSync(join(cwd, ".pi", "experiment-runs", "runs", runId, "summary.json"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		return parsed as SimulationSummary;
	} catch {
		return undefined;
	}
}
