# Raman Measurement Automation

Python control code for automated Raman mapping with Horiba LabSpec6. The current codebase focuses on microscope image acquisition, Z autofocus, image-based XY calibration, reusable motion-stage abstractions, and early camera-control experiments for the IDS uEye microscope camera.

## Hardware

| Component | Model | Interface |
| --- | --- | --- |
| Microscope camera | IDS UI-358x | USB, `pyueye` + IDS Software Suite 4.96; experimental DirectShow/COM route under `camera-activeX/` |
| Motion controller | MC.NewtonLT-06 | USB serial `COM3`, 115200 8N1, Z axis on channel 3 |
| Raman spectrometer | Horiba Raman | Controlled by LabSpec6; this project provides focus, positioning, and trigger-side workflow support |

Stage protocol notes live under `assets/`.

## Environment

- Python 3.10 for hardware operation
- IDS Software Suite 4.96 installed
- Default IDS DLL path: `C:\Program Files\IDS\uEye\develop\bin`
- Windows `pywin32` for COM initialization and ActiveX/DirectShow experiments
- PowerShell and a usable .NET/C# runtime for the embedded DirectShow interop helper in `camera-activeX/`

Install dependencies:

```powershell
pip install -r requirements.txt
```

If IDS DLLs are not in the default location:

```powershell
$env:IDS_DLL_DIR = "C:\path\to\uEye_dll_dir"
```

For the DirectShow/ActiveX camera route, make sure the IDS DirectShow component is installed and `uEyeCapture.ax` is registered. The DirectShow filter, Python process, and PowerShell/.NET process must have matching bitness.

## Directory Layout

```text
raman/
  microscope/                IDS camera acquisition and PyQt preview GUI
    main.py                  GUI entry point
    config.py                camera defaults and IDS DLL path injection
    camera/                  low-level pyueye camera wrapper
    acquisition/             camera lifecycle, live view, FrameProvider adapter
    gui/                     PyQt widgets
    utils/                   image IO helpers

  camera-activeX/            IDS uEye DirectShow/COM capture experiments
    capture_ids_camera_activex.py
                              Python entry point that initializes COM, enumerates DirectShow
                              devices, and captures one BMP through an embedded C# helper
    Probe-DirectShowCamera.ps1
                              DirectShow device enumeration and IBaseFilter binding probe
    Run-DirectShowCameraSmoke.ps1
                              minimal DirectShow graph smoke test

  stage/                     motion-stage interfaces and controllers
    models.py                StagePosition / StageShift / ZStage / XYZStage
    memory_stage.py          offline MemoryXYZStage for tests and workflow simulation
    z_stage.py               MC.NewtonLT-06 ZStageController
    exceptions.py

  autofocus/                 hardware-decoupled Z autofocus
    models.py                Frame, ROI, params, result types
    metrics.py               tenengrad / laplacian / brenner / normalized variance
    scanner.py               coarse/fine Z scanning and peak fitting
    controller.py            AutofocusController.run_single
    labspec_file_bridge.py   LabSpec worker-backed FrameProvider for autofocus

  calibration/               image-registration based XY calibration
    models.py                ROI / PixelShift / ShiftResult
    preprocessing.py         grayscale, normalization, Hann window, ROI crop
    phase_correlation.py     Fourier phase correlation translation estimate
    stage_transform.py       pixel shift <-> stage um transform
    xy_corrector.py          compute inverse XY correction
    stage_adapter.py         apply correction to an XYZStage

  mapping/                   offline-first Raman mapping orchestration
    models.py                mapping points, acquisition results, point records
    planner.py               rectangular grid generation
    focus_plane.py           focus anchor fitting and Z prediction
    runner.py                point execution state machine
    records.py               JSONL point-record persistence
    labspec.py               RamanAcquirer protocol and fake acquirer

  workflows/                 hardware workflows built from reusable modules
    labspec_matrix_autofocus_spectrum.py
                              n x n LabSpec mapping: first-point autofocus,
                              MappingRunner execution, spectrum + PNG output

  ui/                        local browser UIs
    mapping_ui.py            HTTP server and API for matrix mapping UI
    static/mapping.html      matrix heatmap and spectrum viewer

  tests/                     offline tests and hardware helper scripts
  assets/                    hardware manuals and UI assets
  captures/                  default image capture output
```

## Run

Camera preview GUI:

```powershell
python -m microscope.main
```

List DirectShow video input devices:

```powershell
python .\camera-activeX\capture_ids_camera_activex.py --list-devices
```

Capture one IDS uEye frame through the DirectShow/COM path:

```powershell
python .\camera-activeX\capture_ids_camera_activex.py --name-contains "UI358x" --output .\captures\ids_frame.bmp
```

Manual Z-stage check:

```powershell
python -m tests.z_stage_manual --port COM3 --move 10.5
```

Offline tests:

```powershell
python -m pytest tests/ -v
```

LabSpec matrix mapping UI:

```powershell
py -3.12 -m ui.mapping_ui --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765
```

Start `assets/labspec_scripts/labspec_worker.vbs` inside LabSpec before running
the UI. The UI launches `workflows.labspec_matrix_autofocus_spectrum` in the
background, writes spectra under `runtime/labspec_bridge/spectra/`, and shows a
live matrix heatmap by interpolating spectrum intensity at the selected Raman
shift.

## Raman Mapping Workflow

The intended mapping loop combines planned XY movement, focus-plane prediction, local autofocus, image registration, and Raman acquisition:

```text
prepare mapping grid
  -> collect focus/calibration anchors
  -> fit focus plane z = ax + by + c
  -> calibrate pixel shift <-> stage XY transform

for each mapping point:
  -> move XYZ stage to planned XY and predicted Z
  -> run local autofocus if needed
  -> capture microscope image after Z change
  -> estimate XY image drift by phase correlation
  -> convert pixel drift to stage um correction
  -> apply XY correction through XYZStage
  -> optionally verify residual drift once
  -> trigger or coordinate LabSpec6 Raman acquisition
  -> store point metadata, focus result, correction, and image references
```

Key design rule: mapping orchestration should depend on interfaces (`FrameProvider`, `ZStage`, `XYZStage`) and algorithm modules (`autofocus`, `calibration`), not on camera SDK or serial commands directly.

## Camera Control Routes

The project currently has two IDS camera routes:

| Route | Location | Purpose | Status |
| --- | --- | --- | --- |
| `pyueye` SDK | `microscope/` | GUI preview, snapshots, basic exposure control, integration with `FrameProvider` | Main working route |
| DirectShow/COM | `camera-activeX/` | Validate the IDS `uEyeCapture.ax` ActiveX/DirectShow path and capture one frame without `pyueye` | Experimental |

The DirectShow route is not a normal `win32com.client.Dispatch(...)` automation object. `uEyeCapture.ax` is exposed as a DirectShow COM filter, so the current script keeps Python as the orchestration layer and uses an embedded C# helper for `IUnknown`/vtable DirectShow calls. The capture graph is:

```text
IDS uEye source filter -> Sample Grabber -> Null Renderer
```

The current DirectShow capture script requests `RGB24`, runs the graph, reads one frame from `ISampleGrabber.GetCurrentBuffer()`, and writes a BMP. It does not yet set exposure, gain, resolution, frame rate, trigger mode, or pixel format.

For formal camera control, the next DirectShow interfaces to add are:

| Interface | Use |
| --- | --- |
| `IAMStreamConfig` | enumerate and set resolution, frame rate, and media subtype before `RenderStream()` |
| `IAMCameraControl` | exposure, focus, zoom, and other camera-control properties when supported by the driver |
| `IAMVideoProcAmp` | gain, brightness, contrast, gamma, white balance, and related video-processing properties |

Add these controls in a discover-first order: list supported formats and property ranges, then set only values inside the reported ranges. IDS-specific features such as hardware trigger, pixel clock, ROI, Mono12/Mono16, or advanced buffer control may require IDS uEye SDK / IDS peak SDK or vendor-specific DirectShow properties rather than the standard DirectShow interfaces.

## Autofocus Module

`autofocus/` is hardware-decoupled. It depends on:

| Interface | Meaning | Real implementation | Offline implementation |
| --- | --- | --- | --- |
| `FrameProvider` | provides timestamped frames | `microscope.acquisition.controller.AcquisitionController` | `tests.fakes.SyntheticFrameProvider` |
| `ZStage` | Z read/move/wait/stop | `stage.z_stage.ZStageController` | `tests.fakes.FakeZStage` |
| `FocusStrategy` | scores image sharpness in ROI | `autofocus.metrics.MetricStrategy` | same |

Single-point autofocus:

```text
run_single(roi, params)
  -> read current Z
  -> check Z safety limits
  -> coarse scan
  -> fine scan around coarse peak
  -> parabolic peak estimate
  -> backlash-compensated final move
  -> verify final score
  -> return FocusResult
```

For autofocus input, prefer uncompressed grayscale frames over compressed color formats. The practical priority is:

```text
Mono8 / Y800 / Y8
  -> best default for speed and robust sharpness metrics
Mono12 / Mono16
  -> useful for weak-contrast or low-light microscopy if the camera route exposes it
RGB24
  -> acceptable as a bridge; convert to grayscale or use the green channel before scoring
MJPEG / JPEG / H.264
  -> avoid for autofocus metrics because compression artifacts contaminate sharpness scores
```

During autofocus, keep exposure, gain, gamma, and white balance fixed. Automatic camera adjustments can distort the Z-score curve and move the best-focus estimate.

## XY Calibration Module

Sample tilt means Z autofocus can shift the field of view in XY. `calibration/` estimates and corrects that shift:

```text
reference image + current image
  -> ROI crop, grayscale, normalize, Hann window
  -> phase correlation gives PixelShift(dx, dy)
  -> PixelStageTransform.pixel_to_stage
  -> estimate_xy_correction returns inverse StageShift(dx_um, dy_um, dz_um=0)
  -> optional estimate_and_apply_xy_correction calls XYZStage.move_relative_um
```

`calibration/` contains math and adapters only. It does not directly own camera capture, serial communication, or LabSpec6 control.

## Docs

Use `docs/` for engineering notes that should not crowd this README:

- `docs/README.md`: documentation index.
- `docs/autofocus.md`: current Z autofocus algorithm, parameters, failure modes, and implementation notes.
- `docs/calibration.md`: current image-registration XY calibration algorithm, coordinate conventions, confidence checks, and implementation notes.
- `docs/labspec_activex_spectrum.md`: LabSpec worker bridge and spectrum request protocol.
- `docs/matrix_mapping_ui.md`: matrix mapping workflow, UI parameters, output layout, and test commands.
- `docs/raman_mapping_implementation_plan.md`: motion control, autofocus, position calibration, Raman mapping architecture, implementation phases, and current optimization priorities.

## Completed / Todo

Completed:

- IDS camera preview, snapshot, exposure control, and GUI entry point.
- Experimental IDS uEye DirectShow/COM capture path with device enumeration, graph smoke testing, and one-frame BMP capture.
- Z-stage serial controller with read, absolute move, relative move, wait, and stop.
- Generic stage abstractions: `StagePosition`, `StageShift`, `ZStage`, `XYZStage`.
- Offline `MemoryXYZStage` for mapping and calibration workflow simulation.
- Single-point autofocus: coarse scan, fine scan, parabolic fit, backlash compensation, confidence/status output.
- Image-based XY calibration: phase correlation, pixel/stage transform, inverse correction.
- Calibration-to-stage adapter: `estimate_and_apply_xy_correction`.
- Offline mapping skeleton: grid planning, focus-plane fitting, fake Raman acquisition, runner, and JSONL point records.
- Offline tests for autofocus, calibration, and stage abstractions.

Todo:

- Implement real XY-stage controller or adapter once the hardware command protocol is confirmed.
- Extend the DirectShow/COM camera route with `IAMStreamConfig`, `IAMCameraControl`, and `IAMVideoProcAmp` discovery and setters.
- Add a grayscale autofocus capture mode, preferably `Mono8`/`Y800` when exposed by the camera path.
- Extend `mapping/` with image-based XY correction, retry policies, resume support, and LabSpec6 coordination.
- Add GUI ROI selection, autofocus button, calibration status, and background worker integration.
- Add focus-plane fitting from anchors: `z = ax + by + c`.
- Add persistent run records under `docs/` or a structured output folder for calibration results and mapping logs.
- Add hardware loop tests for Z autofocus and XY correction with real microscope images.
