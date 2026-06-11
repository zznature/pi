"""Data models shared by LabSpec file-bridge mapping helpers."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class AcquisitionResult:
    """Result returned by a single Raman point acquisition."""

    ok: bool
    message: str = ""
    output_path: Path | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
