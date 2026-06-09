"""
Pure dataclasses and Protocol interfaces for the autofocus module.
"""

import numpy as np
from dataclasses import dataclass
from typing import Protocol, Literal, Optional
from enum import Enum

from autofocus.exceptions import FrameTimeoutError
from stage.models import ZStage


# ---------------------------------------------------------------------------
# ROI
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ROI:
    """Rectangular region of interest in pixel coordinates (top-left origin)."""

    x: int
    y: int
    width: int
    height: int

    def slice(self) -> tuple[slice, slice]:
        """Return (row_slice, col_slice) for direct numpy array indexing."""
        return (slice(self.y, self.y + self.height), slice(self.x, self.x + self.width))

    def is_valid(self, image_shape: tuple[int, int]) -> bool:
        """Return True if the ROI fits entirely within (h, w)."""
        h, w = image_shape
        return (
            self.x >= 0
            and self.y >= 0
            and self.width > 0
            and self.height > 0
            and self.x + self.width <= w
            and self.y + self.height <= h
        )


# ---------------------------------------------------------------------------
# Frame
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Frame:
    """A single captured image frame with timing metadata."""

    image: np.ndarray       # 2D grayscale (H, W) or 3D (H, W, C)
    timestamp: float        # Seconds, monotonic clock
    seq: int                # Monotonically increasing frame index


# ---------------------------------------------------------------------------
# Protocols
# ---------------------------------------------------------------------------

class FrameProvider(Protocol):
    """Interface for obtaining camera frames."""

    def get_latest(self) -> Frame:
        """Return the most recent frame; may be stale."""
        ...

    def wait_for_next(self, after_ts: float, timeout_ms: int) -> Frame:
        """Block until a Frame with timestamp > after_ts arrives; raise FrameTimeoutError on timeout."""
        ...


class FocusStrategy(Protocol):
    """Interface for a sharpness metric used to score focus quality."""

    def score(self, image: np.ndarray, roi: ROI) -> float:
        """Return a non-negative sharpness score for the given ROI."""
        ...

    @property
    def name(self) -> str:
        """Human-readable identifier for this metric (e.g. 'tenengrad')."""
        ...


# ---------------------------------------------------------------------------
# AutofocusParams
# ---------------------------------------------------------------------------

@dataclass
class AutofocusParams:
    """Configuration parameters for a single autofocus run."""

    # Required — declared first so dataclass field ordering is satisfied
    z_min_um: float
    z_max_um: float

    # Scan geometry
    coarse_range_um: float = 80.0
    coarse_step_um: float = 10.0
    fine_range_um: float = 15.0
    fine_step_um: float = 2.0

    # Timing
    settle_ms: int = 100
    frame_timeout_ms: int = 500
    stage_timeout_ms: int = 3000

    # Acquisition
    frames_per_z: int = 3

    # Mechanics
    backlash_um: float = 3.0

    # Quality thresholds
    min_confidence: float = 0.2
    coarse_min_prominence: float = 0.2
    max_saturation_ratio: float = 0.01

    # Metric selection
    metric_name: str = "tenengrad"

    def __post_init__(self) -> None:
        if not (self.z_min_um < self.z_max_um):
            raise ValueError(f"z_min_um ({self.z_min_um}) must be less than z_max_um ({self.z_max_um})")
        for name, val in [
            ("coarse_range_um", self.coarse_range_um),
            ("coarse_step_um", self.coarse_step_um),
            ("fine_range_um", self.fine_range_um),
            ("fine_step_um", self.fine_step_um),
        ]:
            if val <= 0:
                raise ValueError(f"{name} must be positive, got {val}")


# ---------------------------------------------------------------------------
# FocusPoint / ScanCurve
# ---------------------------------------------------------------------------

@dataclass
class FocusPoint:
    """Sharpness measurement at a single Z position."""

    z_um: float
    score: float
    saturation_ratio: float


@dataclass
class ScanCurve:
    """Ordered sequence of FocusPoints collected during one scan phase."""

    phase: Literal["coarse", "fine"]
    points: list[FocusPoint]

    def best(self) -> Optional[FocusPoint]:
        """Return the point with the highest score, or None if empty."""
        if not self.points:
            return None
        return max(self.points, key=lambda p: p.score)


# ---------------------------------------------------------------------------
# FocusStatus / FocusResult
# ---------------------------------------------------------------------------

class FocusStatus(str, Enum):
    """Outcome codes for a completed autofocus run."""

    OK = "ok"
    NO_PEAK = "no_peak"
    LOW_CONFIDENCE = "low_confidence"
    OUT_OF_RANGE = "out_of_range"
    ABORTED = "aborted"
    STAGE_ERROR = "stage_error"
    FRAME_ERROR = "frame_error"


@dataclass
class FocusResult:
    """Result returned after an autofocus run completes or fails."""

    status: FocusStatus
    z_best_um: Optional[float]
    final_score: Optional[float]
    confidence: float           # 0.0 to 1.0
    coarse: Optional[ScanCurve]
    fine: Optional[ScanCurve]
    message: str = ""
