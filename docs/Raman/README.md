# Raman Measurement Automation

This directory contains Raman automation prototypes used by the experiment
research agent design. The current tree focuses on reusable stage control,
LabSpec-backed frames and spectra, Z autofocus, and image-based XY calibration.

The previous DirectShow/ActiveX camera probe and C# helper files are not part of
this directory after the rename. Do not document or depend on that removed route
unless those files are intentionally restored later.

## Current Layout

```text
docs/Raman/
  stage/                     Motion-stage interfaces and controllers
    models.py                StagePosition / StageShift / ZStage / XYZStage
    memory_stage.py          Offline MemoryXYZStage for tests and simulations
    z_stage.py               MC.NewtonLT-06 single-axis Z controller
    mc_newton_xyz_stage.py   MC.NewtonLT-06 XYZ controller
    exceptions.py

  autofocus/                 Hardware-decoupled Z autofocus
    models.py                Frame, ROI, params, result types
    metrics.py               Focus metrics including labspec_spot_compactness
    scanner.py               Coarse/fine Z scanning and peak fitting
    controller.py            AutofocusController.run_single
    labspec_file_bridge.py   LabSpec worker-backed FrameProvider

  calibration/               Image-registration based XY calibration
    models.py                ROI / PixelShift / ShiftResult
    preprocessing.py         Grayscale, normalization, Hann window, ROI crop
    phase_correlation.py     Fourier phase-correlation translation estimate
    stage_transform.py       Pixel shift <-> stage um transform
    xy_corrector.py          Compute inverse XY correction
    stage_adapter.py         Apply correction to an XYZStage

  microscope/
    labspec_file_bridge.py   LabSpec worker-backed FrameProvider prototype

  acquire-spectrum/          LabSpec spectrum request helpers
    request_labspec_spectrum.py
```

## Hardware Scope

| Component | Current path | Status |
| --- | --- | --- |
| MC.Newton XYZ stage | `stage/mc_newton_xyz_stage.py` | Real hardware driver prototype |
| MC.Newton Z stage | `stage/z_stage.py` | Real hardware driver prototype |
| Memory stage | `stage/memory_stage.py` | Offline simulation |
| LabSpec frame bridge | `autofocus/labspec_file_bridge.py`, `microscope/labspec_file_bridge.py` | File-queue prototype |
| LabSpec spectrum request | `acquire-spectrum/` | File-queue request prototype |
| IDS DirectShow/ActiveX probe | not present | Intentionally not restored |

## Agent Integration Boundary

Agent-facing tools must stay macro-level:

```text
validate_experiment_spec
run_preflight
run_experiment
analyze_run
plan_next_experiment
pause_run / abort_run / request_operator
```

Do not expose low-level stage, camera, autofocus, or spectrum commands directly
to the planner. These modules are backend adapters and algorithms for a
deterministic kernel.

## Raman Kernel Shape

A future Raman hardware unit should execute deterministically:

```text
watchdog check
  -> move XY/Z stage within ExperimentSpec limits
  -> optional autofocus
  -> optional frame capture through LabSpec bridge
  -> optional XY correction when explicitly enabled
  -> optional Raman spectrum acquisition
  -> write unit event, summary fields, and artifact references
```

Every hardware action must be traceable to an `ExperimentSpec`, a dry-run
preflight, an approval record when required, and append-only run events.

## Autofocus

`autofocus/` depends on protocols rather than concrete hardware:

| Interface | Meaning |
| --- | --- |
| `FrameProvider` | Supplies timestamped frames |
| `ZStage` | Reads/moves/stops Z and waits for settle |
| `FocusStrategy` | Scores focus quality in an ROI |

The controller performs:

```text
read current Z
  -> validate Z range
  -> coarse scan
  -> fine scan around the coarse peak
  -> parabolic peak estimate
  -> backlash-compensated final move
  -> final score verification
```

Autofocus failures should be recorded as structured unit errors or quality
anomalies, not handled by the LLM during the active run.

## XY Calibration

`calibration/` is algorithmic. It estimates translation by phase correlation and
converts pixel shifts to stage corrections through `PixelStageTransform`.

Applying a correction is a hardware action. The kernel may only apply it when the
bounded spec explicitly enables correction and sets confidence/limit guards.

## LabSpec Spectrum Acquisition

`acquire-spectrum/` contains the LabSpec file-queue spectrum request helper. The
agent integration should wrap it as a spectrum adapter inside the kernel, with
request path, result path, timeout, output file, and status recorded as
artifacts/events.

## Immediate Compatibility Note

The experiment research extension resolves the real MC.Newton stage Python root
to `docs/Raman`. If this directory is renamed again, update the extension stage
adapter or make the path configurable before running hardware mode.
