import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	readRecordedSpec,
	readResumeSnapshot,
	writeResumeSnapshot,
	type ResumeSnapshot,
	type SnapshotHardwareReconcile,
	type SnapshotStagePosition,
	type RunStatus,
} from "../../run-store.ts";
import type { ExperimentSpec, ToolResult } from "../../schemas.ts";
import { getUnitCount } from "../../spec-utils.ts";

export type RamanV2ReconcileDecision = "resume" | "pause" | "abort";

export type RamanV2Microstep =
	| "run_started"
	| "unit_started"
	| "stage_move_commanded"
	| "stage_position_confirmed"
	| "autofocus_frame_captured"
	| "autofocus_checkpoint"
	| "xy_correction_checkpoint"
	| "thermal_target_set"
	| "thermal_stable"
	| "acquisition_started"
	| "acquisition_poll"
	| "acquisition_completed"
	| "artifact_collected"
	| "unit_completed"
	| "recovery_required";

export interface RamanV2MicrostepSnapshotInput {
	spec: ExperimentSpec;
	runId: string;
	status: RunStatus | string;
	completedUnits: number;
	unitIndex: number;
	nextUnitIndex?: number;
	microstep: RamanV2Microstep;
	commandId: string;
	lastKnownStagePosition?: SnapshotStagePosition;
	pendingAcquisitionId?: string;
	artifactRefs?: ToolResult["artifacts"];
	nextPlan?: string[];
	safeToResume?: boolean;
	requiresOperatorApproval?: boolean;
	reason?: string;
}

export interface RamanV2AcquisitionProbeResult {
	status: string;
	[key: string]: unknown;
}

export interface RamanV2HardwareReconcileProbe {
	getStagePosition?: () => Promise<SnapshotStagePosition> | SnapshotStagePosition;
	pollAcquisition?: (acquisitionId: string) => Promise<RamanV2AcquisitionProbeResult> | RamanV2AcquisitionProbeResult;
	artifactExists?: (artifact: ToolResult["artifacts"][number]) => Promise<boolean> | boolean;
	stagePositionToleranceUm?: number;
}

export interface RamanV2HardwareReconcileResult {
	decision: RamanV2ReconcileDecision;
	reason: string;
	safeToResume: boolean;
	checks: Record<string, unknown>;
	snapshot?: ResumeSnapshot;
}

function nowIso(): string {
	return new Date().toISOString();
}

function withOptionalSnapshotFields(snapshot: ResumeSnapshot, input: RamanV2MicrostepSnapshotInput): ResumeSnapshot {
	const next = { ...snapshot };
	if (input.lastKnownStagePosition) next.lastKnownStagePosition = input.lastKnownStagePosition;
	if (input.pendingAcquisitionId) next.pendingAcquisitionId = input.pendingAcquisitionId;
	if (input.artifactRefs) next.artifactRefs = input.artifactRefs;
	if (input.nextPlan) next.nextPlan = input.nextPlan;
	if (input.reason) next.reason = input.reason;
	return next;
}

export function buildRamanV2MicrostepSnapshot(input: RamanV2MicrostepSnapshotInput): ResumeSnapshot {
	const totalUnits = getUnitCount(input.spec);
	const nextUnitIndex = input.nextUnitIndex ?? input.unitIndex;
	const snapshot: ResumeSnapshot = {
		schemaVersion: "1",
		runId: input.runId,
		experimentId: input.spec.experimentId,
		mode: input.spec.mode,
		status: input.status,
		completedUnits: input.completedUnits,
		totalUnits,
		unitKind: "point",
		unitIndex: input.unitIndex,
		microstep: input.microstep,
		commandId: input.commandId,
		nextUnitIndex,
		safeToResume: input.safeToResume === true,
		requiresOperatorApproval: input.requiresOperatorApproval ?? (input.spec.mode === "hardware" && input.status !== "completed"),
		createdAt: nowIso(),
	};
	if (nextUnitIndex < totalUnits) {
		snapshot.resumeFrom = String(nextUnitIndex);
	}
	return withOptionalSnapshotFields(snapshot, input);
}

export function writeRamanV2MicrostepSnapshot(cwd: string, input: RamanV2MicrostepSnapshotInput): string {
	return writeResumeSnapshot(cwd, input.runId, buildRamanV2MicrostepSnapshot(input));
}

function maxPositionDelta(expected: SnapshotStagePosition, actual: SnapshotStagePosition): number {
	return Math.max(Math.abs(expected.xUm - actual.xUm), Math.abs(expected.yUm - actual.yUm), Math.abs(expected.zUm - actual.zUm));
}

function artifactPath(cwd: string, artifact: ToolResult["artifacts"][number]): string {
	if (isAbsolute(artifact.uri)) return artifact.uri;
	return join(cwd, artifact.uri);
}

async function artifactExists(cwd: string, artifact: ToolResult["artifacts"][number], probe: RamanV2HardwareReconcileProbe): Promise<boolean> {
	if (probe.artifactExists) {
		return probe.artifactExists(artifact);
	}
	return existsSync(artifactPath(cwd, artifact));
}

function acquisitionDecision(status: string): RamanV2ReconcileDecision | undefined {
	if (status === "cancelled" || status === "failed" || status === "error") return "abort";
	if (status === "running" || status === "completed" || status === "collected") return undefined;
	return "pause";
}

function persistReconcileResult(
	cwd: string,
	snapshot: ResumeSnapshot,
	result: RamanV2HardwareReconcileResult,
): ResumeSnapshot {
	const hardwareReconcile: SnapshotHardwareReconcile = {
		decision: result.decision,
		reason: result.reason,
		checkedAt: nowIso(),
		checks: result.checks,
	};
	const next: ResumeSnapshot = {
		...snapshot,
		safeToResume: result.decision === "resume" && snapshot.safeToResume,
		requiresOperatorApproval: result.decision !== "resume" || snapshot.requiresOperatorApproval,
		hardwareReconcile,
	};
	if (result.decision !== "resume") {
		next.reason = result.reason;
	}
	writeResumeSnapshot(cwd, snapshot.runId, next);
	return next;
}

function result(
	decision: RamanV2ReconcileDecision,
	reason: string,
	checks: Record<string, unknown>,
	snapshot: ResumeSnapshot,
): RamanV2HardwareReconcileResult {
	return {
		decision,
		reason,
		safeToResume: decision === "resume",
		checks,
		snapshot,
	};
}

export async function reconcileRamanV2Hardware(
	cwd: string,
	runId: string,
	probe: RamanV2HardwareReconcileProbe = {},
): Promise<RamanV2HardwareReconcileResult> {
	const snapshot = readResumeSnapshot(cwd, runId);
	if (!snapshot) {
		return {
			decision: "pause",
			reason: "resume snapshot is missing",
			safeToResume: false,
			checks: { snapshot: "missing" },
		};
	}
	const spec = readRecordedSpec(cwd, runId);
	const checks: Record<string, unknown> = {
		snapshot: {
			status: snapshot.status,
			unitIndex: snapshot.unitIndex,
			microstep: snapshot.microstep,
			safeToResume: snapshot.safeToResume,
		},
	};
	if (!spec) {
		const paused = result("pause", "recorded ExperimentSpec is missing", checks, snapshot);
		paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
		return paused;
	}
	if (snapshot.safeToResume !== true) {
		const paused = result("pause", "snapshot is not marked safeToResume", checks, snapshot);
		paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
		return paused;
	}
	if (snapshot.lastKnownStagePosition) {
		if (!probe.getStagePosition) {
			const paused = result("pause", "stage position cannot be reconciled", checks, snapshot);
			paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
			return paused;
		}
		const actual = await probe.getStagePosition();
		const toleranceUm = probe.stagePositionToleranceUm ?? 0.5;
		const deltaUm = maxPositionDelta(snapshot.lastKnownStagePosition, actual);
		checks.stage = { expected: snapshot.lastKnownStagePosition, actual, deltaUm, toleranceUm };
		if (deltaUm > toleranceUm) {
			const paused = result("pause", "stage position does not match the last confirmed snapshot position", checks, snapshot);
			paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
			return paused;
		}
	}
	if (snapshot.pendingAcquisitionId) {
		if (!probe.pollAcquisition) {
			const paused = result("pause", "pending acquisition cannot be reconciled", checks, snapshot);
			paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
			return paused;
		}
		const acquisition = await probe.pollAcquisition(snapshot.pendingAcquisitionId);
		const decision = acquisitionDecision(acquisition.status);
		checks.acquisition = { acquisitionId: snapshot.pendingAcquisitionId, ...acquisition };
		if (decision === "abort") {
			const aborted = result("abort", `pending acquisition is ${acquisition.status}`, checks, snapshot);
			aborted.snapshot = persistReconcileResult(cwd, snapshot, aborted);
			return aborted;
		}
		if (decision === "pause") {
			const paused = result("pause", `pending acquisition status is unknown: ${acquisition.status}`, checks, snapshot);
			paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
			return paused;
		}
	}
	if (snapshot.artifactRefs && snapshot.artifactRefs.length > 0) {
		const missing: string[] = [];
		for (const artifact of snapshot.artifactRefs) {
			if (!(await artifactExists(cwd, artifact, probe))) {
				missing.push(artifact.uri);
			}
		}
		checks.artifacts = { checked: snapshot.artifactRefs.map((artifact) => artifact.uri), missing };
		if (missing.length > 0) {
			const paused = result("pause", "required artifact references are missing", checks, snapshot);
			paused.snapshot = persistReconcileResult(cwd, snapshot, paused);
			return paused;
		}
	}
	const resumed = result("resume", "snapshot and hardware state reconciled", checks, snapshot);
	resumed.snapshot = persistReconcileResult(cwd, snapshot, resumed);
	return resumed;
}
