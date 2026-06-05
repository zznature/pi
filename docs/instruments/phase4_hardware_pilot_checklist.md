# Phase 4 Hardware Pilot Operator Checklist

Narrow stage-only hardware pilot for the `experiment-research` extension. Scope: the
MC.Newton XYZ stage (`mc-newton-xyz-stage`), motion only, at most 4 explicit points.
No camera, no Raman acquisition, no laser, no LLM parameter changes during a run.

## Preconditions

- [ ] MC.Newton controller powered on and connected; note the serial port (e.g. `COM5`).
- [ ] `python` on PATH with `pyserial` installed (`python -c "import serial"`).
- [ ] Stage is homed/calibrated and the work area around the target points is clear.
- [ ] Stage software limits in the spec are inside the safe physical envelope.

## Spec preparation

The hardware gate requires that the *same* `ExperimentSpec` (ignoring only `mode` and
`operatorApprovalRequired`) already passed a `dry_run` preflight. Keep the hardware spec
and its dry-run twin byte-identical apart from those two fields.

- Hardware spec fixture: `.pi/extensions/experiment-research/fixtures/hardware-spec.json`
- Matching dry-run twin: `.pi/extensions/experiment-research/fixtures/hardware-dry-run-spec.json`

## Procedure

1. Validate the hardware spec: `validate_experiment_spec(spec=<hardware-spec>)`.
2. Dry-run preflight on the twin: `run_preflight(spec=<dry-run-spec>)`.
   Record the returned `reportId` (e.g. `dry_run-preflight-0001`).
3. Confirm the dry-run readiness report: adapter reachable, calibration present,
   limits satisfied, output/intents/approval paths writable, abort path present.
4. Operator approval: decide approve/deny. If approving, fill the `approval` block:
   - `approvalId`, `operator`, `approved: true`
   - `dryRunReportId` = the `reportId` from step 2
   - `operatorOnlyMonitoring: true` only if running without the automated watchdog
5. Run the pilot:
   ```
   run_experiment(
     spec=<hardware-spec>,
     hardwarePilot={
       stageAdapter: "mc_newton_xyz",
       stagePort: "<COM port>",
       settleTimeoutMs: 5000,
       heartbeatTimeoutMs: 15000,
       maxConsecutiveErrors: 2,
       approval: { ... }
     }
   )
   ```
6. Watch the run. To stop safely, append an intent (the kernel reads it at the next
   point boundary): `abort_run(runId, reason)` or `pause_run(runId, reason)`.

## Safe stop and resume

- `stopOnError: true` stops the run on the first point error.
- The watchdog aborts on heartbeat timeout or `maxConsecutiveErrors` consecutive errors.
- Resume only from the last completed point: `run_experiment(spec, resumeFrom="<index>")`,
  where `<index>` is the next point index to run. Re-approval still applies.

## Records (every hardware run)

Under `.pi/experiment-runs/runs/<runId>/`:

- `spec.json` — exact executed spec
- `events.jsonl` — per-point started/completed/error + run start/stop/summary
- `intents.jsonl` — operator pause/abort/request_operator intents
- `summary.json` — completion status and completed point count
- `approvals.jsonl` — recorded operator approval and spec hash

## Abort criteria (stop immediately)

- Unexpected stage motion or audible/visual collision risk.
- Position readback diverges from commanded target beyond tolerance.
- Any instrument outside the stage appears to actuate.
