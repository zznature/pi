import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXPERIMENT_RESEARCH_PROMPT } from "./prompt.ts";
import { ramanGetHardwareStatusTool, ramanGetStagePositionTool, ramanStageMoveRelativeTool } from "./tools/operator.ts";
import { getLabCapabilitiesTool, getLabStateTool, runPreflightTool, validateProcedureSpecTool } from "./tools/planner.ts";
import { abortRunTool, approveAndStartRunTool, pauseRunTool, pollRunTool, proposeRunTool, runProcedureTool } from "./tools/runtime.ts";
import { registerConfiguredRamanPythonRuntime } from "./runtime/raman/index.ts";

const PLANNER_TOOL_NAMES = [
	"get_lab_capabilities",
	"get_lab_state",
	"validate_procedure_spec",
	"run_preflight",
	"propose_run",
	"approve_and_start_run",
	"poll_run",
	"pause_run",
	"abort_run",
	"raman_get_hardware_status",
	"raman_get_stage_position",
	"raman_stage_move_relative",
];

export default function experimentResearchExtension(pi: ExtensionAPI) {
	pi.registerTool(getLabCapabilitiesTool);
	pi.registerTool(getLabStateTool);
	pi.registerTool(validateProcedureSpecTool);
	pi.registerTool(runPreflightTool);
	pi.registerTool(ramanGetHardwareStatusTool);
	pi.registerTool(ramanGetStagePositionTool);
	pi.registerTool(ramanStageMoveRelativeTool);
	pi.registerTool(proposeRunTool);
	pi.registerTool(approveAndStartRunTool);
	pi.registerTool(runProcedureTool);
	pi.registerTool(pollRunTool);
	pi.registerTool(pauseRunTool);
	pi.registerTool(abortRunTool);

	pi.on("session_start", (_event, ctx) => {
		if (ctx?.cwd) {
			registerConfiguredRamanPythonRuntime(ctx.cwd);
		}
		const activeTools = new Set(pi.getActiveTools());
		for (const toolName of PLANNER_TOOL_NAMES) {
			activeTools.add(toolName);
		}
		pi.setActiveTools([...activeTools]);
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${EXPERIMENT_RESEARCH_PROMPT}`,
	}));
}
