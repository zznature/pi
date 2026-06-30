# Experiment Research Extension

This directory is the canonical path for the LabAgents MVP rebuild.

Current status:

- Phase 10 bounded Raman parameter search and bounded Raman mapping execution are implemented on top of the planner proposal flow, explicit evaluation rules, simulation runtime, registered live runtime contract, and approval gate
- planner-facing tools:
  - `get_lab_capabilities`
  - `get_lab_state`
  - `validate_procedure_spec`
  - `run_preflight`
- core schema modules available under `schemas/`:
  - `experiment-intent.ts`
  - `procedure-spec.ts`
  - `execution-unit.ts`
  - `run-state.ts`
  - `tool-result.ts`
- persistence store modules available under `store/`:
  - `intent-store.ts`
  - `procedure-spec-store.ts`
  - `run-store.ts`
  - `event-store.ts`
  - `artifact-store.ts`
- kernel compile module available under `kernel/`:
  - `compile-units.ts`
- simulation runtime modules available under `kernel/` and `runtime/`:
  - `run-controller.ts`
  - `simulation-runtime.ts`
- proposal + simulation tools available:
  - `propose_run`
  - `approve_and_start_run`
  - `run_procedure`
  - `poll_run`
  - `pause_run`
  - `abort_run`
- `approve_and_start_run` can now execute:
  - simulation bounded runs
  - live-supervised Raman single-point bounded runs when a live runtime is registered
  - live-supervised Raman parameter-search bounded runs when a live runtime is registered
  - live-supervised Raman grid-mapping bounded runs when a live runtime is registered
- bounded parameter search now enforces:
  - approved search envelope only
  - max attempts
  - explicit rule-based early stop vs operator-decision pause
- bounded mapping now supports:
  - compiled `grid_scan` point execution
  - progress with completed and failed point counts
  - configurable consecutive-failure stop without auto-expanding the grid or auto-changing parameters
- `run_procedure` remains registered as a deprecated blocked entrypoint that returns `approval_required`
- planner builders available under `planner/`:
  - `intent-builder.ts`
  - `procedure-spec-builder.ts`
  - `evaluate-good-enough.ts`
- Raman runtime contract modules available under `runtime/raman/`:
  - `resources.ts`
  - `actions.ts`
  - `live-runtime.ts`
  - `python-runtime.ts`
  - `index.ts`

## Live Raman Runtime Configuration

The rebuild does not assume real hardware is always available. Live-supervised
execution is enabled per workspace by creating:

```text
.pi/experiment-research/raman-runtime.json
```

Minimal shape:

```json
{
  "enabled": true,
  "pythonExecutable": "python",
  "pythonRoot": "docs/Raman",
  "stage": {
    "resourceId": "stage-main",
    "kind": "stage",
    "runtime": "raman_python",
    "driver": "mc_newton_xyz",
    "config": {
      "port": "COM5",
      "xChannel": 1,
      "yChannel": 2,
      "zChannel": 3,
      "baudrate": 115200
    },
    "leasePolicy": "exclusive",
    "simulationAvailable": true,
    "limits": {
      "xRangeUm": [0, 50000],
      "yRangeUm": [0, 50000],
      "zRangeUm": [0, 5000]
    }
  },
  "frameProvider": {
    "resourceId": "frame-main",
    "kind": "frame_provider",
    "runtime": "raman_python",
    "driver": "labspec_file_bridge_frame",
    "config": {
      "bridgeDir": "D:\\RamanLab\\SpecBridge",
      "imageFormat": "tif",
      "minCaptureIntervalMs": 400
    },
    "leasePolicy": "shared-read",
    "simulationAvailable": false
  },
  "spectrometer": {
    "resourceId": "spectrometer-main",
    "kind": "spectrometer",
    "runtime": "raman_python",
    "driver": "labspec_file_bridge_spectrum",
    "config": {
      "bridgeDir": "D:\\RamanLab\\SpecBridge",
      "requestFilename": "spectrum_request.ini",
      "resultFilename": "spectrum_result.ini"
    },
    "leasePolicy": "exclusive",
    "simulationAvailable": false
  }
}
```

Set `"enabled": false` to keep hardware disabled explicitly. Without an enabled
registered runtime, live-supervised `approve_and_start_run` returns
`live_runtime_unavailable`; simulation remains available.

## Tests

Rebuild-specific tests live in:

```text
.pi/extensions/experiment-research/test/
```

Run them with:

```bash
npm --prefix .pi/extensions/experiment-research test
```

The previous implementation has been moved to:

- `.pi/extensions/experiment-research-legacy`

That legacy directory remains available as a reference-only implementation during the rebuild.
