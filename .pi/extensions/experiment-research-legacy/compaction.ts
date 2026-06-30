import {
	listRunRecords,
	readRecordedApprovals,
	readRecordedArtifacts,
	readRecordedAnalysis,
	readResumeSnapshot,
	type RecordedApproval,
	type ResumeSnapshot,
	type RunRecord,
} from "./run-store.ts";

export interface ExperimentCompactionDetails {
	source: "experiment-research";
	runCount: number;
	activeRunIds: string[];
	recentRunIds: string[];
}

export interface ExperimentCompactionSummary {
	summary: string;
	details: ExperimentCompactionDetails;
}

const MAX_COMPACTED_RUNS = 8;

function isActiveRun(record: RunRecord): boolean {
	return record.status === "running" || record.status === "paused" || record.status === "recovering";
}

function latestApprovalId(approvals: RecordedApproval[]): string | undefined {
	for (const approval of approvals.slice().reverse()) {
		if (approval.approval?.approvalId) return approval.approval.approvalId;
	}
	return undefined;
}

function latestDryRunReportId(approvals: RecordedApproval[]): string | undefined {
	for (const approval of approvals.slice().reverse()) {
		if (approval.approval?.dryRunReportId) return approval.approval.dryRunReportId;
	}
	return undefined;
}

function formatResume(snapshot: ResumeSnapshot | undefined): string {
	if (!snapshot) return "resumeSnapshot=missing";
	return [
		`resumeStatus=${snapshot.status}`,
		`progress=${snapshot.completedUnits}/${snapshot.totalUnits}`,
		`nextUnitIndex=${snapshot.nextUnitIndex}`,
		`safeToResume=${snapshot.safeToResume}`,
		snapshot.resumeFrom ? `resumeFrom=${snapshot.resumeFrom}` : undefined,
		snapshot.reason ? `reason=${snapshot.reason}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(", ");
}

function hasRecordedAnalysis(cwd: string, runId: string): boolean {
	try {
		return readRecordedAnalysis(cwd, runId) !== undefined;
	} catch {
		return false;
	}
}

function artifactCount(cwd: string, runId: string): number {
	try {
		return readRecordedArtifacts(cwd, runId).length;
	} catch {
		return 0;
	}
}

function runLine(cwd: string, record: RunRecord): string {
	let approvals: RecordedApproval[] = [];
	let snapshot: ResumeSnapshot | undefined;
	try {
		approvals = readRecordedApprovals(cwd, record.runId);
	} catch {
		approvals = [];
	}
	try {
		snapshot = readResumeSnapshot(cwd, record.runId);
	} catch {
		snapshot = undefined;
	}
	const approvalId = latestApprovalId(approvals);
	const dryRunReportId = latestDryRunReportId(approvals);
	const parts = [
		`runId=${record.runId}`,
		`experimentId=${record.experimentId}`,
		`mode=${record.mode}`,
		`status=${record.status}`,
		`specId=${record.specId}`,
		`specHash=${record.specHash}`,
		approvalId ? `approvalId=${approvalId}` : undefined,
		dryRunReportId ? `dryRunReportId=${dryRunReportId}` : undefined,
		formatResume(snapshot),
		`artifacts=${artifactCount(cwd, record.runId)}`,
		`analysisRecorded=${hasRecordedAnalysis(cwd, record.runId)}`,
	]
		.filter((part): part is string => part !== undefined)
		.join("; ");
	return `- ${parts}`;
}

export function buildExperimentCompactionSummary(cwd: string, previousSummary: string | undefined): ExperimentCompactionSummary | undefined {
	const records = listRunRecords(cwd);
	if (records.length === 0 && !previousSummary) return undefined;

	const recentRuns = records.slice(-MAX_COMPACTED_RUNS);
	const activeRuns = records.filter(isActiveRun);
	const lines: string[] = [
		"## Experiment Research Checkpoint",
		"",
		"Disk records under `.pi/experiment-runs` remain the source of truth. Use exact ids below when resuming analysis, recovery, or replanning.",
	];
	if (previousSummary) {
		lines.push("", "## Previous Conversation Summary", previousSummary);
	}
	if (activeRuns.length > 0) {
		lines.push("", "## Active Runs", ...activeRuns.map((record) => runLine(cwd, record)));
	}
	if (recentRuns.length > 0) {
		lines.push("", "## Recent Run Registry", ...recentRuns.map((record) => runLine(cwd, record)));
	}
	lines.push("", "## Continuation Rules");
	lines.push("- Do not infer experiment state from natural-language chat; call get_experiment_state or read recorded artifacts when precise state is needed.");
	lines.push("- For terminal hardware runs, analyze the returned runId before planning the next bounded ExperimentSpec.");
	lines.push("- For paused/recovering runs, inspect resume.snapshot.json and require operator approval before resuming hardware.");

	return {
		summary: lines.join("\n"),
		details: {
			source: "experiment-research",
			runCount: records.length,
			activeRunIds: activeRuns.map((record) => record.runId),
			recentRunIds: recentRuns.map((record) => record.runId),
		},
	};
}
