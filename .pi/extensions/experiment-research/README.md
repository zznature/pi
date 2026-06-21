# Experiment Research Extension

This project-local extension implements the bounded experiment loop described in
`docs/pi_agent_experiment_research_adaptation.md`.

## Configuration

The extension is loaded from `.pi/extensions/experiment-research`. It registers
planner macro tools only:

- `get_lab_state`
- `get_experiment_state`
- `validate_experiment_spec`
- `run_preflight`
- `run_experiment`
- `start_run`
- `advance_run`
- `analyze_run`
- `plan_next_experiment`

Operator tools are registered for out-of-band control and are not added to the
planner default active set:

- `pause_run`
- `abort_run`
- `poll_run`
- `request_operator`
- `raman_active_probe`
- `raman_record_xy_calibration`
- `raman_fit_xy_calibration`
- `raman_auto_xy_calibration`
- `raman_prepare_hardware_validation_payload`
- `raman_record_hardware_validation`
- `raman_check_hardware_validation`
- `raman_prepare_validation_spec_pair`

## Capabilities

Capabilities are loaded from `capabilities.ts`.

- `simulation` uses fake stage, camera, and acquisition resources.
- `dry_run` probes gated hardware readiness without motion,
  acquisition, or power writes.
- `hardware` supports a constrained non-Raman MC.Newton XYZ stage path and typed
  Raman specs when `domain.raman` is present.

Raman readiness currently includes:

- typed `domain.raman` schema and semantic validation for acquisition,
  autofocus windows, and XY correction margins;
- `raman_bridge.py`, a JSON-lines Python bridge with read-only probe,
  memory-stage `visit_point`, fake `run_unit` acquisition, and stderr-only
  diagnostics;
- `RamanBridgeClient` for long-lived stdio protocol tests;
- dry-run `readOnlyProbe` reports written through the Python bridge for Raman
  specs;
- `active_probe` smoke checks for operator-approved frame capture and short
  spectrum artifacts through the operator-only `raman_active_probe` tool, kept
  separate from read-only dry runs;
- operator-approved Raman XY calibration records through
  `raman_record_xy_calibration`, persisted under
  `.pi/experiment-runs/lab/calibrations` and referenced by
  `domain.raman.xyCorrection.transformArtifactId`;
- operator-approved Raman XY calibration fitting through
  `raman_fit_xy_calibration`, which estimates `pixelPerUm` from non-collinear
  stage shifts and reference/current frame pairs before writing the same
  calibration artifact format;
- operator-approved automatic Raman XY calibration sequencing through
  `raman_auto_xy_calibration`, which can move a stage, capture frames, fit
  `pixelPerUm`, and write the calibration artifact. The no-hardware path uses a
  memory stage with synthetic frames; the real path uses MC.Newton plus the
  LabSpec frame bridge and still requires supervised hardware validation;
- operator-only Raman hardware validation draft preparation through
  `raman_prepare_hardware_validation_payload`, which assembles a schema-valid
  draft payload from evidence identifiers and instrument IDs while intentionally
  leaving operator approval, real-hardware attestation, and checklist booleans
  unset until the operator completes the final review. A copyable current
  real-capable draft example lives at
  `fixtures/raman-v2-real-validation-payload.draft.json`;
  matching operator input examples for dry-run preflight, active probe, and the
  first bootstrap real V2 minimum run live at
  `fixtures/raman-v2-real-validation-preflight-input.json`,
  `fixtures/raman-v2-real-validation-active-probe-input.json`, and
  `fixtures/raman-v2-real-validation-bootstrap-run-input.json`;
- operator-reviewed Raman hardware validation records through
  `raman_record_hardware_validation`, collecting read-only preflight, active
  smoke, minimum Raman run, optional calibration, safety checklist evidence,
  explicit hardware observation metadata, and instrument IDs into
  `.pi/experiment-runs/lab/validations`. Records only become
  `productionReady` when the evidence is marked `hardware`, the operator
  attests real hardware observation, and the referenced active probe/run records
  do not use fake or memory backends. The minimum Raman run must also include a
  completed unit with `labspec_file_bridge` spectrum metadata, while the active
  probe must include both LabSpec frame capture and spectrum smoke artifacts.
  When `evidence.workflowBackend === "v2_bridge"`, the minimum Raman run must
  also carry matching V2 parity evidence for enabled capabilities: autofocus
  requires `unit.autofocus`, XY correction requires `unit.xyCorrection`,
  thermal waiting requires `unit.thermal`, and autofocus/XY runs require real
  frame artifacts on disk.
  The first supervised real V2 minimum run may use
  `hardwareExecution.approval.bootstrapV2ValidationRun = true` as an
  operator-only bootstrap path before the first production-ready
  `v2ValidationId` exists; later real V2 runs must switch to explicit
  `hardwareExecution.raman.v2ValidationId`.
  The referenced read-only preflight and minimum Raman run must share the same
  canonical `specHash`; the validation record stores an `evidenceDigest` with
  SHA-256 hashes for the referenced preflight, active probe, run records, and
  optional calibration artifact, plus the active probe frame/spectrum artifacts
  and minimum-run spectrum artifacts. Real `v2_bridge` hardware runs must pass
  `hardwareExecution.raman.v2ValidationId` pointing at a production-ready V2
  validation record before the Raman hardware gate opens. Current real hardware
  execution still rejects `thermal.waitBeforeAcquisition` because the thermal
  backend is fake-only; use the current real-capable validation spec pair for
  production-ready V2 evidence, and treat thermal parity as a future full-surface
  target until a real backend exists;
- operator-only Raman validation readiness checks through
  `raman_check_hardware_validation`, which can re-verify stored evidence and,
  when given a candidate ExperimentSpec, also verify that the validation record
  covers the requested Raman capability surface before real hardware execution;
- Raman hardware gates require a `labspec-workstation` workspace lease and
  explicit `ramanSafety` laser-power confirmation in the operator approval;
- bridge-backed Raman `run_experiment` execution for the minimal
  `visit_point + acquire` path, returning immediately with a `runId` and
  updating `poll_run` state through `resume.snapshot.json`;
- selectable Raman acquisition backends: `fake` for no-hardware regression
  tests and `labspec_file_bridge` for the LabSpec worker request/result
  directory protocol;
- bridge `autofocus` and `xy_correct` actions with fake/no-hardware backends
  plus real-capable `labspec_file_bridge` autofocus and `phase_correlation`
  XY correction backends, wired into Raman `run_unit` so focus confidence and
  correction metadata flow into run records and analysis. Hardware execution
  params can provide explicit phase-correlation frame paths, while the transform
  is normally resolved from the referenced calibration artifact;
- deterministic Raman analysis metrics for spectrum SNR, saturation, focus
  confidence, and XY correction metadata.

The `docs/Raman/mapping` LabSpec helper package is also present so the existing
autofocus/microscope file bridge modules and `request_labspec_spectrum.py` can
import in a no-hardware environment. The non-Raman hardware path remains
synchronous and limited to MC.Newton stage movement.

The next hardware milestone is validating the `labspec_file_bridge`
acquisition/autofocus path and `phase_correlation` XY correction path against
the real LabSpec worker, camera stream, stage, and operator safety workflow.

Hardware execution requires a matching dry-run `specHash`, a capability
snapshot, and explicit operator approval.

New `run_experiment` hardware calls should pass `hardwareExecution` parameters.
The legacy `hardwarePilot` parameter remains accepted during migration, but a
single call must not provide both aliases.

## Operator Flow

1. Compile a bounded `ExperimentSpec`.
2. Run `validate_experiment_spec`.
3. Run `run_preflight`.
4. For hardware, review the dry-run report and record operator approval.
5. Run `run_experiment`.
6. Run `analyze_run`.
7. Run `plan_next_experiment`.
8. Compile the returned strategy into the next bounded `ExperimentSpec`.

The agent must not change run parameters while a run is active.

## Records

Each run writes:

- `run.json`
- `spec.json`
- `events.jsonl`
- `summary.json`
- `analysis.json`
- `resume.snapshot.json`
- `artifacts.json`
- `approvals.jsonl` for hardware

Experiment-level history is stored in:

- `experiment.json`
- `lineage.jsonl`
- `decisions.jsonl`

## Fake Experiment

Use `fixtures/valid-spec.json` for a complete simulation loop:

```text
validate_experiment_spec -> run_preflight -> run_experiment -> analyze_run -> plan_next_experiment
```

Use `fixtures/hardware-dry-run-spec.json` and `fixtures/hardware-spec.json` for
the gated non-Raman stage hardware path.

Use `fixtures/raman-dry-run-spec.json` and `fixtures/raman-hardware-spec.json`
for the minimal Raman acquisition contract path.

## CI Checks

Run focused tests after changing this extension:

```text
npm --prefix .pi/extensions/experiment-research test
```

Run an individual phase test when iterating on a narrow change:

```text
npm --prefix .pi/extensions/experiment-research run test:phase7
```

After code changes, run the repository check:

```text
npm run check
```
