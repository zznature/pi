"""Preprocessing helpers for Fourier-based image registration."""

import numpy as np

from calibration.models import ROI


def crop(image: np.ndarray, roi: ROI | None = None) -> np.ndarray:
    """Return image cropped to roi, or the original image if roi is None."""
    if roi is None:
        return image
    if not roi.is_valid(image.shape[:2]):
        raise ValueError(f"ROI {roi} is invalid for image shape {image.shape[:2]}")
    return image[roi.slice()]


def to_grayscale(image: np.ndarray) -> np.ndarray:
    """Convert image to grayscale float32."""
    if image.ndim == 2:
        return image.astype(np.float32)
    if image.ndim == 3 and image.shape[2] in (3, 4):
        r, g, b = image[:, :, 0], image[:, :, 1], image[:, :, 2]
        return (0.299 * r + 0.587 * g + 0.114 * b).astype(np.float32)
    raise ValueError(
        f"Unsupported image shape {image.shape}; expected 2D or RGB/RGBA image"
    )


def normalize(image: np.ndarray, eps: float = 1e-6) -> np.ndarray:
    """Subtract mean and divide by standard deviation."""
    img = image.astype(np.float32)
    return (img - float(np.mean(img))) / (float(np.std(img)) + eps)


def apply_hann_window(image: np.ndarray) -> np.ndarray:
    """Apply a 2D Hann window to reduce FFT edge artifacts."""
    h, w = image.shape
    window_y = np.hanning(h).astype(np.float32)
    window_x = np.hanning(w).astype(np.float32)
    return image.astype(np.float32) * np.outer(window_y, window_x)


def prepare_image(image: np.ndarray, roi: ROI | None = None, window: bool = True) -> np.ndarray:
    """Crop, convert to grayscale, normalize, and optionally apply a Hann window."""
    prepared = normalize(to_grayscale(crop(image, roi)))
    if window:
        prepared = apply_hann_window(prepared)
    return prepared.astype(np.float32)
