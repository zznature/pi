import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { STATIC_CAPABILITIES, type Capabilities } from "../capabilities.ts";
import { EmptyParamsSchema, type ToolResult } from "../schemas.ts";

export interface LabState {
	mode: "simulation";
	capabilities: Capabilities;
	activeRunId: null;
	dryRunAvailable: false;
	hardwareAvailable: false;
	notes: string[];
}

export function getLabState(): LabState {
	return {
		mode: "simulation",
		capabilities: STATIC_CAPABILITIES,
		activeRunId: null,
		dryRunAvailable: false,
		hardwareAvailable: false,
		notes: [
			"Phase 0 exposes schema validation and static simulation capabilities only.",
			"No kernel, dry run, records, watchdog, or hardware adapter is connected.",
		],
	};
}

function createLabStateResult(state: LabState): ToolResult {
	return {
		status: "success",
		summary: "Static Phase 0 lab state loaded. Only simulation capabilities are available.",
		nextActions: ["Draft an ExperimentSpec in simulation mode.", "Call validate_experiment_spec before any run."],
		artifacts: [],
		commandId: "phase0-get-lab-state",
		stateBefore: null,
		stateAfter: state,
		stopConditionMet: false,
	};
}

export const getLabStateTool = {
	name: "get_lab_state",
	label: "Get Lab State",
	description: "Return static Phase 0 lab state and simulated instrument capabilities.",
	promptSnippet: "Inspect static Phase 0 lab state and simulated capabilities",
	promptGuidelines: [
		"Use get_lab_state before planning an experiment when current lab capabilities or mode matter.",
	],
	parameters: EmptyParamsSchema,
	async execute() {
		const result = createLabStateResult(getLabState());
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof EmptyParamsSchema, ToolResult>;
