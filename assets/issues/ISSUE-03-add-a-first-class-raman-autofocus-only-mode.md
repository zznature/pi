# ISSUE-03: Add a first-class Raman autofocus-only mode

## Suggested metadata

- Type: Design + Feature
- Priority: P1.5
- Milestone: M3 raman-autofocus-model
- PR wave: PR3
- Labels: `area:schema`, `area:runtime`, `risk:planner-misfire`, `blocks:mvp-lab-demo`
- Depends on: ISSUE-01
- Blocks: none

## Summary

`ExperimentSpec` needs a first-class Raman autofocus-only mode so the system
can express "laser-assisted focus without spectrum acquisition" clearly and
consistently.

## Problem

The current system can omit `domain.raman.acquisition`, but it does not model
autofocus-only as a first-class Raman intermediate state. As a result, planner
and runtime reasoning must infer intent indirectly from a mix of:

- `domain.raman.autofocus`
- `limits.powerEnergy.maxLaserPowerMw`
- resource presence such as `lab-acquirer`
- absence of acquisition settings

That leaves a common Raman workflow under-expressed and makes it easy to create
confusing or contradictory specs.

## Scope

This top-level issue carries forward the intent of:

- `ER-06`: add a first-class Raman autofocus-only / laser-illumination mode to
  `ExperimentSpec`

## Why this matters

- "Autofocus-only, supervised, with laser illumination, no spectrum
  acquisition" is a normal Raman lab state.
- Prompt fixes will stay brittle if the data model itself is ambiguous.
- A first-class mode reduces planner guesswork and makes policy/runtime checks
  more coherent.

## Proposed ADR direction

Autofocus-only should be modeled as a bounded Raman operation, not as "Raman
acquisition minus some fields". The minimum ADR should define:

- autofocus-only allows laser illumination;
- autofocus quality is judged from laser spot size;
- bounded Z motion is allowed inside the declared autofocus window;
- spectrum acquisition is not allowed in this mode.

The ADR should also separate machine-readiness checks from operator damage
approval. For the current Raman MVP, user approval should be required only when
the system detects a material damage risk:

- `objective_collision`: autofocus Z motion cannot be proven to stay inside a
  trusted safe clearance envelope for the current sample/objective setup;
- `sample_burn`: requested laser power and cumulative exposure energy/dose
  exceed the safe autofocus or acquisition envelope for the sample/run.

Everything else is a machine-readiness or runtime-diagnostic concern and should
not trigger user approval:

- LabSpec worker reachability;
- Windows power-policy state;
- camera/frame bridge reachability;
- stage/file-bridge health;
- autofocus failure states such as no peak, low confidence, or out-of-range.

Those conditions should fail preflight or runtime with explicit diagnostics, but
they should not ask the operator to "approve" a non-damaging problem.

### Approval semantics

- safe autofocus-only hardware runs may execute without user approval when:
  - autofocus Z motion stays inside a trusted bounded window;
  - requested laser power and cumulative exposure energy stay inside the
    autofocus-safe envelope;
  - no spectrum acquisition is requested;
- if a damage risk is present, ask only for the relevant confirmation:
  - collision risk -> clearance / safe-Z confirmation;
  - burn risk -> laser power + dose/energy confirmation;
- non-safety booleans such as `labSpecWorkerReady` and
  `windowsPowerPolicyReady` should move out of operator `ramanSafety` and into
  preflight/readiness evidence.

### Schema direction

Prefer an explicit first-class Raman operation intent such as:

- `autofocus_only`
- `autofocus_then_acquire`
- `acquire_only`

instead of inferring autofocus-only from the absence of acquisition settings.
This keeps planner intent, runtime execution, and safety gates aligned.

## Proposed implementation checklist

- Write a short ADR defining:
  - autofocus-only semantics as laser-spot-size focusing without spectrum
    acquisition;
  - a 2-risk approval model (`objective_collision`, `sample_burn`);
  - `sample_burn` as a dose/energy gate, not a pure power gate;
  - separation of readiness failures from damage approvals.
- Extend `ExperimentSpec` so autofocus-only intent is explicit.
- Decouple "laser illumination required" from "spectrum acquisition required".
- Extend Raman safety limits/confirmations so cumulative exposure energy is a
  first-class validated gate alongside laser power.
- Move non-damaging readiness fields out of operator approval payloads.
- Update policy/runtime so approval is derived from damage risk, not from
  hardware mode in general.
- Update validation, policy, runtime behavior, fixtures, and docs to support
  the new state cleanly.

## Acceptance criteria

- A spec can explicitly represent Raman autofocus-only with laser illumination,
  laser-spot-size focus scoring, and without spectrum acquisition.
- Validation and policy separate:
  - readiness failures that should stop execution directly;
  - damage risks that should request targeted operator approval.
- Autofocus-only does not require user approval when the run stays inside the
  trusted Z window and autofocus-safe power/dose envelope.
- Approval is requested only when the run presents one of the two bounded MVP
  damage risks:
  - objective collision risk;
  - over-power or over-dose sample burn risk.
- Runtime and run records can distinguish autofocus-only from acquisition runs.
- Fixtures and tests cover:
  - autofocus-only without approval
  - autofocus plus acquisition
  - autofocus-only with collision-risk approval required
  - autofocus-only with over-power approval required
  - invalid mixed/contradictory states

## Relevant files

- `.pi/extensions/experiment-research/schemas.ts`
- `.pi/extensions/experiment-research/policy.ts`
- `.pi/extensions/experiment-research/preflight.ts`
- `.pi/extensions/experiment-research/records.ts`
- `.pi/extensions/experiment-research/kernel/raman-v2-orchestrator.ts`
- `.pi/extensions/experiment-research/fixtures`
- `.pi/extensions/experiment-research/test`

## Notes

- Keep this as a separate top-level issue; it is a model change, not just a
  planner cleanup.
- Do not paper over missing semantics with more prompt instructions.
- The existing `limits.powerEnergy.maxExposureEnergyMj` field should become a
  real semantic and hardware-gate check rather than remaining optional dead
  metadata.
- Autofocus-only may still need an explicit focus illumination budget field if
  the laser-on dwell during focusing cannot be derived from existing Raman
  settings.
