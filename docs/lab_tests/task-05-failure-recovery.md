# Task 05: Failure Recovery and Abort Behavior

## Purpose

Confirm that Raman mapping failure modes are safe and diagnosable before running larger maps on the superconducting thin film sample.

## Agent Usage

Use only bounded hardware runs and operator tools:

- `poll_run` to observe progress.
- `pause_run` to request a pause at a safe boundary.
- `abort_run` to request abort.
- `analyze_run` after terminal state.

The planner must not patch the active spec while a run is active.

## Failure Scenarios

Run these intentionally on a sacrificial region or with laser disabled where possible.

| Scenario | Method | Expected result |
| --- | --- | --- |
| Acquisition timeout | Stop or delay LabSpec worker result | Structured `acquisition_failed` or pause |
| Stage timeout | Use unreachable stage port in dry-run, not live sample | Preflight or run rejects safely |
| Low focus confidence | Defocus sample within safe Z range | `autofocus_low_confidence` and pause |
| Operator abort | Call `abort_run` during hardware run | Run becomes `aborted`; records remain inspectable |
| Consecutive point failures | Configure bridge to fail repeated acquisitions | Run pauses or aborts after `maxConsecutiveErrors` |
| Missing XY calibration | Enable XY correction with invalid `transformArtifactId` | Preflight fails before hardware |

## Minimal Abort Test Spec

Use a 3-point hardware spec derived from task 02, then call `abort_run` after the first point starts or completes. Keep laser power low and integration short.

```json
{
  "schemaVersion": "1",
  "experimentId": "exp-sc-film-raman-001",
  "specId": "spec-sc-film-abort-001",
  "experimentType": "spatial_mapping",
  "objective": "Validate operator abort behavior during Raman hardware run.",
  "subject": {
    "id": "SC-FILM-SI-001",
    "kind": "superconducting_thin_film_on_si",
    "label": "superconducting film on silicon wafer"
  },
  "mode": "dry_run",
  "resources": [
    { "id": "mc-newton-xyz-stage", "kind": "instrument", "role": "stage" },
    { "id": "lab-acquirer", "kind": "instrument", "role": "acquirer" },
    { "id": "labspec-workstation", "kind": "workspace", "role": "exclusive_lab_station" }
  ],
  "limits": {
    "motion": {
      "xUm": { "minUm": 0, "maxUm": 20 },
      "yUm": { "minUm": 0, "maxUm": 20 },
      "zUm": { "minUm": -20, "maxUm": 20 }
    },
    "powerEnergy": {
      "maxLaserPowerMw": 0.2
    },
    "acquisition": {
      "maxExposureMs": 500,
      "maxUnits": 3
    }
  },
  "plan": {
    "kind": "points",
    "points": [
      { "xUm": 8, "yUm": 10, "zUm": 0 },
      { "xUm": 10, "yUm": 10, "zUm": 0 },
      { "xUm": 12, "yUm": 10, "zUm": 0 }
    ]
  },
  "domain": {
    "raman": {
      "acquisition": {
        "integrationTimeS": 0.5,
        "accumulations": 1,
        "fromNm": 100,
        "toNm": 3500,
        "saveFormat": "txt"
      }
    }
  },
  "stoppingRules": {
    "maxRuntimeMinutes": 3,
    "maxUnits": 3,
    "stopOnError": true
  },
  "operatorApprovalRequired": false
}
```

## Pass Criteria

- Abort intent is written to the run intents log.
- Hardware run reaches `aborted`, `paused`, or another documented safe terminal state.
- Partial spectra and point records remain available.
- `analyze_run` can process the partial run or reports a clear missing-summary condition.
- The next real mapping run is blocked until the operator reviews why the abort occurred.

## Expansion Gate

Do not proceed to larger maps until:

- Task 04 has passed at least once.
- Task 05 has demonstrated abort behavior.
- The operator has reviewed artifacts and confirmed no visible sample damage.
- Any increase in laser power, exposure, grid size, or map area is encoded as a new `ExperimentSpec`.

