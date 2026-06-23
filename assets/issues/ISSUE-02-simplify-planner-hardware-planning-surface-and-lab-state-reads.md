# ISSUE-02: Simplify planner hardware planning surface and lab-state reads

## Suggested metadata

- Type: Improvement
- Priority: P1
- Milestone: M2 planner-surface-simplification
- PR wave: PR2-PR4
- Labels: `area:planner`, `area:prompt`, `area:tooling`, `risk:operator-trust`, `risk:planner-misfire`, `blocks:mvp-lab-demo`
- Depends on: ISSUE-01
- Blocks: none

## Summary

The planner surface should be simplified so the agent does not invent
placeholder hardware specs or repeatedly query a mixed static/dynamic lab-state
tool when the capability picture has not changed.

## Problem

The current planner surface encourages two kinds of avoidable complexity:

1. It can generate placeholder hardware specs before audited absolute
   coordinates exist.
2. It is nudged to re-call `get_lab_state` even when only static capability
   information is needed, despite the tool mixing mostly static capability data
   with dynamic active-run state.

Both behaviors add noise and create misleading readiness signals.

## Scope

This top-level issue merges the intent of:

- `ER-04`: planner must not generate placeholder hardware specs before audited
  absolute coordinates exist
- `ER-07`: split static lab capabilities from dynamic runtime state and reduce
  redundant `get_lab_state` calls

## Why this matters

- Placeholder hardware specs can look authoritative to operators while not
  actually representing the intended physical task.
- Mixed static/dynamic state tools make the planner noisier and harder to keep
  robust.
- A simpler planner surface reduces prompt burden and token waste.

## Proposed implementation checklist

- Update planner guidance so real hardware planning stops at parameter
  collection until operator-audited absolute coordinates exist.
- Remove the implicit invitation to probe real hardware readiness with invented
  coordinates.
- Clarify the contract boundary between:
  - static lab capabilities
  - dynamic run/activity state
- Either split `get_lab_state` semantics or restructure the returned shape and
  prompt guidance so repeated same-context calls are no longer the default.

## Acceptance criteria

- The planner no longer emits placeholder real-hardware specs before audited
  coordinates are provided.
- The planner asks for the minimum missing coordinate inputs rather than
  guessing them.
- Static capability reads and dynamic run-state reads are clearly separated in
  tool semantics and prompt usage.
- Same-context redundant `get_lab_state` usage is reduced by design rather than
  by ad hoc caching alone.

## Relevant files

- `.pi/extensions/experiment-research/prompt.ts`
- `.pi/extensions/experiment-research/index.ts`
- `.pi/extensions/experiment-research/lab-state.ts`
- `.pi/extensions/experiment-research/tools/lab-state.ts`
- `assets/agent_sessions/v2_test_session_with_encrypted_content_compressed.jsonl`

## Notes

- Keep the agent simple by shrinking ambiguity in the planning surface.
- Do not optimize with naive caching until the static/dynamic boundary is
  explicit.

