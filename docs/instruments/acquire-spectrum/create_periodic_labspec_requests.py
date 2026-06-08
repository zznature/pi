r"""Create queued LabSpec spectrum requests at a fixed interval.

Run from the repository root:

    python raman\acquire-spectrum\create_periodic_labspec_requests.py

By default, this submits one default spectrum request immediately, then submits
another request every 10 minutes. Press Ctrl+C to stop it.
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
DEFAULT_INTERVAL_S = 600.0
DEFAULT_PREFIX = "spectrum"
DEFAULT_INTEGRATION_TIME_S = 360.0
DEFAULT_ACCUMULATIONS = 1
DEFAULT_FROM_NM = 0.0
DEFAULT_TO_NM = 0.0
DEFAULT_AUTO_SHOW = True
DEFAULT_SAVE_FORMAT = "txt"


def _timestamp_request_id(prefix: str) -> str:
    return f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-dir", type=Path, default=DEFAULT_BRIDGE_DIR)
    parser.add_argument("--interval-s", type=float, default=DEFAULT_INTERVAL_S)
    parser.add_argument("--count", type=int)
    parser.add_argument("--prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--laser-power-percent", help="Optional spectrum laser Filter setting, for example 10 or 10%%.")
    return parser.parse_args()


def _validate_args(args: argparse.Namespace) -> None:
    if args.interval_s <= 0:
        raise SystemExit("--interval-s must be > 0")
    if args.count is not None and args.count <= 0:
        raise SystemExit("--count must be > 0 when provided")
    if not args.prefix.strip():
        raise SystemExit("--prefix must not be empty")


def _submit_request(bridge_dir: Path, prefix: str, laser_power_percent: str | None) -> None:
    request_id = _timestamp_request_id(prefix)
    request = create_labspec_spectrum_request(
        bridge_dir=bridge_dir,
        request_id=request_id,
        integration_time_s=DEFAULT_INTEGRATION_TIME_S,
        accumulations=DEFAULT_ACCUMULATIONS,
        acq_from_nm=DEFAULT_FROM_NM,
        acq_to_nm=DEFAULT_TO_NM,
        auto_show=DEFAULT_AUTO_SHOW,
        save_format=DEFAULT_SAVE_FORMAT,
        laser_power_percent=laser_power_percent,
    )
    print(time.strftime("%Y-%m-%d %H:%M:%S"))
    print(f"request_id={request.request_id}")
    print(f"request_path={request.request_path}")
    print(f"save_path={request.save_path}")
    print(f"result_path={request.result_path}")
    print("", flush=True)


def main() -> int:
    args = _parse_args()
    _validate_args(args)

    sent_count = 0
    try:
        while args.count is None or sent_count < args.count:
            _submit_request(args.bridge_dir, args.prefix, args.laser_power_percent)
            sent_count += 1
            if args.count is not None and sent_count >= args.count:
                break
            time.sleep(args.interval_s)
    except KeyboardInterrupt:
        print("stopped by user", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
