# Task 02: Minimum Raman Spectrum Run

## Purpose

Run the smallest real Raman acquisition on the approved sample region. This validates the stage/acquirer/LabSpec bridge path and produces the first spectrum artifact before any mapping run.

This task is not a mapping task. It is a single- or two-point hardware pilot.

## Agent Usage

1. Use the same spec body as task 01, but set:
   - `mode: "hardware"`
   - `operatorApprovalRequired: true`
2. Ensure task 01 passed with the matching dry-run preflight report.
3. Call `run_experiment` with the hardware spec and `hardwarePilot`.
4. Call `poll_run` until the run reaches a terminal state.
5. Call `analyze_run` with the returned `runId`.

## Required Inputs

| Parameter | Example |
| --- | --- |
| `dryRunReportId` | `dry_run-preflight-0001` |
| `stage_port` | `COM3` |
| `labspec_bridge_dir` | `D:\RamanLab\SpecBridge` |
| `confirmed_laser_power_mw` | `0.2` |
| `operator` | Lab operator name |

## Hardware ExperimentSpec

Keep this spec identical to task 01 except for `mode` and `operatorApprovalRequired`.

```json
{
  "schemaVersion": "1",
  "experimentId": "exp-sc-film-raman-001",
  "specId": "spec-sc-film-preflight-001",
  "experimentType": "spatial_mapping",
  "objective": "Minimum Raman spectrum acquisition on superconducting thin film on silicon wafer.",
  "subject": {
    "id": "SC-FILM-SI-001",
    "kind": "superconducting_thin_film_on_si",
    "label": "superconducting film on silicon wafer"
  },
  "mode": "hardware",
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
  },
  "operatorApprovalRequired": true
}
```

## HardwarePilot Parameters

Use the shared template from task 00. Required fields for this task:

- `stageAdapter: "mc_newton_xyz"`
- `stagePort`
- `raman.acquisitionBackend: "labspec_file_bridge"`
- `raman.labspecBridgeDir`
- `approval.dryRunReportId`
- `approval.ramanSafety.laserPowerConfirmed: true`
- `approval.ramanSafety.confirmedLaserPowerMw <= limits.powerEnergy.maxLaserPowerMw`

## Pass Criteria

- `run_experiment` starts a Raman hardware run and returns `runId`.
- `poll_run` reaches `completed`, or reaches `paused` with a structured Raman error.
- At least one spectrum artifact is recorded for a successful point.
- `analyze_run` reports spectrum quality metrics or structured acquisition failure.
- No Python traceback text is used as the primary failure signal.

## Scientific Review

The operator should inspect the saved spectrum for:

- Saturation.
- Very low signal or all-zero data.
- Approximate Si peak near 520.7 cm-1 if substrate signal is expected.
- Film-specific Raman features if the material has known bands.
- Any sign that the film may be heating or degrading.
