"""AutofocusController — top-level orchestrator for single-point autofocus."""

import logging
import statistics
from typing import Callable, Optional
from autofocus.models import (
    ROI, FrameProvider, ZStage, FocusStrategy,
    AutofocusParams, FocusPoint, ScanCurve, FocusStatus, FocusResult,
)
from autofocus.exceptions import (
    OutOfRangeError, NoPeakError, LowConfidenceError,
    StageTimeoutError, FrameTimeoutError,
)
from autofocus.scanner import ZScanner
from autofocus.metrics import MetricStrategy
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
        log.warning("Autofocus aborted: %s — %s", status.value, message)
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
        """Run a full coarse→fine autofocus and return the outcome."""
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
                "Focus curve too flat — likely low texture; try a different ROI.",
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

        # 9. Backlash-compensated final move: overshoot then approach from below.
        pre_z = max(z_best - params.backlash_um, params.z_min_um)
        try:
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
            final_point = scanner.sample_score(z_best, roi)
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
                z_best_um=z_best,
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
            z_best_um=z_best,
            final_score=final_point.score,
            confidence=c,
            coarse=coarse,
            fine=fine,
            message=message,
        )
