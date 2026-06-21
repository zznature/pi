import { join } from "node:path";
import { relativeArtifact, type SnapshotStagePosition } from "../run-store.ts";
import type { ExperimentSpec, RamanErrorCode, ToolResult } from "../schemas.ts";
import type { ExperimentPoint } from "../spec-utils.ts";
import { normalizeMatrix2x2, resolveRamanXyCalibration, type Matrix2x2 } from "./raman-calibration.ts";
import { writeRamanV2MicrostepSnapshot, type RamanV2Microstep } from "./raman-v2-resume.ts";

export interface RamanV2Bridge {
	request<Result>(
		domain: string,
		action: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<Result>;
}

export interface RamanV2AutofocusRecord {
	zBestUm: number;
	finalScore: number;
	confidence: number;
	curveArtifactId?: string;
}

export interface RamanV2XyCorrectionRecord {
	dxUm: number;
	dyUm: number;
	confidence: number;
	applied: boolean;
}

export interface RamanV2SpectrumRecord {
	artifactId: string;
	integrationTimeS: number;
	accumulations: number;
}

export interface RamanV2ThermalRecord {
	targetTemperatureC: number;
	currentTemperatureC: number;
	toleranceC: number;
	stable: boolean;
}

export interface RamanV2UnitRecord extends ExperimentPoint {
	status: "success";
	positionBefore: SnapshotStagePosition;
	positionAfter: SnapshotStagePosition;
	focusScore?: number;
	autofocus?: RamanV2AutofocusRecord;
	xyCorrection?: RamanV2XyCorrectionRecord;
	thermal?: RamanV2ThermalRecord;
	spectrum?: RamanV2SpectrumRecord;
	spectrumMetadata?: Record<string, unknown>;
	artifactRefs: ToolResult["artifacts"];
}

export interface RamanV2RunUnitOptions {
	cwd: string;
	runId: string;
	commandId: string;
	spec: ExperimentSpec;
	point: ExperimentPoint;
	bridge: RamanV2Bridge;
	stage?: Record<string, unknown>;
	settleTimeoutMs?: number;
	fakeFocusZUm?: number;
	xyReferenceImage?: number[][];
	xyCurrentImage?: number[][];
	xyTransform?: Matrix2x2;
	xyApplyCorrection?: boolean;
	thermal?: {
		backend?: "fake";
		simulateDurationMs?: number;
	};
	camera?: {
		backend?: "fake" | "labspec_file_bridge";
		bridgeDir?: string;
		timeoutMs?: number;
		imageFormat?: string;
		minCaptureIntervalMs?: number;
	};
	acquisition?: {
		backend?: "fake" | "labspec_file_bridge";
		bridgeDir?: string;
		timeoutS?: number;
		pollIntervalS?: number;
	};
	acquisitionSimulateDurationMs?: number;
}

export class RamanV2WorkflowPauseError extends Error {
	readonly code: "autofocus_low_confidence" | "calibration_low_confidence";

	constructor(code: "autofocus_low_confidence" | "calibration_low_confidence", message: string) {
		super(message);
		this.name = "RamanV2WorkflowPauseError";
		this.code = code;
	}
}

export class RamanV2WorkflowAbortError extends Error {
	readonly code: RamanErrorCode;

	constructor(code: RamanErrorCode, message: string) {
		super(message);
		this.name = "RamanV2WorkflowAbortError";
		this.code = code;
	}
}

interface FocusSample {
	zUm: number;
	score: number;
	frameArtifact: ToolResult["artifacts"][number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Expected numeric field ${key}`);
	}
	return value;
}

function optionalNumberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	if (!record) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePosition(value: unknown): SnapshotStagePosition {
	if (!isRecord(value)) throw new Error("Stage position response was malformed");
	return {
		xUm: numberField(value, "xUm"),
		yUm: numberField(value, "yUm"),
		zUm: numberField(value, "zUm"),
	};
}

function parseImage(value: unknown): number[][] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Camera frame image was malformed");
	return value.map((row) => {
		if (!Array.isArray(row) || row.length === 0) throw new Error("Camera frame row was malformed");
		return row.map((cell) => {
			if (typeof cell !== "number" || !Number.isFinite(cell)) throw new Error("Camera frame pixel was malformed");
			return cell;
		});
	});
}

function runArtifactPath(cwd: string, runId: string, fileName: string): string {
	return join(cwd, ".pi", "experiment-runs", "runs", runId, fileName);
}

function artifactRef(runId: string, fileName: string, label: string, kind: string): ToolResult["artifacts"][number] {
	return {
		id: `${runId}-${kind}-${fileName.replace(/[^A-Za-z0-9_.-]/g, "-")}`,
		uri: relativeArtifact(runId, fileName),
		label,
		kind,
		producerRunId: runId,
	};
}

function addArtifact(artifacts: ToolResult["artifacts"], artifact: ToolResult["artifacts"][number]): void {
	if (!artifacts.some((existing) => existing.uri === artifact.uri)) {
		artifacts.push(artifact);
	}
}

function pointZ(point: ExperimentPoint): number {
	return point.zUm ?? 0;
}

function appendRange(values: number[], start: number, stop: number, step: number): void {
	for (let value = start; value <= stop + step / 1000; value += step) {
		values.push(Number(value.toFixed(6)));
	}
}

function autofocusZPositions(point: ExperimentPoint, autofocus: Record<string, unknown>): number[] {
	const center = pointZ(point);
	const zMin = optionalNumberField(autofocus, "zMinUm") ?? center;
	const zMax = optionalNumberField(autofocus, "zMaxUm") ?? center;
	const coarseRange = optionalNumberField(autofocus, "coarseRangeUm") ?? Math.max(0, zMax - zMin);
	const coarseStep = optionalNumberField(autofocus, "coarseStepUm") ?? Math.max(coarseRange, 1);
	const start = Math.max(zMin, center - coarseRange / 2);
	const stop = Math.min(zMax, center + coarseRange / 2);
	const values: number[] = [];
	appendRange(values, start, stop, Math.max(coarseStep, 0.001));
	if (!values.includes(center) && center >= zMin && center <= zMax) values.push(center);
	return [...new Set(values)].sort((a, b) => a - b);
}

function focusConfidence(samples: FocusSample[], best: FocusSample): number {
	const sorted = [...samples].sort((a, b) => b.score - a.score);
	const second = sorted.find((sample) => sample !== best);
	if (!second || best.score <= 0) return 1;
	return Math.max(0, Math.min(1, (best.score - second.score) / best.score));
}

function inverse2x2(matrix: Matrix2x2): Matrix2x2 {
	const determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
	if (Math.abs(determinant) < 1e-12) throw new Error("XY transform is singular");
	return [
		[matrix[1][1] / determinant, -matrix[0][1] / determinant],
		[-matrix[1][0] / determinant, matrix[0][0] / determinant],
	];
}

function transformPixelsToStageUm(matrix: Matrix2x2, dxPx: number, dyPx: number): { dxUm: number; dyUm: number } {
	const inverse = inverse2x2(matrix);
	return {
		dxUm: inverse[0][0] * dxPx + inverse[0][1] * dyPx,
		dyUm: inverse[1][0] * dxPx + inverse[1][1] * dyPx,
	};
}

function acquisitionComplete(status: unknown): boolean {
	return status === "completed" || status === "collected";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stagePosition(bridge: RamanV2Bridge): Promise<SnapshotStagePosition> {
	const response = await bridge.request<Record<string, unknown>>("stage", "get_position");
	return parsePosition(isRecord(response.position) ? response.position : undefined);
}

function snapshot(
	options: RamanV2RunUnitOptions,
	microstep: RamanV2Microstep,
	fields: {
		completedUnits?: number;
		nextUnitIndex?: number;
		position?: SnapshotStagePosition;
		pendingAcquisitionId?: string;
		artifacts?: ToolResult["artifacts"];
		nextPlan?: string[];
		safeToResume?: boolean;
		status?: string;
		reason?: string;
	},
): void {
	writeRamanV2MicrostepSnapshot(options.cwd, {
		spec: options.spec,
		runId: options.runId,
		status: fields.status ?? "running",
		completedUnits: fields.completedUnits ?? 0,
		unitIndex: options.point.index,
		nextUnitIndex: fields.nextUnitIndex ?? options.point.index,
		microstep,
		commandId: options.commandId,
		lastKnownStagePosition: fields.position,
		pendingAcquisitionId: fields.pendingAcquisitionId,
		artifactRefs: fields.artifacts,
		nextPlan: fields.nextPlan,
		safeToResume: fields.safeToResume,
		reason: fields.reason,
	});
}

async function captureFrame(
	options: RamanV2RunUnitOptions,
	fileName: string,
	label: string,
	artifacts: ToolResult["artifacts"],
): Promise<{ image: number[][]; artifact: ToolResult["artifacts"][number] }> {
	const artifact = artifactRef(options.runId, fileName, label, "frame");
	const backend = options.camera?.backend ?? "fake";
	const response = await options.bridge.request<Record<string, unknown>>("camera", "capture_frame", {
		backend,
		bridgeDir: options.camera?.bridgeDir,
		timeoutMs: options.camera?.timeoutMs,
		imageFormat: options.camera?.imageFormat,
		minCaptureIntervalMs: options.camera?.minCaptureIntervalMs,
		fakeFocusZUm: options.fakeFocusZUm ?? pointZ(options.point),
		savePath: runArtifactPath(options.cwd, options.runId, fileName),
	});
	addArtifact(artifacts, artifact);
	return { image: parseImage(response.image), artifact };
}

async function runAutofocus(
	options: RamanV2RunUnitOptions,
	artifacts: ToolResult["artifacts"],
): Promise<RamanV2AutofocusRecord | undefined> {
	const autofocus = options.spec.domain?.raman?.autofocus;
	if (!autofocus?.enabled) return undefined;
	const autofocusRecord = autofocus as Record<string, unknown>;
	const positions = autofocusZPositions(options.point, autofocusRecord);
	const metric = typeof autofocusRecord.metric === "string" ? autofocusRecord.metric : "tenengrad";
	const samples: FocusSample[] = [];
	for (const [index, zUm] of positions.entries()) {
		await options.bridge.request("stage", "move_absolute", { zUm, simulateDurationMs: options.settleTimeoutMs ?? 0 });
		const position = await stagePosition(options.bridge);
		snapshot(options, "stage_position_confirmed", {
			position,
			artifacts,
			safeToResume: true,
			nextPlan: ["capture autofocus frame", "calculate focus score"],
		});
		const frame = await captureFrame(
			options,
			`artifacts/frames/point_${options.point.index}_autofocus_${index}.pgm`,
			`Autofocus frame point ${options.point.index} step ${index}`,
			artifacts,
		);
		snapshot(options, "autofocus_frame_captured", {
			position,
			artifacts,
			safeToResume: true,
			nextPlan: ["calculate focus score", "continue autofocus scan"],
		});
		const focus = await options.bridge.request<Record<string, unknown>>("focus_metric", "calc_score", {
			metric,
			image: frame.image,
		});
		const sample = { zUm, score: numberField(focus, "score"), frameArtifact: frame.artifact };
		samples.push(sample);
		snapshot(options, "autofocus_checkpoint", {
			position,
			artifacts,
			safeToResume: true,
			nextPlan: ["continue autofocus scan", "move to best focus"],
		});
	}
	const best = samples.reduce((currentBest, sample) => (sample.score > currentBest.score ? sample : currentBest));
	const confidence = focusConfidence(samples, best);
	const minConfidence = optionalNumberField(autofocusRecord, "minConfidence") ?? 0;
	if (confidence < minConfidence) {
		snapshot(options, "recovery_required", {
			artifacts,
			safeToResume: false,
			status: "recovering",
			reason: "autofocus confidence is below minConfidence",
		});
		throw new RamanV2WorkflowPauseError("autofocus_low_confidence", "autofocus confidence is below minConfidence");
	}
	await options.bridge.request("stage", "move_absolute", { zUm: best.zUm, simulateDurationMs: options.settleTimeoutMs ?? 0 });
	const position = await stagePosition(options.bridge);
	snapshot(options, "stage_position_confirmed", {
		position,
		artifacts,
		safeToResume: true,
		nextPlan: ["run XY correction", "begin spectrum acquisition"],
	});
	return {
		zBestUm: best.zUm,
		finalScore: best.score,
		confidence,
		curveArtifactId: best.frameArtifact.id,
	};
}

async function runXyCorrection(
	options: RamanV2RunUnitOptions,
	artifacts: ToolResult["artifacts"],
): Promise<RamanV2XyCorrectionRecord | undefined> {
	const xyCorrection = options.spec.domain?.raman?.xyCorrection;
	if (!xyCorrection?.enabled) return undefined;
	const currentFrame = await captureFrame(
		options,
		`artifacts/frames/point_${options.point.index}_xy_current.pgm`,
		`XY current frame point ${options.point.index}`,
		artifacts,
	);
	const reference = options.xyReferenceImage ?? currentFrame.image;
	const current = options.xyCurrentImage ?? currentFrame.image;
	const shift = await options.bridge.request<Record<string, unknown>>("drift_correction", "phase_correlation", {
		reference,
		current,
		maxShiftPx: 8,
	});
	const confidence = numberField(shift, "confidence");
	if (confidence < xyCorrection.minConfidence) {
		snapshot(options, "recovery_required", {
			artifacts,
			safeToResume: false,
			status: "recovering",
			reason: "XY correction confidence is below minConfidence",
		});
		throw new RamanV2WorkflowPauseError("calibration_low_confidence", "XY correction confidence is below minConfidence");
	}
	const pixelShift = isRecord(shift.pixelShift) ? shift.pixelShift : undefined;
	if (!pixelShift) throw new Error("phase_correlation result is missing pixelShift");
	const transform =
		options.xyTransform ??
		(() => {
			const resolution = resolveRamanXyCalibration(options.cwd, xyCorrection.transformArtifactId);
			if (!resolution.ok) throw new Error(resolution.issues.map((issue) => issue.message).join("; "));
			return resolution.artifact.pixelPerUm;
		})();
	const normalizedTransform = normalizeMatrix2x2(transform);
	if (!normalizedTransform) throw new Error("XY transform is not a finite 2x2 matrix");
	const correction = transformPixelsToStageUm(normalizedTransform, numberField(pixelShift, "dx"), numberField(pixelShift, "dy"));
	if (Math.max(Math.abs(correction.dxUm), Math.abs(correction.dyUm)) > xyCorrection.maxCorrectionUm) {
		snapshot(options, "recovery_required", {
			artifacts,
			safeToResume: false,
			status: "recovering",
			reason: "XY correction exceeds maxCorrectionUm",
		});
		throw new RamanV2WorkflowPauseError("calibration_low_confidence", "XY correction exceeds maxCorrectionUm");
	}
	const applied = options.xyApplyCorrection ?? true;
	if (applied) {
		const before = await stagePosition(options.bridge);
		await options.bridge.request("stage", "move_absolute", {
			xUm: before.xUm + correction.dxUm,
			yUm: before.yUm + correction.dyUm,
			simulateDurationMs: options.settleTimeoutMs ?? 0,
		});
	}
	const position = await stagePosition(options.bridge);
	snapshot(options, "xy_correction_checkpoint", {
		position,
		artifacts,
		safeToResume: true,
		nextPlan: ["begin spectrum acquisition", "complete unit"],
	});
	return { ...correction, confidence, applied };
}

async function runSpectrumAcquisition(
	options: RamanV2RunUnitOptions,
	artifacts: ToolResult["artifacts"],
): Promise<{ spectrum?: RamanV2SpectrumRecord; metadata?: Record<string, unknown> }> {
	const acquisition = options.spec.domain?.raman?.acquisition;
	if (!acquisition) return {};
	const fileName = `artifacts/spectra/point_${options.point.index}.${acquisition.saveFormat}`;
	const spectrumArtifact = artifactRef(options.runId, fileName, `Raman spectrum point ${options.point.index}`, "spectrum");
	const backend = options.acquisition?.backend ?? "fake";
	const begun = await options.bridge.request<Record<string, unknown>>("spectrometer", "begin_acquisition", {
		...acquisition,
		backend,
		bridgeDir: options.acquisition?.bridgeDir,
		timeoutS: options.acquisition?.timeoutS,
		pollIntervalS: options.acquisition?.pollIntervalS,
		savePath: runArtifactPath(options.cwd, options.runId, fileName),
		simulateDurationMs: backend === "fake" ? (options.acquisitionSimulateDurationMs ?? 0) : undefined,
	});
	const acquisitionId = typeof begun.acquisitionId === "string" ? begun.acquisitionId : undefined;
	if (!acquisitionId) throw new Error("begin_acquisition result is missing acquisitionId");
	snapshot(options, "acquisition_started", {
		pendingAcquisitionId: acquisitionId,
		artifacts,
		safeToResume: true,
		nextPlan: ["poll spectrometer acquisition", "collect spectrum result"],
	});
	let poll = begun;
	while (!acquisitionComplete(poll.status)) {
		await delay(20);
		poll = await options.bridge.request<Record<string, unknown>>("spectrometer", "poll_acquisition", { acquisitionId });
		if (poll.status === "cancelled") {
			snapshot(options, "recovery_required", {
				pendingAcquisitionId: acquisitionId,
				artifacts,
				safeToResume: false,
				status: "aborted",
				reason: "spectrum acquisition was cancelled",
			});
			throw new RamanV2WorkflowAbortError("aborted", "spectrum acquisition was cancelled");
		}
		if (poll.status === "failed" || poll.status === "error") {
			snapshot(options, "recovery_required", {
				pendingAcquisitionId: acquisitionId,
				artifacts,
				safeToResume: false,
				status: "recovering",
				reason: `spectrum acquisition failed with status ${String(poll.status)}`,
			});
			throw new RamanV2WorkflowAbortError("acquisition_failed", `spectrum acquisition failed with status ${String(poll.status)}`);
		}
		snapshot(options, "acquisition_poll", {
			pendingAcquisitionId: acquisitionId,
			artifacts,
			safeToResume: true,
			nextPlan: ["poll spectrometer acquisition", "collect spectrum result"],
		});
	}
	const collected = await options.bridge.request<Record<string, unknown>>("spectrometer", "collect_result", { acquisitionId });
	addArtifact(artifacts, spectrumArtifact);
	snapshot(options, "artifact_collected", {
		artifacts,
		safeToResume: true,
		nextPlan: ["complete unit"],
	});
	const metadata = isRecord(collected.metadata) ? collected.metadata : {};
	return {
		spectrum: {
			artifactId: spectrumArtifact.id ?? `${options.runId}-spectrum-point-${options.point.index}`,
			integrationTimeS: numberField(metadata, "integrationTimeS"),
			accumulations: numberField(metadata, "accumulations"),
		},
		metadata,
	};
}

async function runThermalWait(options: RamanV2RunUnitOptions, artifacts: ToolResult["artifacts"]): Promise<RamanV2ThermalRecord | undefined> {
	const thermal = options.spec.domain?.thermal;
	if (!thermal?.enabled || thermal.waitBeforeAcquisition === false) return undefined;
	const target = await options.bridge.request<Record<string, unknown>>("thermal", "set_target_temp", {
		backend: options.thermal?.backend ?? "fake",
		targetTemperatureC: thermal.targetTemperatureC,
		toleranceC: thermal.toleranceC,
		stableWindowS: thermal.stableWindowS,
		simulateDurationMs: options.thermal?.simulateDurationMs ?? 0,
	});
	const position = await stagePosition(options.bridge);
	snapshot(options, "thermal_target_set", {
		position,
		artifacts,
		safeToResume: true,
		nextPlan: ["wait for thermal stability", "begin spectrum acquisition"],
	});
	const timeoutS = thermal.timeoutS ?? 30;
	const stable = await options.bridge.request<Record<string, unknown>>(
		"thermal",
		"wait_stable",
		{
			timeoutS,
			pollIntervalS: thermal.pollIntervalS,
		},
		timeoutS * 1000 + 1_000,
	);
	snapshot(options, "thermal_stable", {
		position,
		artifacts,
		safeToResume: true,
		nextPlan: ["begin spectrum acquisition"],
	});
	return {
		targetTemperatureC: numberField(target, "targetTemperatureC"),
		currentTemperatureC: numberField(stable, "currentTemperatureC"),
		toleranceC: numberField(stable, "toleranceC"),
		stable: stable.stable === true,
	};
}

export async function executeRamanV2RunUnit(options: RamanV2RunUnitOptions): Promise<RamanV2UnitRecord> {
	const artifacts: ToolResult["artifacts"] = [];
	if (options.stage) {
		await options.bridge.request("stage", "connect", options.stage);
	}
	snapshot(options, "unit_started", {
		safeToResume: false,
		nextPlan: ["move stage to point"],
	});
	const before = await stagePosition(options.bridge);
	snapshot(options, "stage_move_commanded", {
		position: before,
		safeToResume: false,
		nextPlan: ["wait for stage position confirmation"],
	});
	await options.bridge.request("stage", "move_absolute", {
		xUm: options.point.xUm,
		yUm: options.point.yUm,
		zUm: pointZ(options.point),
		simulateDurationMs: options.settleTimeoutMs ?? 0,
	});
	let current = await stagePosition(options.bridge);
	snapshot(options, "stage_position_confirmed", {
		position: current,
		artifacts,
		safeToResume: true,
		nextPlan: ["run autofocus", "run XY correction", "begin spectrum acquisition"],
	});
	const autofocus = await runAutofocus(options, artifacts);
	const xyCorrection = await runXyCorrection(options, artifacts);
	const thermal = await runThermalWait(options, artifacts);
	const acquisition = await runSpectrumAcquisition(options, artifacts);
	current = await stagePosition(options.bridge);
	snapshot(options, "unit_completed", {
		completedUnits: options.point.index + 1,
		nextUnitIndex: options.point.index + 1,
		position: current,
		artifacts,
		safeToResume: true,
		nextPlan: ["advance to next unit"],
	});
	const record: RamanV2UnitRecord = {
		...options.point,
		status: "success",
		positionBefore: before,
		positionAfter: current,
		artifactRefs: artifacts,
	};
	if (autofocus) {
		record.autofocus = autofocus;
		record.focusScore = autofocus.finalScore;
	}
	if (xyCorrection) record.xyCorrection = xyCorrection;
	if (thermal) record.thermal = thermal;
	if (acquisition.spectrum) record.spectrum = acquisition.spectrum;
	if (acquisition.metadata) record.spectrumMetadata = acquisition.metadata;
	return record;
}
