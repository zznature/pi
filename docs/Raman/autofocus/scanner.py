"""Z-axis scanning routines: coarse scan, fine scan, parabolic peak fitting."""

import time
import statistics
from typing import Callable, Optional
import numpy as np
from autofocus.models import (
    ROI, Frame, FrameProvider, ZStage, FocusStrategy,
    AutofocusParams, FocusPoint, ScanCurve,
)
from autofocus.exceptions import OutOfRangeError
from autofocus.roi import saturation_ratio, crop, to_grayscale


def parabolic_peak(zs: list[float], scores: list[float]) -> Optional[float]:
    """Fit a parabola to three equally-spaced points and return the interpolated peak Z."""
    if len(zs) < 3 or len(scores) < 3:
        return None
    dz = zs[1] - zs[0]
    if abs((zs[2] - zs[1]) - dz) > 1e-6 * abs(dz):
        return None
    s_minus, s_zero, s_plus = scores[0], scores[1], scores[2]
    denom = s_minus - 2 * s_zero + s_plus
    if abs(denom) < 1e-9:
        return None
    delta = 0.5 * (s_minus - s_plus) / denom
    if abs(delta) > 1.0:
        return None
    return zs[1] + delta * dz


class ZScanner:
    """Drives Z-axis scans and computes per-Z sharpness scores."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: FocusStrategy,
        params: AutofocusParams,
    ):
        self.stage = stage
        self.frames = frames
        self.strategy = strategy
        self.params = params

    def sample_score(self, z_um: float, roi: ROI) -> FocusPoint:
        """Move to z_um, acquire frames_per_z frames, and return the median sharpness and saturation."""
        if not (self.params.z_min_um <= z_um <= self.params.z_max_um):
            raise OutOfRangeError(
                f"z={z_um} outside [{self.params.z_min_um}, {self.params.z_max_um}]"
            )
        self.stage.move_absolute_um(z_um)
        self.stage.wait_settled(self.params.stage_timeout_ms)
        if self.params.settle_ms > 0:
            time.sleep(self.params.settle_ms / 1000.0)
        t_after = time.monotonic()
        scores_list: list[float] = []
        sat_list: list[float] = []
        for _ in range(self.params.frames_per_z):
            frame = self.frames.wait_for_next(
                after_ts=t_after, timeout_ms=self.params.frame_timeout_ms
            )
            t_after = frame.timestamp
            scores_list.append(self.strategy.score(frame.image, roi))
            sat_patch = to_grayscale(crop(frame.image, roi))
            sat_list.append(saturation_ratio(sat_patch))
        return FocusPoint(
            z_um=z_um,
            score=statistics.median(scores_list),
            saturation_ratio=statistics.median(sat_list),
        )

    def _scan(
        self,
        center_um: float,
        roi: ROI,
        range_um: float,
        step_um: float,
        phase: str,
        on_progress: Optional[Callable[[FocusPoint], None]],
    ) -> ScanCurve:
        """Run a single scan phase over [center-range, center+range] at the given step size."""
        z_lo = max(center_um - range_um, self.params.z_min_um)
        z_hi = min(center_um + range_um, self.params.z_max_um)
        grid = [
            float(z)
            for z in np.arange(z_lo, z_hi + step_um * 0.5, step_um)
            if z <= z_hi
        ]
        # Approach z_lo from below so all measurements are made from the same direction.
        current = self.stage.get_position_um()
        if current > z_lo:
            pre_z = max(z_lo - self.params.backlash_um, self.params.z_min_um)
            self.stage.move_absolute_um(pre_z)
            self.stage.wait_settled(self.params.stage_timeout_ms)
        points: list[FocusPoint] = []
        for z in grid:
            point = self.sample_score(z, roi)
            points.append(point)
            if on_progress is not None:
                on_progress(point)
        return ScanCurve(phase=phase, points=points)

    def coarse_scan(
        self,
        center_um: float,
        roi: ROI,
        on_progress: Optional[Callable[[FocusPoint], None]] = None,
    ) -> ScanCurve:
        """Run the coarse scan centred at center_um and return the scored curve."""
        return self._scan(
            center_um, roi,
            self.params.coarse_range_um, self.params.coarse_step_um,
            "coarse", on_progress,
        )

    def fine_scan(
        self,
        center_um: float,
        roi: ROI,
        on_progress: Optional[Callable[[FocusPoint], None]] = None,
    ) -> ScanCurve:
        """Run the fine scan centred at center_um and return the scored curve."""
        return self._scan(
            center_um, roi,
            self.params.fine_range_um, self.params.fine_step_um,
            "fine", on_progress,
        )

    def estimate_peak(self, curve: ScanCurve) -> Optional[float]:
        """Return the sub-step peak Z via parabolic interpolation, or the raw argmax if fitting fails."""
        points = curve.points
        if not points:
            return None
        i = max(range(len(points)), key=lambda k: points[k].score)
        if i == 0 or i == len(points) - 1:
            return points[i].z_um
        three = [points[i - 1], points[i], points[i + 1]]
        z_peak = parabolic_peak(
            [p.z_um for p in three],
            [p.score for p in three],
        )
        if z_peak is None:
            return points[i].z_um
        return float(np.clip(z_peak, self.params.z_min_um, self.params.z_max_um))
