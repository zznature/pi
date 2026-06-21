import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capabilities } from "./capabilities.ts";
import type { ExperimentSpec, ToolResult } from "./schemas.ts";

export type RunStatus = "queued" | "running" | "paused" | "aborted" | "completed" | "failed" | "recovering";

export class ActiveRunConflictError extends Error {
	runId: string;
	status: RunStatus;
	constructor(runId: string, status: RunStatus) {
		super(`Another run is active: ${runId} (${status})`);
		this.name = "ActiveRunConflictError";
		this.runId = runId;
		this.status = status;
	}
}

export interface ExperimentRecord {
	experimentId: string;
	experimentType: ExperimentSpec["experimentType"];
	objective: string;
	subject: ExperimentSpec["subject"];
	status: "active" | "completed" | "failed";
	rootRunIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface RunRecord {
	runId: string;
	experimentId: string;
	mode: ExperimentSpec["mode"];
	specId: string;
	specHash: string;
	status: RunStatus;
	resourceLeaseId?: string;
	recordPaths: {
		runDir: string;
		runJson: string;
		spec: string;
		preflight: string;
		capabilitiesSnapshot: string;
		events: string;
		intents: string;
		summary: string;
		analysis: string;
		resumeSnapshot: string;
		artifacts: string;
		approvals: string;
		leases: string;
	};
	parentRunId?: string;
	startedAt?: string;
	finishedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface ResourceLease {
	leaseId: string;
	resourceIds: string[];
	mode: ExperimentSpec["mode"];
	runId: string;
	commandId: string;
	fencingToken: string;
	status: "active" | "released";
	createdAt: string;
	releasedAt?: string;
}

export interface ReservedRun {
	record: RunRecord;
	spec: ExperimentSpec;
	runDir: string;
	specHash: string;
	eventsPath: string;
	intentsPath: string;
	lease: ResourceLease;
}

export interface LineageEntry {
	parentRunId: string;
	strategy: string;
	inputArtifacts: string[];
	generatedSpecId?: string;
	reason: string;
	createdAt: string;
}

export interface DecisionAuditEntry {
	decisionId: string;
	commandId: string;
	parentRunId: string;
	strategy: string;
	rationale: string;
	inputArtifacts: string[];
	stopConditionMet: boolean;
	createdAt: string;
}

export interface RecordedEvent {
	schemaVersion?: string;
	sequence?: number;
	type?: string;
	experimentId?: string;
	runId?: string;
	correlationId?: string;
	timestamp?: string;
	unitKind?: string;
	unit?: unknown;
	summary?: unknown;
	status?: string;
	stopReason?: string;
}

export interface RecordedApproval {
	type?: string;
	runId?: string;
	approval?: {
		approvalId?: string;
		operator?: string;
		approved?: boolean;
		dryRunReportId?: string;
		operatorOnlyMonitoring?: boolean;
	};
	operatorOnlyMonitoring?: boolean;
	specHash?: string;
	raman?: boolean;
}

export interface SnapshotStagePosition {
	xUm: number;
	yUm: number;
	zUm: number;
}

export interface SnapshotHardwareReconcile {
	decision: "resume" | "pause" | "abort";
	reason: string;
	checkedAt: string;
	checks: Record<string, unknown>;
}

export interface ResumeSnapshot {
	schemaVersion: "1";
	runId: string;
	experimentId: string;
	mode: ExperimentSpec["mode"];
	status: RunStatus | string;
	completedUnits: number;
	totalUnits: number;
	unitKind: string;
	unitIndex?: number;
	microstep?: string;
	commandId?: string;
	nextUnitIndex: number;
	resumeFrom?: string;
	safeToResume: boolean;
	requiresOperatorApproval: boolean;
	intentWatermark?: number;
	lastKnownStagePosition?: SnapshotStagePosition;
	pendingAcquisitionId?: string;
	artifactRefs?: ToolResult["artifacts"];
	nextPlan?: string[];
	hardwareReconcile?: SnapshotHardwareReconcile;
	reason?: string;
	createdAt: string;
}

interface ArtifactIndexEntry {
	id?: string;
	uri: string;
	label: string;
	kind?: string;
	contentHash?: string;
	producerRunId?: string;
}

interface CommandIndexEntry {
	commandId: string;
	runId: string;
	specHash: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function storeRoot(cwd: string): string {
	return join(cwd, ".pi", "experiment-runs");
}

function experimentsRoot(cwd: string): string {
	return join(storeRoot(cwd), "experiments");
}

function runsRoot(cwd: string): string {
	return join(storeRoot(cwd), "runs");
}

function commandIndexPath(cwd: string): string {
	return join(storeRoot(cwd), "command-index.json");
}

function stableCanonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableCanonicalize(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const entries = keys.map((key) => `${JSON.stringify(key)}:${stableCanonicalize(record[key])}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(null);
}

function normalizeSpecForGate(spec: ExperimentSpec): unknown {
	return {
		...spec,
		mode: "hardware_gate",
		operatorApprovalRequired: true,
	};
}

export function hashExperimentSpec(spec: ExperimentSpec): string {
	return createHash("sha256").update(stableCanonicalize(normalizeSpecForGate(spec))).digest("hex");
}

function readCommandIndex(cwd: string): CommandIndexEntry[] {
	const path = commandIndexPath(cwd);
	if (!existsSync(path)) return [];
	const parsed = readJson(path);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is CommandIndexEntry => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
		const record = entry as Record<string, unknown>;
		return typeof record.commandId === "string" && typeof record.runId === "string" && typeof record.specHash === "string";
	});
}

function writeCommandIndex(cwd: string, entries: CommandIndexEntry[]): void {
	mkdirSync(storeRoot(cwd), { recursive: true });
	writeJson(commandIndexPath(cwd), entries);
}

function createRunId(mode: ExperimentSpec["mode"]): string {
	const prefix = mode === "hardware" ? "hw-run" : mode === "dry_run" ? "dry-run" : "sim-run";
	return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function artifactUriPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function relativeRunPath(runId: string, fileName: string): string {
	return artifactUriPath(join(".pi", "experiment-runs", "runs", runId, fileName));
}

function absoluteRunPath(cwd: string, runId: string, fileName: string): string {
	return join(runsRoot(cwd), runId, fileName);
}

function buildRecord(
	cwd: string,
	spec: ExperimentSpec,
	runId: string,
	specHash: string,
	leaseId: string,
	parentRunId: string | undefined,
): RunRecord {
	const runDir = join(runsRoot(cwd), runId);
	const createdAt = nowIso();
	const record: RunRecord = {
		runId,
		experimentId: spec.experimentId,
		mode: spec.mode,
		specId: spec.specId,
		specHash,
		status: "queued",
		resourceLeaseId: leaseId,
		recordPaths: {
			runDir,
			runJson: join(runDir, "run.json"),
			spec: join(runDir, "spec.json"),
			preflight: join(runDir, "preflight.json"),
			capabilitiesSnapshot: join(runDir, "capabilities.snapshot.json"),
			events: join(runDir, "events.jsonl"),
			intents: join(runDir, "intents.jsonl"),
			summary: join(runDir, "summary.json"),
			analysis: join(runDir, "analysis.json"),
			resumeSnapshot: join(runDir, "resume.snapshot.json"),
			artifacts: join(runDir, "artifacts.json"),
			approvals: join(runDir, "approvals.jsonl"),
			leases: join(runDir, "leases.jsonl"),
		},
		createdAt,
		updatedAt: createdAt,
	};
	if (parentRunId) {
		record.parentRunId = parentRunId;
	}
	return record;
}

function ensureExperimentRecord(cwd: string, spec: ExperimentSpec): void {
	const experimentDir = join(experimentsRoot(cwd), spec.experimentId);
	const experimentPath = join(experimentDir, "experiment.json");
	mkdirSync(experimentDir, { recursive: true });
	if (existsSync(experimentPath)) {
		const parsed = readJson(experimentPath);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const record = parsed as ExperimentRecord;
			writeJson(experimentPath, { ...record, updatedAt: nowIso() });
			return;
		}
	}
	const timestamp = nowIso();
	const record: ExperimentRecord = {
		experimentId: spec.experimentId,
		experimentType: spec.experimentType,
		objective: spec.objective,
		subject: spec.subject,
		status: "active",
		rootRunIds: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	writeJson(experimentPath, record);
}

function updateExperimentRoots(cwd: string, experimentId: string, runId: string, parentRunId: string | undefined): void {
	const experimentPath = join(experimentsRoot(cwd), experimentId, "experiment.json");
	if (!existsSync(experimentPath)) return;
	const parsed = readJson(experimentPath);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
	const record = parsed as ExperimentRecord;
	if (parentRunId) {
		writeJson(experimentPath, { ...record, updatedAt: nowIso() });
		return;
	}
	const rootRunIds = record.rootRunIds.includes(runId) ? record.rootRunIds : [...record.rootRunIds, runId];
	writeJson(experimentPath, { ...record, rootRunIds, updatedAt: nowIso() });
}

function createLease(spec: ExperimentSpec, runId: string, commandId: string): ResourceLease {
	const timestamp = nowIso();
	return {
		leaseId: `lease-${randomUUID().slice(0, 8)}`,
		resourceIds: spec.resources.map((resource) => resource.id),
		mode: spec.mode,
		runId,
		commandId,
		fencingToken: randomUUID(),
		status: "active",
		createdAt: timestamp,
	};
}

function writeEvent(path: string, event: unknown): void {
	writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf-8", flag: "a" });
}

export function reserveRun(cwd: string, spec: ExperimentSpec, commandId: string, capabilities: Capabilities): ReservedRun {
	mkdirSync(runsRoot(cwd), { recursive: true });
	mkdirSync(storeRoot(cwd), { recursive: true });
	const specHash = hashExperimentSpec(spec);
	const commandIndex = readCommandIndex(cwd);
	const existing = commandIndex.find((entry) => entry.commandId === commandId);
	if (existing) {
		const existingRecord = readRunRecord(cwd, existing.runId);
		const existingSpec = readJson(existingRecord.recordPaths.spec) as ExperimentSpec;
		const lease = readLatestLease(existingRecord.recordPaths.leases);
		return {
			record: existingRecord,
			spec: existingSpec,
			runDir: existingRecord.recordPaths.runDir,
			specHash: existing.specHash,
			eventsPath: existingRecord.recordPaths.events,
			intentsPath: existingRecord.recordPaths.intents,
			lease,
		};
	}

	const activeRun = findActiveRun(cwd);
	if (activeRun) {
		throw new ActiveRunConflictError(activeRun.runId, activeRun.status);
	}

	const runId = createRunId(spec.mode);
	const runDir = join(runsRoot(cwd), runId);
	mkdirSync(runDir, { recursive: false });
	ensureExperimentRecord(cwd, spec);
	const lease = createLease(spec, runId, commandId);
	const parentRunId = findParentRunIdForSpec(cwd, spec);
	const record = buildRecord(cwd, spec, runId, specHash, lease.leaseId, parentRunId);
	writeJson(record.recordPaths.runJson, record);
	writeJson(record.recordPaths.spec, spec);
	writeJson(record.recordPaths.capabilitiesSnapshot, capabilities);
	writeJson(record.recordPaths.artifacts, []);
	writeFileSync(record.recordPaths.intents, "", "utf-8");
	writeEvent(record.recordPaths.leases, lease);
	writeEvent(record.recordPaths.events, {
		schemaVersion: "1",
		sequence: 1,
		type: "run_reserved",
		experimentId: spec.experimentId,
		runId,
		correlationId: commandId,
		timestamp: record.createdAt,
		specHash,
	});
	commandIndex.push({ commandId, runId, specHash });
	writeCommandIndex(cwd, commandIndex);
	updateExperimentRoots(cwd, spec.experimentId, runId, parentRunId);
	return { record, spec, runDir, specHash, eventsPath: record.recordPaths.events, intentsPath: record.recordPaths.intents, lease };
}

export function markRunRunning(cwd: string, runId: string): RunRecord {
	const record = readRunRecord(cwd, runId);
	const timestamp = nowIso();
	const next: RunRecord = { ...record, status: "running", startedAt: timestamp, updatedAt: timestamp };
	writeJson(record.recordPaths.runJson, next);
	return next;
}

export function markRunFinished(cwd: string, runId: string, status: RunStatus): RunRecord {
	const record = readRunRecord(cwd, runId);
	const timestamp = nowIso();
	const next: RunRecord = { ...record, status, finishedAt: timestamp, updatedAt: timestamp };
	writeJson(record.recordPaths.runJson, next);
	return next;
}

export function readRunRecord(cwd: string, runId: string): RunRecord {
	return readJson(absoluteRunPath(cwd, runId, "run.json")) as RunRecord;
}

export function readRecordedSpec(cwd: string, runId: string): ExperimentSpec | undefined {
	const specPath = absoluteRunPath(cwd, runId, "spec.json");
	if (!existsSync(specPath)) return undefined;
	return readJson(specPath) as ExperimentSpec;
}

export function readRecordedSummary(cwd: string, runId: string): unknown | undefined {
	const summaryPath = absoluteRunPath(cwd, runId, "summary.json");
	if (!existsSync(summaryPath)) return undefined;
	return readJson(summaryPath);
}

export function readRecordedAnalysis(cwd: string, runId: string): unknown | undefined {
	const analysisPath = absoluteRunPath(cwd, runId, "analysis.json");
	if (!existsSync(analysisPath)) return undefined;
	return readJson(analysisPath);
}

export function readRecordedArtifacts(cwd: string, runId: string): unknown[] {
	const artifactsPath = absoluteRunPath(cwd, runId, "artifacts.json");
	if (!existsSync(artifactsPath)) return [];
	const parsed = readJson(artifactsPath);
	return Array.isArray(parsed) ? parsed : [];
}

export function readRecordedEvents(cwd: string, runId: string): RecordedEvent[] {
	const eventsPath = absoluteRunPath(cwd, runId, "events.jsonl");
	if (!existsSync(eventsPath)) return [];
	return readJsonl(eventsPath).filter((event): event is RecordedEvent => typeof event === "object" && event !== null && !Array.isArray(event));
}

export function readRecordedApprovals(cwd: string, runId: string): RecordedApproval[] {
	const approvalsPath = absoluteRunPath(cwd, runId, "approvals.jsonl");
	if (!existsSync(approvalsPath)) return [];
	return readJsonl(approvalsPath).filter(isRecordedApproval);
}

export function writeRecordedAnalysis(cwd: string, runId: string, analysis: unknown): ToolResult["artifacts"][number] {
	const analysisPath = absoluteRunPath(cwd, runId, "analysis.json");
	writeJson(analysisPath, analysis);
	const artifact: ToolResult["artifacts"][number] = {
		id: `${runId}-analysis`,
		uri: relativeRunPath(runId, "analysis.json"),
		label: "Run analysis",
		kind: "analysis",
		producerRunId: runId,
	};
	const artifacts = normalizeArtifactIndex(readRecordedArtifacts(cwd, runId));
	if (!artifacts.some((entry) => entry.uri === artifact.uri)) {
		writeJson(absoluteRunPath(cwd, runId, "artifacts.json"), [...artifacts, artifact]);
	}
	return artifact;
}

export function writeResumeSnapshot(cwd: string, runId: string, snapshot: ResumeSnapshot): string {
	const snapshotPath = absoluteRunPath(cwd, runId, "resume.snapshot.json");
	writeJson(snapshotPath, snapshot);
	return snapshotPath;
}

export function readResumeSnapshot(cwd: string, runId: string): ResumeSnapshot | undefined {
	const snapshotPath = absoluteRunPath(cwd, runId, "resume.snapshot.json");
	if (!existsSync(snapshotPath)) return undefined;
	const parsed = readJson(snapshotPath);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as ResumeSnapshot;
}

export function appendLineage(cwd: string, experimentId: string, entry: LineageEntry): string {
	const experimentDir = join(experimentsRoot(cwd), experimentId);
	mkdirSync(experimentDir, { recursive: true });
	const path = join(experimentDir, "lineage.jsonl");
	writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
	return path;
}

export function appendDecisionAudit(cwd: string, experimentId: string, entry: DecisionAuditEntry): string {
	const experimentDir = join(experimentsRoot(cwd), experimentId);
	mkdirSync(experimentDir, { recursive: true });
	const path = join(experimentDir, "decisions.jsonl");
	writeFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: "utf-8", flag: "a" });
	return path;
}

export function readExperimentLineage(cwd: string, experimentId: string): LineageEntry[] {
	const path = join(experimentsRoot(cwd), experimentId, "lineage.jsonl");
	return readJsonl(path).filter(isLineageEntry);
}

export function readDecisionAudit(cwd: string, experimentId: string): DecisionAuditEntry[] {
	const path = join(experimentsRoot(cwd), experimentId, "decisions.jsonl");
	return readJsonl(path).filter(isDecisionAuditEntry);
}

export function getExperimentState(
	cwd: string,
	experimentId: string,
): { experiment?: ExperimentRecord; runs: RunRecord[]; lineage: LineageEntry[]; decisions: DecisionAuditEntry[] } {
	const experimentPath = join(experimentsRoot(cwd), experimentId, "experiment.json");
	const experiment = existsSync(experimentPath) ? (readJson(experimentPath) as ExperimentRecord) : undefined;
	const runsDir = runsRoot(cwd);
	const lineage = readExperimentLineage(cwd, experimentId);
	const decisions = readDecisionAudit(cwd, experimentId);
	if (!existsSync(runsDir)) return { experiment, runs: [], lineage, decisions };
	const runIds = readDirNames(runsDir);
	const runs = runIds
		.map((runId) => {
			try {
				return readRunRecord(cwd, runId);
			} catch {
				return undefined;
			}
		})
		.filter((record): record is RunRecord => record !== undefined && record.experimentId === experimentId);
	return { experiment, runs, lineage, decisions };
}

export function listRunRecords(cwd: string): RunRecord[] {
	const runsDir = runsRoot(cwd);
	if (!existsSync(runsDir)) return [];
	return readDirNames(runsDir)
		.map((runId) => {
			try {
				return readRunRecord(cwd, runId);
			} catch {
				return undefined;
			}
		})
		.filter((record): record is RunRecord => record !== undefined)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function findActiveRun(cwd: string): RunRecord | undefined {
	const runsDir = runsRoot(cwd);
	if (!existsSync(runsDir)) return undefined;
	for (const runId of readDirNames(runsDir)) {
		try {
			const record = readRunRecord(cwd, runId);
			if (record.status === "running" || record.status === "paused" || record.status === "recovering") return record;
		} catch {
			// Ignore malformed run directories; recovery code can handle them later.
		}
	}
	return undefined;
}

function readLatestLease(path: string): ResourceLease {
	if (!existsSync(path)) {
		throw new Error(`lease record not found: ${path}`);
	}
	const lines = readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0);
	const [last] = lines.slice(-1);
	if (!last) throw new Error(`lease record is empty: ${path}`);
	return JSON.parse(last) as ResourceLease;
}

function readDirNames(path: string): string[] {
	return readdirSync(path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

export function relativeArtifact(runId: string, fileName: string): string {
	return relativeRunPath(runId, fileName);
}

function findParentRunIdForSpec(cwd: string, spec: ExperimentSpec): string | undefined {
	return readExperimentLineage(cwd, spec.experimentId).find((entry) => entry.generatedSpecId === spec.specId)?.parentRunId;
}

function readJsonl(path: string): unknown[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as unknown;
			} catch {
				return undefined;
			}
		})
		.filter((value): value is unknown => value !== undefined);
}

function normalizeArtifactIndex(values: unknown[]): ArtifactIndexEntry[] {
	return values.filter((value): value is ArtifactIndexEntry => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		return typeof record.uri === "string" && typeof record.label === "string";
	});
}

function isLineageEntry(value: unknown): value is LineageEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.parentRunId === "string" &&
		typeof record.strategy === "string" &&
		Array.isArray(record.inputArtifacts) &&
		typeof record.reason === "string" &&
		typeof record.createdAt === "string"
	);
}

function isDecisionAuditEntry(value: unknown): value is DecisionAuditEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.decisionId === "string" &&
		typeof record.commandId === "string" &&
		typeof record.parentRunId === "string" &&
		typeof record.strategy === "string" &&
		typeof record.rationale === "string" &&
		Array.isArray(record.inputArtifacts) &&
		typeof record.stopConditionMet === "boolean" &&
		typeof record.createdAt === "string"
	);
}

function isRecordedApproval(value: unknown): value is RecordedApproval {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.approval !== undefined) {
		if (typeof record.approval !== "object" || record.approval === null || Array.isArray(record.approval)) return false;
		const approval = record.approval as Record<string, unknown>;
		if (approval.approvalId !== undefined && typeof approval.approvalId !== "string") return false;
		if (approval.operator !== undefined && typeof approval.operator !== "string") return false;
		if (approval.approved !== undefined && typeof approval.approved !== "boolean") return false;
		if (approval.dryRunReportId !== undefined && typeof approval.dryRunReportId !== "string") return false;
		if (approval.operatorOnlyMonitoring !== undefined && typeof approval.operatorOnlyMonitoring !== "boolean") return false;
	}
	return (
		(record.type === undefined || typeof record.type === "string") &&
		(record.runId === undefined || typeof record.runId === "string") &&
		(record.operatorOnlyMonitoring === undefined || typeof record.operatorOnlyMonitoring === "boolean") &&
		(record.specHash === undefined || typeof record.specHash === "string") &&
		(record.raman === undefined || typeof record.raman === "boolean")
	);
}
