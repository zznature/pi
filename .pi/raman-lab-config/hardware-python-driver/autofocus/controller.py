"""AutofocusController - top-level orchestrator for single-point autofocus."""

import logging
import statistics
from typing import Callable, Optional
from autofocus.models import (
    ROI, FrameProvider, ZStage, FocusStrategy,
    AutofocusParams, FixedRangeAutofocusParams, FixedRangeAutofocusResult,
    FocusPoint, ScanCurve, FocusStatus, FocusResult, ScoredZPoint,
)
from autofocus.exceptions import (
    OutOfRangeError, StageTimeoutError, FrameTimeoutError,
)
from autofocus.scanner import ZScanner
from autofocus.metrics import MetricStrategy
from autofocus.peak_locator import PeakLocator
from autofocus.range_scanner import FixedRangeScanner
from stage.exceptions import StageError

log = logging.getLogger(__name__)


class AutofocusController:
    """High-level autofocus orchestrator: validates inputs, runs scans, applies confidence checks."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: Optional[FocusStrategy] = None,
    ):
        self.stage = stage
        self.frames = frames
        self._strategy = strategy

    def _result_error(
        self,
        status: FocusStatus,
        message: str,
        coarse: Optional[ScanCurve] = None,
        fine: Optional[ScanCurve] = None,
    ) -> FocusResult:
        """Build and log a failed FocusResult."""
        log.warning("Autofocus aborted: %s - %s", status.value, message)
        return FocusResult(
            status=status, z_best_um=None, final_score=None,
            confidence=0.0, coarse=coarse, fine=fine, message=message,
        )

    def run_single(
        self,
        roi: ROI,
        params: AutofocusParams,
        on_progress: Optional[Callable[[FocusPoint], None]] = None,
    ) -> FocusResult:
        """Run a full coarse->fine autofocus and return the outcome."""
        # 1. Resolve strategy and build scanner.
        strategy = self._strategy or MetricStrategy(params.metric_name)
        scanner = ZScanner(self.stage, self.frames, strategy, params)

        # 2. Read starting position; check overall reachability.
        try:
            z0 = self.stage.get_position_um()
        except (StageTimeoutError, StageError) as e:
            return self._result_error(FocusStatus.STAGE_ERROR, f"Cannot read Z position: {e}")
        if (z0 + params.coarse_range_um < params.z_min_um
                or z0 - params.coarse_range_um > params.z_max_um):
            return self._result_error(
                FocusStatus.OUT_OF_RANGE,
                f"Coarse range around z0={z0} does not overlap [{params.z_min_um}, {params.z_max_um}]",
            )

        # 3. Coarse scan.
        try:
            coarse = scanner.coarse_scan(z0, roi, on_progress=on_progress)
        except FrameTimeoutError as e:
            return self._result_error(FocusStatus.FRAME_ERROR, f"Coarse scan: {e}")
        except (StageTimeoutError, StageError) as e:
            return self._result_error(FocusStatus.STAGE_ERROR, f"Coarse scan: {e}")
        except OutOfRangeError as e:
            return self._result_error(FocusStatus.OUT_OF_RANGE, f"Coarse scan: {e}")

        # 4. Validate coarse curve.
        if len(coarse.points) < 3:
            return self._result_error(
                FocusStatus.NO_PEAK,
                "Too few coarse scan points to find a peak; widen z_min/z_max or check stage limits.",
                coarse=coarse,
            )
        coarse_scores = [p.score for p in coarse.points]
        argmax_index = max(range(len(coarse.points)), key=lambda k: coarse_scores[k])
        if argmax_index == 0 or argmax_index == len(coarse.points) - 1:
            return self._result_error(
                FocusStatus.NO_PEAK,
                "Peak likely outside coarse range, consider widening coarse_range_um.",
                coarse=coarse,
            )
        median_score = statistics.median(coarse_scores)
        prominence = (coarse_scores[argmax_index] - median_score) / (median_score + 1e-9)
        if prominence < params.coarse_min_prominence:
            return self._result_error(
                FocusStatus.NO_PEAK,
                "Focus curve too flat - likely low texture; try a different ROI.",
                coarse=coarse,
            )
        top3 = sorted(coarse.points, key=lambda p: p.score, reverse=True)[:3]
        low_confidence_saturation = any(
            p.saturation_ratio > params.max_saturation_ratio for p in top3
        )

        # 5. Re-centre fine scan on the raw argmax, not the parabolic estimate.
        zc = coarse.best().z_um

        # 6. Fine scan.
        try:
            fine = scanner.fine_scan(zc, roi, on_progress=on_progress)
        except FrameTimeoutError as e:
            status = FocusStatus.FRAME_ERROR
            return self._result_error(status, f"Fine scan: {e}", coarse=coarse)
        except (StageTimeoutError, StageError) as e:
            return self._result_error(FocusStatus.STAGE_ERROR, f"Fine scan: {e}", coarse=coarse)
        except OutOfRangeError as e:
            return self._result_error(FocusStatus.OUT_OF_RANGE, f"Fine scan: {e}", coarse=coarse)

        # 7. Validate fine curve the same way.
        if len(fine.points) < 3:
            return self._result_error(
                FocusStatus.NO_PEAK,
                "Too few fine scan points to find a peak.",
                coarse=coarse, fine=fine,
            )
        fine_scores = [p.score for p in fine.points]
        fine_argmax = max(range(len(fine.points)), key=lambda k: fine_scores[k])
        if fine_argmax == 0 or fine_argmax == len(fine.points) - 1:
            return self._result_error(
                FocusStatus.NO_PEAK,
                "Peak at edge of fine scan range; coarse peak may have been a shoulder.",
                coarse=coarse, fine=fine,
            )

        # 8. Sub-step peak estimate.
        z_best = scanner.estimate_peak(fine)
        if z_best is None:
            z_best = fine.best().z_um

        # 9. Final positioning: approach the best Z from above, then move down to target.
        pre_z = min(z_best + params.backlash_um, params.z_max_um)
        scanner._set_stage_tolerance(params.final_stage_tolerance_um)
        try:
            if pre_z > z_best:
                self.stage.move_absolute_um(pre_z)
                self.stage.wait_settled(params.stage_timeout_ms)
            self.stage.move_absolute_um(z_best)
            self.stage.wait_settled(params.stage_timeout_ms)
        except (StageTimeoutError, StageError) as e:
            return self._result_error(
                FocusStatus.STAGE_ERROR, f"Final move: {e}", coarse=coarse, fine=fine
            )

        # 10. Final verification sample.
        try:
            final_point = scanner.score_current_position(roi)
        except FrameTimeoutError as e:
            return self._result_error(
                FocusStatus.FRAME_ERROR, f"Final verification: {e}", coarse=coarse, fine=fine
            )
        except (StageTimeoutError, StageError) as e:
            return self._result_error(
                FocusStatus.STAGE_ERROR, f"Final verification: {e}", coarse=coarse, fine=fine
            )

        fine_best_score = fine.best().score
        if final_point.score < 0.7 * fine_best_score:
            return FocusResult(
                status=FocusStatus.LOW_CONFIDENCE,
                z_best_um=final_point.z_um,
                final_score=final_point.score,
                confidence=0.0,
                coarse=coarse, fine=fine,
                message=(
                    f"Final score {final_point.score:.4f} regressed below 70% of "
                    f"fine-scan best {fine_best_score:.4f}"
                ),
            )

        # 11. Compute confidence in [0, 1].
        c = 1.0
        if low_confidence_saturation:
            c *= 0.5
        c *= min(1.0, prominence)
        c = max(0.0, min(1.0, c))
        if c < params.min_confidence:
            status = FocusStatus.LOW_CONFIDENCE
            message = f"Confidence {c:.2f} below threshold {params.min_confidence:.2f}"
        else:
            status = FocusStatus.OK
            message = ""

        # 12. Return result.
        return FocusResult(
            status=status,
            z_best_um=final_point.z_um,
            final_score=final_point.score,
            confidence=c,
            coarse=coarse,
            fine=fine,
            message=message,
        )

    def run_fixed_range(
        self,
        roi: ROI,
        params: FixedRangeAutofocusParams,
        on_progress: Optional[Callable[[ScoredZPoint], None]] = None,
    ) -> FocusResult:
        """Run the lab-optimized fixed-range autofocus and adapt it to FocusResult."""
        controller = FixedRangeAutofocusController(self.stage, self.frames, self._strategy)
        try:
            result = controller.run(roi, params, on_progress=on_progress)
        except FrameTimeoutError as e:
            return self._result_error(FocusStatus.FRAME_ERROR, f"Fixed-range scan: {e}")
        except (StageTimeoutError, StageError) as e:
            return self._result_error(FocusStatus.STAGE_ERROR, f"Fixed-range scan: {e}")
        except Exception as e:
            return self._result_error(FocusStatus.NO_PEAK, f"Fixed-range scan: {e}")

        confidence = self._fixed_range_confidence(result)
        status = FocusStatus.OK if confidence >= 0.2 else FocusStatus.LOW_CONFIDENCE
        message = "" if status == FocusStatus.OK else f"Fixed-range confidence {confidence:.2f} below threshold 0.20"
        curve = ScanCurve(
            phase="coarse",
            points=[
                FocusPoint(z_um=point.actual_z_um, score=point.score, saturation_ratio=0.0)
                for point in result.points
            ],
        )
        return FocusResult(
            status=status,
            z_best_um=result.final_z_um,
            final_score=result.final_verification.score,
            confidence=confidence,
            coarse=curve,
            fine=None,
            message=message,
        )

    @staticmethod
    def _fixed_range_confidence(result: FixedRangeAutofocusResult) -> float:
        scores = [point.score for point in result.points]
        if len(scores) < 3:
            return 0.0
        median_score = statistics.median(scores)
        prominence = (result.best.score - median_score) / (median_score + 1e-9)
        verification_ratio = result.final_verification.score / (result.best.score + 1e-9)
        return max(0.0, min(1.0, prominence, verification_ratio))


class FixedRangeAutofocusController:
    """Scan a known Z range, estimate the focus peak, then move to it."""

    def __init__(
        self,
        stage: ZStage,
        frames: FrameProvider,
        strategy: Optional[FocusStrategy] = None,
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
        on_progress: Optional[Callable[[ScoredZPoint], None]] = None,
    ) -> FixedRangeAutofocusResult:
        scanner = FixedRangeScanner(self.stage, self.frames, self.strategy, params)
        points = scanner.scan(roi, on_progress=on_progress)
        if not points:
            raise RuntimeError("fixed-range autofocus produced no scan points.")
        peak = self.peak_locator.locate(points, interpolate=params.interpolate_peak)
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
            points=points,
        )
