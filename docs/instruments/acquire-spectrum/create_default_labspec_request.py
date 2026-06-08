r"""Create one default queued LabSpec spectrum request.

Run from the repository root:

    python raman\acquire-spectrum\create_default_labspec_request.py

The LabSpec worker must be running inside LabSpec and watching:

    raman\runtime\labspec_bridge
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from mapping import create_labspec_spectrum_request

DEFAULT_BRIDGE_DIR = PROJECT_DIR / "runtime" / "labspec_bridge"
DEFAULT_INTEGRATION_TIME_S = 360.0
DEFAULT_ACCUMULATIONS = 1
DEFAULT_FROM_NM = 0.0
DEFAULT_TO_NM = 0.0
DEFAULT_AUTO_SHOW = True
DEFAULT_SAVE_FORMAT = "txt"


def _default_request_id() -> str:
    return time.strftime("manual_spectrum_%Y%m%d_%H%M%S")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request-id", default=_default_request_id())
    parser.add_argument("--bridge-dir", type=Path, default=DEFAULT_BRIDGE_DIR)
    parser.add_argument("--integration-time-s", type=float, default=DEFAULT_INTEGRATION_TIME_S)
    parser.add_argument("--laser-power-percent", help="Optional spectrum laser Filter setting, for example 10 or 10%%.")
    args = parser.parse_args()

    request = create_labspec_spectrum_request(
        bridge_dir=args.bridge_dir,
        request_id=args.request_id,
        integration_time_s=args.integration_time_s,
        accumulations=DEFAULT_ACCUMULATIONS,
        acq_from_nm=DEFAULT_FROM_NM,
        acq_to_nm=DEFAULT_TO_NM,
        auto_show=DEFAULT_AUTO_SHOW,
        save_format=DEFAULT_SAVE_FORMAT,
        laser_power_percent=args.laser_power_percent,
    )

    print(f"request_id={request.request_id}")
    print(f"request_path={request.request_path}")
    print(f"save_path={request.save_path}")
    print(f"result_path={request.result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
