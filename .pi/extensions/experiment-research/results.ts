import type { ErrorCode, ToolResult, ValidationIssue } from "./schemas.ts";

export function createSuccessResult(
	commandId: string,
	summary: string,
	stateAfter: unknown,
	nextActions: string[],
	artifacts: ToolResult["artifacts"] = [],
	runId?: string,
	experimentId?: string,
): ToolResult {
	return {
		status: "success",
		summary,
		nextActions,
		artifacts,
		experimentId,
		runId,
		commandId,
		correlationId: commandId,
		stateAfter,
		stopConditionMet: false,
	};
}

export function createErrorResult(
	commandId: string,
	summary: string,
	errorCode: ErrorCode,
	nextActions: string[],
	stateAfter: unknown,
	retrySafe: boolean,
	experimentId?: string,
): ToolResult {
	return {
		status: "error",
		summary,
		nextActions,
		artifacts: [],
		commandId,
		correlationId: commandId,
		experimentId,
		stateAfter,
		errorCode,
		retrySafe,
		stopConditionMet: false,
	};
}

export function issuesState(issues: ValidationIssue[]): { valid: false; issues: ValidationIssue[] } {
	return { valid: false, issues };
}
