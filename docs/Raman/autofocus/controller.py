"""Controller for fixed-range autofocus."""

from __future__ import annotations

from collections.abc import Callable

from autofocus_function.metrics import MetricStrategy
from autofocus_function.models import FixedRangeAutofocusParams, FixedRangeAutofocusResult, ScoredZPoint
from autofocus_function.peak_locator import PeakLocator
from autofocus_function.protocols import FrameProvider, FocusStrategy, ROI, ZStage
from autofocus_function.range_scanner import FixedRangeScanner


class FixedRangeAutofocusController:
    """Scan a known Z range, estimate the focus peak, then move to it."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: FocusStrategy | None = None,
        metric_name: str = "labspec_spot_compactness",
    ) -> None:
        self.stage = stage
        self.frames = frames
        self.strategy = strategy or MetricStrategy(metric_name)
        self.peak_locator = PeakLocator()

    def run(
        self,
        roi: ROI,
        params: FixedRangeAutofocusParams,
        on_progress: Callable[[ScoredZPoint], None] | None = None,
    ) -> FixedRangeAutofocusResult:
        scanner = FixedRangeScanner(self.stage, self.frames, self.strategy, params)
        points = scanner.scan(roi, on_progress=on_progress)
        if not points:
            raise RuntimeError("fixed-range autofocus produced no scan points.")
        peak = self.peak_locator.locate(points, interpolate=params.interpolate_peak)
        verification_points: list[ScoredZPoint] | None = None
        final_z_um = scanner.move_to_z(peak.z_um)
        final_verification = scanner.sample(
            peak.z_um,
            roi,
            frames_per_z=params.final_verification_frames_per_z,
            tolerance_um=params.final_tolerance_um,
        )
        return FixedRangeAutofocusResult(
            best=peak.sampled_best,
            peak=peak,
            final_z_um=final_z_um,
            final_verification=final_verification,
            final_error_um=float(final_z_um - peak.z_um),
            verification_points=verification_points,
            points=points,
        )
