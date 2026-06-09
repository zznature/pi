"""Fourier phase-correlation based image translation estimation."""

import numpy as np

from calibration.models import PixelShift, ROI, ShiftResult
from calibration.preprocessing import prepare_image


def estimate_translation(
    reference: np.ndarray,
    moving: np.ndarray,
    roi: ROI | None = None,
    *,
    upsample: bool = True,
    eps: float = 1e-12,
) -> ShiftResult:
    """
    Estimate moving-image translation relative to reference using phase correlation.

    The returned shift is the pixel displacement of moving relative to reference:
    positive dx means moving is shifted right; positive dy means moving is shifted down.
    """
    ref = prepare_image(reference, roi)
    mov = prepare_image(moving, roi)
    if ref.shape != mov.shape:
        raise ValueError(f"Image shapes must match after preprocessing: {ref.shape} vs {mov.shape}")

    cross_power = np.fft.fft2(mov) * np.conj(np.fft.fft2(ref))
    cross_power /= np.maximum(np.abs(cross_power), eps)
    corr = np.fft.ifft2(cross_power)
    corr_abs = np.abs(corr)

    peak_y, peak_x = np.unravel_index(np.argmax(corr_abs), corr_abs.shape)
    dy = _wrapped_peak_to_shift(peak_y, corr_abs.shape[0])
    dx = _wrapped_peak_to_shift(peak_x, corr_abs.shape[1])

    if upsample:
        sub_dx, sub_dy = _subpixel_peak_offset(corr_abs, peak_x, peak_y)
        dx += sub_dx
        dy += sub_dy

    peak_value = float(corr_abs[peak_y, peak_x])
    confidence = _peak_confidence(corr_abs, peak_x, peak_y)
    return ShiftResult(
        shift=PixelShift(dx=float(dx), dy=float(dy)),
        confidence=confidence,
        peak_value=peak_value,
        peak_position=(int(peak_x), int(peak_y)),
        roi=roi,
    )


def _wrapped_peak_to_shift(peak_index: int, size: int) -> float:
    """Convert FFT wrapped peak index to signed pixel shift."""
    if peak_index > size // 2:
        return float(peak_index - size)
    return float(peak_index)


def _subpixel_peak_offset(corr: np.ndarray, peak_x: int, peak_y: int) -> tuple[float, float]:
    """Estimate subpixel peak offset with independent 1D quadratic fits."""
    h, w = corr.shape
    x_offset = _quadratic_offset(
        corr[peak_y, (peak_x - 1) % w],
        corr[peak_y, peak_x],
        corr[peak_y, (peak_x + 1) % w],
    )
    y_offset = _quadratic_offset(
        corr[(peak_y - 1) % h, peak_x],
        corr[peak_y, peak_x],
        corr[(peak_y + 1) % h, peak_x],
    )
    return x_offset, y_offset


def _quadratic_offset(left: float, center: float, right: float) -> float:
    """Return vertex offset in [-1, 1] for three equally spaced samples."""
    denom = float(left - 2.0 * center + right)
    if abs(denom) < 1e-12:
        return 0.0
    offset = 0.5 * float(left - right) / denom
    return float(np.clip(offset, -1.0, 1.0))


def _peak_confidence(corr: np.ndarray, peak_x: int, peak_y: int) -> float:
    """Compute a simple peak-to-sidelobe confidence score in [0, 1]."""
    h, w = corr.shape
    mask = np.ones_like(corr, dtype=bool)
    y0, y1 = max(0, peak_y - 2), min(h, peak_y + 3)
    x0, x1 = max(0, peak_x - 2), min(w, peak_x + 3)
    mask[y0:y1, x0:x1] = False

    peak = float(corr[peak_y, peak_x])
    sidelobes = corr[mask]
    if sidelobes.size == 0:
        return 1.0

    background = float(np.mean(sidelobes))
    spread = float(np.std(sidelobes)) + 1e-12
    z_score = max(0.0, (peak - background) / spread)
    return float(z_score / (z_score + 10.0))
