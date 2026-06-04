import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXPERIMENT_RESEARCH_PROMPT } from "./prompt.ts";
import { getLabStateTool } from "./tools/lab-state.ts";
import { validateExperimentSpecTool } from "./tools/validate-spec.ts";

export default function experimentResearchExtension(pi: ExtensionAPI) {
	pi.registerTool(getLabStateTool);
	pi.registerTool(validateExperimentSpecTool);

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${EXPERIMENT_RESEARCH_PROMPT}`,
	}));
}
