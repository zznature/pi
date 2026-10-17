<!-- Generated: 2026-06-25 | Files scanned: 67 | Token estimate: ~980 -->

# Experiment Research Extension Codemap

Scope: `.pi/extensions/experiment-research`, a project-local pi extension for bounded experiment loops and Raman hardware MVP work.

```text
pi extension
  index.ts
    registers planner/operator/Raman tools, injects prompt, blocks low-level hardware tools
    subscribes to async Raman terminal events and emits follow-up messages
      |
      v
  tools/*.ts             thin ToolDefinition wrappers and active-tool surface
      |
      v
  dispatch.ts            schema validation, policy/preflight, hardware gate, routing
      |
      +--> simulation: run-store.ts -> kernel/sim.ts -> records.ts
      +--> async sim:  run-store.ts -> kernel/run.ts (start/advance/poll)
      +--> hw pilot:   records.ts gate -> kernel/hw/stage.ts + kernel/hw/pilot.ts
      +--> Raman v1:   kernel/raman/run.ts -> kernel/raman/bridge.ts -> raman_bridge.py
      +--> Raman v2:   kernel/raman/run.ts -> kernel/hw/bridge-v2.ts -> hardware_bridge_v2.py
      +--> analysis:   run-store.ts -> analysis.ts -> planning.ts
```

## Entry Points

- `.pi/extensions/experiment-research/index.ts`
  - default export `experimentResearchExtension(pi: ExtensionAPI)`
  - planner-active tools: `get_lab_capabilities`, `get_lab_state`, `get_experiment_state`, `hardware_bridge_v2_read`, `validate_experiment_spec`, `run_preflight`, `run_experiment`, `start_run`, `advance_run`, `analyze_run`, `plan_next_experiment`, `raman_active_probe`
  - operator-only tools: `pause_run`, `abort_run`, `poll_run`, `request_operator`, `record_hardware_coordinate_audit`, Raman calibration/validation tools
  - guards planner from direct low-level tools: `move_relative`, `move_z`, `snap_image`, `serial_send`, `set_laser_power`
- `.pi/extensions/experiment-research/package.json`
  - `npm --prefix .pi/extensions/experiment-research test`
  - focused phase and regression tests under `test/*.test.ts`

## Core Contracts

- `schemas.ts`
  - `ExperimentSpec`: bounded `simulation | dry_run | hardware` spec with resources, limits, spatial plan, optional `domain.raman` and `domain.thermal`
  - `HardwareExecutionParams`: stage adapter, watchdog thresholds, operator approval, optional Raman v1/v2 backend config, coordinate audit, validation id
  - Raman contract includes explicit `operationIntent`, autofocus, XY correction, acquisition, thermal wait, laser safety confirmation
  - tool params cover planner lifecycle, operator intents, coordinate audits, Raman calibration, active probe, validation, and bridge-v2 read calls
- `spec-utils.ts`: expands grid/points, derives dry-run partners, classifies Raman operation intent and validation coverage.
- `results.ts`: standard success/error `ToolResult`s.

## Safety And Gating

- `policy.ts`
  - validates mode/tool compatibility, active-run exclusion, instrument availability, unit count, point limits
  - constrains non-Raman hardware to MC.Newton explicit points with z limits
  - constrains Raman hardware to stage, LabSpec workspace, camera/acquirer/thermal resources as required by intent
- `preflight.ts`
  - estimates runtime, probes dry-run live state, resolves XY calibration artifacts
  - dry-run reports explicitly list writes that will not execute
- `records.ts`
  - writes preflight reports, run records, approvals, summaries, artifact indexes, resume snapshots
  - `validateHardwareGate` checks Raman collision ceiling and laser ceiling against approved hardware params
- `kernel/hw/coord-audit.ts`
  - records operator-reviewed absolute coordinate plans; readiness matches subject+plan hash.
- `watchdog.ts`
  - converts operator intents, heartbeat, error counts, quality/artifact/budget guards into pause/abort/request decisions.

## Persistence

Source of truth is disk under `.pi/experiment-runs`.

```text
.pi/experiment-runs/
  command-index.json
  approvals.jsonl
  preflights/<reportId>/{preflight.json,capabilities.snapshot.json}
  experiments/<experimentId>/{experiment.json,lineage.jsonl,decisions.jsonl}
  runs/<runId>/
    run.json spec.json capabilities.snapshot.json events.jsonl intents.jsonl
    summary.json analysis.json resume.snapshot.json artifacts.json approvals.jsonl leases.jsonl
    artifacts/{spectra,frames,labspec}/...
  lab/calibrations/<calibrationId>.json
  lab/coordinate-audits/<coordinateAuditId>.json
  lab/validations/<validationId>.json
```

- `run-store.ts`: run reservation, idempotent command index, active-run conflict detection, spec hashing, leases, lineage/decision reads/writes.
- `compaction.ts`: compact session summaries from recent experiment records; disk remains authoritative.

## Execution Kernels

- `kernel/sim.ts`: deterministic point simulation and summary.
- `kernel/run.ts`: interruptible simulation lifecycle with `startRun`, `advanceRun`, `pollRun`; honors intents at unit boundaries.
- `kernel/hw/stage.ts` + `stage_bridge.py`: memory or one-shot MC.Newton XYZ stage adapter.
- `kernel/hw/pilot.ts`: synchronous non-Raman hardware pilot over `StageAdapter`.
- `kernel/hw/bridge-v2.ts` + `hardware_bridge_v2.py`: JSON-lines bridge with advertised action contracts, side-effect levels, progress events, and request errors.
- `kernel/raman/run.ts`: async Raman hardware run launcher.
  - v1 path uses `RamanBridgeClient` and `raman_bridge.py`
  - v2 path uses `HardwareBridgeV2Client` and `executeRamanV2RunUnit`
  - writes bridge events/stderr, LabSpec archives, spectra/frames, resume snapshots, terminal summaries
  - terminal listener notifies `index.ts` so completed/paused/failed hardware runs trigger follow-up turns
- `kernel/raman/v2-orchestrator.ts`: per-point v2 workflow: move, autofocus, XY correction, thermal wait, acquisition, artifacts, microstep snapshots.
- `kernel/raman/v2-resume.ts`: microstep snapshot builder and hardware reconcile checks for stage position, pending acquisition, and artifacts.

## Raman Maintenance

- `kernel/raman/probe.ts`: operator-approved active frame/spectrum smoke records.
- `kernel/raman/calibration.ts`: record, fit, or auto-fit XY calibration artifacts.
- `kernel/raman/validation.ts`: evidence-chain validation for production-ready Raman hardware records; checks dry-run preflight, active probe, minimum run, artifacts, hashes, coverage.
- `tools/raman.ts`
  - calibration: `raman_record_xy_calibration`, `raman_fit_xy_calibration`, `raman_auto_xy_calibration`
  - validation: `raman_prepare_hardware_validation_payload`, `raman_record_hardware_validation`, `raman_check_hardware_validation`, `raman_prepare_validation_spec_pair`
- `raman_bridge.py`: v1 low-level Raman protocol.
- `hardware_bridge_v2.py`: v2 action-contract hardware protocol for stage, camera, focus metric, drift correction, spectrometer, thermal.
- `labspec-bridge.ts`: default Windows LabSpec bridge directory.

## Analysis And Planning

- `analysis.ts`: derives deterministic quality metrics, Raman SNR/saturation/focus/XY metadata, anomalies, stopping-rule judgments, and replan usability.
- `planning.ts`: selects bounded next strategy: `repeat_same`, `refine_region`, `add_replicates`, `reduce_scope`, `stop`; returns compiler input, not an executable spec.
- `lab-state.ts` and `live-state.ts`: split static capability planning from dynamic active-run/live dry-run probes.

## Test Map

- `test/phase4.test.ts`: hardware gate, non-Raman pilot, policy/watchdog basics.
- `test/phase5.test.ts`: resume/recovery/operator intent flows.
- `test/phase6.test.ts`: async simulation lifecycle.
- `test/phase7.test.ts`: Raman schema, bridge, probe, calibration, validation, LabSpec file bridge, autofocus/XY correction, analysis metrics.
- `test/planner-surface.test.ts`: planner/operator active-tool boundary.
- `test/hardware-bridge-v2*.test.ts`: v2 bridge contracts, read-only surface, bridge assertions.
- `test/raman-v2-*.test.ts`: v2 orchestrator, hardware run, resume/reconcile, validation.
- `test/raman-operation-intent.test.ts`, `test/raman-dose-energy-gate.test.ts`, `test/safety-contract-alignment.test.ts`: Raman intent and safety contracts.
- `fixtures/`: simulation, dry-run, hardware, Raman base/v2/real payload examples.

## Development Rules

- Add planner-facing behavior through `schemas.ts` -> `policy.ts`/`preflight.ts` -> `dispatch.ts` -> kernel; keep `tools/*.ts` as wrappers.
- Split static capability reads (`get_lab_capabilities`) from dynamic run state (`get_lab_state`) to avoid unnecessary hardware probing.
- Classify bridge actions by effect; only `hardware_bridge_v2_read` may call action-contract `read` operations directly.
- Put real motion/acquisition/power changes behind approved `run_experiment` hardware flow or operator-only maintenance tools.
- Keep low-level commands blocked in `index.ts`; do not expose direct motion/acquisition tools to the planner.
- Preserve `specHash` compatibility between dry-run preflight and hardware execution unless intentionally changing the gate contract.
