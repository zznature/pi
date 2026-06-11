"""Exceptions raised by the calibration module."""


class CalibrationError(Exception):
    """Base class for calibration errors."""


class LowConfidenceError(CalibrationError):
    """Raised when image registration confidence is too low."""


class SingularTransformError(CalibrationError):
    """Raised when the pixel-stage transform is not invertible."""
