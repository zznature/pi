#!/usr/bin/env python3
"""V2 hardware bridge protocol foundation.

The bridge owns device-session state, but not experiment workflow state. Stdout is
reserved for JSON-lines protocol messages; diagnostics must go to stderr.
"""

from __future__ import annotations

import json
import argparse
import queue
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

JsonObject = dict[str, Any]
NP: Any | None = None
PIL_IMAGE: Any | None = None
FOCUS_METRICS: Any | None = None
FOCUS_ROI: Any | None = None
CALIBRATION_ROI: Any | None = None
ESTIMATE_TRANSLATION: Any | None = None
ALGORITHM_IMPORT_ERROR: Exception | None = None
CREATE_LABSPEC_START_VIDEO_REQUEST: Any | None = None
CREATE_LABSPEC_VIDEO_FRAME_REQUEST: Any | None = None
READ_LABSPEC_RESULT: Any | None = None
LABSPEC_BRIDGE_IMPORT_ERROR: Exception | None = None


class BridgeError(Exception):
    def __init__(self, code: str, message: str, detail: JsonObject | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail or {}


@dataclass(frozen=True)
class ActionContract:
    domain: str
    action: str
    side_effect_level: str
    resources_touched: tuple[str, ...]
    safe_to_retry: bool
    cancel_behavior: str
    emits_progress: bool

    def to_wire(self) -> JsonObject:
        return {
            "domain": self.domain,
            "action": self.action,
            "sideEffectLevel": self.side_effect_level,
            "resourcesTouched": list(self.resources_touched),
            "safeToRetry": self.safe_to_retry,
            "cancelBehavior": self.cancel_behavior,
            "emitsProgress": self.emits_progress,
        }


@dataclass(frozen=True)
class Command:
    request_id: str
    domain: str
    action: str
    payload: JsonObject
    timeout_ms: int | None
    reserved_resources: tuple[str, ...] = ()


@dataclass(frozen=True)
class BridgeContext:
    request_id: str
    output_lock: threading.Lock

    def emit(self, event: JsonObject) -> None:
        write_protocol({"event": "progress", "id": self.request_id, **event}, self.output_lock)


ActionHandler = Callable[[JsonObject, BridgeContext], JsonObject]


class ActionRegistry:
    def __init__(self) -> None:
        self._actions: dict[tuple[str, str], tuple[ActionContract, ActionHandler]] = {}

    def register(self, contract: ActionContract, handler: ActionHandler) -> None:
        self._actions[(contract.domain, contract.action)] = (contract, handler)

    def contracts(self) -> list[JsonObject]:
        return [contract.to_wire() for contract, _handler in self._actions.values()]

    def contract_for(self, domain: str, action: str) -> ActionContract:
        entry = self._actions.get((domain, action))
        if entry is None:
            raise BridgeError(
                "unknown_action",
                f"unknown V2 hardware action: {domain}.{action}",
                {"domain": domain, "action": action},
            )
        contract, _handler = entry
        return contract

    def handle(self, command: Command, context: BridgeContext) -> JsonObject:
        entry = self._actions.get((command.domain, command.action))
        if entry is None:
            raise BridgeError(
                "unknown_action",
                f"unknown V2 hardware action: {command.domain}.{command.action}",
                {"domain": command.domain, "action": command.action},
            )
        _contract, handler = entry
        return handler(command.payload, context)


@dataclass(frozen=True)
class StagePosition:
    x_um: float
    y_um: float
    z_um: float


@dataclass
class SpectrometerAcquisition:
    acquisition_id: str
    backend: str
    acquisition: JsonObject
    started_monotonic: float
    duration_s: float
    estimated_total_s: float
    save_format: str
    save_path: Path | None
    timeout_s: float
    poll_interval_s: float
    bridge_dir: Path | None = None
    request_path: Path | None = None
    result_path: Path | None = None
    error_message: str | None = None
    file_bridge_result: dict[str, str] | None = None
    status: str = "running"
    cancelled_at: float | None = None
    collected_result: JsonObject | None = None


@dataclass
class ThermalState:
    backend: str
    target_c: float
    start_c: float
    started_monotonic: float
    stable_after_monotonic: float
    tolerance_c: float
    stable_window_s: float


class MemoryStage:
    def __init__(self, initial_position: StagePosition | None = None) -> None:
        self.position = initial_position or StagePosition(0.0, 0.0, 0.0)
        self.history = [self.position]
        self.stopped = False
        self.closed = False

    def connect(self) -> None:
        return None

    def disconnect(self) -> None:
        self.closed = True

    def get_position_um(self) -> StagePosition:
        return self.position

    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        self.stopped = False
        self.position = StagePosition(
            self.position.x_um if x_um is None else float(x_um),
            self.position.y_um if y_um is None else float(y_um),
            self.position.z_um if z_um is None else float(z_um),
        )
        self.history.append(self.position)

    def wait_settled(self, _timeout_ms: int) -> None:
        return None

    def stop(self) -> None:
        self.stopped = True


class BridgeRuntime:
    def __init__(self, stage_root: Path) -> None:
        self.stage_root = stage_root
        self.stage: Any | None = None
        self.stage_adapter = "memory"
        self.stage_lock = threading.Lock()
        self.spectrometer_lock = threading.Lock()
        self.spectrometer_sessions: dict[str, SpectrometerAcquisition] = {}
        self.active_acquisition_id: str | None = None
        self.thermal_lock = threading.Lock()
        self.thermal = ThermalState(
            backend="fake",
            target_c=25.0,
            start_c=25.0,
            started_monotonic=time.monotonic(),
            stable_after_monotonic=time.monotonic(),
            tolerance_c=0.25,
            stable_window_s=0.0,
        )
        self.busy_lock = threading.Lock()
        self.busy_resources: dict[str, str] = {}
        self.stop_requested = threading.Event()

    def reserve(self, contract: ActionContract, request_id: str) -> tuple[str, ...]:
        if contract.side_effect_level == "read":
            return ()
        resources = contract.resources_touched
        with self.busy_lock:
            conflicts = {resource: self.busy_resources[resource] for resource in resources if resource in self.busy_resources}
            if conflicts:
                raise BridgeError(
                    "resource_busy",
                    f"resources are busy for {contract.domain}.{contract.action}",
                    {"resources": list(conflicts.keys()), "holders": conflicts},
                )
            for resource in resources:
                self.busy_resources[resource] = request_id
        return resources

    def release(self, request_id: str, resources: tuple[str, ...]) -> None:
        if not resources:
            return
        with self.busy_lock:
            for resource in resources:
                if self.busy_resources.get(resource) == request_id:
                    del self.busy_resources[resource]

    def close(self) -> None:
        with self.stage_lock:
            if self.stage is None:
                return
            disconnect = getattr(self.stage, "disconnect", None)
            if callable(disconnect):
                disconnect()
            self.stage = None

    def stop_stage(self) -> bool:
        self.stop_requested.set()
        with self.stage_lock:
            if self.stage is None:
                return False
            stop = getattr(self.stage, "stop", None)
            if callable(stop):
                stop()
                return True
        return False

    def create_stage(self, payload: JsonObject) -> tuple[str, Any]:
        adapter = str(payload.get("adapter", "memory"))
        if adapter == "memory":
            initial = parse_payload(payload.get("initialPosition"))
            stage = MemoryStage(
                StagePosition(
                    float(initial.get("xUm", 0.0)),
                    float(initial.get("yUm", 0.0)),
                    float(initial.get("zUm", 0.0)),
                )
            )
            stage.connect()
            return "memory", stage
        if adapter == "mc_newton_xyz":
            return "mc_newton_xyz", self.load_mc_newton_stage(payload)
        raise BridgeError("stage_connection_error", f"unsupported stage adapter: {adapter}")

    def load_mc_newton_stage(self, payload: JsonObject) -> Any:
        if str(self.stage_root) not in sys.path:
            sys.path.insert(0, str(self.stage_root))
        try:
            from stage.mc_newton_xyz_stage import MCNewtonXYZStageController
        except Exception as error:
            raise BridgeError(
                "stage_connection_error",
                f"MC.Newton stage dependencies are unavailable: {error}",
                {"exception": error.__class__.__name__},
            ) from error
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
            stability_tolerance_um=0.5,
            settle_correction_attempts=3,
        )
        stage.connect()
        return stage

    def connect_stage(self, payload: JsonObject) -> JsonObject:
        adapter, stage = self.create_stage(payload)
        with self.stage_lock:
            if self.stage is not None:
                disconnect = getattr(self.stage, "disconnect", None)
                if callable(disconnect):
                    disconnect()
            self.stage = stage
            self.stage_adapter = adapter
            self.stop_requested.clear()
        return {"adapter": adapter, "connected": True, "position": position_to_wire(stage.get_position_um())}

    def ensure_stage(self, payload: JsonObject) -> Any:
        with self.stage_lock:
            if self.stage is not None:
                return self.stage
        stage_payload = parse_payload(payload.get("stage", payload.get("adapter") and payload))
        if not stage_payload:
            stage_payload = {"adapter": "memory"}
        self.connect_stage(stage_payload)
        with self.stage_lock:
            if self.stage is None:
                raise BridgeError("stage_connection_error", "stage is not connected")
            return self.stage

    def begin_acquisition(self, payload: JsonObject) -> SpectrometerAcquisition:
        acquisition = normalize_acquisition_payload(payload)
        backend = str(acquisition.get("backend", "fake"))
        if backend not in {"fake", "labspec_file_bridge"}:
            raise BridgeError("acquisition_failed", f"unsupported acquisition backend for V2 lifecycle: {backend}")
        save_format = str(acquisition.get("saveFormat", "txt"))
        save_path_value = acquisition.get("savePath")
        save_path = Path(str(save_path_value)) if save_path_value else None
        estimated_total_s = acquisition_estimated_total_s(acquisition)
        duration_s = acquisition_duration_s(acquisition, estimated_total_s) if backend == "fake" else estimated_total_s
        timeout_s = parse_non_negative_number(acquisition.get("timeoutS"), "timeoutS", max(30.0, estimated_total_s))
        poll_interval_s = parse_non_negative_number(acquisition.get("pollIntervalS"), "pollIntervalS", 0.2)
        with self.spectrometer_lock:
            active = self.active_acquisition_id
            if active is not None:
                session = self.spectrometer_sessions.get(active)
                if session is not None:
                    refresh_acquisition_status(session)
                    if session.status in {"running", "completed"}:
                        raise BridgeError(
                            "resource_busy",
                            "spectrometer acquisition is already active",
                            {"resources": ["spectrometer_session", "spectrometer_acquisition"], "acquisitionId": active},
                        )
            acquisition_id = f"acq_{time.monotonic_ns()}"
            session = SpectrometerAcquisition(
                acquisition_id=acquisition_id,
                backend=backend,
                acquisition=acquisition,
                started_monotonic=time.monotonic(),
                duration_s=duration_s,
                estimated_total_s=estimated_total_s,
                save_format=save_format,
                save_path=save_path,
                timeout_s=timeout_s,
                poll_interval_s=poll_interval_s,
            )
            if backend == "labspec_file_bridge":
                prepare_labspec_acquisition(session)
            self.spectrometer_sessions[acquisition_id] = session
            self.active_acquisition_id = acquisition_id
            return session

    def acquisition_for(self, acquisition_id: str | None) -> SpectrometerAcquisition:
        with self.spectrometer_lock:
            resolved_id = acquisition_id or self.active_acquisition_id
            if resolved_id is None:
                raise BridgeError("acquisition_not_found", "no active spectrometer acquisition")
            session = self.spectrometer_sessions.get(resolved_id)
            if session is None:
                raise BridgeError("acquisition_not_found", f"unknown spectrometer acquisition: {resolved_id}")
            refresh_acquisition_status(session)
            return session

    def cancel_acquisition(self, acquisition_id: str | None) -> JsonObject:
        with self.spectrometer_lock:
            resolved_id = acquisition_id or self.active_acquisition_id
            if resolved_id is None:
                raise BridgeError("acquisition_not_found", "no active spectrometer acquisition")
            session = self.spectrometer_sessions.get(resolved_id)
            if session is None:
                raise BridgeError("acquisition_not_found", f"unknown spectrometer acquisition: {resolved_id}")
            refresh_acquisition_status(session)
            if session.status == "running":
                session.status = "cancelled"
                session.cancelled_at = time.monotonic()
                if self.active_acquisition_id == resolved_id:
                    self.active_acquisition_id = None
                return {"acquisitionId": resolved_id, "status": session.status, "cancelled": True}
            return {"acquisitionId": resolved_id, "status": session.status, "cancelled": False}

    def clear_active_acquisition(self, acquisition_id: str) -> None:
        with self.spectrometer_lock:
            if self.active_acquisition_id == acquisition_id:
                self.active_acquisition_id = None

    def set_thermal_target(self, payload: JsonObject) -> JsonObject:
        backend = str(payload.get("backend", "fake"))
        if backend != "fake":
            raise BridgeError("thermal_connection_error", f"unsupported thermal backend: {backend}")
        target_c = parse_number(payload.get("targetTemperatureC"), "targetTemperatureC")
        tolerance_c = parse_non_negative_number(payload.get("toleranceC"), "toleranceC", 0.25)
        stable_window_s = parse_non_negative_number(payload.get("stableWindowS"), "stableWindowS", 0.0)
        duration_s = parse_non_negative_number(payload.get("simulateDurationMs"), "simulateDurationMs", 0.0) / 1000.0
        with self.thermal_lock:
            current_c = thermal_current_temperature(self.thermal)
            now = time.monotonic()
            self.thermal = ThermalState(
                backend=backend,
                target_c=target_c,
                start_c=current_c,
                started_monotonic=now,
                stable_after_monotonic=now + duration_s + stable_window_s,
                tolerance_c=tolerance_c,
                stable_window_s=stable_window_s,
            )
            return thermal_state_to_wire(self.thermal)

    def thermal_state(self) -> JsonObject:
        with self.thermal_lock:
            return thermal_state_to_wire(self.thermal)


def debug(message: str) -> None:
    print(f"[hardware_bridge_v2] {message}", file=sys.stderr, flush=True)


def preload_algorithm_modules(stage_root: Path) -> None:
    global ALGORITHM_IMPORT_ERROR
    global CALIBRATION_ROI
    global ESTIMATE_TRANSLATION
    global FOCUS_METRICS
    global FOCUS_ROI
    global NP
    global PIL_IMAGE
    global CREATE_LABSPEC_START_VIDEO_REQUEST
    global CREATE_LABSPEC_VIDEO_FRAME_REQUEST
    global READ_LABSPEC_RESULT
    global LABSPEC_BRIDGE_IMPORT_ERROR

    if str(stage_root) not in sys.path:
        sys.path.insert(0, str(stage_root))
    try:
        import numpy
        from calibration.models import ROI as CalibrationROI
        from calibration.phase_correlation import estimate_translation
        from autofocus import metrics as focus_metrics
        from autofocus.models import ROI as FocusROI

        NP = numpy
        CALIBRATION_ROI = CalibrationROI
        ESTIMATE_TRANSLATION = estimate_translation
        FOCUS_METRICS = focus_metrics
        FOCUS_ROI = FocusROI
        ALGORITHM_IMPORT_ERROR = None
    except Exception as error:
        ALGORITHM_IMPORT_ERROR = error
        debug(f"numpy-backed algorithms unavailable: {error}")
    try:
        from mapping import create_labspec_start_video_request, create_labspec_video_frame_request, read_labspec_result

        CREATE_LABSPEC_START_VIDEO_REQUEST = create_labspec_start_video_request
        CREATE_LABSPEC_VIDEO_FRAME_REQUEST = create_labspec_video_frame_request
        READ_LABSPEC_RESULT = read_labspec_result
        LABSPEC_BRIDGE_IMPORT_ERROR = None
    except Exception as error:
        LABSPEC_BRIDGE_IMPORT_ERROR = error
        debug(f"LabSpec bridge helpers unavailable: {error}")
    try:
        from PIL import Image

        PIL_IMAGE = Image
    except Exception as error:
        if ALGORITHM_IMPORT_ERROR is None:
            ALGORITHM_IMPORT_ERROR = error
        debug(f"PIL image loading unavailable: {error}")


def write_protocol(message: JsonObject, output_lock: threading.Lock) -> None:
    with output_lock:
        sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def write_error(request_id: str, error: BridgeError, output_lock: threading.Lock) -> None:
    write_protocol(
        {
            "id": request_id,
            "ok": False,
            "error": {
                "code": error.code,
                "message": error.message,
                "detail": error.detail,
            },
        },
        output_lock,
    )


def write_exception(request_id: str, error: Exception, output_lock: threading.Lock) -> None:
    debug(f"unexpected exception: {type(error).__name__}: {error}")
    write_error(request_id, map_exception(error), output_lock)


def map_exception(error: Exception) -> BridgeError:
    if isinstance(error, BridgeError):
        return error
    mapping = {
        "StageConnectionError": "stage_connection_error",
        "StageCommandError": "stage_command_error",
        "StageTimeoutError": "stage_timeout",
    }
    return BridgeError(mapping.get(error.__class__.__name__, "bridge_crashed"), str(error), {"exception": error.__class__.__name__})


def parse_payload(value: Any) -> JsonObject:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    raise BridgeError("invalid_request", "payload must be an object when provided", {"payloadType": type(value).__name__})


def parse_command(value: Any) -> Command:
    if not isinstance(value, dict):
        raise BridgeError("invalid_request", "request must be a JSON object")
    request_id = value.get("id")
    domain = value.get("domain")
    action = value.get("action")
    if not isinstance(request_id, str) or not request_id:
        raise BridgeError("invalid_request", "request must include a non-empty string id")
    if not isinstance(domain, str) or not domain:
        raise BridgeError("invalid_request", "request must include a non-empty string domain")
    if not isinstance(action, str) or not action:
        raise BridgeError("invalid_request", "request must include a non-empty string action")
    timeout_value = value.get("timeoutMs")
    timeout_ms = int(timeout_value) if isinstance(timeout_value, (int, float)) else None
    return Command(
        request_id=request_id,
        domain=domain,
        action=action,
        payload=parse_payload(value.get("payload")),
        timeout_ms=timeout_ms,
    )


def parse_number(value: Any, path: str) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    raise BridgeError("invalid_request", f"{path} must be a number", {"path": path})


def optional_number(value: Any, path: str) -> float | None:
    if value is None:
        return None
    return parse_number(value, path)


def position_to_wire(position: Any) -> JsonObject:
    return {
        "xUm": float(getattr(position, "x_um", 0.0)),
        "yUm": float(getattr(position, "y_um", 0.0)),
        "zUm": float(getattr(position, "z_um", 0.0)),
    }


def parse_acquisition_id(payload: JsonObject) -> str | None:
    value = payload.get("acquisitionId")
    if value is None:
        return None
    if isinstance(value, str) and value:
        return value
    raise BridgeError("invalid_request", "acquisitionId must be a non-empty string when provided")


def normalize_acquisition_payload(payload: JsonObject) -> JsonObject:
    raw = parse_payload(payload.get("acquisition", payload))
    acquisition = dict(raw)
    if "integrationTimeS" not in acquisition and "time" in acquisition:
        acquisition["integrationTimeS"] = acquisition["time"]
    if "accumulations" not in acquisition and "accums" in acquisition:
        acquisition["accumulations"] = acquisition["accums"]
    return acquisition


def parse_positive_int(value: Any, path: str, default_value: int) -> int:
    if value is None:
        return default_value
    number = parse_number(value, path)
    integer = int(number)
    if integer < 1 or float(integer) != number:
        raise BridgeError("invalid_request", f"{path} must be a positive integer", {"path": path})
    return integer


def parse_non_negative_number(value: Any, path: str, default_value: float) -> float:
    if value is None:
        return default_value
    number = parse_number(value, path)
    if number < 0:
        raise BridgeError("invalid_request", f"{path} must be non-negative", {"path": path})
    return number


def acquisition_estimated_total_s(acquisition: JsonObject) -> float:
    integration_time_s = parse_non_negative_number(acquisition.get("integrationTimeS"), "integrationTimeS", 1.0)
    accumulations = parse_positive_int(acquisition.get("accumulations"), "accumulations", 1)
    return integration_time_s * accumulations


def acquisition_duration_s(acquisition: JsonObject, estimated_total_s: float) -> float:
    if "simulateDurationMs" in acquisition:
        return parse_non_negative_number(acquisition.get("simulateDurationMs"), "simulateDurationMs", 0.0) / 1000.0
    if "simulateDurationS" in acquisition:
        return parse_non_negative_number(acquisition.get("simulateDurationS"), "simulateDurationS", 0.0)
    return estimated_total_s


def refresh_acquisition_status(session: SpectrometerAcquisition) -> None:
    if session.status != "running":
        return
    if session.backend == "fake" and time.monotonic() - session.started_monotonic >= session.duration_s:
        session.status = "completed"
        return
    if session.backend != "labspec_file_bridge":
        return
    if session.result_path is not None and is_stable_file(session.result_path):
        result = read_ini(session.result_path)
        if result.get("request_id") != session.acquisition_id:
            return
        session.file_bridge_result = result
        status = str(result.get("status", "error")).strip().lower()
        if status == "ok":
            session.status = "completed"
            return
        session.status = "failed"
        session.error_message = str(result.get("message", "LabSpec worker reported an acquisition error"))
        return
    if time.monotonic() - session.started_monotonic >= session.timeout_s:
        session.status = "failed"
        result_path = str(session.result_path) if session.result_path is not None else ""
        session.error_message = f"No LabSpec worker result for request {session.acquisition_id} within {session.timeout_s:.1f}s"
        if result_path:
            session.error_message += f" ({result_path})"


def acquisition_elapsed_s(session: SpectrometerAcquisition) -> float:
    if session.cancelled_at is not None:
        return max(0.0, session.cancelled_at - session.started_monotonic)
    return max(0.0, time.monotonic() - session.started_monotonic)


def acquisition_progress(session: SpectrometerAcquisition) -> float:
    if session.status in {"completed", "collected"}:
        return 1.0
    elapsed_s = acquisition_elapsed_s(session)
    if session.duration_s <= 0:
        return 1.0
    return max(0.0, min(1.0, elapsed_s / session.duration_s))


def acquisition_status_to_wire(session: SpectrometerAcquisition) -> JsonObject:
    refresh_acquisition_status(session)
    elapsed_s = acquisition_elapsed_s(session)
    result: JsonObject = {
        "acquisitionId": session.acquisition_id,
        "backend": session.backend,
        "status": session.status,
        "elapsedS": round(elapsed_s, 3),
        "estimatedTotalS": session.duration_s,
        "requestedTotalS": session.estimated_total_s,
        "progress": round(acquisition_progress(session), 6),
    }
    if session.save_path is not None:
        result["savePath"] = str(session.save_path)
    if session.request_path is not None or session.result_path is not None:
        result["fileBridge"] = {
            "requestId": session.acquisition_id,
            "requestPath": str(session.request_path) if session.request_path is not None else "",
            "resultPath": str(session.result_path) if session.result_path is not None else "",
        }
    if session.error_message is not None:
        result["message"] = session.error_message
    return result


def base_acquisition_metadata(acquisition: JsonObject) -> JsonObject:
    return {
        "integrationTimeS": parse_non_negative_number(acquisition.get("integrationTimeS"), "integrationTimeS", 1.0),
        "accumulations": parse_positive_int(acquisition.get("accumulations"), "accumulations", 1),
        "fromNm": parse_non_negative_number(acquisition.get("fromNm"), "fromNm", 0.0),
        "toNm": parse_non_negative_number(acquisition.get("toNm"), "toNm", 0.0),
    }


def write_fake_spectrum(save_path: Path, metadata: JsonObject) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# fake Raman spectrum generated by hardware_bridge_v2.py",
        f"# integrationTimeS={metadata['integrationTimeS']}",
        f"# accumulations={metadata['accumulations']}",
        "raman_shift_nm,intensity",
        "100,10",
        "200,18",
        "300,12",
    ]
    save_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_ini_atomic(path: Path, rows: list[tuple[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{key}={value}\n" for key, value in rows)
    temp_path = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    temp_path.write_text(body, encoding="utf-8")
    temp_path.replace(path)


def is_stable_file(path: Path) -> bool:
    try:
        first_size = path.stat().st_size
        if first_size <= 0:
            return False
        time.sleep(0.02)
        return path.exists() and path.stat().st_size == first_size
    except OSError:
        return False


def read_ini(path: Path) -> dict[str, str]:
    record: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        record[key.strip()] = value.strip()
    return record


def update_metadata_from_labspec_result(metadata: JsonObject, result: dict[str, str]) -> None:
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


def prepare_labspec_acquisition(session: SpectrometerAcquisition) -> None:
    bridge_dir_value = session.acquisition.get("bridgeDir")
    if not isinstance(bridge_dir_value, str) or not bridge_dir_value:
        raise BridgeError("acquisition_failed", "labspec_file_bridge acquisition requires bridgeDir")
    bridge_dir = Path(bridge_dir_value)
    request_path = bridge_dir / "requests" / f"{session.acquisition_id}.ini"
    result_path = bridge_dir / "results" / f"{session.acquisition_id}.ini"
    request_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    if request_path.exists():
        request_path.unlink()
    if result_path.exists():
        result_path.unlink()

    request_rows = [
        ("request_id", session.acquisition_id),
        ("action", "spectrum"),
        ("integration_time_s", str(base_acquisition_metadata(session.acquisition)["integrationTimeS"])),
        ("accumulations", str(base_acquisition_metadata(session.acquisition)["accumulations"])),
        ("acq_from_nm", str(base_acquisition_metadata(session.acquisition)["fromNm"])),
        ("acq_to_nm", str(base_acquisition_metadata(session.acquisition)["toNm"])),
        ("auto_show", "1" if bool(session.acquisition.get("autoShow", True)) else "0"),
        ("save_format", session.save_format),
    ]
    if session.save_path is not None:
        session.save_path.parent.mkdir(parents=True, exist_ok=True)
        resolved_save_path = str(session.save_path.resolve())
        request_rows.append(("output_path", resolved_save_path))
        request_rows.append(("save_path", resolved_save_path))

    write_ini_atomic(request_path, request_rows)
    session.bridge_dir = bridge_dir
    session.request_path = request_path
    session.result_path = result_path


def fake_frame_matrix(z_um: float, focus_z_um: float) -> list[list[float]]:
    distance = abs(z_um - focus_z_um)
    scale = max(0.2, 1.0 - min(distance / 20.0, 0.8))
    base = [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 32, 64, 64, 32, 0, 0],
        [0, 32, 128, 220, 220, 128, 32, 0],
        [0, 64, 220, 255, 255, 220, 64, 0],
        [0, 64, 220, 255, 255, 220, 64, 0],
        [0, 32, 128, 220, 220, 128, 32, 0],
        [0, 0, 32, 64, 64, 32, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
    ]
    return [[round(value * scale, 3) for value in row] for row in base]


def write_fake_frame(save_path: Path, matrix: list[list[float]]) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(" ".join(str(int(round(value))) for value in row) for row in matrix)
    save_path.write_text(f"P2\n{len(matrix[0])} {len(matrix)}\n255\n{body}\n", encoding="utf-8")


def image_to_matrix(image: Any) -> list[list[float]]:
    if NP is not None:
        array = NP.asarray(image)
        if getattr(array, "ndim", 0) == 3:
            array = array[:, :, :3].mean(axis=2)
        return [[float(value) for value in row] for row in array.tolist()]
    if hasattr(image, "tolist"):
        raw = image.tolist()
    else:
        raw = image
    return grayscale_matrix(raw, "frame.image")


def load_saved_frame_matrix(path: Path) -> list[list[float]]:
    if PIL_IMAGE is not None:
        try:
            image = PIL_IMAGE.open(path).convert("L")
            width, height = image.size
            pixels = list(image.getdata())
            return [[float(pixels[y * width + x]) for x in range(width)] for y in range(height)]
        except Exception:
            pass
    text = path.read_text(encoding="utf-8")
    tokens = [token for token in text.split() if not token.startswith("#")]
    if len(tokens) < 4 or tokens[0] != "P2":
        raise BridgeError("frame_timeout", f"unsupported frame file format without Pillow: {path.suffix or 'unknown'}")
    width = int(tokens[1])
    height = int(tokens[2])
    pixel_tokens = tokens[4:]
    if len(pixel_tokens) != width * height:
        raise BridgeError("frame_timeout", f"PGM frame pixel count mismatch for {path}")
    values = [float(token) for token in pixel_tokens]
    return [values[row_index * width : (row_index + 1) * width] for row_index in range(height)]


def save_frame_image(save_path: Path, image: Any) -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    if PIL_IMAGE is not None and NP is not None:
        PIL_IMAGE.fromarray(NP.asarray(image)).save(save_path)
        return
    matrix = image_to_matrix(image)
    write_fake_frame(save_path, matrix)


def thermal_current_temperature(state: ThermalState) -> float:
    now = time.monotonic()
    duration_s = max(state.stable_after_monotonic - state.stable_window_s - state.started_monotonic, 0.0)
    if duration_s <= 0 or now >= state.stable_after_monotonic - state.stable_window_s:
        return state.target_c
    progress = max(0.0, min(1.0, (now - state.started_monotonic) / duration_s))
    return state.start_c + (state.target_c - state.start_c) * progress


def thermal_state_to_wire(state: ThermalState) -> JsonObject:
    current_c = thermal_current_temperature(state)
    now = time.monotonic()
    stable = abs(current_c - state.target_c) <= state.tolerance_c and now >= state.stable_after_monotonic
    return {
        "backend": state.backend,
        "targetTemperatureC": state.target_c,
        "currentTemperatureC": round(current_c, 4),
        "toleranceC": state.tolerance_c,
        "stableWindowS": state.stable_window_s,
        "stable": stable,
        "remainingS": round(max(0.0, state.stable_after_monotonic - now), 3),
    }


def collect_fake_acquisition(runtime: BridgeRuntime, session: SpectrometerAcquisition) -> JsonObject:
    refresh_acquisition_status(session)
    if session.status == "cancelled":
        raise BridgeError(
            "acquisition_cancelled",
            f"spectrometer acquisition was cancelled: {session.acquisition_id}",
            {"acquisitionId": session.acquisition_id},
        )
    if session.status == "running":
        raise BridgeError(
            "acquisition_not_ready",
            f"spectrometer acquisition is still running: {session.acquisition_id}",
            acquisition_status_to_wire(session),
        )
    if session.collected_result is not None:
        return session.collected_result

    save_path = session.save_path or Path(f"spectrum_{session.acquisition_id}.{session.save_format}")
    metadata = {
        **base_acquisition_metadata(session.acquisition),
        "snrEstimate": 12.0,
        "totalIntensity": 40.0,
        "saturated": False,
        "backend": session.backend,
    }
    write_fake_spectrum(save_path, metadata)
    session.status = "collected"
    result = {
        "acquisitionId": session.acquisition_id,
        "status": session.status,
        "outputPath": str(save_path),
        "metadata": metadata,
        "artifact": {
            "kind": "spectrum",
            "path": str(save_path),
            "format": session.save_format,
        },
    }
    session.collected_result = result
    runtime.clear_active_acquisition(session.acquisition_id)
    return result


def collect_labspec_acquisition(runtime: BridgeRuntime, session: SpectrometerAcquisition) -> JsonObject:
    refresh_acquisition_status(session)
    if session.status == "cancelled":
        raise BridgeError(
            "acquisition_cancelled",
            f"spectrometer acquisition was cancelled: {session.acquisition_id}",
            {"acquisitionId": session.acquisition_id},
        )
    if session.status == "running":
        raise BridgeError(
            "acquisition_not_ready",
            f"spectrometer acquisition is still running: {session.acquisition_id}",
            acquisition_status_to_wire(session),
        )
    if session.status == "failed":
        raise BridgeError(
            "acquisition_failed",
            session.error_message or "LabSpec worker reported an acquisition error",
            acquisition_status_to_wire(session),
        )
    if session.collected_result is not None:
        return session.collected_result

    result = session.file_bridge_result or {}
    metadata = base_acquisition_metadata(session.acquisition)
    metadata["backend"] = "labspec_file_bridge"
    update_metadata_from_labspec_result(metadata, result)
    output_value = result.get("output_path") or result.get("save_path")
    if not output_value and session.save_path is not None:
        output_value = str(session.save_path)
    file_bridge = {
        "requestId": session.acquisition_id,
        "requestPath": str(session.request_path) if session.request_path is not None else "",
        "resultPath": str(session.result_path) if session.result_path is not None else "",
    }
    session.status = "collected"
    collected = {
        "acquisitionId": session.acquisition_id,
        "status": session.status,
        "outputPath": str(output_value) if output_value else "",
        "metadata": metadata,
        "fileBridge": file_bridge,
        "artifact": {
            "kind": "spectrum",
            "path": str(output_value) if output_value else "",
            "format": session.save_format,
        },
    }
    session.collected_result = collected
    runtime.clear_active_acquisition(session.acquisition_id)
    return collected


def collect_acquisition(runtime: BridgeRuntime, session: SpectrometerAcquisition) -> JsonObject:
    if session.backend == "fake":
        return collect_fake_acquisition(runtime, session)
    if session.backend == "labspec_file_bridge":
        return collect_labspec_acquisition(runtime, session)
    raise BridgeError("acquisition_failed", f"unsupported acquisition backend: {session.backend}")


def parse_numeric_matrix(value: Any, path: str) -> list[list[float]]:
    if not isinstance(value, list) or len(value) == 0:
        raise BridgeError("invalid_request", f"{path} must be a non-empty numeric matrix", {"path": path})
    matrix: list[list[float]] = []
    width: int | None = None
    for row_index, raw_row in enumerate(value):
        if not isinstance(raw_row, list) or len(raw_row) == 0:
            raise BridgeError("invalid_request", f"{path}[{row_index}] must be a non-empty numeric row", {"path": path})
        row = [parse_number(item, f"{path}[{row_index}]") for item in raw_row]
        if width is None:
            width = len(row)
        elif len(row) != width:
            raise BridgeError("invalid_request", f"{path} rows must have equal lengths", {"path": path})
        matrix.append(row)
    return matrix


def parse_roi(value: Any) -> tuple[int, int, int, int] | None:
    roi = parse_payload(value)
    if not roi:
        return None
    x = int(parse_number(roi.get("x", 0), "roi.x"))
    y = int(parse_number(roi.get("y", 0), "roi.y"))
    width = int(parse_number(roi.get("width", 1), "roi.width"))
    height = int(parse_number(roi.get("height", 1), "roi.height"))
    if width <= 0 or height <= 0:
        raise BridgeError("invalid_request", "roi width and height must be positive")
    return (x, y, width, height)


def grayscale_matrix(value: Any, path: str) -> list[list[float]]:
    raw = parse_numeric_matrix_like(value, path)
    matrix: list[list[float]] = []
    for row in raw:
        gray_row: list[float] = []
        for cell in row:
            if isinstance(cell, list):
                channels = [parse_number(channel, path) for channel in cell]
                if not channels:
                    raise BridgeError("invalid_request", f"{path} image pixels must not have empty channel lists")
                gray_row.append(sum(channels[:3]) / min(len(channels), 3))
            else:
                gray_row.append(parse_number(cell, path))
        matrix.append(gray_row)
    return matrix


def parse_numeric_matrix_like(value: Any, path: str) -> list[list[Any]]:
    if not isinstance(value, list) or len(value) == 0:
        raise BridgeError("invalid_request", f"{path} must be a non-empty image matrix", {"path": path})
    matrix: list[list[Any]] = []
    width: int | None = None
    for row_index, raw_row in enumerate(value):
        if not isinstance(raw_row, list) or len(raw_row) == 0:
            raise BridgeError("invalid_request", f"{path}[{row_index}] must be a non-empty row", {"path": path})
        if width is None:
            width = len(raw_row)
        elif len(raw_row) != width:
            raise BridgeError("invalid_request", f"{path} rows must have equal lengths", {"path": path})
        matrix.append(raw_row)
    return matrix


def load_image_matrix(payload: JsonObject, key: str) -> list[list[float]]:
    if key in payload:
        return grayscale_matrix(payload[key], key)
    path_key = f"{key}Path"
    path = payload.get(path_key)
    if isinstance(path, str):
        if PIL_IMAGE is None:
            raise BridgeError(
                "algorithm_dependency_unavailable",
                f"{path_key} requires Pillow image loading, but PIL is unavailable",
                {"dependency": "PIL", "path": path_key},
            )
        try:
            image = PIL_IMAGE.open(path).convert("L")
            width, height = image.size
            pixels = list(image.getdata())
            return [[float(pixels[y * width + x]) for x in range(width)] for y in range(height)]
        except Exception as error:
            raise BridgeError("invalid_request", f"failed to load {path_key}: {error}", {"path": path}) from error
    raise BridgeError("invalid_request", f"payload requires {key} or {path_key}")


def crop(matrix: list[list[float]], roi: tuple[int, int, int, int] | None) -> list[list[float]]:
    if roi is None:
        return matrix
    x, y, width, height = roi
    if y < 0 or x < 0 or y + height > len(matrix) or x + width > len(matrix[0]):
        raise BridgeError("invalid_request", "roi is outside image bounds")
    return [row[x : x + width] for row in matrix[y : y + height]]


def mean(values: list[float]) -> float:
    return sum(values) / max(len(values), 1)


def variance(values: list[float]) -> float:
    avg = mean(values)
    return sum((value - avg) * (value - avg) for value in values) / max(len(values), 1)


def convolve3(matrix: list[list[float]], kernel: list[list[float]]) -> list[list[float]]:
    height = len(matrix)
    width = len(matrix[0])
    result: list[list[float]] = []
    for y in range(height):
        row: list[float] = []
        for x in range(width):
            total = 0.0
            for ky in range(3):
                source_y = min(max(y + ky - 1, 0), height - 1)
                for kx in range(3):
                    source_x = min(max(x + kx - 1, 0), width - 1)
                    total += kernel[ky][kx] * matrix[source_y][source_x]
            row.append(total)
        result.append(row)
    return result


def focus_score_fallback(image: list[list[float]], metric: str, roi: tuple[int, int, int, int] | None) -> float:
    patch = crop(image, roi)
    flat = [value for row in patch for value in row]
    if metric == "normalized_variance":
        return variance(flat) / max(mean(flat), 1e-6)
    if metric == "brenner":
        total = 0.0
        count = 0
        for row in patch:
            for x in range(max(len(row) - 2, 0)):
                total += (row[x + 2] - row[x]) ** 2
                count += 1
        return total / max(count, 1)
    if metric == "laplacian_variance":
        lap = convolve3(patch, [[0.0, 1.0, 0.0], [1.0, -4.0, 1.0], [0.0, 1.0, 0.0]])
        return variance([value for row in lap for value in row])
    if metric == "tenengrad":
        gx = convolve3(patch, [[-1.0, 0.0, 1.0], [-2.0, 0.0, 2.0], [-1.0, 0.0, 1.0]])
        gy = convolve3(patch, [[-1.0, -2.0, -1.0], [0.0, 0.0, 0.0], [1.0, 2.0, 1.0]])
        energy = [gx[y][x] * gx[y][x] + gy[y][x] * gy[y][x] for y in range(len(patch)) for x in range(len(patch[0]))]
        return mean(energy)
    raise BridgeError("invalid_request", f"unsupported fallback focus metric: {metric}")


def action_calc_focus_score(payload: JsonObject, _context: BridgeContext) -> JsonObject:
    metric = str(payload.get("metric", "tenengrad"))
    image = load_image_matrix(payload, "image")
    roi = parse_roi(payload.get("roi"))
    if NP is not None and FOCUS_METRICS is not None and FOCUS_ROI is not None:
        try:
            focus_roi = FOCUS_ROI(x=roi[0], y=roi[1], width=roi[2], height=roi[3]) if roi is not None else FOCUS_ROI(0, 0, len(image[0]), len(image))
            score = FOCUS_METRICS.get_metric(metric)(NP.asarray(image, dtype=NP.float32), focus_roi)
            return {"score": float(score), "metric": metric, "backend": "docs_raman_numpy"}
        except KeyError as error:
            raise BridgeError("invalid_request", str(error)) from error
    return {"score": focus_score_fallback(image, metric, roi), "metric": metric, "backend": "pure_python_fallback"}


def phase_correlation_fallback(
    reference: list[list[float]],
    current: list[list[float]],
    roi: tuple[int, int, int, int] | None,
    max_shift_px: int,
) -> JsonObject:
    ref = crop(reference, roi)
    cur = crop(current, roi)
    if len(ref) != len(cur) or len(ref[0]) != len(cur[0]):
        raise BridgeError("invalid_request", "reference and current images must have the same shape")
    height = len(ref)
    width = len(ref[0])
    best_score: float | None = None
    second_score: float | None = None
    best_dx = 0
    best_dy = 0
    for dy in range(-max_shift_px, max_shift_px + 1):
        for dx in range(-max_shift_px, max_shift_px + 1):
            score = 0.0
            count = 0
            for y in range(height):
                target_y = y + dy
                if target_y < 0 or target_y >= height:
                    continue
                for x in range(width):
                    target_x = x + dx
                    if target_x < 0 or target_x >= width:
                        continue
                    score += ref[y][x] * cur[target_y][target_x]
                    count += 1
            score = score / max(count, 1)
            if best_score is None or score > best_score:
                second_score = best_score
                best_score = score
                best_dx = dx
                best_dy = dy
            elif second_score is None or score > second_score:
                second_score = score
    peak = best_score if best_score is not None else 0.0
    confidence = 1.0 if second_score is None else max(0.0, min(1.0, (peak - second_score) / (abs(peak) + 1e-12)))
    return {
        "shift": {"dx": float(best_dx), "dy": float(best_dy)},
        "pixelShift": {"dx": float(best_dx), "dy": float(best_dy)},
        "confidence": float(confidence),
        "peakValue": float(peak),
        "backend": "pure_python_fallback",
    }


def action_phase_correlation(payload: JsonObject, _context: BridgeContext) -> JsonObject:
    reference = load_image_matrix(payload, "reference")
    current = load_image_matrix(payload, "current")
    roi = parse_roi(payload.get("roi"))
    max_shift_px = int(payload.get("maxShiftPx", min(8, len(reference), len(reference[0]))))
    if max_shift_px < 0:
        raise BridgeError("invalid_request", "maxShiftPx must be non-negative")
    if NP is not None and ESTIMATE_TRANSLATION is not None and CALIBRATION_ROI is not None:
        calibration_roi = CALIBRATION_ROI(x=roi[0], y=roi[1], width=roi[2], height=roi[3]) if roi is not None else None
        result = ESTIMATE_TRANSLATION(NP.asarray(reference), NP.asarray(current), calibration_roi)
        dx = float(result.shift.dx)
        dy = float(result.shift.dy)
        return {
            "shift": {"dx": dx, "dy": dy},
            "pixelShift": {"dx": dx, "dy": dy},
            "confidence": float(result.confidence),
            "peakValue": float(result.peak_value),
            "peakPosition": {"x": int(result.peak_position[0]), "y": int(result.peak_position[1])},
            "backend": "docs_raman_numpy",
        }
    return phase_correlation_fallback(reference, current, roi, max_shift_px)


def parse_shift(value: Any, path: str, dx_key: str, dy_key: str) -> tuple[float, float]:
    shift = parse_payload(value)
    return (parse_number(shift.get(dx_key), f"{path}.{dx_key}"), parse_number(shift.get(dy_key), f"{path}.{dy_key}"))


def pixel_shift_from_measurement(measurement: JsonObject, min_confidence: float, index: int) -> tuple[float, float, float]:
    if "pixelShift" in measurement:
        dx, dy = parse_shift(measurement.get("pixelShift"), f"measurements[{index}].pixelShift", "dx", "dy")
        return (dx, dy, 1.0)
    result = action_phase_correlation(
        {
            "reference": measurement.get("reference"),
            "current": measurement.get("current"),
            "referencePath": measurement.get("referenceFramePath"),
            "currentPath": measurement.get("currentFramePath"),
            "roi": measurement.get("roi"),
            "maxShiftPx": measurement.get("maxShiftPx", 8),
        },
        BridgeContext("fit-matrix-internal", threading.Lock()),
    )
    confidence = parse_number(result.get("confidence"), "phase_correlation.confidence")
    if confidence < min_confidence:
        raise BridgeError(
            "calibration_low_confidence",
            f"measurement {index} confidence {confidence:.3f} below threshold {min_confidence:.3f}",
        )
    pixel_shift = parse_payload(result.get("pixelShift"))
    return (
        parse_number(pixel_shift.get("dx"), f"measurements[{index}].pixelShift.dx"),
        parse_number(pixel_shift.get("dy"), f"measurements[{index}].pixelShift.dy"),
        confidence,
    )


def action_fit_matrix(payload: JsonObject, _context: BridgeContext) -> JsonObject:
    measurements = payload.get("measurements")
    if not isinstance(measurements, list) or len(measurements) < 2:
        raise BridgeError("calibration_singular_transform", "fit_matrix requires at least two measurements")
    min_confidence = float(payload.get("minConfidence", 0.4))
    stage_rows: list[tuple[float, float]] = []
    pixel_rows: list[tuple[float, float]] = []
    results: list[JsonObject] = []
    confidences: list[float] = []
    for index, raw_measurement in enumerate(measurements):
        measurement = parse_payload(raw_measurement)
        if "stageShift" in measurement:
            stage_dx, stage_dy = parse_shift(measurement.get("stageShift"), f"measurements[{index}].stageShift", "dxUm", "dyUm")
        else:
            stage_dx = parse_number(measurement.get("dxUm"), f"measurements[{index}].dxUm")
            stage_dy = parse_number(measurement.get("dyUm"), f"measurements[{index}].dyUm")
        pixel_dx, pixel_dy, confidence = pixel_shift_from_measurement(measurement, min_confidence, index)
        stage_rows.append((stage_dx, stage_dy))
        pixel_rows.append((pixel_dx, pixel_dy))
        confidences.append(confidence)
        results.append(
            {
                "index": index,
                "stageShiftUm": {"dxUm": stage_dx, "dyUm": stage_dy},
                "pixelShift": {"dx": pixel_dx, "dy": pixel_dy},
                "confidence": confidence,
            }
        )
    s00 = sum(dx * dx for dx, _dy in stage_rows)
    s01 = sum(dx * dy for dx, dy in stage_rows)
    s11 = sum(dy * dy for _dx, dy in stage_rows)
    determinant = s00 * s11 - s01 * s01
    if abs(determinant) < 1e-12:
        raise BridgeError("calibration_singular_transform", "calibration stage shifts must span both XY axes")
    b00 = sum(stage_rows[i][0] * pixel_rows[i][0] for i in range(len(stage_rows)))
    b01 = sum(stage_rows[i][0] * pixel_rows[i][1] for i in range(len(stage_rows)))
    b10 = sum(stage_rows[i][1] * pixel_rows[i][0] for i in range(len(stage_rows)))
    b11 = sum(stage_rows[i][1] * pixel_rows[i][1] for i in range(len(stage_rows)))
    inv00 = s11 / determinant
    inv01 = -s01 / determinant
    inv10 = -s01 / determinant
    inv11 = s00 / determinant
    solution = [
        [inv00 * b00 + inv01 * b10, inv00 * b01 + inv01 * b11],
        [inv10 * b00 + inv11 * b10, inv10 * b01 + inv11 * b11],
    ]
    pixel_per_um = [[solution[0][0], solution[1][0]], [solution[0][1], solution[1][1]]]
    residual_sum = 0.0
    for index, (stage_dx, stage_dy) in enumerate(stage_rows):
        predicted_dx = stage_dx * solution[0][0] + stage_dy * solution[1][0]
        predicted_dy = stage_dx * solution[0][1] + stage_dy * solution[1][1]
        residual_sum += (pixel_rows[index][0] - predicted_dx) ** 2
        residual_sum += (pixel_rows[index][1] - predicted_dy) ** 2
    residual_rms_px = (residual_sum / max(2 * len(stage_rows), 1)) ** 0.5
    return {
        "pixelPerUm": pixel_per_um,
        "confidence": min(confidences),
        "meanConfidence": mean(confidences),
        "residualRmsPx": residual_rms_px,
        "measurements": results,
        "backend": "pure_python_fallback" if NP is None else "docs_raman_compatible",
    }


def sleep_with_stop(runtime: BridgeRuntime, duration_ms: int) -> None:
    if duration_ms <= 0:
        return
    deadline = time.monotonic() + duration_ms / 1000.0
    while time.monotonic() < deadline:
        if runtime.stop_requested.is_set():
            raise BridgeError("aborted", "stage motion was stopped")
        time.sleep(min(0.025, max(deadline - time.monotonic(), 0.0)))


def action_stage_connect(runtime: BridgeRuntime, payload: JsonObject, _context: BridgeContext) -> JsonObject:
    stage_payload = parse_payload(payload.get("stage", payload))
    return {"stage": runtime.connect_stage(stage_payload)}


def action_stage_get_position(runtime: BridgeRuntime, payload: JsonObject, _context: BridgeContext) -> JsonObject:
    stage = runtime.ensure_stage(payload)
    return {"adapter": runtime.stage_adapter, "position": position_to_wire(stage.get_position_um())}


def action_stage_move_absolute(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    runtime.stop_requested.clear()
    stage = runtime.ensure_stage(payload)
    before = position_to_wire(stage.get_position_um())
    x_um = optional_number(payload.get("xUm"), "xUm")
    y_um = optional_number(payload.get("yUm"), "yUm")
    z_um = optional_number(payload.get("zUm"), "zUm")
    if x_um is None and y_um is None and z_um is None:
        raise BridgeError("invalid_request", "stage.move_absolute requires at least one of xUm, yUm, or zUm")
    stage.move_absolute_um(x_um=x_um, y_um=y_um, z_um=z_um)
    context.emit({"domain": "stage", "action": "move_absolute", "phase": "commanded", "target": {"xUm": x_um, "yUm": y_um, "zUm": z_um}})
    sleep_with_stop(runtime, int(payload.get("simulateDurationMs", 0)))
    return {"adapter": runtime.stage_adapter, "before": before, "position": position_to_wire(stage.get_position_um())}


def action_stage_wait_settled(runtime: BridgeRuntime, payload: JsonObject, _context: BridgeContext) -> JsonObject:
    stage = runtime.ensure_stage(payload)
    timeout_ms = int(payload.get("timeoutMs", 1000))
    stage.wait_settled(timeout_ms)
    return {"adapter": runtime.stage_adapter, "position": position_to_wire(stage.get_position_um()), "settled": True}


def action_stage_stop(runtime: BridgeRuntime, _payload: JsonObject, _context: BridgeContext) -> JsonObject:
    stopped = runtime.stop_stage()
    return {"stopped": stopped}


def action_camera_capture_frame(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    backend = str(payload.get("backend", "fake"))
    position = runtime.ensure_stage(payload).get_position_um()
    stage_position = position_to_wire(position)
    if backend == "labspec_file_bridge":
        if LABSPEC_BRIDGE_IMPORT_ERROR is not None:
            raise BridgeError(
                "frame_timeout",
                f"LabSpec frame bridge helpers are unavailable: {LABSPEC_BRIDGE_IMPORT_ERROR}",
                {"exception": LABSPEC_BRIDGE_IMPORT_ERROR.__class__.__name__},
            )
        if CREATE_LABSPEC_START_VIDEO_REQUEST is None or CREATE_LABSPEC_VIDEO_FRAME_REQUEST is None or READ_LABSPEC_RESULT is None:
            raise BridgeError("frame_timeout", "LabSpec frame bridge helpers were not loaded")
        bridge_dir_value = payload.get("bridgeDir")
        if not isinstance(bridge_dir_value, str) or not bridge_dir_value:
            raise BridgeError("frame_timeout", "labspec_file_bridge camera capture requires bridgeDir")
        timeout_ms = int(parse_non_negative_number(payload.get("timeoutMs"), "timeoutMs", 10000.0))
        bridge_dir = Path(bridge_dir_value)
        image_format = str(payload.get("imageFormat", "tif"))
        min_capture_interval_ms = int(parse_non_negative_number(payload.get("minCaptureIntervalMs"), "minCaptureIntervalMs", 400.0))
        save_path_value = payload.get("savePath")
        save_path = Path(str(save_path_value)) if isinstance(save_path_value, str) and save_path_value else None
        start_request = CREATE_LABSPEC_START_VIDEO_REQUEST(
            bridge_dir=bridge_dir,
            request_id=f"start_video_{time.monotonic_ns()}",
        )
        deadline = time.monotonic() + timeout_ms / 1000.0
        while time.monotonic() <= deadline:
            if start_request.result_path.exists() and is_stable_file(start_request.result_path):
                start_result = READ_LABSPEC_RESULT(start_request.result_path)
                if start_result.get("request_id") == start_request.request_id and start_result.get("status", "error").strip().lower() == "ok":
                    break
            time.sleep(0.05)
        else:
            raise BridgeError("frame_timeout", f"No LabSpec worker result for request {start_request.request_id} within {timeout_ms}ms")

        frame_request = CREATE_LABSPEC_VIDEO_FRAME_REQUEST(
            bridge_dir=bridge_dir,
            request_id=f"cap_{time.monotonic_ns()}",
            output_path=save_path,
            image_format=image_format,
            timeout_ms=timeout_ms,
            min_capture_interval_ms=min_capture_interval_ms,
        )
        while time.monotonic() <= deadline:
            if frame_request.result_path.exists() and is_stable_file(frame_request.result_path):
                result_record = READ_LABSPEC_RESULT(frame_request.result_path)
                if result_record.get("request_id") != frame_request.request_id:
                    time.sleep(0.05)
                    continue
                if result_record.get("status", "error").strip().lower() != "ok":
                    raise BridgeError("frame_timeout", result_record.get("message", "LabSpec worker reported an error"))
                frame_path = Path(result_record.get("frame_path") or frame_request.output_path or "")
                if not str(frame_path):
                    raise BridgeError("frame_timeout", f"LabSpec capture request {frame_request.request_id} has no output path")
                while time.monotonic() <= deadline:
                    if is_stable_file(frame_path):
                        matrix = load_saved_frame_matrix(frame_path)
                        result: JsonObject = {
                            "backend": backend,
                            "width": len(matrix[0]),
                            "height": len(matrix),
                            "image": matrix,
                            "metadata": {
                                "stagePosition": stage_position,
                                "bridgeDir": bridge_dir_value,
                                "requestId": frame_request.request_id,
                                "framePath": str(frame_path),
                            },
                            "outputPath": str(frame_path),
                            "artifact": {"kind": "frame", "path": str(frame_path), "format": frame_path.suffix.lstrip(".") or image_format},
                        }
                        context.emit({"domain": "camera", "action": "capture_frame", "backend": backend, "stagePosition": stage_position})
                        return result
                    time.sleep(0.05)
                raise BridgeError("frame_timeout", f"LabSpec capture request {frame_request.request_id} produced no stable frame within {timeout_ms}ms")
            time.sleep(0.05)
        raise BridgeError("frame_timeout", f"No LabSpec worker result for request {frame_request.request_id} within {timeout_ms}ms")
    if backend != "fake":
        raise BridgeError("frame_timeout", f"unsupported V2 camera backend: {backend}")
    z_um = parse_number(stage_position.get("zUm"), "stage.position.zUm")
    focus_z_um = parse_number(payload.get("fakeFocusZUm", 0.0), "fakeFocusZUm")
    matrix = fake_frame_matrix(z_um, focus_z_um)
    result: JsonObject = {
        "backend": backend,
        "width": len(matrix[0]),
        "height": len(matrix),
        "image": matrix,
        "metadata": {
            "stagePosition": stage_position,
            "fakeFocusZUm": focus_z_um,
        },
    }
    save_path_value = payload.get("savePath")
    if isinstance(save_path_value, str) and save_path_value:
        save_path = Path(save_path_value)
        write_fake_frame(save_path, matrix)
        result["outputPath"] = str(save_path)
        result["artifact"] = {"kind": "frame", "path": str(save_path), "format": "pgm"}
    context.emit({"domain": "camera", "action": "capture_frame", "backend": backend, "stagePosition": stage_position})
    return result


def action_thermal_set_target(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    result = runtime.set_thermal_target(payload)
    context.emit({"domain": "thermal", "action": "set_target_temp", **result})
    return result


def action_thermal_get_current(runtime: BridgeRuntime, _payload: JsonObject, _context: BridgeContext) -> JsonObject:
    return runtime.thermal_state()


def action_thermal_wait_stable(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    if "targetTemperatureC" in payload:
        runtime.set_thermal_target(payload)
    timeout_s = parse_non_negative_number(payload.get("timeoutS"), "timeoutS", 30.0)
    poll_interval_s = parse_non_negative_number(payload.get("pollIntervalS"), "pollIntervalS", 0.2)
    deadline = time.monotonic() + timeout_s
    last_emit = 0.0
    while True:
        state = runtime.thermal_state()
        now = time.monotonic()
        if now - last_emit >= min(max(poll_interval_s, 0.05), 1.0):
            context.emit({"domain": "thermal", "action": "wait_stable", **state})
            last_emit = now
        if state["stable"] is True:
            return state
        if now >= deadline:
            raise BridgeError("thermal_timeout", "thermal stage did not stabilize before timeout", state)
        time.sleep(min(max(poll_interval_s, 0.01), 1.0))


def action_spectrometer_begin_acquisition(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    session = runtime.begin_acquisition(payload)
    result = acquisition_status_to_wire(session)
    context.emit({"domain": "spectrometer", "action": "begin_acquisition", "phase": "started", **result})
    return result


def action_spectrometer_poll_acquisition(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    session = runtime.acquisition_for(parse_acquisition_id(payload))
    result = acquisition_status_to_wire(session)
    context.emit({"domain": "spectrometer", "action": "poll_acquisition", **result})
    return result


def action_spectrometer_cancel_acquisition(runtime: BridgeRuntime, payload: JsonObject, _context: BridgeContext) -> JsonObject:
    return runtime.cancel_acquisition(parse_acquisition_id(payload))


def action_spectrometer_collect_result(runtime: BridgeRuntime, payload: JsonObject, _context: BridgeContext) -> JsonObject:
    session = runtime.acquisition_for(parse_acquisition_id(payload))
    return collect_acquisition(runtime, session)


def action_spectrometer_acquire_point(runtime: BridgeRuntime, payload: JsonObject, context: BridgeContext) -> JsonObject:
    session = runtime.begin_acquisition(payload)
    poll_interval_s = parse_non_negative_number(session.acquisition.get("pollIntervalS"), "pollIntervalS", 0.2)
    context.emit({"domain": "spectrometer", "action": "acquire_point", "phase": "started", **acquisition_status_to_wire(session)})
    while True:
        status = acquisition_status_to_wire(session)
        if status["status"] == "cancelled":
            raise BridgeError("aborted", "spectrometer acquisition was cancelled", {"acquisitionId": session.acquisition_id})
        if status["status"] == "failed":
            raise BridgeError("acquisition_failed", str(status.get("message", "spectrometer acquisition failed")), status)
        if status["status"] == "completed":
            break
        context.emit({"domain": "spectrometer", "action": "acquire_point", **status})
        time.sleep(min(max(poll_interval_s, 0.01), 1.0))
    context.emit({"domain": "spectrometer", "action": "acquire_point", "phase": "completed", **acquisition_status_to_wire(session)})
    return collect_acquisition(runtime, session)


def register_default_actions(registry: ActionRegistry, runtime: BridgeRuntime) -> None:
    def list_actions(_payload: JsonObject, _context: BridgeContext) -> JsonObject:
        return {"actions": registry.contracts()}

    def shutdown(_payload: JsonObject, _context: BridgeContext) -> JsonObject:
        return {"shutdown": True}

    def fake_echo(payload: JsonObject, _context: BridgeContext) -> JsonObject:
        return {"payload": payload}

    def fake_status(_payload: JsonObject, _context: BridgeContext) -> JsonObject:
        return {
            "status": "ok",
            "bridge": "hardware_bridge_v2",
            "workflowState": "external",
            "deviceSessionState": "fake",
        }

    def fake_emit_progress(payload: JsonObject, context: BridgeContext) -> JsonObject:
        context.emit(
            {
                "domain": "fake",
                "action": "emit_progress",
                "message": str(payload.get("message", "progress")),
            }
        )
        return {"emitted": True}

    registry.register(
        ActionContract("bridge", "list_actions", "read", (), True, "none", False),
        list_actions,
    )
    registry.register(
        ActionContract("bridge", "shutdown", "read", (), True, "none", False),
        shutdown,
    )
    registry.register(
        ActionContract("fake", "echo", "read", ("fake",), True, "none", False),
        fake_echo,
    )
    registry.register(
        ActionContract("fake", "status", "read", ("fake",), True, "none", False),
        fake_status,
    )
    registry.register(
        ActionContract("fake", "emit_progress", "read", ("fake",), True, "none", True),
        fake_emit_progress,
    )
    registry.register(
        ActionContract("stage", "connect", "motion", ("stage_session", "stage_motion"), False, "best_effort", False),
        lambda payload, context: action_stage_connect(runtime, payload, context),
    )
    registry.register(
        ActionContract("stage", "get_position", "read", ("stage_session",), True, "none", False),
        lambda payload, context: action_stage_get_position(runtime, payload, context),
    )
    registry.register(
        ActionContract("stage", "move_absolute", "motion", ("stage_session", "stage_motion"), False, "best_effort", True),
        lambda payload, context: action_stage_move_absolute(runtime, payload, context),
    )
    registry.register(
        ActionContract("stage", "wait_settled", "motion", ("stage_session", "stage_motion"), False, "best_effort", False),
        lambda payload, context: action_stage_wait_settled(runtime, payload, context),
    )
    registry.register(
        ActionContract("stage", "stop", "motion", ("stage_motion",), True, "best_effort", False),
        lambda payload, context: action_stage_stop(runtime, payload, context),
    )
    registry.register(
        ActionContract("camera", "capture_frame", "read", ("camera_session",), True, "best_effort", True),
        lambda payload, context: action_camera_capture_frame(runtime, payload, context),
    )
    registry.register(
        ActionContract("thermal", "set_target_temp", "environment", ("thermal_session", "thermal_heating"), False, "best_effort", True),
        lambda payload, context: action_thermal_set_target(runtime, payload, context),
    )
    registry.register(
        ActionContract("thermal", "get_current_temp", "read", ("thermal_session",), True, "none", False),
        lambda payload, context: action_thermal_get_current(runtime, payload, context),
    )
    registry.register(
        ActionContract("thermal", "wait_stable", "environment", ("thermal_session", "thermal_heating"), False, "best_effort", True),
        lambda payload, context: action_thermal_wait_stable(runtime, payload, context),
    )
    registry.register(
        ActionContract(
            "spectrometer",
            "begin_acquisition",
            "acquisition",
            ("spectrometer_session", "spectrometer_acquisition"),
            False,
            "best_effort",
            True,
        ),
        lambda payload, context: action_spectrometer_begin_acquisition(runtime, payload, context),
    )
    registry.register(
        ActionContract("spectrometer", "poll_acquisition", "read", ("spectrometer_session",), True, "none", True),
        lambda payload, context: action_spectrometer_poll_acquisition(runtime, payload, context),
    )
    registry.register(
        ActionContract("spectrometer", "cancel_acquisition", "acquisition", ("spectrometer_acquisition",), True, "best_effort", False),
        lambda payload, context: action_spectrometer_cancel_acquisition(runtime, payload, context),
    )
    registry.register(
        ActionContract("spectrometer", "collect_result", "acquisition", ("spectrometer_session", "artifact_store"), True, "none", False),
        lambda payload, context: action_spectrometer_collect_result(runtime, payload, context),
    )
    registry.register(
        ActionContract(
            "spectrometer",
            "acquire_point",
            "acquisition",
            ("spectrometer_session", "spectrometer_acquisition", "artifact_store"),
            False,
            "best_effort",
            True,
        ),
        lambda payload, context: action_spectrometer_acquire_point(runtime, payload, context),
    )
    registry.register(
        ActionContract("focus_metric", "calc_score", "read", ("algorithm",), True, "none", False),
        action_calc_focus_score,
    )
    registry.register(
        ActionContract("drift_correction", "phase_correlation", "read", ("algorithm",), True, "none", False),
        action_phase_correlation,
    )
    registry.register(
        ActionContract("calibration", "fit_matrix", "read", ("algorithm",), True, "none", False),
        action_fit_matrix,
    )


def reader_loop(
    registry: ActionRegistry,
    runtime: BridgeRuntime,
    commands: "queue.Queue[Command]",
    output_lock: threading.Lock,
) -> None:
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        parsed: Any | None = None
        try:
            parsed = json.loads(text)
            command = parse_command(parsed)
            contract = registry.contract_for(command.domain, command.action)
            if command.domain == "stage" and command.action == "stop":
                stopped = runtime.stop_stage()
                write_protocol({"id": command.request_id, "ok": True, "result": {"stopped": stopped}}, output_lock)
                continue
            if command.domain == "spectrometer" and command.action == "cancel_acquisition":
                result = runtime.cancel_acquisition(parse_acquisition_id(command.payload))
                write_protocol({"id": command.request_id, "ok": True, "result": result}, output_lock)
                continue
            reserved_resources = runtime.reserve(contract, command.request_id)
            commands.put(
                Command(
                    command.request_id,
                    command.domain,
                    command.action,
                    command.payload,
                    command.timeout_ms,
                    reserved_resources,
                )
            )
        except BridgeError as error:
            request_id = "unknown"
            if isinstance(parsed, dict) and isinstance(parsed.get("id"), str):
                request_id = parsed["id"]
            write_error(request_id, error, output_lock)
        except Exception as error:
            write_exception("unknown", error, output_lock)
    commands.put(Command("stdin-eof", "bridge", "shutdown", {}, None))


def worker_loop(
    registry: ActionRegistry,
    runtime: BridgeRuntime,
    commands: "queue.Queue[Command]",
    output_lock: threading.Lock,
) -> None:
    while True:
        command = commands.get()
        context = BridgeContext(command.request_id, output_lock)
        try:
            result = registry.handle(command, context)
            write_protocol({"id": command.request_id, "ok": True, "result": result}, output_lock)
        except BridgeError as error:
            write_error(command.request_id, error, output_lock)
        except Exception as error:
            write_exception(command.request_id, error, output_lock)
        finally:
            runtime.release(command.request_id, command.reserved_resources)
        if command.domain == "bridge" and command.action == "shutdown":
            return


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-root", type=Path, default=Path.cwd() / "docs" / "Raman")
    args = parser.parse_args()
    preload_algorithm_modules(args.stage_root)
    runtime = BridgeRuntime(args.stage_root)
    registry = ActionRegistry()
    register_default_actions(registry, runtime)
    commands: "queue.Queue[Command]" = queue.Queue()
    output_lock = threading.Lock()
    reader = threading.Thread(target=reader_loop, args=(registry, runtime, commands, output_lock), daemon=True)
    reader.start()
    debug("hardware_bridge_v2 ready")
    worker_loop(registry, runtime, commands, output_lock)
    runtime.close()
    debug("hardware_bridge_v2 stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
