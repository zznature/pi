<!-- Generated: 2026-06-16 | Files scanned: 56 | Token estimate: ~950 -->

# Experiment Research Extension Codemap

Scope: `.pi/extensions/experiment-research`, a project-local pi extension for bounded experiment loops and Raman hardware MVP work.

```text
pi extension
  index.ts
    registers planner tools, operator tools, prompt injection, low-level tool guard
    subscribes to Raman terminal events and emits follow-up messages
      |
      v
  tools/*.ts             thin ToolDefinition wrappers
      |
      v
  dispatch.ts            validates params/spec, applies policy, gates hardware, routes work
      |
      +--> simulation: run-store.ts -> kernel/lab-agent-kernel.ts -> kernel/simulation.ts -> records.ts
      +--> async sim:  run-store.ts -> kernel/kernel.ts (start/advance/poll)
      +--> hardware:   records.ts hardware gate -> stage-adapter.ts or raman-hardware.ts
      +--> analysis:   run-store.ts -> analysis.ts -> planning.ts
```

## Entry Points

- `.pi/extensions/experiment-research/index.ts`
  - default export `experimentResearchExtension(pi: ExtensionAPI)`
  - planner-active tools: `get_lab_state`, `get_experiment_state`, `validate_experiment_spec`, `run_preflight`, `run_experiment`, `start_run`, `advance_run`, `analyze_run`, `plan_next_experiment`
  - operator-only tools: `pause_run`, `abort_run`, `poll_run`, `request_operator`, Raman probe/calibration/validation tools
- `.pi/extensions/experiment-research/package.json`
  - `npm --prefix .pi/extensions/experiment-research test`
  - phase tests: `test:phase4` through `test:phase7`

## Core Contracts

- `schemas.ts`
  - `ExperimentSpec`: bounded `simulation | dry_run | hardware` spec with resources, limits, plan, optional `domain.raman`
  - `ToolResult`: uniform tool response with status, summary, artifacts, run/experiment ids, retry metadata
  - `HardwareExecutionParams`: stage adapter, watchdog thresholds, operator approval, optional Raman backends
  - `validateExperimentSpec(value)` performs TypeBox schema checks plus semantic checks for grid/points, motion bounds, Raman autofocus/acquisition/XY correction
- `results.ts` creates standard success/error `ToolResult`s.
- `spec-utils.ts` expands grid/points into unit lists and resource ids.

## Safety And Gating

- `policy.ts`
  - enforces mode/tool compatibility, active-run exclusion, resource availability, unit limits
  - constrains non-Raman hardware to MC.Newton explicit points
  - constrains Raman hardware to required stage/workspace/camera/acquirer resources and z limits
- `preflight.ts`
  - estimates runtime, checks live dry-run state, resolves Raman XY calibration when needed
  - dry runs do not execute motion/acquisition/power writes
- `live-state.ts`
  - probes dry-run adapters and calls `raman_bridge.py` read-only `probe` for Raman specs
- `records.ts`
  - writes preflight reports and validates hardware approvals against matching `specHash`
  - records operator intents and hardware approvals
- `watchdog.ts`
  - decides `none | pause | abort | request_operator` from operator intents, heartbeat, errors, quality, artifacts, budget

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
  lab/calibrations/<calibrationId>.json
  lab/validations/<validationId>.json
```

- `run-store.ts`: run reservation, active-run conflict detection, spec hashing, lineage/decision reads/writes.
- `records.ts`: simulation/hardware/preflight record writers.
- `compaction.ts`: compact session summaries from recent run records; disk remains authoritative.

## Execution Kernels

- `kernel/simulation.ts`: deterministic point simulation and summary.
- `kernel/kernel.ts`: interruptible simulation lifecycle with `startRun`, `advanceRun`, `pollRun`; honors intents at unit boundaries.
- `kernel/hardware-pilot.ts`: synchronous non-Raman hardware pilot over `StageAdapter`.
- `kernel/stage-adapter.ts` and `stage_bridge.py`: memory or one-shot MC.Newton XYZ stage bridge.
- `kernel/raman-hardware.ts`: async Raman hardware run worker.
  - starts long-lived `RamanBridgeClient`, emits bridge stderr/events into `events.jsonl`
  - archives LabSpec request/result files and spectrum artifacts
  - writes resume snapshots and terminal summaries, then notifies `index.ts`
- `kernel/raman-bridge.ts`: JSON-lines stdio client around `raman_bridge.py`.

## Raman Maintenance

- `kernel/raman-active-probe.ts`: operator-approved frame/spectrum smoke records.
- `kernel/raman-calibration.ts`: record, fit, or auto-fit XY calibration artifacts.
- `kernel/raman-validation.ts`: evidence-chain validation for production-ready Raman hardware records.
- `raman_bridge.py`: low-level Python protocol actions:
  - `probe`, `active_probe`, `connect`, `visit_point`, `run_unit`, `autofocus`, `xy_correct`, `calibrate_xy`, `calibrate_xy_sequence`, `acquire_spectrum`, `stop`, `shutdown`
  - backends include `fake`, `labspec_file_bridge`, and `phase_correlation`; diagnostics must stay on stderr.
- `labspec-bridge.ts`: default Windows LabSpec bridge directory.

## Analysis And Planning

- `analysis.ts`: derives deterministic metrics, Raman SNR/saturation/focus/XY metadata, anomalies, stopping-rule judgments.
- `planning.ts`: selects bounded next strategy: `repeat_same`, `refine_region`, `add_replicates`, `reduce_scope`, `stop`; returns compiler input, not an executable spec.

## Test Map

- `test/phase4.test.ts`: hardware gate, non-Raman pilot, policy/watchdog basics.
- `test/phase5.test.ts`: resume/recovery/operator intent flows.
- `test/phase6.test.ts`: async simulation lifecycle.
- `test/phase7.test.ts`: Raman schema, bridge, probe, calibration, validation, LabSpec file bridge, autofocus/XY correction, analysis metrics.
- `fixtures/*.json`: valid/invalid simulation, dry-run, hardware, and Raman specs.

## Development Rules

- Add new planner behavior through `schemas.ts` -> `policy.ts`/`preflight.ts` -> `dispatch.ts` -> kernel; keep `tools/*.ts` as wrappers.
- Add Raman side-effecting behavior behind operator-only tools or approved `run_experiment` hardware flow.
- Keep low-level commands blocked in `index.ts`; do not expose direct motion/acquisition tools to the planner.
- Preserve `specHash` compatibility between dry-run preflight and hardware execution unless intentionally changing the gate contract.
