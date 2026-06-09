# Experiment Research Extension

This project-local extension implements the bounded experiment loop described in
`docs/pi_agent_experiment_research_adaptation.md`.

## Configuration

The extension is loaded from `.pi/extensions/experiment-research`. It registers
planner macro tools only:

- `get_lab_state`
- `get_experiment_state`
- `validate_experiment_spec`
- `run_preflight`
- `run_experiment`
- `analyze_run`
- `plan_next_experiment`

Operator tools are registered for out-of-band control and are not added to the
planner default active set:

- `pause_run`
- `abort_run`
- `request_operator`

## Capabilities

Capabilities are loaded from `capabilities.ts`.

- `simulation` uses fake stage, camera, and acquisition resources.
- `dry_run` probes the narrow hardware pilot capability without motion,
  acquisition, or power writes.
- `hardware` is limited to the MC.Newton XYZ stage pilot path.

Hardware execution requires a matching dry-run `specHash`, a capability
snapshot, and explicit operator approval.

## Operator Flow

1. Compile a bounded `ExperimentSpec`.
2. Run `validate_experiment_spec`.
3. Run `run_preflight`.
4. For hardware, review the dry-run report and record operator approval.
5. Run `run_experiment`.
6. Run `analyze_run`.
7. Run `plan_next_experiment`.
8. Compile the returned strategy into the next bounded `ExperimentSpec`.

The agent must not change run parameters while a run is active.

## Records

Each run writes:

- `run.json`
- `spec.json`
- `events.jsonl`
- `summary.json`
- `analysis.json`
- `resume.snapshot.json`
- `artifacts.json`
- `approvals.jsonl` for hardware

Experiment-level history is stored in:

- `experiment.json`
- `lineage.jsonl`
- `decisions.jsonl`

## Fake Experiment

Use `fixtures/valid-spec.json` for a complete simulation loop:

```text
validate_experiment_spec -> run_preflight -> run_experiment -> analyze_run -> plan_next_experiment
```

Use `fixtures/hardware-dry-run-spec.json` and `fixtures/hardware-spec.json` for
the memory-adapter hardware pilot path.

## CI Checks

Run focused tests after changing this extension:

```text
node --test .pi\extensions\experiment-research\phase4.test.ts
node --test .pi\extensions\experiment-research\phase5.test.ts
```

After code changes, run the repository check:

```text
npm run check
```
