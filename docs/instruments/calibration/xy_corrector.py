"""High-level XY correction calculation from reference/current images."""

import numpy as np

from calibration.exceptions import LowConfidenceError
from calibration.models import ROI
from calibration.phase_correlation import estimate_translation
from calibration.stage_transform import PixelStageTransform
from stage.models import StageShift


def estimate_xy_correction(
    reference: np.ndarray,
    current: np.ndarray,
    transform: PixelStageTransform,
    roi: ROI | None = None,
    *,
    min_confidence: float = 0.4,
) -> StageShift:
    """
    Estimate the stage correction needed to align current image to reference.

    If current is shifted by +dx pixels relative to reference, the correction is
    the opposite stage movement that cancels that image shift.
    """
    result = estimate_translation(reference, current, roi)
    if result.confidence < min_confidence:
        raise LowConfidenceError(
            f"Registration confidence {result.confidence:.3f} below threshold {min_confidence:.3f}"
        )
    measured_stage_shift = transform.pixel_to_stage(result.shift)
    return StageShift(
        dx_um=-measured_stage_shift.dx_um,
        dy_um=-measured_stage_shift.dy_um,
        dz_um=0.0,
    )
