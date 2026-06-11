import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { autoFitAndRecordRamanXyCalibration, fitAndRecordRamanXyCalibration, recordRamanXyCalibration } from "../kernel/raman-calibration.ts";
import {
	RamanAutoXyCalibrationParamsSchema,
	RamanFitXyCalibrationParamsSchema,
	RamanRecordXyCalibrationParamsSchema,
	type ToolResult,
} from "../schemas.ts";

export const ramanRecordXyCalibrationTool = {
	name: "raman_record_xy_calibration",
	label: "Raman XY Calibration",
	description: "Record an operator-approved Raman XY pixel-to-stage calibration artifact for later transformArtifactId use.",
	promptSnippet: "Record a Raman XY calibration artifact for bounded Raman specs",
	promptGuidelines: [
		"Use raman_record_xy_calibration only as an operator maintenance action.",
		"Reference the returned calibrationId from domain.raman.xyCorrection.transformArtifactId.",
	],
	parameters: RamanRecordXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = recordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanRecordXyCalibrationParamsSchema, ToolResult>;

export const ramanFitXyCalibrationTool = {
	name: "raman_fit_xy_calibration",
	label: "Fit Raman XY Calibration",
	description: "Fit and record an operator-approved Raman XY calibration artifact from stage shifts and frame pairs.",
	promptSnippet: "Fit a Raman XY calibration matrix from approved frame pairs",
	promptGuidelines: [
		"Use raman_fit_xy_calibration only as an operator maintenance action.",
		"Provide at least two non-collinear stage shifts with matching reference/current frame pairs.",
	],
	parameters: RamanFitXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await fitAndRecordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanFitXyCalibrationParamsSchema, ToolResult>;

export const ramanAutoXyCalibrationTool = {
	name: "raman_auto_xy_calibration",
	label: "Auto Raman XY Calibration",
	description: "Run an operator-approved Raman XY calibration sequence that moves the stage, captures frames, fits, and records a calibration artifact.",
	promptSnippet: "Run an approved Raman XY calibration movement/capture sequence",
	promptGuidelines: [
		"Use raman_auto_xy_calibration only as an operator maintenance action.",
		"Use the memory/fake backend for no-hardware checks; use mc_newton_xyz and labspec_file_bridge only during supervised hardware maintenance.",
	],
	parameters: RamanAutoXyCalibrationParamsSchema,
	executionMode: "sequential",
	async execute(toolCallId, params, _signal, _onUpdate, ctx) {
		const result = await autoFitAndRecordRamanXyCalibration(params, { cwd: ctx.cwd, commandId: toolCallId });
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
	},
} satisfies ToolDefinition<typeof RamanAutoXyCalibrationParamsSchema, ToolResult>;
