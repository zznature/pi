# ISSUE-01: Real Raman V2 launch path must be self-consistent and planner-visible

Status note: historical issue, superseded for the current MVP branch by
`docs/experiment_extension/mvp_safety_contract.md` and
`assets/issues/CHECKLIST-safety-alignment-and-bridge-asserts.md`.

## Suggested metadata

- Type: Epic
- Priority: P0
- Milestone: M1 real-v2-launch-trust
- PR wave: PR1-PR2
- Labels: `area:runtime`, `area:prompt`, `area:planner`, `area:tooling`, `risk:safety`, `risk:operator-trust`, `risk:planner-misfire`, `blocks:mvp-lab-demo`
- Depends on: none
- Blocks: ISSUE-02, ISSUE-03

## Summary

The real Raman V2 launch path is currently inconsistent across preflight,
prompted planner knowledge, launch-time gate enforcement, and returned error
surface. The system must become self-consistent before further planner or Raman
workflow expansion.

## Problem

The observed lab session hit a deterministic launch failure that should have
been visible much earlier:

- `run_preflight` returned success
- the planner still lacked concrete first-run V2 bootstrap knowledge
- the planner emitted a `run_experiment` call that was guaranteed to fail
- runtime returned a misleading error code for a validation-evidence problem

This creates a `preflight/pass -> launch/fail` trust gap exactly where the
operator most needs the system to be explicit.

## Scope

This top-level issue merged the intent of:

- `ER-01`: mirror real Raman launch readiness in `run_preflight`
- `ER-02`: expose first-run bootstrap vs. `v2ValidationId` evidence handling to
  planner prompt and tool guidance
- `ER-03`: require the planner to branch before real V2 launch instead of
  issuing guaranteed-failure launch calls
- `ER-05`: return a dedicated readiness/validation-evidence error code instead of a
  misleading simulated-hardware code

## Why this matters

- Operators must be able to trust preflight signals before approving launch.
- The planner should know critical Raman V2 launch rules before calling tools,
  not learn them by hitting runtime failures.
- Error surfaces should preserve the actual cause so recovery logic and humans
  can respond correctly.

## Proposed implementation checklist

- Make `run_preflight` report launch-path backend executability for real Raman
  V2 runs, not only dry-run reachability.
- Reuse one shared Raman launch-readiness rule source between preflight and
  launch.
- Keep bootstrap / `v2ValidationId` / coordinate-audit evidence visible to the
  operator and planner as readiness or traceability metadata, without reviving
  them as MVP Raman launch blockers.
- Prevent the planner from calling `run_experiment` with a hardwareExecution
  preview that is already known to fail backend executability.
- Introduce or preserve operator-meaningful runtime error surfaces for
  readiness failures vs. damage-gate failures.

## Acceptance criteria

- A real `v2_bridge` Raman spec with backend-mismatched execution settings is
  visible as not launch-ready before the final launch attempt.
- The planner no longer emits the previously observed guaranteed-failure launch
  call shape.
- The system prompt and `run_experiment` tool guidance no longer teach
  traceability metadata as MVP launch blockers.
- Readiness failures are distinguishable from simulated-hardware failures and
  from bounded damage-gate failures.
- Regression coverage exists for the recorded session path.

## Relevant files

- `.pi/extensions/experiment-research/dispatch.ts`
- `.pi/extensions/experiment-research/prompt.ts`
- `.pi/extensions/experiment-research/tools/preflight.ts`
- `.pi/extensions/experiment-research/tools/run-experiment.ts`
- `.pi/extensions/experiment-research/schemas.ts`
- `.pi/extensions/experiment-research/test/raman-v2-validation.test.ts`
- `assets/agent_sessions/v2_test_session_with_encrypted_content_compressed.jsonl`

## Notes

- Keep the agent simple by fixing contract visibility first.
- Current MVP Raman contract is narrower than the earlier issue draft:
  backend executability plus the two bounded damage invariants are the launch
  gate; coordinate audit, bootstrap flags, and `v2ValidationId` remain
  readiness / traceability evidence.
