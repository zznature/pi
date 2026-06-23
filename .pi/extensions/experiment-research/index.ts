import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildExperimentCompactionSummary } from "./compaction.ts";
import { subscribeRamanHardwareRunTerminal, type RamanHardwareRunTerminalEvent } from "./kernel/raman-hardware.ts";
import { EXPERIMENT_RESEARCH_PROMPT } from "./prompt.ts";
import type { ToolResult } from "./schemas.ts";
import { analyzeRunTool } from "./tools/analyze-run.ts";
import { getExperimentStateTool } from "./tools/experiment-state.ts";
import { recordHardwareCoordinateAuditTool } from "./tools/hardware-coordinate-audit.ts";
import { getLabCapabilitiesTool, getLabStateTool } from "./tools/lab-state.ts";
import { advanceRunTool, pollRunTool, startRunTool } from "./tools/lifecycle.ts";
import { abortRunTool, pauseRunTool, requestOperatorTool } from "./tools/operator.ts";
import { planNextExperimentTool } from "./tools/plan-next.ts";
import { runPreflightTool } from "./tools/preflight.ts";
import { ramanActiveProbeTool } from "./tools/raman-active-probe.ts";
import { ramanAutoXyCalibrationTool, ramanFitXyCalibrationTool, ramanRecordXyCalibrationTool } from "./tools/raman-calibration.ts";
import {
	ramanHardwareValidationDraftTool,
	ramanHardwareValidationReadinessTool,
	ramanHardwareValidationTool,
	ramanValidationSpecPairTool,
} from "./tools/raman-validation.ts";
import { runExperimentTool } from "./tools/run-experiment.ts";
import { validateExperimentSpecTool } from "./tools/validate-spec.ts";

const PLANNER_TOOL_NAMES = [
	"get_lab_capabilities",
	"get_lab_state",
	"get_experiment_state",
	"validate_experiment_spec",
	"run_preflight",
	"run_experiment",
	"start_run",
	"advance_run",
	"analyze_run",
	"plan_next_experiment",
];

// Operator/watchdog tools are registered so they can be invoked out-of-band, but
// are intentionally kept out of the planner default active set per the design.
const OPERATOR_TOOL_NAMES = [
	"pause_run",
	"abort_run",
	"poll_run",
	"request_operator",
	"record_hardware_coordinate_audit",
	"raman_active_probe",
	"raman_record_xy_calibration",
	"raman_fit_xy_calibration",
	"raman_auto_xy_calibration",
	"raman_prepare_hardware_validation_payload",
	"raman_record_hardware_validation",
	"raman_check_hardware_validation",
	"raman_prepare_validation_spec_pair",
];

const LOW_LEVEL_TOOL_NAMES = new Set(["move_relative", "move_z", "snap_image", "serial_send", "set_laser_power"]);

function getSpecMode(input: Record<string, unknown>): string | undefined {
	const spec = input.spec;
	if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return undefined;
	const mode = (spec as Record<string, unknown>).mode;
	return typeof mode === "string" ? mode : undefined;
}

function isExperimentToolResult(value: unknown): value is ToolResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.status === "string" &&
		Array.isArray(record.nextActions) &&
		typeof record.summary === "string" &&
		typeof record.commandId === "string"
	);
}

function isRunningRunResult(details: ToolResult): boolean {
	if (typeof details.stateAfter !== "object" || details.stateAfter === null || Array.isArray(details.stateAfter)) return false;
	const runState = (details.stateAfter as Record<string, unknown>).runState;
	if (typeof runState !== "object" || runState === null || Array.isArray(runState)) return false;
	return (runState as Record<string, unknown>).status === "running";
}

function terminalNextActions(event: RamanHardwareRunTerminalEvent): string[] {
	switch (event.status) {
		case "completed":
			return [`Call analyze_run with runId ${event.runId}.`, "Then call plan_next_experiment before compiling a follow-up spec."];
		case "paused":
			return [
				`Run ${event.runId} paused at a safe boundary.`,
				"Inspect resume.snapshot.json and require operator approval before resume.",
			];
		case "aborted":
			return [`Run ${event.runId} was aborted.`, "Review events.jsonl and summary.json before any new bounded run."];
		case "failed":
			return [`Run ${event.runId} failed.`, "Inspect events.jsonl, bridge stderr events, and resume.snapshot.json before retrying."];
	}
}

function formatTerminalRunMessage(event: RamanHardwareRunTerminalEvent): string {
	const progress = event.summary.progress;
	const stopReason = event.summary.stopReason ? ` Stop reason: ${event.summary.stopReason}.` : "";
	return [
		`Raman hardware run ${event.runId} reached ${event.status}: ${progress.completedUnits}/${progress.totalUnits} ${progress.unitKind}(s).${stopReason}`,
		"",
		...terminalNextActions(event),
	].join("\n");
}

export default function experimentResearchExtension(pi: ExtensionAPI) {
	let terminalWatcherActive = true;
	const unsubscribeRamanTerminal = subscribeRamanHardwareRunTerminal((event) => {
		if (!terminalWatcherActive) return;
		try {
			pi.sendMessage(
				{
					customType: "experiment-run-terminal",
					content: formatTerminalRunMessage(event),
					display: true,
					details: event,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// Stale extension instances can occur during session replacement; session_shutdown clears the watcher.
		}
	});

	pi.registerTool(getLabStateTool);
	pi.registerTool(getLabCapabilitiesTool);
	pi.registerTool(getExperimentStateTool);
	pi.registerTool(validateExperimentSpecTool);
	pi.registerTool(runPreflightTool);
	pi.registerTool(runExperimentTool);
	pi.registerTool(startRunTool);
	pi.registerTool(advanceRunTool);
	pi.registerTool(pollRunTool);
	pi.registerTool(analyzeRunTool);
	pi.registerTool(planNextExperimentTool);
	pi.registerTool(pauseRunTool);
	pi.registerTool(abortRunTool);
	pi.registerTool(requestOperatorTool);
	pi.registerTool(recordHardwareCoordinateAuditTool);
	pi.registerTool(ramanActiveProbeTool);
	pi.registerTool(ramanRecordXyCalibrationTool);
	pi.registerTool(ramanFitXyCalibrationTool);
	pi.registerTool(ramanAutoXyCalibrationTool);
	pi.registerTool(ramanHardwareValidationDraftTool);
	pi.registerTool(ramanHardwareValidationTool);
	pi.registerTool(ramanHardwareValidationReadinessTool);
	pi.registerTool(ramanValidationSpecPairTool);

	pi.on("session_start", () => {
		const activeTools = new Set(pi.getActiveTools());
		for (const toolName of PLANNER_TOOL_NAMES) {
			activeTools.add(toolName);
		}
		// Operator/watchdog tools stay out of the planner default active set.
		for (const toolName of OPERATOR_TOOL_NAMES) {
			activeTools.delete(toolName);
		}
		pi.setActiveTools([...activeTools]);
	});

	pi.on("session_before_compact", (event, ctx) => {
		const checkpoint = buildExperimentCompactionSummary(ctx.cwd, event.preparation.previousSummary);
		if (!checkpoint) return;
		return {
			compaction: {
				summary: checkpoint.summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: checkpoint.details,
			},
		};
	});

	pi.on("session_shutdown", () => {
		terminalWatcherActive = false;
		unsubscribeRamanTerminal();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${EXPERIMENT_RESEARCH_PROMPT}`,
	}));

	pi.on("tool_call", (event) => {
		if (LOW_LEVEL_TOOL_NAMES.has(event.toolName)) {
			return { block: true, reason: "Experiment planner cannot call low-level hardware tools." };
		}

		if (event.toolName === "run_experiment") {
			const mode = getSpecMode(event.input);
			if (mode !== undefined && mode !== "simulation" && mode !== "hardware") {
				return { block: true, reason: "run_experiment accepts simulation or approved hardware mode only." };
			}
		}

		if (event.toolName === "start_run") {
			const mode = getSpecMode(event.input);
			if (mode !== undefined && mode !== "simulation") {
				return { block: true, reason: "start_run accepts simulation specs only; use run_experiment for approved hardware execution." };
			}
		}
	});

	pi.on("tool_result", (event) => {
		const isPlannerTool = PLANNER_TOOL_NAMES.includes(event.toolName);
		const isOperatorTool = OPERATOR_TOOL_NAMES.includes(event.toolName);
		if (!isPlannerTool && !isOperatorTool) return;
		if (!isExperimentToolResult(event.details)) return;

		if (event.toolName === "run_experiment" && event.details.status === "success") {
			pi.sendMessage(
				{
					customType: "experiment-run-summary",
					content: event.details.summary,
					display: true,
					details: event.details.stateAfter,
				},
				{ triggerTurn: !isRunningRunResult(event.details), deliverAs: "followUp" },
			);
		}

		if (event.details.status !== "error") return;

		const recovery = `Recovery: ${event.details.nextActions.join(" ")}`;
		return {
			content: [...event.content, { type: "text" as const, text: recovery }],
			details: {
				...event.details,
				recovery: {
					errorCode: event.details.errorCode,
					retrySafe: event.details.retrySafe,
					nextActions: event.details.nextActions,
				},
			},
		};
	});
}
