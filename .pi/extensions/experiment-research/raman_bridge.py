"""Long-lived Raman bridge process using JSON-lines over stdio.

Stdout is reserved for protocol messages. Diagnostics must go to stderr.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import queue
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PIL_IMAGE: Any | None = None
NP: Any | None = None
AUTOFOCUS_CONTROLLER: Any | None = None
AUTOFOCUS_PARAMS: Any | None = None
AUTOFOCUS_ROI: Any | None = None
FOCUS_STATUS: Any | None = None
LABSPEC_FRAME_PROVIDER: Any | None = None
CALIBRATION_ROI: Any | None = None
PIXEL_STAGE_TRANSFORM: Any | None = None
ESTIMATE_XY_CORRECTION: Any | None = None
ESTIMATE_TRANSLATION: Any | None = None
LOW_CONFIDENCE_ERROR: type[Exception] | None = None
SINGULAR_TRANSFORM_ERROR: type[Exception] | None = None
ALGORITHM_IMPORT_ERROR: Exception | None = None


def debug(message: str) -> None:
    if os.environ.get("RAMAN_BRIDGE_DEBUG") == "1":
        print(f"raman_bridge debug: {message}", file=sys.stderr, flush=True)


def preload_algorithm_modules(stage_root: Path) -> None:
    """Import numpy/PIL-backed algorithm modules before reader threads start."""

    global ALGORITHM_IMPORT_ERROR
    global AUTOFOCUS_CONTROLLER
    global AUTOFOCUS_PARAMS
    global AUTOFOCUS_ROI
    global CALIBRATION_ROI
    global ESTIMATE_XY_CORRECTION
    global ESTIMATE_TRANSLATION
    global FOCUS_STATUS
    global LABSPEC_FRAME_PROVIDER
    global LOW_CONFIDENCE_ERROR
    global NP
    global PIL_IMAGE
    global PIXEL_STAGE_TRANSFORM
    global SINGULAR_TRANSFORM_ERROR

    if str(stage_root) not in sys.path:
        sys.path.insert(0, str(stage_root))
    try:
        from PIL import Image
        import numpy
        from autofocus.controller import AutofocusController
        from autofocus.labspec_file_bridge import LabSpecFileBridgeFrameProvider
        from autofocus.models import AutofocusParams, FocusStatus, ROI as FocusROI
        from calibration.exceptions import LowConfidenceError, SingularTransformError
        from calibration.models import ROI as CalibrationROI
        from calibration.stage_transform import PixelStageTransform
        from calibration.phase_correlation import estimate_translation
        from calibration.xy_corrector import estimate_xy_correction

        PIL_IMAGE = Image
        NP = numpy
        AUTOFOCUS_CONTROLLER = AutofocusController
        AUTOFOCUS_PARAMS = AutofocusParams
        AUTOFOCUS_ROI = FocusROI
        FOCUS_STATUS = FocusStatus
        LABSPEC_FRAME_PROVIDER = LabSpecFileBridgeFrameProvider
        CALIBRATION_ROI = CalibrationROI
        PIXEL_STAGE_TRANSFORM = PixelStageTransform
        ESTIMATE_TRANSLATION = estimate_translation
        ESTIMATE_XY_CORRECTION = estimate_xy_correction
        LOW_CONFIDENCE_ERROR = LowConfidenceError
        SINGULAR_TRANSFORM_ERROR = SingularTransformError
        ALGORITHM_IMPORT_ERROR = None
    except Exception as error:
        ALGORITHM_IMPORT_ERROR = error
        print(f"raman_bridge algorithm imports unavailable: {error}", file=sys.stderr, flush=True)


class BridgeError(Exception):
    """Error with a stable cross-boundary Raman code."""

    def __init__(self, code: str, message: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.detail = detail or {}


@dataclass(frozen=True)
class StagePosition:
    x_um: float
    y_um: float
    z_um: float


class MemoryStage:
    def __init__(self) -> None:
        self.position = StagePosition(0.0, 0.0, 0.0)
        self.stopped = False
        self.closed = False

    def connect(self) -> None:
        return None

    def disconnect(self) -> None:
        self.closed = True

    def get_position_um(self) -> StagePosition:
        return self.position

    def get_axis_position_um(self, axis: str, *, preserve_enabled_channels: bool = False) -> float:
        _ = preserve_enabled_channels
        if axis == "x":
            return self.position.x_um
        if axis == "y":
            return self.position.y_um
        if axis == "z":
            return self.position.z_um
        raise ValueError(f"Unsupported axis: {axis}")

    def enable_only_axis(self, _axis: str) -> None:
        return None

    def disable_all_axes(self) -> None:
        return None

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        self.position = StagePosition(
            self.position.x_um if x_um is None else float(x_um),
            self.position.y_um if y_um is None else float(y_um),
            self.position.z_um if z_um is None else float(z_um),
        )

    def move_relative_um(
        self,
        *,
        dx_um: float = 0.0,
        dy_um: float = 0.0,
        dz_um: float = 0.0,
    ) -> None:
        self.move_absolute_um(
            x_um=self.position.x_um + float(dx_um),
            y_um=self.position.y_um + float(dy_um),
            z_um=self.position.z_um + float(dz_um),
        )

    def wait_settled(self, _timeout_ms: int) -> None:
        return None

    def stop(self) -> None:
        self.stopped = True


class XYZStageZAdapter:
    """Adapt an XYZ stage object to the autofocus ZStage protocol."""

    def __init__(self, xyz_stage: Any) -> None:
        self._xyz_stage = xyz_stage

    def get_position_um(self) -> float:
        get_axis_position_um = getattr(self._xyz_stage, "get_axis_position_um", None)
        if callable(get_axis_position_um):
            return float(get_axis_position_um("z", preserve_enabled_channels=True))
        return float(getattr(self._xyz_stage.get_position_um(), "z_um", 0.0))

    def move_absolute_um(self, z_um: float) -> None:
        self._xyz_stage.move_absolute_um(z_um=float(z_um))

    def move_relative_um(self, dz_um: float) -> None:
        self._xyz_stage.move_relative_um(dz_um=float(dz_um))

    def wait_settled(self, timeout_ms: int) -> None:
        wait_settled = getattr(self._xyz_stage, "wait_settled")
        try:
            wait_settled(int(timeout_ms), axes={"z"})
        except TypeError as exc:
            if "axes" not in str(exc):
                raise
            wait_settled(int(timeout_ms))

    def stop(self) -> None:
        self._xyz_stage.stop()

    def enter_z_only(self) -> None:
        enable_only_axis = getattr(self._xyz_stage, "enable_only_axis", None)
        if callable(enable_only_axis):
            enable_only_axis("z")

    def exit_z_only(self) -> None:
        disable_all_axes = getattr(self._xyz_stage, "disable_all_axes", None)
        if callable(disable_all_axes):
            disable_all_axes()


class BridgeState:
    def __init__(self, stage_root: Path) -> None:
        self.stage_root = stage_root
        self.stage: Any | None = None
        self.stage_adapter = "memory"
        self.lock = threading.Lock()
        self.stage_operation_lock = threading.RLock()

    def close(self) -> None:
        with self.lock:
            if self.stage is None:
                return
            disconnect = getattr(self.stage, "disconnect", None)
            if callable(disconnect):
                disconnect()
            self.stage = None

    def stop(self) -> None:
        with self.lock:
            if self.stage is None:
                return
            stop = getattr(self.stage, "stop", None)
            if callable(stop):
                stop()


@dataclass(frozen=True)
class Command:
    request_id: str
    action: str
    payload: dict[str, Any]


def write_protocol(value: dict[str, Any], output_lock: threading.Lock) -> None:
    with output_lock:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def write_error(request_id: str, error: BridgeError, output_lock: threading.Lock) -> None:
    write_protocol(
        {
            "id": request_id,
            "ok": False,
            "error": {
                "code": error.code,
                "message": str(error),
                "detail": error.detail,
            },
        },
        output_lock,
    )


def write_exception(request_id: str, error: Exception, output_lock: threading.Lock) -> None:
    print(f"raman_bridge exception: {error}", file=sys.stderr)
    write_error(request_id, map_exception(error), output_lock)


def map_exception(error: Exception) -> BridgeError:
    if isinstance(error, BridgeError):
        return error
    name = error.__class__.__name__
    mapping = {
        "StageConnectionError": "stage_connection_error",
        "StageCommandError": "stage_command_error",
        "StageTimeoutError": "stage_timeout",
        "FrameTimeoutError": "frame_timeout",
    }
    return BridgeError(mapping.get(name, "bridge_crashed"), str(error), {"exception": name})


def parse_payload(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def wait_stage_settled(stage: Any, timeout_ms: int, axes: set[str] | None = None) -> None:
    if axes is None:
        stage.wait_settled(timeout_ms)
        return
    try:
        stage.wait_settled(timeout_ms, axes=axes)
    except TypeError as exc:
        if "axes" not in str(exc):
            raise
        stage.wait_settled(timeout_ms)


def position_to_wire(position: Any) -> dict[str, float]:
    return {
        "xUm": float(getattr(position, "x_um", 0.0)),
        "yUm": float(getattr(position, "y_um", 0.0)),
        "zUm": float(getattr(position, "z_um", 0.0)),
    }


def load_real_stage(stage_root: Path, payload: dict[str, Any]) -> Any:
    if str(stage_root) not in sys.path:
        sys.path.insert(0, str(stage_root))
    from stage.mc_newton_xyz_stage import MCNewtonXYZStageController

    port = payload.get("port")
    if not isinstance(port, str) or not port:
        raise BridgeError("stage_connection_error", "stage.port is required for mc_newton_xyz")
    channels = parse_payload(payload.get("channels"))
    stage = MCNewtonXYZStageController(
        port,
        x_channel=int(channels.get("x", 1)),
        y_channel=int(channels.get("y", 2)),
        z_channel=int(channels.get("z", 3)),
        default_cmd_wait_ms=100.0,
        exclusive_channel=False,
        stability_tolerance_um=0.5,
        settle_correction_attempts=3,
    )
    stage.connect()
    stage.apply_fast_move_profile()
    return stage


def create_stage(stage_root: Path, payload: dict[str, Any]) -> tuple[str, Any]:
    adapter = payload.get("adapter", "memory")
    if adapter == "memory":
        stage = MemoryStage()
        stage.connect()
        return "memory", stage
    if adapter == "mc_newton_xyz":
        return "mc_newton_xyz", load_real_stage(stage_root, payload)
    raise BridgeError("stage_connection_error", f"unsupported stage adapter: {adapter}")


def ensure_stage(state: BridgeState, payload: dict[str, Any]) -> Any:
    with state.lock:
        if state.stage is not None:
            return state.stage
    action_connect(state, {"stage": payload.get("stage", {"adapter": "memory"})})
    with state.lock:
        if state.stage is None:
            raise BridgeError("stage_connection_error", "stage is not connected")
        return state.stage


def action_connect(state: BridgeState, payload: dict[str, Any]) -> dict[str, Any]:
    stage_payload = parse_payload(payload.get("stage"))
    adapter, stage = create_stage(state.stage_root, stage_payload)
    with state.lock:
        state.stage = stage
        state.stage_adapter = adapter
    return {
        "stage": {
            "adapter": adapter,
            "connected": True,
        },
        "dependencies": dependency_versions(),
    }


def dependency_versions() -> dict[str, str]:
    versions: dict[str, str] = {"python": sys.version.split()[0]}
    for package_name, version_key in {
        "pyserial": "pyserial",
        "numpy": "numpy",
        "pillow": "PIL",
    }.items():
        try:
            versions[version_key] = importlib.metadata.version(package_name)
        except importlib.metadata.PackageNotFoundError:
            versions[version_key] = "unavailable"
    return versions


def action_probe(state: BridgeState, payload: dict[str, Any]) -> dict[str, Any]:
    stage_payload = parse_payload(payload.get("stage"))
    bridge_dir = Path(str(payload.get("bridgeDir", ""))) if payload.get("bridgeDir") else None
    output_dir = Path(str(payload.get("outputDir", ""))) if payload.get("outputDir") else None
    adapter = stage_payload.get("adapter", "memory")
    stage_reachable = adapter == "memory"
    idn = "memory-stage" if adapter == "memory" else "not-opened-read-only"
    writable = True
    if output_dir is not None:
        try:
            output_dir.mkdir(parents=True, exist_ok=True)
            probe_file = output_dir / ".raman_probe_write"
            probe_file.write_text("ok\n", encoding="utf-8")
            probe_file.unlink(missing_ok=True)
        except OSError as error:
            writable = False
            print(f"raman_bridge probe outputDir not writable: {error}", file=sys.stderr)
    return {
        "stage": {
            "reachable": stage_reachable,
            "idn": idn,
            "adapter": adapter,
        },
        "labspecWorker": {
            "reachable": bridge_dir is not None and bridge_dir.exists(),
            "latencyMs": 0,
        },
        "outputDirWritable": writable,
        "dependencies": dependency_versions(),
        "readOnly": True,
    }


def write_fake_frame(save_path: Path) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    pixels = [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 32, 64, 64, 32, 0, 0],
        [0, 32, 128, 220, 220, 128, 32, 0],
        [0, 64, 220, 255, 255, 220, 64, 0],
        [0, 64, 220, 255, 255, 220, 64, 0],
        [0, 32, 128, 220, 220, 128, 32, 0],
        [0, 0, 32, 64, 64, 32, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
    ]
    body = "\n".join(" ".join(str(value) for value in row) for row in pixels)
    save_path.write_text(f"P2\n8 8\n255\n{body}\n", encoding="utf-8")


def active_probe_frame(
    payload: dict[str, Any],
    output_dir: Path,
    abort_event: threading.Event,
) -> dict[str, Any]:
    frame_payload = parse_payload(payload.get("frame"))
    backend = str(frame_payload.get("backend", payload.get("frameBackend", "fake")))
    if abort_event.is_set():
        raise BridgeError("aborted", "active_probe frame capture aborted")
    if backend == "fake":
        frame_path = output_dir / "active_probe_frame.pgm"
        write_fake_frame(frame_path)
        return {
            "path": str(frame_path),
            "kind": "frame",
            "backend": "fake",
            "sideEffect": "synthetic_frame_written",
        }
    if backend != "labspec_file_bridge":
        raise BridgeError("frame_timeout", f"unsupported active_probe frame backend: {backend}")
    if ALGORITHM_IMPORT_ERROR is not None:
        raise BridgeError("frame_timeout", f"frame provider dependencies are unavailable: {ALGORITHM_IMPORT_ERROR}")
    if LABSPEC_FRAME_PROVIDER is None or PIL_IMAGE is None:
        raise BridgeError("frame_timeout", "frame provider dependencies were not loaded")
    bridge_dir_value = frame_payload.get("bridgeDir", payload.get("bridgeDir"))
    if not isinstance(bridge_dir_value, str) or not bridge_dir_value:
        raise BridgeError("frame_timeout", "active_probe frame capture requires bridgeDir")
    provider = LABSPEC_FRAME_PROVIDER(
        Path(bridge_dir_value),
        stop_on_disconnect=bool(frame_payload.get("stopOnDisconnect", False)),
        initial_timeout_ms=int(frame_payload.get("timeoutMs", 10000)),
    )
    try:
        provider.connect()
        frame = provider.wait_for_next(after_ts=0.0, timeout_ms=int(frame_payload.get("timeoutMs", 10000)))
        frame_path = output_dir / "active_probe_frame.png"
        PIL_IMAGE.fromarray(frame.image).save(frame_path)
        return {
            "path": str(frame_path),
            "kind": "frame",
            "backend": "labspec_file_bridge",
            "sideEffect": "labspec_frame_captured",
        }
    finally:
        provider.disconnect()


def action_active_probe(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    output_dir_value = payload.get("outputDir", payload.get("bridgeDir", "."))
    output_dir = Path(str(output_dir_value))
    output_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, Any]] = []
    side_effects: list[str] = []

    if payload.get("captureFrame") is True:
        write_protocol({"event": "progress", "action": "active_probe", "phase": "capture_frame"}, output_lock)
        frame_artifact = active_probe_frame(payload, output_dir, abort_event)
        artifacts.append(frame_artifact)
        side_effects.append(str(frame_artifact["sideEffect"]))

    if payload.get("acquireSpectrumSmoke") is True:
        write_protocol({"event": "progress", "action": "active_probe", "phase": "acquire_spectrum_smoke"}, output_lock)
        acquisition = parse_payload(payload.get("acquisition"))
        if "backend" not in acquisition:
            acquisition["backend"] = "fake"
        if "savePath" not in acquisition:
            acquisition["savePath"] = str(output_dir / f"active_probe_spectrum.{acquisition.get('saveFormat', 'txt')}")
        acquisition.setdefault("integrationTimeS", 0.1)
        acquisition.setdefault("accumulations", 1)
        acquisition.setdefault("fromNm", 100)
        acquisition.setdefault("toNm", 3500)
        acquisition.setdefault("saveFormat", "txt")
        spectrum = action_acquire_spectrum(
            state,
            {"acquisition": acquisition},
            abort_event,
            output_lock,
        )
        artifacts.append(
            {
                "path": spectrum["outputPath"],
                "kind": "spectrum",
                "backend": spectrum["metadata"].get("backend", acquisition["backend"]),
                "sideEffect": "spectrum_smoke_acquired",
                "metadata": spectrum["metadata"],
            }
        )
        side_effects.append("spectrum_smoke_acquired")

    return {
        "readOnly": False,
        "requiresOperatorApproval": True,
        "artifacts": artifacts,
        "sideEffects": side_effects,
    }


def action_visit_point(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    with state.stage_operation_lock:
        stage = ensure_stage(state, payload)
        point = parse_payload(payload.get("point"))
        settle_timeout_ms = int(payload.get("settleTimeoutMs", 1000))
        if abort_event.is_set():
            raise BridgeError("aborted", "visit_point aborted before motion")
        before = stage.get_position_um()
        target = StagePosition(
            float(point.get("xUm", getattr(before, "x_um", 0.0))),
            float(point.get("yUm", getattr(before, "y_um", 0.0))),
            float(point.get("zUm", getattr(before, "z_um", 0.0))),
        )
        dx = abs(target.x_um - getattr(before, "x_um", 0.0))
        dy = abs(target.y_um - getattr(before, "y_um", 0.0))
        dz = abs(target.z_um - getattr(before, "z_um", 0.0))
        skip_move = max(dx, dy, dz) < 2.0
        if skip_move:
            debug(f"visit_point skip move: already within 2um (dx={dx:.3f} dy={dy:.3f} dz={dz:.3f})")
        else:
            axis_targets = [
                ("x", "x_um", "xUm", target.x_um),
                ("y", "y_um", "yUm", target.y_um),
                ("z", "z_um", "zUm", target.z_um),
            ]
            for axis, move_key, wire_key, target_um in axis_targets:
                if wire_key not in point:
                    continue
                if abort_event.is_set():
                    state.stop()
                    raise BridgeError("aborted", f"visit_point aborted before {axis.upper()} motion")
                write_protocol(
                    {
                        "event": "progress",
                        "action": "visit_point",
                        "phase": "move_axis",
                        "axis": axis,
                        "targetUm": target_um,
                    },
                    output_lock,
                )
                stage.move_absolute_um(**{move_key: target_um})
                wait_stage_settled(stage, settle_timeout_ms, {axis})
        if abort_event.is_set():
            state.stop()
            raise BridgeError("aborted", "visit_point aborted after motion")
        after = stage.get_position_um()
        return {"before": position_to_wire(before), "after": position_to_wire(after)}

def action_autofocus(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    autofocus = parse_payload(payload.get("autofocus", payload))
    backend = str(autofocus.get("backend", "fake"))
    if backend == "labspec_file_bridge":
        return action_autofocus_labspec(state, autofocus, abort_event, output_lock)
    if backend != "fake":
        raise BridgeError("autofocus_no_peak", f"unsupported autofocus backend: {backend}")
    if abort_event.is_set():
        raise BridgeError("aborted", "autofocus aborted before scan")
    with state.stage_operation_lock:
        z_stage = XYZStageZAdapter(ensure_stage(state, payload))
        z_stage.enter_z_only()
        try:
            current_z = z_stage.get_position_um()
            z_min = float(autofocus.get("zMinUm", current_z))
            z_max = float(autofocus.get("zMaxUm", current_z))
            z_best = min(max(float(autofocus.get("zBestUm", current_z)), z_min), z_max)
            z_stage.move_absolute_um(z_best)
            z_stage.wait_settled(int(autofocus.get("stageTimeoutMs", payload.get("settleTimeoutMs", 1000))))
            if abort_event.is_set():
                state.stop()
                raise BridgeError("aborted", "autofocus aborted after final move")
        finally:
            z_stage.exit_z_only()
    confidence = max(float(autofocus.get("minConfidence", 0.2)), float(autofocus.get("confidence", 0.85)))
    return {
        "status": "ok",
        "zBestUm": z_best,
        "finalScore": float(autofocus.get("finalScore", 1.0)),
        "confidence": min(confidence, 1.0),
    }


def action_autofocus_labspec(
    state: BridgeState,
    autofocus: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    if ALGORITHM_IMPORT_ERROR is not None:
        raise BridgeError("frame_timeout", f"autofocus dependencies are unavailable: {ALGORITHM_IMPORT_ERROR}")
    if (
        AUTOFOCUS_CONTROLLER is None
        or AUTOFOCUS_PARAMS is None
        or AUTOFOCUS_ROI is None
        or FOCUS_STATUS is None
        or LABSPEC_FRAME_PROVIDER is None
    ):
        raise BridgeError("frame_timeout", "autofocus dependencies were not loaded")

    bridge_dir_value = autofocus.get("bridgeDir")
    if not isinstance(bridge_dir_value, str) or not bridge_dir_value:
        raise BridgeError("frame_timeout", "labspec_file_bridge autofocus requires bridgeDir")
    frames = LABSPEC_FRAME_PROVIDER(Path(bridge_dir_value), stop_on_disconnect=False)
    try:
        width, height = frames.connect()
        roi_payload = parse_payload(autofocus.get("roi"))
        roi = AUTOFOCUS_ROI(
            x=int(roi_payload.get("x", 0)),
            y=int(roi_payload.get("y", 0)),
            width=int(roi_payload.get("width", width)),
            height=int(roi_payload.get("height", height)),
        )
        params = AUTOFOCUS_PARAMS(
            z_min_um=float(autofocus.get("zMinUm")),
            z_max_um=float(autofocus.get("zMaxUm")),
            coarse_range_um=float(autofocus.get("coarseRangeUm", 80.0)),
            coarse_step_um=float(autofocus.get("coarseStepUm", 10.0)),
            fine_range_um=float(autofocus.get("fineRangeUm", 15.0)),
            fine_step_um=float(autofocus.get("fineStepUm", 2.0)),
            settle_ms=int(autofocus.get("settleMs", 100)),
            frame_timeout_ms=int(autofocus.get("frameTimeoutMs", 500)),
            stage_timeout_ms=int(autofocus.get("stageTimeoutMs", 3000)),
            frames_per_z=int(autofocus.get("framesPerZ", 3)),
            min_confidence=float(autofocus.get("minConfidence", 0.2)),
            metric_name=str(autofocus.get("metric", "labspec_spot_compactness")),
        )

        def on_progress(point: Any) -> None:
            if abort_event.is_set():
                state.stop()
            write_protocol(
                {
                    "event": "progress",
                    "action": "autofocus",
                    "backend": "labspec_file_bridge",
                    "zUm": float(point.z_um),
                    "score": float(point.score),
                },
                output_lock,
            )

        with state.stage_operation_lock:
            z_stage = XYZStageZAdapter(ensure_stage(state, {"stage": autofocus.get("stage", {"adapter": "memory"})}))
            z_stage.enter_z_only()
            try:
                controller = AUTOFOCUS_CONTROLLER(z_stage, frames)
                result = controller.run_single(roi, params, on_progress=on_progress)
            finally:
                z_stage.exit_z_only()
    finally:
        frames.disconnect()

    if result.status != FOCUS_STATUS.OK:
        raise BridgeError(
            autofocus_error_code(str(result.status.value)),
            result.message or f"autofocus ended with status {result.status.value}",
        )
    return {
        "status": result.status.value,
        "zBestUm": result.z_best_um,
        "finalScore": result.final_score,
        "confidence": result.confidence,
    }

def autofocus_error_code(status: str) -> str:
    if status == "no_peak":
        return "autofocus_no_peak"
    if status == "low_confidence":
        return "autofocus_low_confidence"
    if status == "out_of_range":
        return "autofocus_out_of_range"
    if status == "frame_error":
        return "frame_timeout"
    if status == "aborted":
        return "aborted"
    return "stage_timeout"


def action_xy_correct(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
) -> dict[str, Any]:
    xy_correction = parse_payload(payload.get("xyCorrection", payload))
    backend = str(xy_correction.get("backend", "fake"))
    debug(f"xy_correct backend {backend}")
    if backend == "phase_correlation":
        return action_xy_correct_phase_correlation(state, xy_correction, abort_event)
    if backend != "fake":
        raise BridgeError("calibration_low_confidence", f"unsupported XY correction backend: {backend}")
    confidence = float(xy_correction.get("confidence", 1.0))
    min_confidence = float(xy_correction.get("minConfidence", 0.4))
    if confidence < min_confidence:
        raise BridgeError("calibration_low_confidence", "fake XY correction confidence is below minConfidence")
    dx_um = float(xy_correction.get("dxUm", 0.0))
    dy_um = float(xy_correction.get("dyUm", 0.0))
    max_correction_um = float(xy_correction.get("maxCorrectionUm", 0.0))
    if max(abs(dx_um), abs(dy_um)) > max_correction_um:
        raise BridgeError("calibration_low_confidence", "fake XY correction exceeds maxCorrectionUm")
    applied = bool(xy_correction.get("applied", abs(dx_um) > 0.0 or abs(dy_um) > 0.0))
    if applied:
        if abort_event.is_set():
            raise BridgeError("aborted", "xy_correct aborted before move")
        stage = ensure_stage(state, payload)
        stage.move_relative_um(dx_um=dx_um, dy_um=dy_um, dz_um=0.0)
        stage.wait_settled(int(xy_correction.get("stageTimeoutMs", payload.get("settleTimeoutMs", 1000))))
    return {"dxUm": dx_um, "dyUm": dy_um, "confidence": confidence, "applied": applied}


def action_xy_correct_phase_correlation(
    state: BridgeState,
    xy_correction: dict[str, Any],
    abort_event: threading.Event,
) -> dict[str, Any]:
    debug("xy phase_correlation start")
    if ALGORITHM_IMPORT_ERROR is not None:
        raise BridgeError("calibration_low_confidence", f"XY correction dependencies are unavailable: {ALGORITHM_IMPORT_ERROR}")
    if (
        PIL_IMAGE is None
        or NP is None
        or CALIBRATION_ROI is None
        or PIXEL_STAGE_TRANSFORM is None
        or ESTIMATE_XY_CORRECTION is None
        or LOW_CONFIDENCE_ERROR is None
        or SINGULAR_TRANSFORM_ERROR is None
    ):
        raise BridgeError("calibration_low_confidence", "XY correction dependencies were not loaded")

    reference_path = xy_correction.get("referenceFramePath")
    current_path = xy_correction.get("currentFramePath")
    if not isinstance(reference_path, str) or not isinstance(current_path, str):
        raise BridgeError("calibration_low_confidence", "phase_correlation XY correction requires referenceFramePath and currentFramePath")
    transform_value = xy_correction.get("transform")
    if not isinstance(transform_value, list):
        raise BridgeError("calibration_singular_transform", "phase_correlation XY correction requires a 2x2 transform")
    try:
        transform = PIXEL_STAGE_TRANSFORM(NP.asarray(transform_value, dtype=NP.float64))
    except SINGULAR_TRANSFORM_ERROR as error:
        raise BridgeError("calibration_singular_transform", str(error)) from error
    roi_payload = parse_payload(xy_correction.get("roi"))
    roi = None
    if roi_payload:
        roi = CALIBRATION_ROI(
            x=int(roi_payload.get("x", 0)),
            y=int(roi_payload.get("y", 0)),
            width=int(roi_payload.get("width", 1)),
            height=int(roi_payload.get("height", 1)),
        )
    reference = NP.asarray(PIL_IMAGE.open(reference_path))
    current = NP.asarray(PIL_IMAGE.open(current_path))
    debug("xy phase_correlation images loaded")
    try:
        shift = ESTIMATE_XY_CORRECTION(
            reference,
            current,
            transform,
            roi,
            min_confidence=float(xy_correction.get("minConfidence", 0.4)),
        )
    except LOW_CONFIDENCE_ERROR as error:
        raise BridgeError("calibration_low_confidence", str(error)) from error
    dx_um = float(shift.dx_um)
    dy_um = float(shift.dy_um)
    max_correction_um = float(xy_correction.get("maxCorrectionUm", 0.0))
    if max(abs(dx_um), abs(dy_um)) > max_correction_um:
        raise BridgeError("calibration_low_confidence", "XY correction exceeds maxCorrectionUm")
    applied = bool(xy_correction.get("applied", True))
    if applied:
        if abort_event.is_set():
            raise BridgeError("aborted", "xy_correct aborted before move")
        stage = ensure_stage(state, {"stage": xy_correction.get("stage", {"adapter": "memory"})})
        stage.move_relative_um(dx_um=dx_um, dy_um=dy_um, dz_um=0.0)
        stage.wait_settled(int(xy_correction.get("stageTimeoutMs", 1000)))
    debug("xy phase_correlation complete")
    return {"dxUm": dx_um, "dyUm": dy_um, "confidence": 1.0, "applied": applied}


def action_calibrate_xy(
    payload: dict[str, Any],
) -> dict[str, Any]:
    if ALGORITHM_IMPORT_ERROR is not None:
        raise BridgeError("calibration_low_confidence", f"XY calibration dependencies are unavailable: {ALGORITHM_IMPORT_ERROR}")
    if PIL_IMAGE is None or NP is None or CALIBRATION_ROI is None or ESTIMATE_TRANSLATION is None:
        raise BridgeError("calibration_low_confidence", "XY calibration dependencies were not loaded")
    measurements = payload.get("measurements")
    if not isinstance(measurements, list) or len(measurements) < 2:
        raise BridgeError("calibration_singular_transform", "calibrate_xy requires at least two measurements")

    min_confidence = float(payload.get("minConfidence", 0.4))
    rows_stage: list[list[float]] = []
    rows_pixel: list[list[float]] = []
    results: list[dict[str, Any]] = []
    for index, raw_measurement in enumerate(measurements):
        measurement = parse_payload(raw_measurement)
        reference_path = measurement.get("referenceFramePath")
        current_path = measurement.get("currentFramePath")
        if not isinstance(reference_path, str) or not isinstance(current_path, str):
            raise BridgeError("calibration_low_confidence", f"measurement {index} requires referenceFramePath and currentFramePath")
        stage_shift = parse_payload(measurement.get("stageShift"))
        dx_um = float(stage_shift.get("dxUm", measurement.get("dxUm", 0.0)))
        dy_um = float(stage_shift.get("dyUm", measurement.get("dyUm", 0.0)))
        roi_payload = parse_payload(measurement.get("roi", payload.get("roi")))
        roi = None
        if roi_payload:
            roi = CALIBRATION_ROI(
                x=int(roi_payload.get("x", 0)),
                y=int(roi_payload.get("y", 0)),
                width=int(roi_payload.get("width", 1)),
                height=int(roi_payload.get("height", 1)),
            )
        reference = NP.asarray(PIL_IMAGE.open(reference_path))
        current = NP.asarray(PIL_IMAGE.open(current_path))
        translation = ESTIMATE_TRANSLATION(reference, current, roi)
        confidence = float(translation.confidence)
        if confidence < min_confidence:
            raise BridgeError(
                "calibration_low_confidence",
                f"measurement {index} confidence {confidence:.3f} below threshold {min_confidence:.3f}",
            )
        rows_stage.append([dx_um, dy_um])
        rows_pixel.append([float(translation.shift.dx), float(translation.shift.dy)])
        results.append(
            {
                "index": index,
                "stageShiftUm": {"dxUm": dx_um, "dyUm": dy_um},
                "pixelShift": {"dx": float(translation.shift.dx), "dy": float(translation.shift.dy)},
                "confidence": confidence,
            }
        )

    stage_matrix = NP.asarray(rows_stage, dtype=NP.float64)
    pixel_matrix = NP.asarray(rows_pixel, dtype=NP.float64)
    if int(NP.linalg.matrix_rank(stage_matrix)) < 2:
        raise BridgeError("calibration_singular_transform", "calibration stage shifts must span both XY axes")
    solution, residuals, rank, _singular_values = NP.linalg.lstsq(stage_matrix, pixel_matrix, rcond=None)
    pixel_per_um = solution.T
    determinant = float(NP.linalg.det(pixel_per_um))
    if abs(determinant) < 1e-12:
        raise BridgeError("calibration_singular_transform", "fitted pixel_per_um matrix is singular")
    fitted = stage_matrix @ solution
    residual = pixel_matrix - fitted
    residual_rms_px = float(NP.sqrt(NP.mean(residual * residual)))
    confidence_values = [measurement["confidence"] for measurement in results]
    return {
        "pixelPerUm": pixel_per_um.tolist(),
        "confidence": float(min(confidence_values)),
        "meanConfidence": float(sum(confidence_values) / len(confidence_values)),
        "residualRmsPx": residual_rms_px,
        "rank": int(rank),
        "residuals": residuals.tolist() if hasattr(residuals, "tolist") else [],
        "measurements": results,
    }


def parse_calibration_shifts(payload: dict[str, Any]) -> list[dict[str, float]]:
    shifts_payload = payload.get("shifts")
    if not isinstance(shifts_payload, list):
        step_um = float(payload.get("stepUm", 20.0))
        return [{"dxUm": step_um, "dyUm": 0.0}, {"dxUm": 0.0, "dyUm": step_um}]
    shifts: list[dict[str, float]] = []
    for raw_shift in shifts_payload:
        shift = parse_payload(raw_shift)
        shifts.append({"dxUm": float(shift.get("dxUm", 0.0)), "dyUm": float(shift.get("dyUm", 0.0))})
    if len(shifts) < 2:
        raise BridgeError("calibration_singular_transform", "calibration sequence requires at least two shifts")
    return shifts


def parse_matrix2x2(value: Any, fallback: list[list[float]]) -> list[list[float]]:
    raw = value if isinstance(value, list) else fallback
    if (
        not isinstance(raw, list)
        or len(raw) != 2
        or not isinstance(raw[0], list)
        or not isinstance(raw[1], list)
        or len(raw[0]) != 2
        or len(raw[1]) != 2
    ):
        raise BridgeError("calibration_singular_transform", "fakePixelPerUm must be a 2x2 matrix")
    return [[float(raw[0][0]), float(raw[0][1])], [float(raw[1][0]), float(raw[1][1])]]


def write_synthetic_calibration_frame(
    save_path: Path,
    *,
    dx_px: float,
    dy_px: float,
    width: int = 96,
    height: int = 96,
) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    pixels = [[0 for _x in range(width)] for _y in range(height)]
    for x0, y0, size, value in [(24, 30, 8, 230), (55, 20, 6, 180), (42, 62, 7, 210)]:
        for y in range(size):
            for x in range(size):
                yy = int(round(y0 + y + dy_px))
                xx = int(round(x0 + x + dx_px))
                if 0 <= yy < height and 0 <= xx < width:
                    pixels[yy][xx] = value
    body = "\n".join(" ".join(str(value) for value in row) for row in pixels)
    save_path.write_text(f"P2\n{width} {height}\n255\n{body}\n", encoding="utf-8")


def save_frame_image(path: Path, image: Any) -> None:
    if PIL_IMAGE is None:
        raise BridgeError("frame_timeout", "PIL dependency was not loaded")
    path.parent.mkdir(parents=True, exist_ok=True)
    PIL_IMAGE.fromarray(image).save(path)


def initial_position_to_target(initial: Any, shift: dict[str, float]) -> dict[str, float]:
    return {
        "x_um": float(getattr(initial, "x_um", 0.0)) + shift["dxUm"],
        "y_um": float(getattr(initial, "y_um", 0.0)) + shift["dyUm"],
        "z_um": float(getattr(initial, "z_um", 0.0)),
    }


def action_calibrate_xy_sequence(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    if ALGORITHM_IMPORT_ERROR is not None:
        raise BridgeError("calibration_low_confidence", f"XY calibration dependencies are unavailable: {ALGORITHM_IMPORT_ERROR}")
    shifts = parse_calibration_shifts(payload)
    output_dir = Path(str(payload.get("outputDir", ".")))
    output_dir.mkdir(parents=True, exist_ok=True)
    frame_backend = str(payload.get("frameBackend", "fake"))
    stage = ensure_stage(state, payload)
    settle_timeout_ms = int(payload.get("settleTimeoutMs", 1000))
    frame_timeout_ms = int(payload.get("frameTimeoutMs", 10000))
    initial = stage.get_position_um()
    measurements: list[dict[str, Any]] = []
    artifacts: list[dict[str, Any]] = []
    side_effects: list[str] = []
    try:
        if frame_backend == "fake":
            fake_pixel_per_um = parse_matrix2x2(payload.get("fakePixelPerUm"), [[2.0, 0.0], [0.0, 1.0]])
            reference_path = output_dir / "calibration_reference.pgm"
            write_synthetic_calibration_frame(reference_path, dx_px=0.0, dy_px=0.0)
            artifacts.append({"path": str(reference_path), "kind": "frame", "role": "reference", "backend": "fake"})
            for index, shift in enumerate(shifts):
                if abort_event.is_set():
                    state.stop()
                    raise BridgeError("aborted", "calibrate_xy_sequence aborted before move")
                target = initial_position_to_target(initial, shift)
                write_protocol(
                    {"event": "progress", "action": "calibrate_xy_sequence", "phase": "move", "index": index},
                    output_lock,
                )
                stage.move_absolute_um(x_um=target["x_um"], y_um=target["y_um"], z_um=target["z_um"])
                stage.wait_settled(settle_timeout_ms)
                dx_px = fake_pixel_per_um[0][0] * shift["dxUm"] + fake_pixel_per_um[0][1] * shift["dyUm"]
                dy_px = fake_pixel_per_um[1][0] * shift["dxUm"] + fake_pixel_per_um[1][1] * shift["dyUm"]
                current_path = output_dir / f"calibration_current_{index}.pgm"
                write_synthetic_calibration_frame(current_path, dx_px=dx_px, dy_px=dy_px)
                artifacts.append({"path": str(current_path), "kind": "frame", "role": f"current_{index}", "backend": "fake"})
                measurements.append(
                    {
                        "referenceFramePath": str(reference_path),
                        "currentFramePath": str(current_path),
                        "stageShift": shift,
                    }
                )
            side_effects.append("synthetic_calibration_frames_written")
        elif frame_backend == "labspec_file_bridge":
            if LABSPEC_FRAME_PROVIDER is None or PIL_IMAGE is None:
                raise BridgeError("frame_timeout", "LabSpec frame provider dependencies were not loaded")
            bridge_dir_value = payload.get("bridgeDir")
            if not isinstance(bridge_dir_value, str) or not bridge_dir_value:
                raise BridgeError("frame_timeout", "calibrate_xy_sequence labspec_file_bridge requires bridgeDir")
            provider = LABSPEC_FRAME_PROVIDER(
                Path(bridge_dir_value),
                stop_on_disconnect=bool(payload.get("stopOnDisconnect", False)),
                initial_timeout_ms=frame_timeout_ms,
            )
            try:
                provider.connect()
                reference_frame = provider.get_latest()
                reference_path = output_dir / "calibration_reference.png"
                save_frame_image(reference_path, reference_frame.image)
                artifacts.append({"path": str(reference_path), "kind": "frame", "role": "reference", "backend": "labspec_file_bridge"})
                after_ts = float(reference_frame.timestamp)
                for index, shift in enumerate(shifts):
                    if abort_event.is_set():
                        state.stop()
                        raise BridgeError("aborted", "calibrate_xy_sequence aborted before move")
                    target = initial_position_to_target(initial, shift)
                    write_protocol(
                        {"event": "progress", "action": "calibrate_xy_sequence", "phase": "move", "index": index},
                        output_lock,
                    )
                    stage.move_absolute_um(x_um=target["x_um"], y_um=target["y_um"], z_um=target["z_um"])
                    stage.wait_settled(settle_timeout_ms)
                    frame = provider.wait_for_next(after_ts=after_ts, timeout_ms=frame_timeout_ms)
                    after_ts = float(frame.timestamp)
                    current_path = output_dir / f"calibration_current_{index}.png"
                    save_frame_image(current_path, frame.image)
                    artifacts.append({"path": str(current_path), "kind": "frame", "role": f"current_{index}", "backend": "labspec_file_bridge"})
                    measurements.append(
                        {
                            "referenceFramePath": str(reference_path),
                            "currentFramePath": str(current_path),
                            "stageShift": shift,
                        }
                    )
                side_effects.append("stage_moved_and_labspec_frames_captured")
            finally:
                provider.disconnect()
        else:
            raise BridgeError("frame_timeout", f"unsupported calibration frame backend: {frame_backend}")
        fit = action_calibrate_xy({"measurements": measurements, "minConfidence": payload.get("minConfidence", 0.4)})
        fit["artifacts"] = artifacts
        fit["sideEffects"] = side_effects
        fit["frameBackend"] = frame_backend
        return fit
    finally:
        try:
            stage.move_absolute_um(
                x_um=float(getattr(initial, "x_um", 0.0)),
                y_um=float(getattr(initial, "y_um", 0.0)),
                z_um=float(getattr(initial, "z_um", 0.0)),
            )
            stage.wait_settled(settle_timeout_ms)
        except Exception as error:
            print(f"raman_bridge calibration restore failed: {error}", file=sys.stderr, flush=True)


def write_fake_spectrum(save_path: Path, metadata: dict[str, Any]) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# fake Raman spectrum generated by raman_bridge.py",
        f"# integrationTimeS={metadata['integrationTimeS']}",
        f"# accumulations={metadata['accumulations']}",
        "raman_shift_nm,intensity",
        "100,10",
        "200,18",
        "300,12",
    ]
    save_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def base_acquisition_metadata(acquisition: dict[str, Any]) -> dict[str, Any]:
    return {
        "integrationTimeS": float(acquisition.get("integrationTimeS", 1.0)),
        "accumulations": int(acquisition.get("accumulations", 1)),
        "fromNm": float(acquisition.get("fromNm", 0.0)),
        "toNm": float(acquisition.get("toNm", 0.0)),
    }


def update_metadata_from_labspec_result(metadata: dict[str, Any], result: dict[str, str]) -> None:
    numeric_keys = {
        "snr_estimate": "snrEstimate",
        "total_intensity": "totalIntensity",
    }
    for source_key, target_key in numeric_keys.items():
        value = result.get(source_key)
        if value is None:
            continue
        try:
            metadata[target_key] = float(value)
        except ValueError:
            metadata[target_key] = value
    saturated = result.get("saturated")
    if saturated is not None:
        metadata["saturated"] = saturated.strip().lower() in {"1", "true", "yes", "y"}


def action_acquire_fake(acquisition: dict[str, Any]) -> dict[str, Any]:
    save_format = str(acquisition.get("saveFormat", "txt"))
    save_path_value = acquisition.get("savePath")
    save_path = Path(str(save_path_value)) if save_path_value else Path("spectrum." + save_format)
    metadata = {
        **base_acquisition_metadata(acquisition),
        "snrEstimate": 12.0,
        "totalIntensity": 40.0,
        "saturated": False,
        "backend": "fake",
    }
    write_fake_spectrum(save_path, metadata)
    return {"outputPath": str(save_path), "metadata": metadata}


def action_acquire_labspec(
    state: BridgeState,
    acquisition: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    if str(state.stage_root) not in sys.path:
        sys.path.insert(0, str(state.stage_root))
    from mapping import DEFAULT_LABSPEC_BRIDGE_DIR

    bridge_dir_value = acquisition.get("bridgeDir")
    bridge_dir = Path(bridge_dir_value) if isinstance(bridge_dir_value, str) and bridge_dir_value.strip() else DEFAULT_LABSPEC_BRIDGE_DIR

    request_id = f"acq_{time.monotonic_ns()}"
    timeout_s = float(acquisition.get("timeoutS", 30.0))
    poll_interval_s = float(acquisition.get("pollIntervalS", 0.2))
    save_format = str(acquisition.get("saveFormat", "txt"))
    save_path_value = acquisition.get("savePath")
    save_path = Path(str(save_path_value)) if save_path_value else None

    request_path = bridge_dir / "requests" / f"{request_id}.ini"
    result_path = bridge_dir / "results" / f"{request_id}.ini"

    request_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    if request_path.exists():
        request_path.unlink()
    if result_path.exists():
        result_path.unlink()

    request_lines = [
        ("request_id", request_id),
        ("action", "spectrum"),
        ("integration_time_s", str(float(acquisition.get("integrationTimeS", 1.0)))),
        ("accumulations", str(int(acquisition.get("accumulations", 1)))),
        ("acq_from_nm", str(float(acquisition.get("fromNm", 0.0)))),
        ("acq_to_nm", str(float(acquisition.get("toNm", 0.0)))),
        ("auto_show", "1" if bool(acquisition.get("autoShow", True)) else "0"),
        ("save_format", save_format),
    ]
    if save_path is not None:
        save_path.parent.mkdir(parents=True, exist_ok=True)
        request_lines.append(("output_path", str(save_path.resolve())))
        request_lines.append(("save_path", str(save_path.resolve())))

    body = "".join(f"{key}={value}\n" for key, value in request_lines)
    temp_path = request_path.with_name(f"{request_id}.ini.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(body, encoding="utf-8")
    temp_path.replace(request_path)

    deadline = time.monotonic() + timeout_s
    last_event = 0.0
    while time.monotonic() <= deadline:
        if abort_event.is_set():
            raise BridgeError("aborted", "acquire_spectrum aborted while waiting for LabSpec result")
        now = time.monotonic()
        if now - last_event >= 2.0:
            elapsed_s = max(0.0, timeout_s - (deadline - now))
            write_protocol(
                {
                    "event": "progress",
                    "action": "acquire_spectrum",
                    "backend": "labspec_file_bridge",
                    "elapsedS": round(elapsed_s, 3),
                    "integrationTimeS": float(acquisition.get("integrationTimeS", 1.0)),
                },
                output_lock,
            )
            last_event = now
        if is_stable_file(result_path):
            result = {}
            for line in result_path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and "=" in stripped:
                    key, value = stripped.split("=", 1)
                    result[key.strip()] = value.strip()
            if result.get("request_id") != request_id:
                time.sleep(poll_interval_s)
                continue
            status = str(result.get("status", "error")).strip().lower()
            metadata = base_acquisition_metadata(acquisition)
            metadata["backend"] = "labspec_file_bridge"
            update_metadata_from_labspec_result(metadata, result)
            output_value = result.get("save_path") or str(save_path) if save_path else None
            if status == "ok":
                return {
                    "outputPath": str(output_value) if output_value else "",
                    "metadata": metadata,
                    "fileBridge": {
                        "requestId": request_id,
                        "requestPath": str(request_path),
                        "resultPath": str(result_path),
                    },
                }
            raise BridgeError(
                "acquisition_failed",
                str(result.get("message", "LabSpec worker reported an acquisition error")),
                {"requestId": request_id, "resultPath": str(result_path)},
            )
        time.sleep(poll_interval_s)
    raise BridgeError(
        "acquisition_failed",
        f"No LabSpec worker result for request {request_id} within {timeout_s:.1f}s",
        {"requestId": request_id, "resultPath": str(result_path)},
    )


def action_acquire_spectrum(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    acquisition = parse_payload(payload.get("acquisition", payload))
    backend = str(acquisition.get("backend", "fake"))
    if backend == "fake":
        return action_acquire_fake(acquisition)
    if backend == "labspec_file_bridge":
        return action_acquire_labspec(state, acquisition, abort_event, output_lock)
    raise BridgeError("acquisition_failed", f"unsupported acquisition backend: {backend}")


def is_stable_file(path: Path) -> bool:
    try:
        first_size = path.stat().st_size
        if first_size <= 0:
            return False
        time.sleep(0.02)
        return path.exists() and path.stat().st_size == first_size
    except OSError:
        return False


def action_run_unit(
    state: BridgeState,
    payload: dict[str, Any],
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    point = parse_payload(payload.get("point"))
    visit = action_visit_point(state, payload, abort_event, output_lock)
    record: dict[str, Any] = {
        "index": int(point.get("index", 0)),
        "xUm": float(point.get("xUm", 0.0)),
        "yUm": float(point.get("yUm", 0.0)),
        "status": "success",
        "positionBefore": visit["before"],
        "positionAfter": visit["after"],
    }
    if "zUm" in point:
        record["zUm"] = float(point["zUm"])
    autofocus = payload.get("autofocus")
    if isinstance(autofocus, dict) and autofocus.get("enabled") is True:
        write_protocol({"event": "progress", "action": "autofocus", "phase": "fake"}, output_lock)
        autofocus_result = action_autofocus(
            state,
            {"autofocus": autofocus, "settleTimeoutMs": payload.get("settleTimeoutMs")},
            abort_event,
            output_lock,
        )
        if autofocus_result.get("status") != "ok":
            raise BridgeError("autofocus_low_confidence", str(autofocus_result.get("message", "autofocus failed")))
        record["autofocus"] = {
            "zBestUm": autofocus_result["zBestUm"],
            "finalScore": autofocus_result["finalScore"],
            "confidence": autofocus_result["confidence"],
        }
    xy_correction = payload.get("xyCorrection")
    if isinstance(xy_correction, dict) and xy_correction.get("enabled") is True:
        write_protocol({"event": "progress", "action": "xy_correct", "phase": "fake"}, output_lock)
        record["xyCorrection"] = action_xy_correct(
            state,
            {"xyCorrection": xy_correction, "settleTimeoutMs": payload.get("settleTimeoutMs")},
            abort_event,
        )
    acquisition = payload.get("acquisition")
    if isinstance(acquisition, dict):
        write_protocol({"event": "progress", "action": "acquire_spectrum", "elapsedS": 0.0}, output_lock)
        spectrum = action_acquire_spectrum(state, {"acquisition": acquisition}, abort_event, output_lock)
        artifact_id = str(acquisition.get("artifactId", f"point_{record['index']}_spectrum"))
        record["spectrum"] = {
            "artifactId": artifact_id,
            "integrationTimeS": spectrum["metadata"]["integrationTimeS"],
            "accumulations": spectrum["metadata"]["accumulations"],
        }
        record["spectrumMetadata"] = spectrum["metadata"]
        if isinstance(spectrum.get("fileBridge"), dict):
            record["spectrumFileBridge"] = spectrum["fileBridge"]
    return record


def handle_command(
    state: BridgeState,
    command: Command,
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> dict[str, Any]:
    if command.action == "connect":
        return action_connect(state, command.payload)
    if command.action == "probe":
        return action_probe(state, command.payload)
    if command.action == "active_probe":
        return action_active_probe(state, command.payload, abort_event, output_lock)
    if command.action == "visit_point":
        return action_visit_point(state, command.payload, abort_event, output_lock)
    if command.action == "run_unit":
        return action_run_unit(state, command.payload, abort_event, output_lock)
    if command.action == "autofocus":
        return action_autofocus(state, command.payload, abort_event, output_lock)
    if command.action == "xy_correct":
        return action_xy_correct(state, command.payload, abort_event)
    if command.action == "calibrate_xy":
        return action_calibrate_xy(command.payload)
    if command.action == "calibrate_xy_sequence":
        return action_calibrate_xy_sequence(state, command.payload, abort_event, output_lock)
    if command.action == "acquire_spectrum":
        return action_acquire_spectrum(state, command.payload, abort_event, output_lock)
    if command.action == "shutdown":
        state.close()
        return {"shutdown": True}
    raise BridgeError("bridge_crashed", f"unknown action: {command.action}")


def worker_loop(
    state: BridgeState,
    commands: "queue.Queue[Command]",
    abort_event: threading.Event,
    output_lock: threading.Lock,
) -> None:
    while True:
        command = commands.get()
        debug(f"worker received {command.action} {command.request_id}")
        if command.action != "stop":
            abort_event.clear()
        try:
            result = handle_command(state, command, abort_event, output_lock)
            debug(f"worker completed {command.action} {command.request_id}")
            write_protocol({"id": command.request_id, "ok": True, "result": result}, output_lock)
        except BridgeError as error:
            write_error(command.request_id, error, output_lock)
        except Exception as error:
            write_exception(command.request_id, error, output_lock)
        finally:
            if command.action == "shutdown":
                return


def reader_loop(
	state: BridgeState,
	commands: "queue.Queue[Command]",
	abort_event: threading.Event,
	output_lock: threading.Lock,
) -> None:
    for line in sys.stdin:
        debug("reader received line")
        text = line.strip()
        if not text:
            continue
        try:
            parsed = json.loads(text)
            request_id = parsed.get("id")
            action = parsed.get("action")
            if not isinstance(request_id, str) or not isinstance(action, str):
                raise BridgeError("bridge_crashed", "request must include string id and action")
            command = Command(request_id=request_id, action=action, payload=parse_payload(parsed.get("payload")))
            if action == "stop":
                abort_event.set()
                state.stop()
                write_protocol({"id": request_id, "ok": True, "result": {"stopped": True}}, output_lock)
                continue
            commands.put(command)
        except BridgeError as error:
            write_error("unknown", error, output_lock)
        except Exception as error:
            write_exception("unknown", error, output_lock)
    commands.put(Command(request_id="stdin-eof", action="shutdown", payload={}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-root", type=Path, default=Path.cwd() / "docs" / "Raman")
    args = parser.parse_args()

    preload_algorithm_modules(args.stage_root)
    state = BridgeState(args.stage_root)
    commands: "queue.Queue[Command]" = queue.Queue()
    abort_event = threading.Event()
    output_lock = threading.Lock()
    reader = threading.Thread(target=reader_loop, args=(state, commands, abort_event, output_lock), daemon=True)
    reader.start()
    debug("bridge ready")
    worker_loop(state, commands, abort_event, output_lock)
    state.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
