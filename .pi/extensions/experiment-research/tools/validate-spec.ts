import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type ToolResult,
	ValidateExperimentSpecParamsSchema,
	type ValidateExperimentSpecParams,
	validateExperimentSpec,
} from "../schemas.ts";

function createSuccessResult(): ToolResult {
	return {
		status: "success",
		summary: "ExperimentSpec is valid for Phase 0 schema checks.",
		nextActions: ["Run preflight after Phase 1 adds execution support."],
		artifacts: [],
		commandId: "phase0-validate-experiment-spec",
		stateBefore: null,
		stateAfter: { valid: true },
		stopConditionMet: false,
	};
}

function createErrorResult(params: ValidateExperimentSpecParams): ToolResult {
	const validation = validateExperimentSpec(params.spec);
	const issues = validation.valid ? [] : validation.issues;
	return {
		status: "error",
		summary: `ExperimentSpec failed validation with ${issues.length} issue(s).`,
		nextActions: [
			"Fix the reported schema issues.",
			"Provide exactly one of grid or points.",
			"Call validate_experiment_spec again before any run.",
		],
		artifacts: [],
		commandId: "phase0-validate-experiment-spec",
		stateBefore: null,
		stateAfter: { valid: false, issues },
		errorCode: "invalid_experiment_spec",
		retrySafe: true,
		stopConditionMet: false,
	};
}

export const validateExperimentSpecTool = {
	name: "validate_experiment_spec",
	label: "Validate Experiment Spec",
	description: "Validate an ExperimentSpec candidate against the Phase 0 schema.",
	promptSnippet: "Validate a candidate ExperimentSpec without touching hardware",
	promptGuidelines: [
		"Use validate_experiment_spec before proposing any experiment run.",
		"Do not call hardware or execution tools when validate_experiment_spec returns an error.",
	],
	parameters: ValidateExperimentSpecParamsSchema,
	async execute(_toolCallId, params) {
		const validation = validateExperimentSpec(params.spec);
		const result = validation.valid ? createSuccessResult() : createErrorResult(params);
		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	},
} satisfies ToolDefinition<typeof ValidateExperimentSpecParamsSchema, ToolResult>;
