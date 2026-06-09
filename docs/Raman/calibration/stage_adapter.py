"""Adapters that apply calibration results to XYZ stage interfaces."""

from calibration.models import ROI
from calibration.stage_transform import PixelStageTransform
from calibration.xy_corrector import estimate_xy_correction
from stage.models import StageShift, XYZStage


def estimate_and_apply_xy_correction(
    reference,
    current,
    transform: PixelStageTransform,
    stage: XYZStage,
    roi: ROI | None = None,
    *,
    min_confidence: float = 0.4,
    settle_timeout_ms: int = 3000,
) -> StageShift:
    """Estimate image-based XY correction, move the stage, and return the correction."""
    correction = estimate_xy_correction(
        reference,
        current,
        transform,
        roi=roi,
        min_confidence=min_confidence,
    )
    stage.move_relative_um(
        dx_um=correction.dx_um,
        dy_um=correction.dy_um,
        dz_um=0.0,
    )
    stage.wait_settled(settle_timeout_ms)
    return correction
