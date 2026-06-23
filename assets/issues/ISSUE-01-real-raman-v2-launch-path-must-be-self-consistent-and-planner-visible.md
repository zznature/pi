# ISSUE-01: Real Raman V2 launch path must be self-consistent and planner-visible

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

This top-level issue merges the intent of:

- `ER-01`: mirror the real Raman V2 evidence gate in `run_preflight`
- `ER-02`: inject first-run bootstrap vs. `v2ValidationId` knowledge into the
  planner prompt and tool guidance
- `ER-03`: require the planner to branch before real V2 launch instead of
  issuing guaranteed-failure launch calls
- `ER-05`: return a dedicated validation-evidence error code instead of a
  misleading simulated-hardware code

## Why this matters

- Operators must be able to trust preflight signals before approving launch.
- The planner should know critical Raman V2 launch rules before calling tools,
  not learn them by hitting runtime failures.
- Error surfaces should preserve the actual cause so recovery logic and humans
  can respond correctly.

## Proposed implementation checklist

- Make `run_preflight` report launch-path readiness for real Raman V2 runs, not
  only dry-run reachability.
- Reuse one shared Raman V2 gate rule source between preflight and launch.
- Inject an explicit first-run rule:
  - first supervised real V2 run may use bootstrap approval
  - later real V2 runs must provide `hardwareExecution.raman.v2ValidationId`
- Prevent the planner from calling `run_experiment` for real V2 launch until
  that branch is resolved.
- Introduce a dedicated error code for Raman V2 validation-evidence failures.

## Acceptance criteria

- A real `v2_bridge` Raman spec with missing V2 validation evidence is visible
  as not launch-ready before the final launch attempt.
- The planner no longer emits the previously observed guaranteed-failure launch
  call shape.
- The system prompt and `run_experiment` tool guidance explicitly teach the
  bootstrap vs. `v2ValidationId` branch.
- Validation-evidence failures are distinguishable from simulated-hardware
  failures.
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
- Do not push more domain branching into prompt text than necessary once the
  runtime and preflight contract are aligned.

