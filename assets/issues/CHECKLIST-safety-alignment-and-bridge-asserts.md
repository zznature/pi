# Safety Contract Alignment and Runtime Bridge Assertions Checklist

## Goal

Solve two linked problems before further Raman MVP simplification:

1. the safety contract is inconsistent across docs, prompt, schema, tool
   guidance, dispatch, and tests;
2. autofocus Z motion relies on startup-time/static checks without a runtime
   bridge-side assertion that the executed motion stayed inside the declared
   safe envelope.

## Required invariants

This checklist assumes the implementation converges on these two invariants:

1. **Damage approval is derived from damage risk only.**
   For the current Raman MVP, the only approval-triggering risks are:
   - `objective_collision`
   - `sample_burn`
2. **Runtime motion must prove it stayed inside the declared safe envelope.**
   Static plan validation is necessary but not sufficient; the bridge must
   reject autofocus motion that settles outside the declared trusted Z window
   or outside the commanded target tolerance.

## Non-goals

- Do not expand the planner surface while fixing this.
- Do not add more prompt exceptions as a substitute for a coherent contract.
- Do not remove traceability tooling such as coordinate audits or validation
  records unless a separate change explicitly removes them.
- Do not treat machine-readiness failures as operator approvals.

## Phase 0: Lock the contract before refactoring

- [x] Add a short ADR under `docs/` that defines:
  - damage risk vs. readiness failure;
  - the two MVP damage risks;
  - which layer is authoritative for each rule;
  - what runtime postcondition the bridge must enforce for autofocus motion.
- [x] Name one canonical contract owner for code, for example a dedicated
  safety-policy module or one ADR-backed policy definition.
- [x] Freeze terminology so the same words mean the same thing everywhere:
  - `approval`
  - `readiness`
  - `objective_collision`
  - `sample_burn`
  - `trusted bounded window`
  - `target tolerance`
- [x] Decide the status of these existing fields:
  - `operatorApprovalRequired`
  - `ramanSafety.labSpecWorkerReady`
  - `ramanSafety.windowsPowerPolicyReady`
  - `limits.powerEnergy.maxExposureEnergyMj`
  - `hardwareExecution.coordinateAuditId`
  - `hardwareExecution.raman.v2ValidationId`
- [x] Write down which of those are:
  - approval inputs;
  - readiness evidence;
  - traceability-only metadata;
  - dead or misleading fields to remove.

### Phase 0 acceptance

- [x] One written contract exists and it is specific enough that prompt,
  dispatch, README, and tests can be updated mechanically from it.
- [x] No open ambiguity remains about whether coordinate audit / V2 validation /
  worker health are approval gates, readiness gates, or optional traceability.

## Phase 1: Add failing regressions before changing behavior

- [x] Add a regression test showing the current contract drift:
  - docs/README says one thing;
  - prompt/tool guidance says another;
  - `dispatch` enforces a third combination.
- [x] Add a regression test for runtime autofocus overshoot:
  - command target is inside the allowed Z window;
  - stage/bridge readback settles outside the window;
  - run must fail before frame capture or spectrum acquisition continues.
- [x] Add a regression test for target-settle tolerance failure:
  - readback stays inside the coarse safe window;
  - readback is still outside commanded target tolerance;
  - bridge must raise a movement error instead of silently continuing.
- [x] Add a regression test that machine-readiness failures do **not** become
  approval requests once the new contract is in place.

### Suggested test files

- `.pi/extensions/experiment-research/test/phase7.test.ts`
- `.pi/extensions/experiment-research/test/raman-dose-energy-gate.test.ts`
- `.pi/extensions/experiment-research/test/raman-v2-orchestrator.test.ts`
- `.pi/extensions/experiment-research/test/raman-v2-hardware-run.test.ts`

### Phase 1 acceptance

- Historical note: these acceptance checks were intended to prove the pre-fix
  baseline on old `main`. The repaired branch cannot meaningfully keep them as
  live checkboxes without preserving a separate pre-fix reference branch.

## Phase 2: Align the contract surface end to end

### 2A. Documentation and prompt alignment

- [x] Update `.pi/extensions/experiment-research/README.md` so it matches the
  chosen contract exactly.
- [x] Update `.pi/extensions/experiment-research/prompt.ts` to stop teaching a
  contradictory launch model.
- [x] Update `.pi/extensions/experiment-research/tools/planner.ts` prompt
  guidelines so `run_preflight` and `run_experiment` describe the same gates as
  runtime.
- [x] Update relevant lab test docs under `docs/experiment_extension/` so
  operator instructions match actual runtime semantics.

### 2B. Schema and policy cleanup

- [x] Reclassify readiness-only booleans out of operator approval payloads if
  the chosen contract says they are not approval data.
- [x] Make `operatorApprovalRequired` either:
  - derived from damage risk; or
  - removed from user-authored spec shape.
- [x] Ensure `limits.powerEnergy.maxExposureEnergyMj` is either:
  - enforced as a real gate; or
  - explicitly removed/deferred with no fake semantics left behind.
- [x] Keep `hashExperimentSpec()` normalization consistent with the chosen
  contract so spec parity does not depend on presentation-only flags.

### 2C. Dispatch and gate alignment

- [x] Split launch checks into explicit buckets in `dispatch.ts`:
  - backend executability;
  - readiness evidence;
  - damage gates;
  - traceability-only checks.
- [x] Ensure `run_preflight` and `run_experiment` use the same named rule set,
  rather than separate hand-maintained rule copies.
- [x] Make error codes and summaries reveal the correct class of failure:
  - readiness not met
  - approval missing
  - damage gate exceeded
  - runtime bridge assertion failed
- [x] Confirm that planner-visible warnings from `run_preflight` match what
  `run_experiment` will later enforce.

### Suggested files

- `.pi/extensions/experiment-research/prompt.ts`
- `.pi/extensions/experiment-research/tools/planner.ts`
- `.pi/extensions/experiment-research/dispatch.ts`
- `.pi/extensions/experiment-research/policy.ts`
- `.pi/extensions/experiment-research/schemas.ts`
- `.pi/extensions/experiment-research/records.ts`
- `.pi/extensions/experiment-research/run-store.ts`
- `docs/experiment_extension/pi_agent_experiment_research_adaptation.md`

### Phase 2 acceptance

- [x] README, prompt, tool guidance, dispatch, and tests all describe the same
  launch model.
- [x] There is no remaining place where "optional" in docs is "required" in
  runtime, or vice versa.

## Phase 3: Add runtime bridge assertions for autofocus Z motion

### 3A. Pass explicit guard data into runtime moves

- [x] Compute the declared autofocus safe Z window at the TS orchestrator layer.
- [x] Pass guard parameters with each autofocus `stage.move_absolute` call, for
  example:
  - `zGuardMinUm`
  - `zGuardMaxUm`
  - `targetToleranceUm`
- [x] Pass the same guard parameters for the final "move to best focus" step.

### 3B. Enforce postconditions inside the Python bridge

- [x] In `hardware_bridge_v2.py`, after motion settles and before returning:
  - read back actual position;
  - if `zGuardMinUm` / `zGuardMaxUm` are provided, assert readback Z is inside
    that closed interval;
  - if commanded `zUm` and `targetToleranceUm` are provided, assert absolute
    error is within tolerance.
- [x] Raise a typed `BridgeError` when the postcondition fails.
- [x] Map failures to operator-meaningful runtime errors:
  - outside guard window -> `autofocus_out_of_range`
  - outside settle tolerance -> `stage_command_error` or a tighter dedicated
    code if introduced
- [x] Ensure failure happens before downstream frame capture, focus scoring, XY
  correction, or spectrum acquisition.

### 3C. Persist evidence for diagnosis

- [x] Emit bridge events that record:
  - commanded Z target;
  - declared safe window;
  - target tolerance;
  - settled readback;
  - assertion failure code/message when applicable.
- [x] Surface the same fields in run events or resume snapshots when useful for
  post-mortem analysis.

### Suggested files

- `.pi/extensions/experiment-research/kernel/raman/v2-orchestrator.ts`
- `.pi/extensions/experiment-research/hardware_bridge_v2.py`
- `.pi/extensions/experiment-research/kernel/raman/run.ts`

### Phase 3 acceptance

- [x] A bridge-side autofocus overshoot is detected even when the original plan
  was schema-valid and launch-valid.
- [x] No autofocus frame or acquisition step proceeds after a post-move guard
  failure.

## Phase 4: Reconcile autofocus-only semantics with the aligned safety model

- [x] Add explicit Raman operation intent if `ISSUE-03` proceeds:
  - `autofocus_only`
  - `autofocus_then_acquire`
  - `acquire_only`
- [x] Tie approval derivation to actual requested operation intent.
- [x] Make autofocus-only runs eligible for "no approval needed" only when:
  - runtime Z motion stays inside the trusted bounded window;
  - requested laser power and cumulative dose stay inside configured envelope;
  - no acquisition is requested.
- [x] Keep readiness failures as readiness failures, not pseudo-approvals.

### Phase 4 acceptance

- [x] Autofocus-only is no longer inferred indirectly from missing acquisition
  fields.
- [x] Approval/no-approval behavior is deterministic from spec intent plus
  computed risk.

## Recommended PR slicing

Informational only; these were suggested review slices while the work was in
flight, not branch-state completion gates:

- **PR1:** ADR + failing regressions for contract drift and bridge guard
  absence.
- **PR2:** prompt/docs/dispatch/schema alignment to one contract.
- **PR3:** bridge guard payload + Python assertion + runtime error mapping.
- **PR4:** autofocus-only model cleanup and approval derivation polish.

## Done definition

- [x] A new engineer can read one contract description and predict both
  `run_preflight` and `run_experiment` behavior correctly.
- [x] The planner is no longer taught a different launch model than runtime.
- [x] A bridge or stage bug that moves autofocus Z outside the declared safe
  envelope is caught at runtime before the workflow continues.
- [x] Regression coverage exists for both the semantic-alignment failure mode
  and the runtime-assertion failure mode.

## Verification notes

- [x] Focused regression batch passes on the current branch:
  - `node --test test/raman-operation-intent.test.ts test/raman-v2-orchestrator.test.ts test/raman-v2-hardware-run.test.ts test/raman-v2-bridge-asserts.test.ts test/phase7.test.ts test/raman-v2-validation.test.ts test/planner-surface.test.ts test/safety-contract-alignment.test.ts`
- [x] Repository-wide static checks pass:
  - `npm run check`
- [x] Remaining non-checkbox notes in Phase 1 / PR slicing are intentionally
  historical or informational, not open implementation work on this branch.
