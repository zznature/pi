"""Submit one externally configured spectrum request to the LabSpec VBS worker."""

from __future__ import annotations

import argparse
import importlib.util
import sys
import types
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

mapping_pkg = types.ModuleType("mapping")
mapping_pkg.__path__ = [str(PROJECT_DIR / "mapping")]
sys.modules.setdefault("mapping", mapping_pkg)

stage_pkg = types.ModuleType("stage")
stage_pkg.__path__ = [str(PROJECT_DIR / "stage")]
stage_models = types.ModuleType("stage.models")


class StagePosition:
    def __init__(self, x_um: float, y_um: float, z_um: float):
        self.x_um = x_um
        self.y_um = y_um
        self.z_um = z_um


stage_models.StagePosition = StagePosition
sys.modules.setdefault("stage", stage_pkg)
sys.modules.setdefault("stage.models", stage_models)

models_spec = importlib.util.spec_from_file_location(
    "mapping.models",
    PROJECT_DIR / "mapping" / "models.py",
)
if models_spec is None or models_spec.loader is None:
    raise RuntimeError("Could not load mapping.models")
models_module = importlib.util.module_from_spec(models_spec)
sys.modules["mapping.models"] = models_module
models_spec.loader.exec_module(models_module)

labspec_spec = importlib.util.spec_from_file_location(
    "mapping.labspec",
    PROJECT_DIR / "mapping" / "labspec.py",
)
if labspec_spec is None or labspec_spec.loader is None:
    raise RuntimeError("Could not load mapping.labspec")
labspec_module = importlib.util.module_from_spec(labspec_spec)
sys.modules["mapping.labspec"] = labspec_module
labspec_spec.loader.exec_module(labspec_module)

AcquisitionResult = models_module.AcquisitionResult
LabSpecFileBridgeRamanAcquirer = labspec_module.LabSpecFileBridgeRamanAcquirer
LabSpecWorkerAcquisitionConfig = labspec_module.LabSpecWorkerAcquisitionConfig


DEFAULT_BRIDGE_DIR = Path(r"D:\RamanLab\SpecBridge")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-dir", type=Path, default=DEFAULT_BRIDGE_DIR)
    parser.add_argument("--integration-time", type=float, default=360.0)
    parser.add_argument("--accumulations", type=int, default=1)
    parser.add_argument("--from-nm", type=float, default=0.0)
    parser.add_argument("--to-nm", type=float, default=0.0)
    parser.add_argument("--no-auto-show", action="store_true")
    parser.add_argument("--save-path", type=Path)
    parser.add_argument("--save-format", default="txt")
    parser.add_argument("--no-plot", action="store_true")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--poll", type=float, default=0.2)
    args = parser.parse_args()

    if args.integration_time <= 0:
        raise SystemExit("--integration-time must be > 0")
    if args.accumulations <= 0:
        raise SystemExit("--accumulations must be > 0")

    config = LabSpecWorkerAcquisitionConfig(
        bridge_dir=args.bridge_dir,
        integration_time_s=args.integration_time,
        accumulations=args.accumulations,
        acq_from_nm=args.from_nm,
        acq_to_nm=args.to_nm,
        auto_show=not args.no_auto_show,
        save_path=args.save_path,
        save_format=args.save_format,
        plot_spectrum=not args.no_plot,
        poll_interval_s=args.poll,
        timeout_s=args.timeout,
    )
    acquirer = LabSpecFileBridgeRamanAcquirer(config)
    result: AcquisitionResult = acquirer.acquire_point("CLI", {})
    if result.ok:
        for key in sorted(result.metadata):
            print(f"{key}={result.metadata[key]}")
        if result.output_path:
            print(f"output_path={result.output_path}")
        return 0

    print(f"ERROR: {result.message}", file=sys.stderr)
    return 2 if "timed out" in result.message.lower() else 1


if __name__ == "__main__":
    raise SystemExit(main())
