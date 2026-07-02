"""Data models for fixed-range autofocus scans."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class FixedRangeAutofocusParams:
    """Configuration for a deterministic Z scan over a fixed range."""

    z_start_um: float
    z_end_um: float
    scan_mode: Literal["step"] = "step"
    point_count: int | None = None
    min_points: int = 5
    max_points: int = 10
    target_spacing_um: float = 5.0
    stage_timeout_ms: int = 3000
    frame_timeout_ms: int = 500
    settle_ms: int = 100
    frames_per_z: int = 1
    target_tolerance_um: float = 5.0
    final_tolerance_um: float = 5.0
    final_approach_offset_um: float = 3.0
    interpolate_peak: bool = True
    verification_range_um: float = 3.0
    verification_point_count: int = 5
    verification_frames_per_z: int = 1
    final_verification_frames_per_z: int = 1

    def __post_init__(self) -> None:
        if self.z_start_um == self.z_end_um:
            raise ValueError("z_start_um and z_end_um must be different.")
        if self.scan_mode != "step":
            raise ValueError("scan_mode must be 'step'. Continuous autofocus is disabled.")
        if self.point_count is not None and self.point_count < 3:
            raise ValueError("point_count must be at least 3 when set.")
        if self.min_points < 3:
            raise ValueError("min_points must be at least 3.")
        if self.max_points < self.min_points:
            raise ValueError("max_points must be greater than or equal to min_points.")
        if self.target_spacing_um <= 0:
            raise ValueError("target_spacing_um must be positive.")
        if self.stage_timeout_ms <= 0:
            raise ValueError("stage_timeout_ms must be positive.")
        if self.frame_timeout_ms <= 0:
            raise ValueError("frame_timeout_ms must be positive.")
        if self.settle_ms < 0:
            raise ValueError("settle_ms must be non-negative.")
        if self.frames_per_z <= 0:
            raise ValueError("frames_per_z must be positive.")
        if self.target_tolerance_um <= 0:
            raise ValueError("target_tolerance_um must be positive.")
        if self.final_tolerance_um <= 0:
            raise ValueError("final_tolerance_um must be positive.")
        if self.final_approach_offset_um < 0:
            raise ValueError("final_approach_offset_um must be non-negative.")
        if self.verification_range_um <= 0:
            raise ValueError("verification_range_um must be positive.")
        if self.verification_point_count < 3:
            raise ValueError("verification_point_count must be at least 3.")
        if self.verification_frames_per_z <= 0:
            raise ValueError("verification_frames_per_z must be positive.")
        if self.final_verification_frames_per_z <= 0:
            raise ValueError("final_verification_frames_per_z must be positive.")


@dataclass(frozen=True)
class ScoredZPoint:
    """One scored autofocus sample at the actual read-back Z position."""

    target_z_um: float
    actual_z_um: float
    score: float


@dataclass(frozen=True)
class PeakEstimate:
    """Estimated best focus position from actual Z to score samples."""

    z_um: float
    score: float
    source: str
    sampled_best: ScoredZPoint


@dataclass(frozen=True)
class FixedRangeAutofocusResult:
    """Result of a fixed-range autofocus run."""

    best: ScoredZPoint
    peak: PeakEstimate
    final_z_um: float
    final_verification: ScoredZPoint
    final_error_um: float
    verification_points: list[ScoredZPoint] | None
    points: list[ScoredZPoint]
