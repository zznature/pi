import type { ToolResult, ValidationIssue } from "./schemas.ts";

export function createSuccessResult(
	commandId: string,
	summary: string,
	stateAfter: unknown,
	nextActions: string[],
	artifacts: ToolResult["artifacts"] = [],
	runId?: string,
): ToolResult {
	return {
		status: "success",
		summary,
		nextActions,
		artifacts,
		runId,
		commandId,
		stateBefore: null,
		stateAfter,
		stopConditionMet: false,
	};
}

export function createErrorResult(
	commandId: string,
	summary: string,
	errorCode: string,
	nextActions: string[],
	stateAfter: unknown,
	retrySafe: boolean,
): ToolResult {
	return {
		status: "error",
		summary,
		nextActions,
		artifacts: [],
		commandId,
		stateBefore: null,
		stateAfter,
		errorCode,
		retrySafe,
		stopConditionMet: false,
	};
}

export function issuesState(issues: ValidationIssue[]): { valid: false; issues: ValidationIssue[] } {
	return { valid: false, issues };
}
