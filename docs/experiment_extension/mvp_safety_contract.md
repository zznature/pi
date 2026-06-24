# MVP Raman Safety Contract

Status: active for `.pi/extensions/experiment-research`

## Purpose

This document is the canonical safety contract for the current Raman MVP launch
path. README, prompt guidance, planner tool guidance, launch dispatch, and
runtime bridge checks must all match this contract.

## Two damage invariants

The MVP launch path blocks only on the rules that directly bound irreversible
physical damage:

1. `objective_collision`
   - The executed Raman Z position must stay at or below
     `limits.motion.zUm.maxUm`.
2. `sample_burn`
   - The requested Raman laser power must stay at or below
     `limits.powerEnergy.maxLaserPowerMw`.

## Rule ownership

- `schemas.ts`
  - validates that the spec shape can express the bounded envelope.
- `records.ts`
  - computes the static damage-gate verdict from the two invariants above.
- `dispatch.ts`
  - blocks launch on backend executability plus the static damage gate.
  - does not treat approval, coordinate-audit, or V2-validation records as
    launch blockers for the MVP Raman path.
- `kernel/raman/v2-orchestrator.ts`
  - passes explicit autofocus Z guard bounds and optional target tolerance into
    runtime motion calls.
- `hardware_bridge_v2.py`
  - enforces the autofocus post-move runtime assertion using settled readback
    before frame capture or acquisition continues.

## Readiness vs traceability

The following metadata remains allowed, but it is not part of the MVP Raman
launch gate:

- `hardwareExecution.coordinateAuditId`
- `hardwareExecution.raman.v2ValidationId`
- `hardwareExecution.approval.*`

They are treated as readiness or traceability metadata, not as approval inputs
for the current MVP Raman launch path.

The following fields have been removed from the active MVP contract because
they carried misleading pseudo-safety semantics:

- `ExperimentSpec.operatorApprovalRequired`
- `limits.powerEnergy.maxExposureEnergyMj`
- `approval.ramanSafety.labSpecWorkerReady`
- `approval.ramanSafety.windowsPowerPolicyReady`
- `hardwareExecution.coordinateAuditExemption`

## Runtime autofocus postcondition

Whenever Raman autofocus moves Z through `stage.move_absolute`, the bridge must
reject the move if the settled readback:

- leaves the declared trusted bounded autofocus window; or
- misses the commanded Z target by more than the declared target tolerance when
  one is provided.

This runtime postcondition closes the blind spot left by startup-time static
validation.
