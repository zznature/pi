"""Dataclasses used by image-based XY calibration."""

from dataclasses import dataclass
from typing import Optional

from stage.models import StageShift


@dataclass(frozen=True)
class ROI:
    """Rectangular region of interest in pixel coordinates."""

    x: int
    y: int
    width: int
    height: int

    def slice(self) -> tuple[slice, slice]:
        return (slice(self.y, self.y + self.height), slice(self.x, self.x + self.width))

    def is_valid(self, image_shape: tuple[int, int]) -> bool:
        h, w = image_shape
        return (
            self.x >= 0
            and self.y >= 0
            and self.width > 0
            and self.height > 0
            and self.x + self.width <= w
            and self.y + self.height <= h
        )


@dataclass(frozen=True)
class PixelShift:
    """Image displacement in pixels; positive x is right, positive y is down."""

    dx: float
    dy: float


@dataclass(frozen=True)
class ShiftResult:
    """Result of registering a moving image against a reference image."""

    shift: PixelShift
    confidence: float
    peak_value: float
    peak_position: tuple[int, int]
    roi: Optional[ROI] = None
