"""JSON file-queue protocol helpers for the LabSpec worker."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from mapping.models import AcquisitionResult


@dataclass(frozen=True)
class LabSpecRequest:
    """Paths associated with one LabSpec worker request."""

    request_id: str
    request_path: Path
    result_path: Path
    output_path: Path | None = None


@dataclass(frozen=True)
class LabSpecWorkerAcquisitionConfig:
    """Configuration for submitting one spectrum acquisition request."""

    bridge_dir: Path
    integration_time_s: float
    accumulations: int
    acq_from_nm: float
    acq_to_nm: float
    auto_show: bool = True
    save_path: Path | None = None
    save_format: str = "txt"
    plot_spectrum: bool = False
    poll_interval_s: float = 0.2
    timeout_s: float = 30.0


def create_labspec_start_video_request(bridge_dir: Path, request_id: str) -> LabSpecRequest:
    return _write_request(
        bridge_dir=bridge_dir,
        request_id=request_id,
        action="start_video",
        payload={},
    )


def create_labspec_shutdown_request(bridge_dir: Path, request_id: str) -> LabSpecRequest:
    return _write_request(
        bridge_dir=bridge_dir,
        request_id=request_id,
        action="shutdown",
        payload={},
    )


def create_labspec_video_frame_request(
    bridge_dir: Path,
    request_id: str,
    image_format: str,
    timeout_ms: int,
    min_capture_interval_ms: int,
) -> LabSpecRequest:
    output_path = bridge_dir / "frames" / f"frame_{request_id}.{image_format}"
    return _write_request(
        bridge_dir=bridge_dir,
        request_id=request_id,
        action="capture_frame",
        payload={
            "image_format": image_format,
            "timeout_ms": int(timeout_ms),
            "min_capture_interval_ms": int(min_capture_interval_ms),
            "frame_path": str(output_path),
        },
        output_path=output_path,
    )


def create_labspec_acquisition_request(
    bridge_dir: Path,
    request_id: str,
    *,
    integration_time_s: float,
    accumulations: int,
    acq_from_nm: float,
    acq_to_nm: float,
    auto_show: bool,
    save_path: Path | None,
    save_format: str,
    plot_spectrum: bool,
) -> LabSpecRequest:
    output_path = save_path or bridge_dir / "spectra" / f"spectrum_{request_id}.{save_format}"
    return _write_request(
        bridge_dir=bridge_dir,
        request_id=request_id,
        action="acquire_spectrum",
        payload={
            "integration_time_s": float(integration_time_s),
            "accumulations": int(accumulations),
            "acq_from_nm": float(acq_from_nm),
            "acq_to_nm": float(acq_to_nm),
            "auto_show": bool(auto_show),
            "save_path": str(output_path),
            "save_format": save_format,
            "plot_spectrum": bool(plot_spectrum),
        },
        output_path=output_path,
    )


def read_labspec_result(result_path: Path) -> dict[str, Any]:
    with result_path.open("r", encoding="utf-8") as handle:
        parsed = json.load(handle)
    if not isinstance(parsed, dict):
        raise ValueError(f"LabSpec result must be a JSON object: {result_path}")
    return parsed


class LabSpecFileBridgeRamanAcquirer:
    """Submit Raman spectrum requests through the LabSpec file bridge."""

    def __init__(self, config: LabSpecWorkerAcquisitionConfig) -> None:
        self.config = config

    def acquire_point(self, point_id: str, metadata: dict[str, Any]) -> AcquisitionResult:
        request = create_labspec_acquisition_request(
            bridge_dir=self.config.bridge_dir,
            request_id=f"acq_{point_id}_{time.monotonic_ns()}",
            integration_time_s=self.config.integration_time_s,
            accumulations=self.config.accumulations,
            acq_from_nm=self.config.acq_from_nm,
            acq_to_nm=self.config.acq_to_nm,
            auto_show=self.config.auto_show,
            save_path=self.config.save_path,
            save_format=self.config.save_format,
            plot_spectrum=self.config.plot_spectrum,
        )
        try:
            result = _wait_for_result(
                request.result_path,
                request.request_id,
                timeout_s=self.config.timeout_s,
                poll_interval_s=self.config.poll_interval_s,
            )
        except TimeoutError as exc:
            return AcquisitionResult(ok=False, message=str(exc), output_path=request.output_path, metadata=metadata)

        status = str(result.get("status", "error")).strip().lower()
        result_metadata = dict(metadata)
        raw_metadata = result.get("metadata")
        if isinstance(raw_metadata, dict):
            result_metadata.update(raw_metadata)
        output_value = result.get("output_path") or result.get("spectrum_path") or request.output_path
        output_path = Path(output_value) if output_value else None
        if status == "ok":
            return AcquisitionResult(ok=True, output_path=output_path, metadata=result_metadata)
        message = str(result.get("message", "LabSpec worker reported an acquisition error"))
        return AcquisitionResult(ok=False, message=message, output_path=output_path, metadata=result_metadata)


def _write_request(
    *,
    bridge_dir: Path,
    request_id: str,
    action: str,
    payload: dict[str, Any],
    output_path: Path | None = None,
) -> LabSpecRequest:
    requests_dir = bridge_dir / "requests"
    results_dir = bridge_dir / "results"
    requests_dir.mkdir(parents=True, exist_ok=True)
    results_dir.mkdir(parents=True, exist_ok=True)
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    request_path = requests_dir / f"{request_id}.json"
    result_path = results_dir / f"{request_id}.json"
    request_body = {
        "schema_version": "1",
        "request_id": request_id,
        "action": action,
        "result_path": str(result_path),
        **payload,
    }
    if output_path is not None:
        request_body["output_path"] = str(output_path)
    _atomic_write_json(request_path, request_body)
    return LabSpecRequest(
        request_id=request_id,
        request_path=request_path,
        result_path=result_path,
        output_path=output_path,
    )


def _wait_for_result(
    result_path: Path,
    request_id: str,
    *,
    timeout_s: float,
    poll_interval_s: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() <= deadline:
        if _is_stable_file(result_path):
            result = read_labspec_result(result_path)
            if result.get("request_id") == request_id:
                return result
        time.sleep(poll_interval_s)
    raise TimeoutError(f"No LabSpec worker result for request {request_id} in {result_path.parent} within {timeout_s:.1f}s")


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    temp_path.replace(path)


def _is_stable_file(path: Path) -> bool:
    try:
        first_size = path.stat().st_size
        if first_size <= 0:
            return False
        time.sleep(0.02)
        return path.exists() and path.stat().st_size == first_size
    except OSError:
        return False
