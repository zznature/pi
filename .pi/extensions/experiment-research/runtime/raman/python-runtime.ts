import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactRef } from "../../schemas/tool-result.ts";
import {
	failedActionResult,
	successActionResult,
	type ActionError,
	type ActionResult,
	type AutofocusRunSingleAction,
	type FrameCaptureLatestAction,
	type SpectrometerAcquireSpectrumAction,
	type StageMoveAbsoluteAndWaitAction,
} from "./actions.ts";
import { registerRamanLiveRuntime, clearRamanLiveRuntime, type RamanLivePreflightResult, type RamanLiveRuntime } from "./live-runtime.ts";
import {
	FrameProviderResourceValidator,
	SpectrometerResourceValidator,
	StageResourceValidator,
	type FrameProviderResource,
	type SpectrometerResource,
	type StageResource,
} from "./resources.ts";

export const RAMAN_PYTHON_RUNTIME_CONFIG_PATH = join(".pi", "experiment-research", "raman-runtime.json");

interface RamanPythonRuntimeConfig {
	enabled: boolean;
	pythonExecutable?: string;
	pythonRoot?: string;
	stage: StageResource;
	frameProvider: FrameProviderResource;
	spectrometer: SpectrometerResource;
	preflight?: {
		requirePythonRoot?: boolean;
		requireBridgeDirs?: boolean;
		connectStage?: boolean;
	};
	spectrum?: {
		outputDir?: string;
		saturationIntensity?: number;
		targetPeakMinWavenumber?: number;
		targetPeakMaxWavenumber?: number;
	};
}

type PythonActionKind = "preflight" | "stage_move" | "frame_capture" | "autofocus" | "spectrum";

interface PythonRequest {
	action: PythonActionKind;
	pythonRoot: string;
	stage: StageResource;
	frameProvider: FrameProviderResource;
	spectrometer: SpectrometerResource;
	payload: Record<string, unknown>;
}

interface PythonSuccess {
	ok: true;
	summary: string;
	payload: Record<string, unknown>;
}

interface PythonFailure {
	ok: false;
	errorCode: string;
	message: string;
	retrySafe: boolean;
	needsOperator: boolean;
	safeToResume: boolean;
	payload?: Record<string, unknown>;
}

type PythonResponse = PythonSuccess | PythonFailure;

const PYTHON_BRIDGE_SOURCE = String.raw`
import json
import math
import statistics
import sys
from pathlib import Path

def emit(value):
    print(json.dumps(value, ensure_ascii=False))

def fail(error_code, message, retry_safe=False, needs_operator=True, safe_to_resume=False, payload=None):
    emit({
        "ok": False,
        "errorCode": error_code,
        "message": message,
        "retrySafe": retry_safe,
        "needsOperator": needs_operator,
        "safeToResume": safe_to_resume,
        "payload": payload or {},
    })

def success(summary, payload=None):
    emit({"ok": True, "summary": summary, "payload": payload or {}})

def stable_file(path):
    try:
        if not path.exists() or path.stat().st_size <= 0:
            return False
        return True
    except OSError:
        return False

def latest_frame_path(bridge_dir, image_format):
    frame_dir = bridge_dir / "frames"
    candidates = sorted(frame_dir.glob(f"*.{image_format}"), key=lambda p: p.stat().st_mtime if p.exists() else 0)
    for path in reversed(candidates):
        if stable_file(path):
            return str(path)
    return ""

def parse_spectrum_metrics(output_path, saturation_intensity=None, target_min=None, target_max=None):
    if not output_path:
        return {"saturated": False, "snr": 0.0, "targetPeakBaselineRatio": 0.0}
    path = Path(output_path)
    if not path.exists():
        return {"saturated": False, "snr": 0.0, "targetPeakBaselineRatio": 0.0}
    points = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.replace(",", " ").split()
        values = []
        for part in parts:
            try:
                values.append(float(part))
            except ValueError:
                pass
        if len(values) >= 2:
            points.append((values[0], values[1]))
        elif len(values) == 1:
            points.append((float(len(points)), values[0]))
    if not points:
        return {"saturated": False, "snr": 0.0, "targetPeakBaselineRatio": 0.0}
    intensities = [point[1] for point in points]
    baseline = statistics.median(intensities)
    noise = statistics.pstdev(intensities) if len(intensities) > 1 else 0.0
    peak = max(intensities)
    if target_min is not None and target_max is not None:
        target_values = [value for x, value in points if target_min <= x <= target_max]
        if target_values:
            peak = max(target_values)
    snr = (peak - baseline) / noise if noise > 0 else 0.0
    denominator = abs(baseline) if abs(baseline) > 1e-9 else 1.0
    return {
        "saturated": bool(saturation_intensity is not None and max(intensities) >= saturation_intensity),
        "snr": float(max(0.0, snr)),
        "targetPeakBaselineRatio": float(peak / denominator),
    }

try:
    request = json.loads(sys.stdin.read())
    python_root = Path(request["pythonRoot"]).resolve()
    sys.path.insert(0, str(python_root))
    action = request["action"]
    stage = request["stage"]
    frame_provider = request["frameProvider"]
    spectrometer = request["spectrometer"]
    payload = request.get("payload", {})

    if action == "preflight":
        details = {
            "pythonRootExists": python_root.exists(),
            "frameBridgeDirExists": Path(frame_provider["config"]["bridgeDir"]).exists(),
            "spectrumBridgeDirExists": Path(spectrometer["config"]["bridgeDir"]).exists(),
        }
        if payload.get("requirePythonRoot", True) and not details["pythonRootExists"]:
            fail("python_root_missing", f"Python root does not exist: {python_root}", payload=details)
        elif payload.get("requireBridgeDirs", False) and (not details["frameBridgeDirExists"] or not details["spectrumBridgeDirExists"]):
            fail("bridge_dir_missing", "One or more LabSpec bridge directories are missing.", payload=details)
        elif payload.get("connectStage", False):
            from stage.mc_newton_xyz_stage import MCNewtonXYZStageController
            controller = MCNewtonXYZStageController(
                stage["config"]["port"],
                baudrate=stage["config"]["baudrate"],
                x_channel=stage["config"]["xChannel"],
                y_channel=stage["config"]["yChannel"],
                z_channel=stage["config"]["zChannel"],
            )
            try:
                controller.connect()
                position = controller.get_position_um()
                details["stagePosition"] = {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um}
            finally:
                controller.disconnect()
            success("Python Raman preflight completed.", details)
        else:
            success("Python Raman preflight completed.", details)

    elif action == "stage_move":
        from stage.mc_newton_xyz_stage import MCNewtonXYZStageController
        target = payload["target"]
        controller = MCNewtonXYZStageController(
            stage["config"]["port"],
            baudrate=stage["config"]["baudrate"],
            x_channel=stage["config"]["xChannel"],
            y_channel=stage["config"]["yChannel"],
            z_channel=stage["config"]["zChannel"],
        )
        try:
            controller.connect()
            controller.move_absolute_and_wait_um(
                x_um=target.get("xUm"),
                y_um=target.get("yUm"),
                z_um=target.get("zUm"),
                timeout_ms=int(payload["timeoutMs"]),
            )
            position = controller.get_position_um()
            success("Stage moved to requested point.", {"finalPosition": {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um}})
        finally:
            controller.disconnect()

    elif action == "frame_capture":
        from pathlib import Path
        from autofocus.labspec_file_bridge import LabSpecFileBridgeFrameProvider
        bridge_dir = Path(frame_provider["config"]["bridgeDir"])
        image_format = frame_provider["config"]["imageFormat"]
        provider = LabSpecFileBridgeFrameProvider(
            bridge_dir,
            image_format=image_format,
            min_capture_interval_ms=frame_provider["config"]["minCaptureIntervalMs"],
            initial_timeout_ms=int(payload["timeoutMs"]),
        )
        try:
            provider.connect()
            frame = provider.wait_for_next(after_ts=0.0, timeout_ms=int(payload["timeoutMs"]))
            success("Frame captured through LabSpec bridge.", {
                "timestamp": frame.timestamp,
                "seq": frame.seq,
                "shape": list(frame.image.shape),
                "framePath": latest_frame_path(bridge_dir, image_format),
            })
        finally:
            provider.disconnect()

    elif action == "autofocus":
        from pathlib import Path
        from autofocus.controller import AutofocusController
        from autofocus.labspec_file_bridge import LabSpecFileBridgeFrameProvider
        from autofocus.models import AutofocusParams, ROI
        from stage.mc_newton_xyz_stage import MCNewtonXYZStageController
        z_range = stage["limits"]["zRangeUm"]
        params = payload.get("params") or {}
        stage_controller = MCNewtonXYZStageController(
            stage["config"]["port"],
            baudrate=stage["config"]["baudrate"],
            x_channel=stage["config"]["xChannel"],
            y_channel=stage["config"]["yChannel"],
            z_channel=stage["config"]["zChannel"],
        )
        frame_provider_runtime = LabSpecFileBridgeFrameProvider(
            Path(frame_provider["config"]["bridgeDir"]),
            image_format=frame_provider["config"]["imageFormat"],
            min_capture_interval_ms=frame_provider["config"]["minCaptureIntervalMs"],
            initial_timeout_ms=int(payload["timeoutMs"]),
        )
        try:
            stage_controller.connect()
            frame_provider_runtime.connect()
            controller = AutofocusController(stage_controller, frame_provider_runtime)
            result = controller.run_single(
                ROI(**payload["roi"]),
                AutofocusParams(
                    z_min_um=z_range[0],
                    z_max_um=z_range[1],
                    coarse_range_um=params.get("coarseRangeUm", 80.0),
                    coarse_step_um=params.get("coarseStepUm", 10.0),
                    fine_range_um=params.get("fineRangeUm", 15.0),
                    fine_step_um=params.get("fineStepUm", 2.0),
                ),
            )
            response_payload = {
                "status": str(result.status.value),
                "zBestUm": result.z_best_um,
                "finalScore": result.final_score,
                "confidence": result.confidence,
                "message": result.message,
            }
            if str(result.status.value) == "ok":
                success("Autofocus completed.", response_payload)
            else:
                fail(f"autofocus_{result.status.value}", result.message or str(result.status.value), retry_safe=True, safe_to_resume=True, payload=response_payload)
        finally:
            frame_provider_runtime.disconnect()
            stage_controller.disconnect()

    elif action == "spectrum":
        from pathlib import Path
        from mapping.labspec import LabSpecFileBridgeRamanAcquirer, LabSpecWorkerAcquisitionConfig
        acquisition = payload["acquisition"]
        output_dir = payload.get("outputDir") or str(Path(spectrometer["config"]["bridgeDir"]) / "spectra")
        output_path = Path(output_dir) / f"{payload['pointId']}.{acquisition.get('saveFormat') or 'txt'}"
        config = LabSpecWorkerAcquisitionConfig(
            bridge_dir=spectrometer["config"]["bridgeDir"],
            integration_time_s=acquisition["integrationTimeMs"] / 1000.0,
            accumulations=acquisition["accumulations"],
            timeout_s=payload["timeoutMs"] / 1000.0,
            save_path=output_path,
            save_format=acquisition.get("saveFormat") or "txt",
            request_filename=spectrometer["config"]["requestFilename"],
            result_filename=spectrometer["config"]["resultFilename"],
            laser_power_percent=acquisition.get("laserPowerMw"),
        )
        acquirer = LabSpecFileBridgeRamanAcquirer(config)
        result = acquirer.acquire_point(payload["pointId"], payload.get("metadata") or {})
        result_payload = {
            "outputPath": result.output_path or "",
            "message": result.message,
            "metadata": result.metadata,
        }
        result_payload.update(parse_spectrum_metrics(
            result.output_path,
            payload.get("saturationIntensity"),
            payload.get("targetPeakMinWavenumber"),
            payload.get("targetPeakMaxWavenumber"),
        ))
        spectrum_plot_path = result.metadata.get("spectrum_plot_path", "")
        if spectrum_plot_path:
            result_payload["spectrumPlotPath"] = spectrum_plot_path
        if result.ok:
            success("Spectrum acquired through LabSpec bridge.", result_payload)
        else:
            fail("spectrum_acquisition_failed", result.message or "LabSpec spectrum acquisition failed.", retry_safe=False, safe_to_resume=False, payload=result_payload)

    else:
        fail("unknown_python_action", f"Unsupported Python Raman action: {action}")
except Exception as exc:
    fail("python_runtime_error", str(exc), retry_safe=False, needs_operator=True, safe_to_resume=False)
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function asArtifact(path: unknown, kind: string, label: string): ArtifactRef[] {
	if (typeof path !== "string" || path.length === 0) {
		return [];
	}
	return [
		{
			artifactId: `${kind}-${randomUUID().slice(0, 8)}`,
			kind,
			path: path.replace(/\\/gu, "/"),
			label,
		},
	];
}

function toActionFailure(response: PythonFailure): ActionResult {
	const error: ActionError = {
		errorCode: response.errorCode,
		message: response.message,
		retrySafe: response.retrySafe,
		needsOperator: response.needsOperator,
		safeToResume: response.safeToResume,
	};
	return failedActionResult(response.message, error, response.payload ?? {});
}

function parsePythonResponse(stdout: string): PythonResponse {
	const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
	const lastLine = lines[lines.length - 1];
	if (!lastLine) {
		return {
			ok: false,
			errorCode: "python_runtime_no_output",
			message: "Python Raman runtime returned no structured output.",
			retrySafe: false,
			needsOperator: true,
			safeToResume: false,
		};
	}
	const parsed: unknown = JSON.parse(lastLine);
	if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
		throw new Error("Python Raman runtime returned an invalid response shape.");
	}
	if (parsed.ok) {
		return {
			ok: true,
			summary: readString(parsed, "summary") ?? "Python Raman action completed.",
			payload: isRecord(parsed.payload) ? parsed.payload : {},
		};
	}
	return {
		ok: false,
		errorCode: readString(parsed, "errorCode") ?? "python_runtime_error",
		message: readString(parsed, "message") ?? "Python Raman action failed.",
		retrySafe: readBoolean(parsed, "retrySafe") ?? false,
		needsOperator: readBoolean(parsed, "needsOperator") ?? true,
		safeToResume: readBoolean(parsed, "safeToResume") ?? false,
		payload: isRecord(parsed.payload) ? parsed.payload : {},
	};
}

async function runPythonBridge(
	config: RamanPythonRuntimeConfig,
	action: PythonActionKind,
	payload: Record<string, unknown>,
	timeoutMs: number,
): Promise<PythonResponse> {
	const request: PythonRequest = {
		action,
		pythonRoot: resolve(config.pythonRoot ?? join(process.cwd(), "docs", "Raman")),
		stage: config.stage,
		frameProvider: config.frameProvider,
		spectrometer: config.spectrometer,
		payload,
	};

	return new Promise((resolveResult) => {
		const child = spawn(config.pythonExecutable ?? "python", ["-c", PYTHON_BRIDGE_SOURCE], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill();
			resolveResult({
				ok: false,
				errorCode: "python_runtime_timeout",
				message: `Python Raman action ${action} timed out after ${timeoutMs} ms.`,
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
				payload: { stderr },
			});
		}, timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});
		child.on("error", (cause) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolveResult({
				ok: false,
				errorCode: "python_runtime_spawn_failed",
				message: cause.message,
				retrySafe: false,
				needsOperator: true,
				safeToResume: false,
			});
		});
		child.on("close", (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				resolveResult({
					ok: false,
					errorCode: "python_runtime_exit_failed",
					message: `Python Raman action ${action} exited with code ${code}.`,
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
					payload: { stderr, stdout },
				});
				return;
			}
			try {
				resolveResult(parsePythonResponse(stdout));
			} catch (cause) {
				resolveResult({
					ok: false,
					errorCode: "python_runtime_parse_failed",
					message: cause instanceof Error ? cause.message : String(cause),
					retrySafe: false,
					needsOperator: true,
					safeToResume: false,
					payload: { stdout, stderr },
				});
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

function readConfig(cwd: string): RamanPythonRuntimeConfig | undefined {
	const path = join(cwd, RAMAN_PYTHON_RUNTIME_CONFIG_PATH);
	if (!existsSync(path)) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") {
		throw new Error(`Invalid Raman Python runtime config at ${path}: enabled must be boolean.`);
	}
	if (
		parsed.enabled &&
		(!StageResourceValidator.Check(parsed.stage) ||
			!FrameProviderResourceValidator.Check(parsed.frameProvider) ||
			!SpectrometerResourceValidator.Check(parsed.spectrometer))
	) {
		throw new Error(`Invalid Raman Python runtime config at ${path}: enabled config requires valid stage, frameProvider, and spectrometer resources.`);
	}
	return parsed as unknown as RamanPythonRuntimeConfig;
}

function createActionResult(response: PythonResponse, artifacts: ArtifactRef[] = []): ActionResult {
	if (!response.ok) {
		return toActionFailure(response);
	}
	return successActionResult(response.summary, response.payload, artifacts);
}

export function createRamanPythonRuntime(cwd: string, config: RamanPythonRuntimeConfig): RamanLiveRuntime {
	const resolvedConfig: RamanPythonRuntimeConfig = {
		...config,
		pythonRoot: resolve(cwd, config.pythonRoot ?? join("docs", "Raman")),
	};
	return {
		preflight: async (): Promise<RamanLivePreflightResult> => {
			const response = await runPythonBridge(
				resolvedConfig,
				"preflight",
				{
					requirePythonRoot: resolvedConfig.preflight?.requirePythonRoot ?? true,
					requireBridgeDirs: resolvedConfig.preflight?.requireBridgeDirs ?? false,
					connectStage: resolvedConfig.preflight?.connectStage ?? false,
				},
				30_000,
			);
			return {
				preflightReady: response.ok,
				controlAvailable: response.ok,
				details: response.ok ? response.payload : { errorCode: response.errorCode, message: response.message },
			};
		},
		stage: {
			resource: resolvedConfig.stage,
			moveAbsoluteAndWait: async (action: StageMoveAbsoluteAndWaitAction): Promise<ActionResult> =>
				createActionResult(
					await runPythonBridge(
						resolvedConfig,
						"stage_move",
						{ target: action.target, timeoutMs: action.timeoutMs },
						action.timeoutMs + 10_000,
					),
				),
		},
		autofocus: {
			runSingle: async (action: AutofocusRunSingleAction): Promise<ActionResult> =>
				createActionResult(
					await runPythonBridge(
						resolvedConfig,
						"autofocus",
						{ roi: action.roi, params: action.params ?? {}, timeoutMs: action.timeoutMs },
						action.timeoutMs + 10_000,
					),
				),
		},
		frame: {
			resource: resolvedConfig.frameProvider,
			captureLatest: async (action: FrameCaptureLatestAction): Promise<ActionResult> => {
				const response = await runPythonBridge(
					resolvedConfig,
					"frame_capture",
					{ timeoutMs: action.timeoutMs },
					action.timeoutMs + 10_000,
				);
				return createActionResult(response, response.ok ? asArtifact(response.payload.framePath, "frame", "LabSpec frame") : []);
			},
		},
		spectrometer: {
			resource: resolvedConfig.spectrometer,
			acquireSpectrum: async (action: SpectrometerAcquireSpectrumAction): Promise<ActionResult> => {
				const pointId = `point-${randomUUID().slice(0, 8)}`;
				const response = await runPythonBridge(
					resolvedConfig,
					"spectrum",
					{
						pointId,
						acquisition: action.acquisition,
						timeoutMs: action.timeoutMs,
						outputDir: resolvedConfig.spectrum?.outputDir,
						saturationIntensity: resolvedConfig.spectrum?.saturationIntensity,
						targetPeakMinWavenumber: resolvedConfig.spectrum?.targetPeakMinWavenumber,
						targetPeakMaxWavenumber: resolvedConfig.spectrum?.targetPeakMaxWavenumber,
					},
					action.timeoutMs + 10_000,
				);
				const artifacts = response.ok
					? [
							...asArtifact(response.payload.outputPath, "spectrum", "LabSpec spectrum"),
							...asArtifact(response.payload.spectrumPlotPath, "spectrum-plot", "LabSpec spectrum plot"),
						]
					: [];
				return createActionResult(response, artifacts);
			},
		},
	};
}

export function registerConfiguredRamanPythonRuntime(cwd: string): boolean {
	const config = readConfig(cwd);
	if (!config) {
		return false;
	}
	if (!config.enabled) {
		clearRamanLiveRuntime(cwd);
		return false;
	}
	registerRamanLiveRuntime(cwd, createRamanPythonRuntime(cwd, config));
	return true;
}
