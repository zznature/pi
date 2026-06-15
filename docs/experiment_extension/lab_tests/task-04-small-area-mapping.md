# Task 04: Small-area Raman Mapping

## Purpose

Execute the first real Raman mapping run on the superconducting thin film sample.

This task validates the core user goal: pi-agent can complete a bounded Raman mapping experiment and produce traceable map records.

## Agent Usage

1. Compile a small-grid `dry_run` spec.
2. Call `validate_experiment_spec`.
3. Call `run_preflight`.
4. Review the dry-run report and approve hardware.
5. Compile the matching hardware spec with only `mode` and `operatorApprovalRequired` changed.
6. Call `run_experiment` with `hardwarePilot`.
7. Use `poll_run` while active.
8. Call `analyze_run`.
9. Only after analysis, use `plan_next_experiment` to decide whether to increase area, integration time, or point count.

## Required Inputs

| Parameter | Initial value |
| --- | --- |
| `map_x_start_um` | `5` |
| `map_x_stop_um` | `15` |
| `map_x_steps` | `3` |
| `map_y_start_um` | `5` |
| `map_y_stop_um` | `15` |
| `map_y_steps` | `3` |
| `max_laser_power_mw` | `0.2` |
| `integration_time_s` | `0.5` |
| `accumulations` | `1` |
| `autofocus` | enabled only if task 03 passed |

## Dry-run ExperimentSpec

This is the first mapping task. Keep the initial grid small.

```json
{
  "schemaVersion": "1",
  "experimentId": "exp-sc-film-raman-001",
  "specId": "spec-sc-film-map-001",
  "experimentType": "spatial_mapping",
  "objective": "Small-area Raman mapping of superconducting thin film on silicon wafer.",
  "subject": {
    "id": "SC-FILM-SI-001",
    "kind": "superconducting_thin_film_on_si",
    "label": "superconducting film on silicon wafer"
  },
  "mode": "dry_run",
  "resources": [
    { "id": "mc-newton-xyz-stage", "kind": "instrument", "role": "stage" },
    { "id": "lab-camera", "kind": "instrument", "role": "camera" },
    { "id": "lab-acquirer", "kind": "instrument", "role": "acquirer" },
    { "id": "labspec-workstation", "kind": "workspace", "role": "exclusive_lab_station" }
  ],
  "limits": {
    "motion": {
      "xUm": { "minUm": 0, "maxUm": 20 },
      "yUm": { "minUm": 0, "maxUm": 20 },
      "zUm": { "minUm": -25, "maxUm": 25 }
    },
    "powerEnergy": {
      "maxLaserPowerMw": 0.2
    },
    "acquisition": {
      "maxExposureMs": 500,
      "maxUnits": 9
    }
  },
  "plan": {
    "kind": "grid",
    "grid": {
      "x": { "startUm": 5, "stopUm": 15, "steps": 3 },
      "y": { "startUm": 5, "stopUm": 15, "steps": 3 }
    }
  },
  "domain": {
    "raman": {
      "autofocus": {
        "enabled": true,
        "every": "once",
        "zMinUm": -25,
        "zMaxUm": 25,
        "coarseRangeUm": 20,
        "coarseStepUm": 5,
        "fineRangeUm": 6,
        "fineStepUm": 1,
        "metric": "labspec_spot_compactness",
        "minConfidence": 0.2,
        "onFailure": "pause"
      },
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
    "maxRuntimeMinutes": 5,
    "maxUnits": 9,
    "stopOnError": true
  },
  "operatorApprovalRequired": false
}
```

## Pass Criteria

- 9 planned units are recorded.
- Every successful point has a spectrum artifact reference.
- Failed points have structured Raman error codes such as `acquisition_failed`, `stage_timeout`, or `autofocus_low_confidence`.
- No unapproved point outside the XY limits is visited.
- `analyze_run` reports quality metrics and anomalies.
- The operator can reconstruct the mapping from `spec.json`, `events.jsonl`, `summary.json`, `artifacts.json`, and spectrum artifacts.

## Mapping Acceptance Metrics

For the first run, accept the map if:

- Completed points >= 8 of 9.
- Saturated spectra = 0.
- No stage or bridge crash.
- Focus failure count = 0 if autofocus is enabled.
- Signal is scientifically interpretable by the operator.

Do not automatically expand the map if the signal is weak, saturated, drifting, or inconsistent with the microscope image.

