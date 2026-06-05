import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXPERIMENT_RESEARCH_PROMPT } from "./prompt.ts";
import type { ToolResult } from "./schemas.ts";
import { analyzeRunTool } from "./tools/analyze-run.ts";
import { getLabStateTool } from "./tools/lab-state.ts";
import { planNextExperimentTool } from "./tools/plan-next.ts";
import { runPreflightTool } from "./tools/preflight.ts";
import { runExperimentTool } from "./tools/run-experiment.ts";
import { validateExperimentSpecTool } from "./tools/validate-spec.ts";

const PLANNER_TOOL_NAMES = [
	"get_lab_state",
	"validate_experiment_spec",
	"run_preflight",
	"run_experiment",
	"analyze_run",
	"plan_next_experiment",
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

export default function experimentResearchExtension(pi: ExtensionAPI) {
	pi.registerTool(getLabStateTool);
	pi.registerTool(validateExperimentSpecTool);
	pi.registerTool(runPreflightTool);
	pi.registerTool(runExperimentTool);
	pi.registerTool(analyzeRunTool);
	pi.registerTool(planNextExperimentTool);

	pi.on("session_start", () => {
		const activeTools = new Set(pi.getActiveTools());
		for (const toolName of PLANNER_TOOL_NAMES) {
			activeTools.add(toolName);
		}
		pi.setActiveTools([...activeTools]);
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
			if (mode !== undefined && mode !== "simulation") {
				return { block: true, reason: "run_experiment only accepts simulation mode in this extension." };
			}
		}
	});

	pi.on("tool_result", (event) => {
		if (!PLANNER_TOOL_NAMES.includes(event.toolName)) return;
		if (!isExperimentToolResult(event.details)) return;

		if (event.toolName === "run_experiment" && event.details.status === "success") {
			pi.sendMessage({
				customType: "experiment-run-summary",
				content: event.details.summary,
				display: true,
				details: event.details.stateAfter,
			});
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
