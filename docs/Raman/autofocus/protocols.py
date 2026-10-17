"""Local protocol and data-model copies used by fixed-range autofocus."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np

from stage.models import ZStage


@dataclass(frozen=True)
class ROI:
    """Rectangular region of interest in pixel coordinates (top-left origin)."""

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
class Frame:
    """A single captured image frame with timing metadata."""

    image: np.ndarray
    timestamp: float
    seq: int
    source_path: str | None = None


class FrameProvider(Protocol):
    """Interface for obtaining camera frames."""

    def get_latest(self) -> Frame:
        ...

    def wait_for_next(self, after_ts: float, timeout_ms: int) -> Frame:
        ...


@runtime_checkable
class FrameRetentionProvider(Protocol):
    """Optional interface for pruning raw frame artifacts after scoring."""

    def retain_only(self, frames: Sequence[Frame], keep_frame: Frame) -> None:
        ...


@runtime_checkable
class ContinuousFrameProvider(Protocol):
    """Optional interface for iterating camera frames during continuous motion."""

    def iter_frames(
        self,
        after_ts: float,
        timeout_ms: int,
        should_continue: Callable[[], bool],
    ) -> Iterator[Frame]:
        ...


class FocusStrategy(Protocol):
    """Interface for a sharpness metric used to score focus quality."""

    def score(self, image: np.ndarray, roi: ROI) -> float:
        ...

    @property
    def name(self) -> str:
        ...


__all__ = [
    "ContinuousFrameProvider",
    "Frame",
    "FrameProvider",
    "FrameRetentionProvider",
    "FocusStrategy",
    "ROI",
    "ZStage",
]
