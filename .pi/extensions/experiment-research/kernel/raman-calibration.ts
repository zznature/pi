import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DEFAULT_LABSPEC_BRIDGE_DIR } from "../labspec-bridge.ts";
import { createErrorResult, createSuccessResult } from "../results.ts";
import { artifactUriPath } from "../run-store.ts";
import type {
	RamanAutoXyCalibrationParams,
	RamanFitXyCalibrationParams,
	RamanRecordXyCalibrationParams,
	ToolResult,
	ValidationIssue,
} from "../schemas.ts";
import { RamanBridgeClient, RamanBridgeRequestError } from "./raman-bridge.ts";

export type Matrix2x2 = [[number, number], [number, number]];

export interface RamanXyCalibrationArtifact {
	schemaVersion: "1";
	calibrationId: string;
	createdAt: string;
	validUntil?: string;
	pixelPerUm: Matrix2x2;
	confidence: number;
	objective?: string;
	magnification?: string;
	sourceNotes?: string;
	approval: RamanRecordXyCalibrationParams["approval"];
}

export type CalibrationResolution =
	| {
			ok: true;
			path: string;
			artifact: RamanXyCalibrationArtifact;
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

function calibrationPath(cwd: string, calibrationId: string): string {
	return join(cwd, ".pi", "experiment-runs", "lab", "calibrations", `${calibrationId}.json`);
}

function relativeToCwd(cwd: string, path: string): string {
	const result = relative(cwd, path);
	return artifactUriPath(result.startsWith("..") ? path : result);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function normalizeMatrix2x2(value: unknown): Matrix2x2 | undefined {
	if (!Array.isArray(value) || value.length !== 2) return undefined;
	const [row0, row1] = value;
	if (!Array.isArray(row0) || !Array.isArray(row1) || row0.length !== 2 || row1.length !== 2) return undefined;
	if (!isFiniteNumber(row0[0]) || !isFiniteNumber(row0[1]) || !isFiniteNumber(row1[0]) || !isFiniteNumber(row1[1])) {
		return undefined;
	}
	return [
		[row0[0], row0[1]],
		[row1[0], row1[1]],
	];
}

function determinant(matrix: Matrix2x2): number {
	return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
}

function matrixIssues(path: string, matrix: Matrix2x2 | undefined): ValidationIssue[] {
	if (!matrix) return [{ path, message: "Calibration pixelPerUm must be a finite 2x2 matrix" }];
	if (Math.abs(determinant(matrix)) < 1e-12) {
		return [{ path, message: "Calibration pixelPerUm matrix must be invertible" }];
	}
	return [];
}

function parseArtifact(value: unknown, path: string): RamanXyCalibrationArtifact | ValidationIssue[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [{ path, message: "Calibration artifact must be an object" }];
	}
	const record = value as Record<string, unknown>;
	const matrix = normalizeMatrix2x2(record.pixelPerUm);
	const issues = matrixIssues(`${path}.pixelPerUm`, matrix);
	if (record.schemaVersion !== "1") {
		issues.push({ path: `${path}.schemaVersion`, message: "Calibration artifact schemaVersion must be 1" });
	}
	if (typeof record.calibrationId !== "string" || record.calibrationId.length === 0) {
		issues.push({ path: `${path}.calibrationId`, message: "Calibration artifact requires calibrationId" });
	}
	if (!isFiniteNumber(record.confidence) || record.confidence < 0 || record.confidence > 1) {
		issues.push({ path: `${path}.confidence`, message: "Calibration confidence must be between 0 and 1" });
	}
	if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
		issues.push({ path: `${path}.createdAt`, message: "Calibration artifact requires an ISO createdAt timestamp" });
	}
	if (typeof record.validUntil === "string" && Number.isNaN(Date.parse(record.validUntil))) {
		issues.push({ path: `${path}.validUntil`, message: "Calibration validUntil must be an ISO timestamp" });
	}
	if (typeof record.approval !== "object" || record.approval === null || Array.isArray(record.approval)) {
		issues.push({ path: `${path}.approval`, message: "Calibration artifact requires approval record" });
	}
	if (issues.length > 0 || !matrix) return issues;
	const approval = record.approval as RamanRecordXyCalibrationParams["approval"];
	const artifact: RamanXyCalibrationArtifact = {
		schemaVersion: "1",
		calibrationId: String(record.calibrationId),
		createdAt: String(record.createdAt),
		pixelPerUm: matrix,
		confidence: Number(record.confidence),
		approval,
	};
	if (typeof record.validUntil === "string") artifact.validUntil = record.validUntil;
	if (typeof record.objective === "string") artifact.objective = record.objective;
	if (typeof record.magnification === "string") artifact.magnification = record.magnification;
	if (typeof record.sourceNotes === "string") artifact.sourceNotes = record.sourceNotes;
	return artifact;
}

export function resolveRamanXyCalibration(cwd: string, calibrationId: string, now: Date = new Date()): CalibrationResolution {
	const path = calibrationPath(cwd, calibrationId);
	if (!existsSync(path)) {
		return {
			ok: false,
			path,
			issues: [{ path: "domain.raman.xyCorrection.transformArtifactId", message: `Calibration artifact not found: ${calibrationId}` }],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch {
		return {
			ok: false,
			path,
			issues: [{ path: "domain.raman.xyCorrection.transformArtifactId", message: `Calibration artifact is not valid JSON: ${calibrationId}` }],
		};
	}
	const artifactOrIssues = parseArtifact(parsed, "calibration");
	if (Array.isArray(artifactOrIssues)) {
		return { ok: false, path, issues: artifactOrIssues };
	}
	if (artifactOrIssues.validUntil && Date.parse(artifactOrIssues.validUntil) <= now.getTime()) {
		return {
			ok: false,
			path,
			issues: [{ path: "domain.raman.xyCorrection.transformArtifactId", message: `Calibration artifact is expired: ${calibrationId}` }],
		};
	}
	return { ok: true, path, artifact: artifactOrIssues };
}

export function recordRamanXyCalibration(
	params: RamanRecordXyCalibrationParams,
	ctx: { cwd: string; commandId: string },
): ToolResult {
	if (!params.approval.approved) {
		return createErrorResult(
			ctx.commandId,
			"Raman XY calibration recording requires explicit operator approval.",
			"hardware_gate_failed",
			["Approve the calibration only after reviewing the calibration source data."],
			{ approval: params.approval },
			true,
		);
	}
	const matrix = normalizeMatrix2x2(params.pixelPerUm);
	const issues = matrixIssues("pixelPerUm", matrix);
	if (issues.length > 0 || !matrix) {
		return createErrorResult(
			ctx.commandId,
			"Raman XY calibration matrix is invalid.",
			"invalid_tool_params",
			["Provide a finite, invertible 2x2 pixelPerUm matrix."],
			{ valid: false, issues },
			true,
		);
	}
	const calibrationId = params.calibrationId ?? `raman-cal-${randomUUID().slice(0, 8)}`;
	const path = calibrationPath(ctx.cwd, calibrationId);
	mkdirSync(join(ctx.cwd, ".pi", "experiment-runs", "lab", "calibrations"), { recursive: true });
	const artifact: RamanXyCalibrationArtifact = {
		schemaVersion: "1",
		calibrationId,
		createdAt: nowIso(),
		pixelPerUm: matrix,
		confidence: params.confidence,
		approval: params.approval,
	};
	if (params.validUntil) artifact.validUntil = params.validUntil;
	if (params.objective) artifact.objective = params.objective;
	if (params.magnification) artifact.magnification = params.magnification;
	if (params.sourceNotes) artifact.sourceNotes = params.sourceNotes;
	writeJson(path, artifact);
	return createSuccessResult(
		ctx.commandId,
		`Recorded Raman XY calibration ${calibrationId}.`,
		{ calibrationId, artifact, path },
		["Reference this calibration from domain.raman.xyCorrection.transformArtifactId in bounded Raman specs."],
		[{ id: calibrationId, uri: relativeToCwd(ctx.cwd, path), label: "Raman XY calibration", kind: "xy-calibration" }],
	);
}

function isMatrix2x2(value: unknown): value is Matrix2x2 {
	return normalizeMatrix2x2(value) !== undefined;
}

export async function fitAndRecordRamanXyCalibration(
	params: RamanFitXyCalibrationParams,
	ctx: { cwd: string; commandId: string },
): Promise<ToolResult> {
	if (!params.approval.approved) {
		return createErrorResult(
			ctx.commandId,
			"Raman XY calibration fitting requires explicit operator approval.",
			"hardware_gate_failed",
			["Approve calibration fitting only after the operator confirms stage movement and frame pairs."],
			{ approval: params.approval },
			true,
		);
	}
	const bridge = new RamanBridgeClient({ cwd: ctx.cwd, python: params.stagePython, requestTimeoutMs: 30_000 });
	try {
		const fit = await bridge.request<Record<string, unknown>>("calibrate_xy", {
			measurements: params.measurements,
			minConfidence: params.minConfidence ?? 0.4,
		});
		if (!isMatrix2x2(fit.pixelPerUm)) {
			return createErrorResult(
				ctx.commandId,
				"Raman XY calibration fitting returned an invalid matrix.",
				"protocol_corruption",
				["Review bridge output before retrying calibration fitting."],
				{ fit },
				true,
			);
		}
		const confidence = typeof fit.confidence === "number" ? fit.confidence : params.minConfidence ?? 0.4;
		const recorded = recordRamanXyCalibration(
			{
				approval: params.approval,
				calibrationId: params.calibrationId,
				pixelPerUm: fit.pixelPerUm,
				confidence,
				validUntil: params.validUntil,
				objective: params.objective,
				magnification: params.magnification,
				sourceNotes: params.sourceNotes ?? "Fitted from phase-correlation frame pairs.",
			},
			ctx,
		);
		if (recorded.status !== "success") return recorded;
		return {
			...recorded,
			summary: `${recorded.summary} Fit residual ${typeof fit.residualRmsPx === "number" ? fit.residualRmsPx.toFixed(3) : "unknown"} px.`,
			stateAfter: {
				...(recorded.stateAfter as Record<string, unknown>),
				fit,
			},
		};
	} catch (error) {
		const stateAfter =
			error instanceof RamanBridgeRequestError
				? { ramanErrorCode: error.code, detail: error.detail }
				: { message: error instanceof Error ? error.message : String(error) };
		return createErrorResult(
			ctx.commandId,
			"Raman XY calibration fitting failed.",
			error instanceof RamanBridgeRequestError && error.code === "calibration_singular_transform"
				? "invalid_tool_params"
				: "bridge_crashed",
			["Review calibration frame pairs, stage shifts, and bridge diagnostics before retrying."],
			stateAfter,
			true,
		);
	} finally {
		await bridge.shutdown().catch(() => bridge.close());
	}
}

function stagePayload(params: RamanAutoXyCalibrationParams): Record<string, unknown> {
	if (params.stageAdapter === "memory") return { adapter: "memory" };
	return { adapter: "mc_newton_xyz", port: params.stagePort };
}

export async function autoFitAndRecordRamanXyCalibration(
	params: RamanAutoXyCalibrationParams,
	ctx: { cwd: string; commandId: string },
): Promise<ToolResult> {
	if (!params.approval.approved) {
		return createErrorResult(
			ctx.commandId,
			"Raman automatic XY calibration requires explicit operator approval.",
			"hardware_gate_failed",
			["Approve automatic calibration only after the operator confirms stage movement and frame capture side effects."],
			{ approval: params.approval },
			true,
		);
	}
	if (params.stageAdapter === "mc_newton_xyz" && !params.stagePort) {
		return createErrorResult(
			ctx.commandId,
			"MC.Newton automatic XY calibration requires stagePort.",
			"invalid_tool_params",
			["Provide stagePort for the real stage adapter."],
			{ stageAdapter: params.stageAdapter },
			true,
		);
	}
	const frameBridgeDir = params.frameBridgeDir ?? DEFAULT_LABSPEC_BRIDGE_DIR;
	const outputDir =
		params.outputDir ?? join(ctx.cwd, ".pi", "experiment-runs", "maintenance", "xy-calibration", params.calibrationId ?? `auto-${randomUUID().slice(0, 8)}`);
	mkdirSync(outputDir, { recursive: true });
	const bridge = new RamanBridgeClient({ cwd: ctx.cwd, python: params.stagePython, requestTimeoutMs: 60_000 });
	try {
		const fit = await bridge.request<Record<string, unknown>>("calibrate_xy_sequence", {
			stage: stagePayload(params),
			frameBackend: params.frameBackend ?? "fake",
			bridgeDir: frameBridgeDir,
			outputDir,
			stepUm: params.stepUm,
			shifts: params.shifts,
			fakePixelPerUm: params.fakePixelPerUm,
			minConfidence: params.minConfidence ?? 0.4,
			settleTimeoutMs: params.settleTimeoutMs ?? 1000,
			frameTimeoutMs: params.frameTimeoutMs ?? 10000,
		});
		if (!isMatrix2x2(fit.pixelPerUm)) {
			return createErrorResult(
				ctx.commandId,
				"Raman automatic XY calibration returned an invalid matrix.",
				"protocol_corruption",
				["Review bridge output before retrying automatic calibration."],
				{ fit },
				true,
			);
		}
		const confidence = typeof fit.confidence === "number" ? fit.confidence : params.minConfidence ?? 0.4;
		const recorded = recordRamanXyCalibration(
			{
				approval: params.approval,
				calibrationId: params.calibrationId,
				pixelPerUm: fit.pixelPerUm,
				confidence,
				validUntil: params.validUntil,
				objective: params.objective,
				magnification: params.magnification,
				sourceNotes: params.sourceNotes ?? "Automatically fitted from stage moves and captured frames.",
			},
			ctx,
		);
		if (recorded.status !== "success") return recorded;
		const bridgeArtifacts = Array.isArray(fit.artifacts)
			? fit.artifacts
					.filter((artifact): artifact is Record<string, unknown> => typeof artifact === "object" && artifact !== null && !Array.isArray(artifact))
					.map((artifact, index) => ({
						id: `${String((recorded.stateAfter as Record<string, unknown>).calibrationId)}-frame-${index}`,
						uri: typeof artifact.path === "string" ? relativeToCwd(ctx.cwd, artifact.path) : relativeToCwd(ctx.cwd, outputDir),
						label: typeof artifact.role === "string" ? `Raman calibration ${artifact.role}` : "Raman calibration frame",
						kind: "calibration-frame",
					}))
			: [];
		return {
			...recorded,
			summary: `${recorded.summary} Automatic fit residual ${typeof fit.residualRmsPx === "number" ? fit.residualRmsPx.toFixed(3) : "unknown"} px.`,
			artifacts: [...recorded.artifacts, ...bridgeArtifacts],
			stateAfter: {
				...(recorded.stateAfter as Record<string, unknown>),
				fit,
				outputDir,
			},
		};
	} catch (error) {
		const stateAfter =
			error instanceof RamanBridgeRequestError
				? { ramanErrorCode: error.code, detail: error.detail }
				: { message: error instanceof Error ? error.message : String(error) };
		return createErrorResult(
			ctx.commandId,
			"Raman automatic XY calibration failed.",
			error instanceof RamanBridgeRequestError && error.code === "calibration_singular_transform"
				? "invalid_tool_params"
				: "bridge_crashed",
			["Review stage movement, frame capture, and bridge diagnostics before retrying."],
			stateAfter,
			true,
		);
	} finally {
		await bridge.shutdown().catch(() => bridge.close());
	}
}
