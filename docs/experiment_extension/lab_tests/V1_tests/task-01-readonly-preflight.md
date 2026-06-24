# Task 01: Read-only Raman Hardware Preflight

## Purpose

Verify that pi-agent can compile and preflight a Raman mapping `ExperimentSpec` for the superconducting film sample without moving hardware, acquiring spectra, changing laser power, or exposing the sample.

## Agent Usage

1. Compile the task inputs into a `dry_run` `ExperimentSpec`.
2. Call `validate_experiment_spec` with the spec.
3. Call `run_preflight` with the same spec.
4. Save the returned dry-run report ID if your lab wants to keep a traceable dry-run reference for the later hardware run.

Do not call `run_experiment` for this task. `dry_run` is preflight-only.

## Required Inputs

| Parameter | Example |
| --- | --- |
| `sample_id` | `SC-FILM-SI-001` |
| `safe_x_range_um` | `0..20` |
| `safe_y_range_um` | `0..20` |
| `safe_z_range_um` | `-20..20` |
| `max_laser_power_mw` | `0.2` |
| `integration_time_s` | `0.5` |
| `accumulations` | `1` |

## ExperimentSpec Template

The matching hardware spec should keep the scientific intent identical and change only the execution mode.

```json
{
  "schemaVersion": "1",
  "experimentId": "exp-sc-film-raman-001",
  "specId": "spec-sc-film-preflight-001",
  "experimentType": "spatial_mapping",
  "objective": "Read-only preflight for Raman mapping of superconducting thin film on silicon wafer.",
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
      "maxUnits": 2
    }
  },
  "plan": {
    "kind": "points",
    "points": [
      { "xUm": 10, "yUm": 10, "zUm": 0 },
      { "xUm": 12, "yUm": 10, "zUm": 0 }
    ]
  },
  "domain": {
    "raman": {
      "operationIntent": "acquire_only",
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
    "maxRuntimeMinutes": 2,
    "maxUnits": 2,
    "stopOnError": true
  }
}
```

## Pass Criteria

- `validate_experiment_spec` returns success.
- `run_preflight` returns success.
- Preflight `willNotExecute` includes stage motion, Raman acquisition, laser power change, and instrument writes.
- A preflight report exists under `.pi/experiment-runs/preflights`.
- The report exposes a `specHash` that can be reused as traceability evidence for the matching hardware run.

## Fail Criteria

- Any unknown instrument resource.
- Active run already exists.
- Planned point count exceeds `limits.acquisition.maxUnits` or `stoppingRules.maxUnits`.
- Runtime estimate exceeds `stoppingRules.maxRuntimeMinutes`.
- Live read-only probe cannot access required bridge paths or hardware readiness signals.
