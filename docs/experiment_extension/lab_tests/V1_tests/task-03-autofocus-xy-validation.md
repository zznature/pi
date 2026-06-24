# Task 03: Autofocus and XY Correction Validation

## Purpose

Validate focus and optional XY correction before running a map. This task should be run after the minimum Raman run passes and before expanding to grid mapping.

## Agent Usage

1. If XY correction is needed, create or reference a calibration artifact using an operator-only calibration tool:
   - `raman_record_xy_calibration`
   - `raman_fit_xy_calibration`
   - `raman_auto_xy_calibration`
2. Compile an `ExperimentSpec` with `domain.raman.autofocus.enabled: true`.
3. Add `lab-camera` to resources.
4. Run `validate_experiment_spec`.
5. Run `run_preflight`.
6. Execute hardware only after operator approval.
7. Call `analyze_run`.

## Required Inputs

| Parameter | Required when |
| --- | --- |
| `frame_bridge_dir` | Autofocus or XY correction enabled |
| `autofocus_z_min_um` | Autofocus enabled |
| `autofocus_z_max_um` | Autofocus enabled |
| `coarse_range_um` | Autofocus enabled |
| `coarse_step_um` | Autofocus enabled |
| `fine_range_um` | Autofocus enabled |
| `fine_step_um` | Autofocus enabled |
| `transformArtifactId` | XY correction enabled |

## ExperimentSpec Template

This template uses autofocus on every point and leaves XY correction disabled. Enable XY correction only after a calibration artifact exists.

```json
{
  "schemaVersion": "1",
  "experimentId": "exp-sc-film-raman-001",
  "specId": "spec-sc-film-focus-001",
  "experimentType": "spatial_mapping",
  "objective": "Validate Raman autofocus before mapping superconducting thin film on silicon wafer.",
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
      "maxUnits": 3
    }
  },
  "plan": {
    "kind": "points",
    "points": [
      { "xUm": 8, "yUm": 8, "zUm": 0 },
      { "xUm": 10, "yUm": 10, "zUm": 0 },
      { "xUm": 12, "yUm": 12, "zUm": 0 }
    ]
  },
  "domain": {
    "raman": {
      "operationIntent": "autofocus_then_acquire",
      "autofocus": {
        "enabled": true,
        "every": { "kind": "everyNPoints", "n": 1 },
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
    "maxRuntimeMinutes": 4,
    "maxUnits": 3,
    "stopOnError": true
  }
}
```

## XY Correction Block

Add this block under `domain.raman` only after the calibration artifact is recorded and preflight can resolve it:

```json
{
  "xyCorrection": {
    "enabled": true,
    "phase": "postFocusCorrection",
    "transformArtifactId": "cal-raman-xy-001",
    "minConfidence": 0.4,
    "maxCorrectionUm": 3
  }
}
```

## Pass Criteria

- Autofocus returns confidence metadata for each successful point.
- Low-confidence focus triggers `pause` rather than continuing blindly.
- If XY correction is enabled, correction magnitude stays below `maxCorrectionUm`.
- `analyze_run` includes focus confidence and XY correction metadata.

## Fail Criteria

- Autofocus z window exceeds `limits.motion.zUm`.
- Missing `lab-camera` resource when autofocus or XY correction is enabled.
- Missing or expired XY calibration artifact.
- XY correction direction is not operator-verified on a known shift.
