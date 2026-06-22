# Lab Test Tasks: Raman Mapping on Superconducting Thin Film

This directory defines per-task lab validation tasks for using pi-agent to run Raman mapping on a superconducting thin film grown on a silicon wafer.

The intended sample is:

- Substrate: silicon wafer.
- Film: superconducting thin film.
- Primary safety concern: laser heating or damaging the film.
- Primary reference signal: Si substrate Raman peak near 520.7 cm-1 when visible.
- Film-specific Raman targets: operator-supplied, because they depend on the superconducting material, thickness, oxidation state, and substrate visibility.

## Execution Model

Use pi-agent only through bounded experiment tools:

```text
compile task inputs into ExperimentSpec
  -> validate_experiment_spec
  -> run_preflight
  -> operator review and approval for hardware
  -> run_experiment
  -> poll_run while hardware run is active
  -> analyze_run
  -> plan_next_experiment only after analysis
```

Do not ask the agent to directly move stage axes, open shutters, change laser power, focus continuously, or edit parameters during an active run.

## Task Order

Run the tasks in this order:

1. [task-00-shared-inputs-and-safety.md](task-00-shared-inputs-and-safety.md)
2. [task-01-readonly-preflight.md](task-01-readonly-preflight.md)
3. [task-02-minimum-raman-run.md](task-02-minimum-raman-run.md)
4. [task-03-autofocus-xy-validation.md](task-03-autofocus-xy-validation.md)
5. [task-04-small-area-mapping.md](task-04-small-area-mapping.md)
6. [task-05-failure-recovery.md](task-05-failure-recovery.md)

Only task 04 is the first real mapping task. Tasks 01-03 exist to keep the mapping run diagnosable and reversible.

## Global Pass Criteria

A task passes only if:

- The executed spec is saved under `.pi/experiment-runs`.
- Hardware execution references a matching dry-run preflight report.
- Operator approval records confirmed Raman laser power.
- Every point has position metadata and either a spectrum artifact or a structured error.
- `analyze_run` is executed before any next run is planned.
- Abort or failure leaves the system in a state where the operator can inspect partial records.

## Recommended Initial Envelope

Start conservatively until the film damage threshold is known:

| Parameter | Initial value |
| --- | --- |
| Laser power at sample | 0.1-0.5 mW |
| Integration time | 0.2-0.5 s |
| Accumulations | 1 |
| Mapping area | <= 10 um x 10 um |
| Grid | 3 x 3 for first real film mapping |
| Max consecutive errors | 2 |
| Stop on error | true for first hardware tasks |

Longer exposure or higher power is a follow-up experiment, not an ad-hoc change during a run.

