<!-- Generated: 2026-07-02 | Files scanned: 39 | Token estimate: ~930 -->

# Experiment Research Extension Codemap

Scope: `.pi/extensions/experiment-research`, the current LabAgents MVP rebuild for bounded Raman planning, simulation, and live-supervised execution.

```text
pi extension
  index.ts
    registers planner/operator/runtime tools
    injects EXPERIMENT_RESEARCH_PROMPT
    registers configured Raman Python runtime on session_start
      |
      v
  tools/{planner,operator,runtime}.ts
      |
      +--> planner: schemas + preview/preflight
      +--> operator: direct read-only/confirmed Raman runtime actions
      +--> runtime: proposal approval gate -> run-controller
              |
              v
          kernel/compile-units.ts -> ExecutionUnit[]
              |
              v
          kernel/run-controller.ts
              +--> runtime/simulation-runtime.ts
              +--> runtime/raman/live-runtime.ts
                         |
                         v
                 runtime/raman/python-runtime.ts -> raman_runtime_daemon.py
```

## Entry Points

- `.pi/extensions/experiment-research/index.ts`
  - default export `experimentResearchExtension(pi: ExtensionAPI)`
  - registers planner tools: `get_lab_capabilities`, `get_lab_state`, `validate_procedure_spec`, `run_preflight`
  - registers operator tools: `raman_get_hardware_status`, `raman_get_stage_position`, `raman_capture_frame`, `raman_run_autofocus`, `raman_acquire_smoke_spectrum`, `raman_stage_move_relative`
  - registers runtime tools: `propose_run`, `approve_and_start_run`, blocked `run_procedure`, `poll_run`, `pause_run`, `abort_run`
  - activates the tool surface and calls `registerConfiguredRamanPythonRuntime(ctx.cwd)` on `session_start`
- `.pi/extensions/experiment-research/package.json`
  - test command: `npm --prefix .pi/extensions/experiment-research test`

## Core Object Model

- `schemas/experiment-intent.ts`
  - `ExperimentIntent`: user objective/hypothesis/question/constraints; planning input, not kernel input
- `schemas/procedure-spec.ts`
  - `ProcedureSpec`: approved executable plan for `raman_single_point_probe`, `raman_parameter_search`, `raman_grid_mapping`
  - plans: `current_position`, `point_list`, `grid_scan`
  - semantic steps: `move_to_point`, `autofocus`, `capture_frame`, `acquire_spectrum`
  - limits: laser power, objective clearance, XYZ ranges
- `schemas/execution-unit.ts`
  - `ExecutionUnit`: compiled point-level unit with `positionRef`, `actions`, `limits`, `resumeKey`, `artifactScope`
- `schemas/run-state.ts`
  - `RunState`: kernel-owned lifecycle state: queued/running/paused/aborted/failed/completed, progress, current unit, heartbeat, artifacts
- `schemas/evaluation.ts`
  - Raman observation metrics, search envelope, explicit evaluation decision kinds

## Planner And Proposal Flow

- `planner/intent-builder.ts`
  - `buildExperimentIntent(input): ExperimentIntent`
- `planner/procedure-spec-builder.ts`
  - `buildProcedureSpec(input): ProcedureSpec`
  - `buildProcedureProposal(input): { spec, preview }`
  - `summarizeProcedureProposal(spec)` estimates runtime, risks, limits, save path, confirmation needs
- `planner/evaluate-good-enough.ts`
  - `evaluateRamanGoodEnough(...)` returns explicit accept / continue / operator-decision outcomes
  - `createSearchEnvelopeFromParameterSearch(...)` constrains bounded parameter search
- `tools/planner.ts`
  - capability/state reads stay planner-facing
  - `validate_procedure_spec` validates schema and preview
  - `run_preflight` checks required Raman roles, forbidden risks, and live runtime readiness/control availability
- `store/proposal-store.ts`
  - `createProcedureProposal`, `approveProcedureProposal`, `hashProcedureSpec`
  - approval freezes the exact `ProcedureSpec` hash before execution

## Execution

- `kernel/compile-units.ts`
  - `compileProcedureSpec(spec): ExecutionUnit[]`
  - expands `point_list`, `grid_scan` including snake order, and `current_position`
  - validates every compiled unit before returning
- `kernel/run-controller.ts`
  - `startSimulationRun`, `startLiveRamanRun`, `pollRun`, `pauseRun`, `abortRun`
  - owns in-memory active run registry and persisted `RunState`
  - executes units sequentially, updates progress, appends events, records artifacts
  - parameter search may stop early or pause for operator decision using explicit evaluation
  - mapping tracks completed/failed units and honors `maxConsecutiveFailures`
- `runtime/simulation-runtime.ts`
  - `runSimulationUnit(...)` creates deterministic fake artifacts and injectable failures/pauses
- `runtime/raman/live-runtime.ts`
  - `RamanLiveRuntime` contract: `preflight`, `stage`, `autofocus`, `frame`, `spectrometer`
  - `runLiveRamanUnit(...)` executes semantic actions through runtime resources and enforces hard limits

## Raman Runtime

- `runtime/raman/resources.ts`
  - typed resources: stage, frame provider, spectrometer; lease policy and motion limits
- `runtime/raman/actions.ts`
  - typed actions/results: stage move/get position, autofocus, frame capture, spectrum acquisition
- `runtime/raman/python-runtime.ts`
  - config resolution:
    `.pi/raman-lab-config/raman-runtime.local.json`
    > `.pi/raman-lab-config/raman-runtime.lab.json`
    > no live runtime
  - `RamanPythonDaemon` serializes JSON request/response actions to `raman_runtime_daemon.py`
  - lazy spawn, one-at-a-time hardware access, action timeout reset, idle shutdown
  - `createRamanPythonRuntime`, `registerConfiguredRamanPythonRuntime`, `shutdownRamanPythonDaemon`
- Python hardware entrypoint:
  - `.pi/raman-lab-config/hardware-python-driver/raman_runtime_daemon.py`

## Operator Tools

- `tools/operator.ts`
  - read-only/status: `raman_get_hardware_status`, `raman_get_stage_position`
  - frame/status actions: `raman_capture_frame`
  - confirmed effectful actions: `raman_run_autofocus`, `raman_acquire_smoke_spectrum`, `raman_stage_move_relative`
  - these call the registered Raman runtime directly and do not require a `ProcedureSpec`
  - motion and laser debug actions enforce local limits and confirmation gates

## Persistence

Source of truth is disk under `.pi/experiment-research/records`.

```text
.pi/experiment-research/records/
  experiments/<experimentId>/
    intents/<intentId>.json
    procedure-specs/<procedureSpecId>.json
  runs/<runId>/
    run-state.json
    events.jsonl
    artifacts.jsonl
    records/<procedureSpecId>/unit-*/
```

- `store/layout.ts`: all record paths
- `store/storage.ts`: JSON and JSONL helpers
- `store/intent-store.ts`: intent persistence
- `store/procedure-spec-store.ts`: frozen procedure spec persistence
- `store/run-store.ts`: run-state snapshots
- `store/event-store.ts`: run event log
- `store/artifact-store.ts`: artifact records

## Test Map

- `experiment-research-core-schemas.test.ts`: schema contracts
- `experiment-research-unit-compilation.test.ts`: `ProcedureSpec` -> `ExecutionUnit[]`
- `experiment-research-persistence-stores.test.ts`: records layout and stores
- `experiment-research-planner-proposal-flow.test.ts`: validate/preflight/propose/approve flow
- `experiment-research-simulation-runtime.test.ts`: simulation run lifecycle
- `experiment-research-good-enough-rules.test.ts`: Raman evaluation and bounded search decisions
- `experiment-research-raman-runtime-contract.test.ts`: live runtime contract behavior
- `experiment-research-operator-tools.test.ts`: runtime-backed operator tools
- `experiment-research-python-runtime-config.test.ts`: live config resolution/registration
- `experiment-research-raman-python-daemon.test.ts`: daemon transport
- `experiment-research-real-single-point-runtime.test.ts`: live-supervised single point path

## Development Rules

- Keep `ExperimentIntent`, `ProcedureSpec`, `ExecutionUnit`, and `RunState` boundaries separate.
- Add executable behavior through schema -> builder/preflight -> compile-units -> run-controller/runtime.
- Keep `tools/*.ts` thin: validate inputs, call planner/kernel/runtime, serialize results.
- Planner tools must not perform effectful hardware actions.
- Operator tools may call read-only runtime actions directly; effectful operator actions require explicit confirmation and hard limits.
- Live run execution must go through approved/frozen proposals, not direct `run_procedure`.
