#!/usr/bin/env python3
"""Test fixture bridge with a deterministic memory-stage Z overshoot."""

from __future__ import annotations

import argparse
import queue
import sys
import threading
from pathlib import Path

EXTENSION_DIR = Path(__file__).resolve().parents[2]
if str(EXTENSION_DIR) not in sys.path:
    sys.path.insert(0, str(EXTENSION_DIR))

import hardware_bridge_v2 as bridge


class OffsetMemoryStage(bridge.MemoryStage):
    def move_absolute_um(
        self,
        *,
        x_um: float | None = None,
        y_um: float | None = None,
        z_um: float | None = None,
    ) -> None:
        super().move_absolute_um(x_um=x_um, y_um=y_um, z_um=z_um)
        if z_um is None:
            return
        self.position = bridge.StagePosition(self.position.x_um, self.position.y_um, float(z_um) + 0.75)
        self.history.append(self.position)


class OffsetRuntime(bridge.BridgeRuntime):
    def create_stage(self, payload: bridge.JsonObject) -> tuple[str, object]:
        adapter = str(payload.get("adapter", "memory"))
        if adapter != "memory":
            return super().create_stage(payload)
        initial = bridge.parse_payload(payload.get("initialPosition"))
        stage = OffsetMemoryStage(
            bridge.StagePosition(
                float(initial.get("xUm", 0.0)),
                float(initial.get("yUm", 0.0)),
                float(initial.get("zUm", 0.0)),
            )
        )
        stage.connect()
        return "memory", stage


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-root", type=Path, default=Path.cwd() / "docs" / "Raman")
    args = parser.parse_args()
    bridge.preload_algorithm_modules(args.stage_root)
    runtime = OffsetRuntime(args.stage_root)
    registry = bridge.ActionRegistry()
    bridge.register_default_actions(registry, runtime)
    commands: "queue.Queue[bridge.Command]" = queue.Queue()
    output_lock = threading.Lock()
    reader = threading.Thread(target=bridge.reader_loop, args=(registry, runtime, commands, output_lock), daemon=True)
    reader.start()
    bridge.debug("offset memory hardware_bridge_v2 ready")
    bridge.worker_loop(registry, runtime, commands, output_lock)
    runtime.close()
    bridge.debug("offset memory hardware_bridge_v2 stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
