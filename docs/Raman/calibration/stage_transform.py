"""Pixel-to-stage coordinate transforms for XY calibration."""

import numpy as np

from calibration.exceptions import SingularTransformError
from calibration.models import PixelShift
from stage.models import StageShift


class PixelStageTransform:
    """
    Convert between image pixel shifts and stage shifts.

    Matrix convention:
        [dx_px, dy_px]^T = pixel_per_um @ [dx_um, dy_um]^T
    """

    def __init__(self, pixel_per_um: np.ndarray):
        matrix = np.asarray(pixel_per_um, dtype=np.float64)
        if matrix.shape != (2, 2):
            raise ValueError(f"pixel_per_um must be 2x2, got {matrix.shape}")
        try:
            inverse = np.linalg.inv(matrix)
        except np.linalg.LinAlgError as exc:
            raise SingularTransformError("pixel_per_um matrix is singular") from exc
        self._pixel_per_um = matrix
        self._um_per_pixel = inverse

    @property
    def pixel_per_um(self) -> np.ndarray:
        return self._pixel_per_um.copy()

    @property
    def um_per_pixel(self) -> np.ndarray:
        return self._um_per_pixel.copy()

    def stage_to_pixel(self, shift: StageShift) -> PixelShift:
        dx, dy = self._pixel_per_um @ np.array([shift.dx_um, shift.dy_um])
        return PixelShift(dx=float(dx), dy=float(dy))

    def pixel_to_stage(self, shift: PixelShift) -> StageShift:
        dx_um, dy_um = self._um_per_pixel @ np.array([shift.dx, shift.dy])
        return StageShift(dx_um=float(dx_um), dy_um=float(dy_um))
