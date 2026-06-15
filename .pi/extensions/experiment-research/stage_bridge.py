"""Bridge used by gated stage hardware execution to call the stage driver.

The TypeScript extension never imports Python modules directly. This script is
only used when the operator explicitly selects the mc_newton_xyz adapter.

Each invocation runs exactly one action and exits. The `visit` action is
atomic: a single process connects, reads the start position, moves the stage,
waits for it to settle, reads the final position, and disconnects. Keeping the
whole point inside one process is required because the MC.Newton controller
state (the last commanded target used by wait_settled, the enabled serial
channel) does not survive across processes.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage-root", required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--action", required=True)
    parser.add_argument("--payload", default="{}")
    return parser.parse_args()


def _position_dict(position) -> dict[str, float]:
    return {"xUm": position.x_um, "yUm": position.y_um, "zUm": position.z_um}


def main() -> int:
    args = parse_args()
    stage_root = Path(args.stage_root).resolve()
    sys.path.insert(0, str(stage_root))

    from stage.mc_newton_xyz_stage import MCNewtonXYZStageController

    payload = json.loads(args.payload)

    # The MC.Newton controller needs more than the driver's 5 ms default before
    # [check:pos?] returns a value (the Z axis returns nothing at 5 ms). Use a
    # 100 ms command wait so every position query gets one clean response and no
    # reply carries over into the next read.
    with MCNewtonXYZStageController(args.port, default_cmd_wait_ms=100.0, exclusive_channel=False) as stage:
        stage.apply_fast_move_profile()
        if args.action == "position":
            print(json.dumps(_position_dict(stage.get_position_um())))
            return 0

        if args.action == "visit":
            before = stage.get_position_um()
            move_kwargs: dict[str, float] = {"x_um": payload.get("xUm"), "y_um": payload.get("yUm")}
            z_um = payload.get("zUm")
            if z_um is not None:
                move_kwargs["z_um"] = z_um
            stage.move_absolute_um(**move_kwargs)
            stage.wait_settled(int(payload["settleTimeoutMs"]))
            after = stage.get_position_um()
            print(json.dumps({"before": _position_dict(before), "after": _position_dict(after)}))
            return 0

        if args.action == "stop":
            stage.stop()
            print(json.dumps({"ok": True}))
            return 0

    print(f"Unsupported action: {args.action}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
