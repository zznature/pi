import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createErrorResult, createSuccessResult } from "../results.ts";
import { artifactUriPath } from "../run-store.ts";
import type { ExperimentSpec, HardwareCoordinateAuditParams, ToolResult, ValidationIssue } from "../schemas.ts";

export interface HardwareCoordinateAuditRecord {
	schemaVersion: "1";
	coordinateAuditId: string;
	createdAt: string;
	observedAt: string;
	subject: HardwareCoordinateAuditParams["subject"];
	plan: HardwareCoordinateAuditParams["plan"];
	coordinatePlanHash: string;
	approval: HardwareCoordinateAuditParams["approval"];
	notes?: string;
}

export type HardwareCoordinateAuditResolution =
	| {
			ok: true;
			path: string;
			record: HardwareCoordinateAuditRecord;
	  }
	| {
			ok: false;
			path: string;
			issues: ValidationIssue[];
	  };

function nowIso(): string {
	return new Date().toISOString();
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

function coordinateAuditRoot(cwd: string): string {
	return join(cwd, ".pi", "experiment-runs", "lab", "coordinate-audits");
}

function coordinateAuditPath(cwd: string, coordinateAuditId: string): string {
	return join(coordinateAuditRoot(cwd), `${coordinateAuditId}.json`);
}

function relativeToCwd(cwd: string, path: string): string {
	const result = relative(cwd, path);
	return artifactUriPath(result.startsWith("..") ? path : result);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hashCoordinateAuditTarget(
	subject: HardwareCoordinateAuditParams["subject"] | ExperimentSpec["subject"],
	plan: HardwareCoordinateAuditParams["plan"] | ExperimentSpec["plan"],
): string {
	return createHash("sha256")
		.update(stableCanonicalize({ subject, plan }))
		.digest("hex");
}

function parseCoordinateAuditRecord(value: unknown, path: string): HardwareCoordinateAuditRecord | ValidationIssue[] {
	if (!isObjectRecord(value)) {
		return [{ path, message: "Coordinate audit record must be an object" }];
	}
	const issues: ValidationIssue[] = [];
	if (value.schemaVersion !== "1") {
		issues.push({ path: `${path}.schemaVersion`, message: "Coordinate audit record schemaVersion must be 1" });
	}
	if (typeof value.coordinateAuditId !== "string" || value.coordinateAuditId.length === 0) {
		issues.push({ path: `${path}.coordinateAuditId`, message: "Coordinate audit record requires coordinateAuditId" });
	}
	if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
		issues.push({ path: `${path}.createdAt`, message: "Coordinate audit record requires an ISO createdAt timestamp" });
	}
	if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt))) {
		issues.push({ path: `${path}.observedAt`, message: "Coordinate audit record requires an ISO observedAt timestamp" });
	}
	if (!isObjectRecord(value.subject)) {
		issues.push({ path: `${path}.subject`, message: "Coordinate audit record requires subject" });
	}
	if (!isObjectRecord(value.plan)) {
		issues.push({ path: `${path}.plan`, message: "Coordinate audit record requires plan" });
	}
	if (typeof value.coordinatePlanHash !== "string" || value.coordinatePlanHash.length === 0) {
		issues.push({ path: `${path}.coordinatePlanHash`, message: "Coordinate audit record requires coordinatePlanHash" });
	}
	if (!isObjectRecord(value.approval)) {
		issues.push({ path: `${path}.approval`, message: "Coordinate audit record requires approval" });
	} else {
		if (typeof value.approval.approvalId !== "string" || value.approval.approvalId.length === 0) {
			issues.push({ path: `${path}.approval.approvalId`, message: "Coordinate audit approval requires approvalId" });
		}
		if (typeof value.approval.operator !== "string" || value.approval.operator.length === 0) {
			issues.push({ path: `${path}.approval.operator`, message: "Coordinate audit approval requires operator" });
		}
		if (typeof value.approval.approved !== "boolean") {
			issues.push({ path: `${path}.approval.approved`, message: "Coordinate audit approval requires approved boolean" });
		}
	}
	if (issues.length > 0) return issues;
	const record: HardwareCoordinateAuditRecord = {
		schemaVersion: "1",
		coordinateAuditId: String(value.coordinateAuditId),
		createdAt: String(value.createdAt),
		observedAt: String(value.observedAt),
		subject: value.subject as HardwareCoordinateAuditParams["subject"],
		plan: value.plan as HardwareCoordinateAuditParams["plan"],
		coordinatePlanHash: String(value.coordinatePlanHash),
		approval: value.approval as HardwareCoordinateAuditParams["approval"],
	};
	if (typeof value.notes === "string") record.notes = value.notes;
	return record;
}

export function resolveHardwareCoordinateAudit(cwd: string, coordinateAuditId: string): HardwareCoordinateAuditResolution {
	const path = coordinateAuditPath(cwd, coordinateAuditId);
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			issues: [{ path: "hardwareExecution.coordinateAuditId", message: `Coordinate audit record not found: ${coordinateAuditId}` }],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return {
			ok: false,
			path,
			issues: [{ path: "hardwareExecution.coordinateAuditId", message: `Coordinate audit record is not valid JSON: ${coordinateAuditId}` }],
		};
	}
	const recordOrIssues = parseCoordinateAuditRecord(parsed, "coordinateAudit");
	if (Array.isArray(recordOrIssues)) {
		return { ok: false, path, issues: recordOrIssues };
	}
	return { ok: true, path, record: recordOrIssues };
}

export function validateHardwareCoordinateAuditReadiness(
	cwd: string,
	coordinateAuditId: string,
	spec: ExperimentSpec,
): HardwareCoordinateAuditResolution {
	const resolution = resolveHardwareCoordinateAudit(cwd, coordinateAuditId);
	if (!resolution.ok) return resolution;
	const issues: ValidationIssue[] = [];
	if (resolution.record.approval.approved !== true) {
		issues.push({ path: "hardwareExecution.coordinateAuditId", message: `Coordinate audit record ${coordinateAuditId} is not operator-approved` });
	}
	const expectedHash = hashCoordinateAuditTarget(spec.subject, spec.plan);
	if (resolution.record.coordinatePlanHash !== expectedHash) {
		issues.push({
			path: "hardwareExecution.coordinateAuditId",
			message: `Coordinate audit record ${coordinateAuditId} does not match the current hardware subject/plan coordinates`,
		});
	}
	if (issues.length > 0) {
		return { ok: false, path: resolution.path, issues };
	}
	return resolution;
}

export function recordHardwareCoordinateAudit(
	params: HardwareCoordinateAuditParams,
	ctx: { cwd: string; commandId: string },
): ToolResult {
	if (!params.approval.approved) {
		return createErrorResult(
			ctx.commandId,
			"Hardware coordinate audit recording requires explicit operator approval.",
			"hardware_gate_failed",
			["Approve the coordinate audit only after the operator confirms the absolute positions on the real setup."],
			{ approval: params.approval },
			true,
		);
	}
	if (params.plan.kind === "steps") {
		return createErrorResult(
			ctx.commandId,
			"Hardware coordinate audit requires spatial grid or points coordinates, not steps.",
			"invalid_tool_params",
			["Provide a grid or points plan containing the audited absolute coordinates."],
			{ planKind: params.plan.kind },
			true,
		);
	}
	const coordinateAuditId = params.coordinateAuditId ?? `coord-audit-${randomUUID().slice(0, 8)}`;
	const path = coordinateAuditPath(ctx.cwd, coordinateAuditId);
	mkdirSync(coordinateAuditRoot(ctx.cwd), { recursive: true });
	const record: HardwareCoordinateAuditRecord = {
		schemaVersion: "1",
		coordinateAuditId,
		createdAt: nowIso(),
		observedAt: params.observedAt ?? nowIso(),
		subject: params.subject,
		plan: params.plan,
		coordinatePlanHash: hashCoordinateAuditTarget(params.subject, params.plan),
		approval: params.approval,
	};
	if (params.notes) record.notes = params.notes;
	writeJson(path, record);
	return createSuccessResult(
		ctx.commandId,
		`Recorded hardware coordinate audit ${coordinateAuditId}.`,
		{ coordinateAuditId, coordinatePlanHash: record.coordinatePlanHash, path, record },
		["Use this coordinateAuditId in hardwareExecution.coordinateAuditId for supervised real hardware runs."],
		[
			{
				id: coordinateAuditId,
				uri: relativeToCwd(ctx.cwd, path),
				label: "Hardware coordinate audit",
				kind: "coordinate-audit",
			},
		],
	);
}
