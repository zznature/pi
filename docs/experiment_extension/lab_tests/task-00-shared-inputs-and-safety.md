# Task 00: Shared Inputs and Safety Envelope

## Purpose

Collect the minimum information required before pi-agent is allowed to compile or run any Raman hardware task on the superconducting thin film sample.

## Required Lab Inputs

| Input | Required value |
| --- | --- |
| `sample_id` | Unique wafer or chip ID |
| `film_material` | Superconducting film material, e.g. NbN, MgB2, YBCO, or unknown |
| `film_thickness_nm` | Known value or `unknown` |
| `substrate` | `Si wafer` |
| `sample_region_label` | Operator-approved area label |
| `origin_definition` | How stage `(0, 0, 0)` is defined for this run |
| `objective` | Objective and magnification used |
| `laser_wavelength_nm` | Raman laser wavelength |
| `confirmed_laser_power_mw` | Measured or instrument-displayed power at sample |
| `safe_x_range_um` | Allowed local X window |
| `safe_y_range_um` | Allowed local Y window |
| `safe_z_range_um` | Allowed local Z window |
| `labspec_bridge_dir` | LabSpec spectrum request/result bridge directory |
| `frame_bridge_dir` | LabSpec frame bridge directory if autofocus or XY correction is enabled |
| `stage_port` | MC.Newton controller port, for example `COM17` |

## Safety Rules

- Hardware run requires `operatorApprovalRequired: true`.
- The operator must confirm `ramanSafety.confirmedLaserPowerMw <= spec.limits.powerEnergy.maxLaserPowerMw`.
- Do not use film-specific Raman peaks as the only pass/fail signal until a human confirms expected bands.
- If the film is metallic or opaque, the Si 520.7 cm-1 peak may be weak or absent; this is not automatically a mapping failure.
- Use `stopOnError: true` for first hardware contact with the sample.
- Use `maxConsecutiveErrors: 2` or lower until stage, LabSpec, and file bridge behavior are validated.

## pi-agent HardwarePilot Template

Use this structure with `run_experiment` for hardware tasks. Replace IDs and paths with the actual lab values.

```json
{
  "stageAdapter": "mc_newton_xyz",
  "stagePort": "COM17",
  "stagePython": "python",
  "raman": {
    "acquisitionBackend": "labspec_file_bridge",
    "autofocusBackend": "labspec_file_bridge",
    "xyCorrectionBackend": "phase_correlation",
    "labspecBridgeDir": "D:\\RamanLab\\SpecBridge",
    "frameBridgeDir": "D:\\RamanLab\\SpecBridge",
    "labspecTimeoutS": 15,
    "labspecPollIntervalS": 0.2
  },
  "settleTimeoutMs": 5000,
  "heartbeatTimeoutMs": 10000,
  "maxConsecutiveErrors": 2,
  "approval": {
    "approvalId": "approval-raman-film-001",
    "operator": "operator-name",
    "approved": true,
    "dryRunReportId": "dry_run-preflight-0001",
    "operatorOnlyMonitoring": true,
    "ramanSafety": {
      "laserPowerConfirmed": true,
      "confirmedLaserPowerMw": 0.2,
      "labSpecWorkerReady": true,
      "windowsPowerPolicyReady": true,
      "notes": "Laser power confirmed before run; shutter controlled by LabSpec workflow."
    },
    "notes": "Operator reviewed sample position, focus state, and emergency stop."
  }
}
```

## Required Operator Checklist

- Sample is sacrificial or approved for first automated test.
- Laser power has been verified at or below the spec limit.
- LabSpec worker is running and points to the correct bridge directories.
- Stage coordinate origin is inside the approved local sample region.
- The full planned XY area stays inside the operator-approved region.
- Z limits cannot crash the objective into the sample.
- Emergency stop and shutter behavior are verified before hardware run.
