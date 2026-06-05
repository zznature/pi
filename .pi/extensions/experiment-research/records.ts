import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimulationRun, SimulationSummary } from "./kernel/simulation.ts";
import type { PreflightResult } from "./preflight.ts";
import type { ExperimentSpec, ToolResult } from "./schemas.ts";

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
		})}\n`,
		"utf-8",
	);

	return { reportId, reportDir, reportPath, approvalsPath, artifacts };
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
