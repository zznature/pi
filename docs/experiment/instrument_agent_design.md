# Instrument-orchestration Agent Architecture

This document specifies how laboratory instruments are exposed to an Agent
Harness for automated experimentation. The first demo target is automated Raman
mapping, but the design should generalize to any experiment where a deterministic
kernel executes one bounded run while an LLM agent decides what to run next.

In scope:

- How the agent calls instruments: tools, schema, audit.
- How a single run executes deterministically and safely.
- How a non-LLM watchdog provides live safety without sitting in the LLM loop.
- How experiment results feed back into the next agent decision.

Out of scope:

- Real-time LLM intervention inside a running experiment.
- Hardware drivers themselves; they live in domain packages.
- LLM prompt engineering specifics.

## Core principles

The design rests on five ideas. Later sections expand each one.

1. **Protocol -> Tool.** Existing module Protocols (`XYZStage`, `FrameProvider`,
   `RamanAcquirer`, ...) are wrapped, not replaced, into agent-callable Tools.
   The wrapper adds JSON-Schema validation, a policy gate, and an audit record.

2. **Agent operates between bounded runs, not within.** A bounded run (one
   Raman mapping, one calibration sweep) executes deterministically with no LLM
   in the loop. The agent plans the run, reads records after it finishes, and
   proposes the next bounded run. Real-time LLM intervention during a running
   experiment is explicitly out of scope.

3. **Three-tier separation.** Deterministic kernel (`MappingRunner` and peers)
   + non-LLM watchdog (rule-based safety monitor) + agent advisor (LLM, off the
   hot path). The kernel must reach a safe state even when the watchdog and
   the agent are both offline.

4. **`ExperimentSpec` is the only thing the kernel executes.** Free-text agent
   output is compiled into a typed `ExperimentSpec` and validated by the policy
   gate before any hardware command. Free text never reaches an adapter.

5. **Harness-neutral via JSON-Schema.** Claude tool-use, OpenAI function
   calling, and MCP consume the same tool definitions. The harness binding is
   a thin adapter; the tool layer underneath does not change when the harness
   changes.

## System architecture

```text
+------------------------------------------------------------------+
|   Agent runtime  (LLM, off the hot path)                         |
|   research planner | protocol compiler | safety reviewer         |
|   data analyst                                                   |
+----------------------------+-------------------------------------+
                             | dispatch(tool_name, params)
                             v
+------------------------------------------------------------------+
|   Gateway                                                        |
|   single entry; routes to one ToolCall                           |
|                                                                  |
|   +------------------------------------------------------------+ |
|   |  Middleware chain  (schema -> safety -> audit -> adapter)  | |
|   +------------------------------------------------------------+ |
+----------------------------+-------------------------------------+
                             | ToolResult
                             v
+------------------------------------------------------------------+
|   Deterministic kernel                                           |
|   MappingRunner | AutofocusController | calibration math         |
|                                                                  |
|   appends                                                        |
|   v                                                              |
|   events.jsonl    --- tail -->  Watchdog (non-LLM)               |
|                                       |                          |
|   polls                               | append                   |
|   v                                   v                          |
|   intents.jsonl   <--- append --- Operator UI                    |
+----------------------------+-------------------------------------+
                             |
                             v
+------------------------------------------------------------------+
|   Adapters: stage / microscope camera / LabSpec6                 |
|   live in raman/stage, raman/microscope, raman/mapping/labspec   |
+------------------------------------------------------------------+
```

| Component       | Responsibility                                         | Owns                       |
| --------------- | ------------------------------------------------------ | -------------------------- |
| Agent runtime   | Plans and analyzes between bounded runs                | Prompts, LLM client        |
| Gateway         | Single dispatch entry, routes to one tool              | Tool registry lookup       |
| Middleware      | Cross-cutting validation, safety, audit                | None (composable)          |
| Kernel          | Per-point execution, hardware sequencing               | All hardware commands      |
| Watchdog        | Live rule-based monitoring                             | Events tail, intent emit   |
| Adapters        | SDK / serial / file integration                        | Driver state               |

Dependency arrow points upward only. Hardware adapters never import from
`agent_harness/`.

## Action space

The action space splits by granularity. Macro is the only layer the planner
agent calls; medium and micro sit on the same gateway but are caller-gated.

| Layer  | Examples                                                                  | Callable by                | Why this layer                                                  |
| ------ | ------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------- |
| Macro  | `run_raman_mapping(spec)`, `analyze_run(id)`, `plan_next_experiment` | Agent (default, exclusive) | A run takes hours; LLM round-trip must not happen inside        |
| Medium | `pause_run(id)`, `abort_run(id)`, `request_operator(reason)`              | Watchdog and Operator UI   | High-risk, must react faster than an LLM round-trip             |
| Micro  | `move_z(um)`, `snap_image()`, `serial_send(cmd)`                          | Operator maintenance       | Debugging only; not in agent registry                           |

Rationale: macro-tools are appropriate exactly when round-trip overhead is the
dominant cost; that is the default condition for instrument experiments.

## Communication: channels, gateway, middleware

### Three channels

- **Events channel** -- `events.jsonl`, append-only by kernel, tailed by
  watchdog, read post-run by agent. Single source of truth for what happened.
- **Intents channel** -- `intents.jsonl`, written by operator and watchdog,
  polled by kernel only at safe boundaries (between mapping points). Carries
  pause / abort / request_operator messages.
- **Tool channel** -- synchronous request/response between agent and gateway.
  Every call returns a bounded `ToolResult`; no "wait forever" tools exist.

First implementation uses in-process queues for events and intents. Switch to
JSONL files only when watchdog or agent live in separate processes. The
interface stays the same.

### Gateway

```python
def dispatch(tool_name: str, params: dict, ctx: Session) -> ToolResult:
    tool = registry.get(tool_name)
    if tool is None:
        return ToolResult.error(
            summary=f"unknown tool: {tool_name}",
            next_actions=["call list_tools() to see available tools"],
            error_code="tool_not_found",
        )
    return MIDDLEWARE_CHAIN.invoke(tool, params, ctx)
```

`dispatch` is stateless. State lives in `ctx: Session` (run id, budget
counters, instrument registry handle, recorders). This lets tests pass fake
sessions without monkey-patching globals.

### Middleware chain (MVP)

Three stages, composable; each may short-circuit with a typed `ToolResult`.

```text
schema_validate  ->  safety_policy  ->  audit  ->  adapter
```

| Stage             | Purpose                                       | Example short-circuit                |
| ----------------- | --------------------------------------------- | ------------------------------------ |
| `schema_validate` | Match JSON-Schema for the tool                | "params.x_um is not a number"        |
| `safety_policy`   | Limits, approvals, capability state           | "X 12000um exceeds limit 5000um"     |
| `audit`           | Write events.jsonl pre/post entries           | Never short-circuits                 |

Order is intentional: cheap checks first, side effects last. Capability check
and budget guard are deferred until a concrete second tool needs them;
premature isolation produces catch-all middleware.

## Contracts

### ToolCall

```python
class ToolCall(Protocol):
    name: str
    input_schema: dict
    output_schema: dict

    def execute(self, params: dict, ctx: Session) -> ToolResult: ...
```

### ToolResult

Satisfies the agent observation contract (status / summary / next_actions /
artifacts) and the audit needs at the same time:

```python
@dataclass(frozen=True)
class ToolResult:
    status: Literal["success", "warning", "error"]
    summary: str
    next_actions: list[str]
    artifacts: list[ArtifactRef]

    command_id: str
    state_before: dict
    state_after: dict
    started_at: float
    finished_at: float

    error_code: str | None = None
    retry_safe: bool | None = None
    stop_condition_met: bool = False
```

Recovery contract: every `status == "error"` result must populate `error_code`,
`retry_safe`, and at least one `next_actions` entry. This lets the agent
distinguish "retry as is", "change strategy", and "stop".

### ExperimentSpec

Typed compilation target for agent output. Hardware never sees free text.

Minimum fields:

- `sample_id`
- `objective` and expected observable
- `allowed_instruments`
- `motion_limits_um`
- `laser_power_limit`
- `acquisition_time_limit_s`
- `grid` or point list
- `focus_strategy`
- `xy_correction_policy`
- `raman_acquisition_params`
- `stopping_rules`
- `watchdog_thresholds` (focus drop, error streak, heartbeat timeout)
- `operator_approval_required`

### InstrumentDescriptor

Each adapter registers a capability card at startup:

- Stable instrument id
- Supported commands
- Units and coordinate convention
- Software limits
- Required preconditions
- Estimated duration
- Hazards
- Simulation availability
- Calibration dependencies

The agent plans against capability cards. The middleware validates against
live state before each command.

## Agent roles

Use several small agents or agent modes instead of one free-form lab agent.

| Role              | Responsibility                                                                     | Calls hardware tools  |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------- |
| Research planner  | Converts scientific goal into experiment plan, stopping criteria, analysis metrics | No                    |
| Protocol compiler | Converts the plan into a typed `ExperimentSpec`                                    | No                    |
| Safety reviewer   | Reviews `ExperimentSpec` before approval; checks limits and abnormal preconditions | No                    |
| Data analyst      | Parses spectra / images after a run, computes metrics, plans the next bounded run | No                    |
| Watchdog          | Rule-based, non-LLM. Monitors live event log; can pause / abort but not re-plan    | Pause / abort only    |

There is no "run supervisor" agent. Per-point execution is owned by the
deterministic kernel; live monitoring is owned by the watchdog. The LLM-driven
roles can be separate prompts around the same runtime; they do not need to be
separate processes. The watchdog runs as a separate process so it survives LLM
and harness failures.

## Watchdog

The watchdog tails the events channel and may emit `pause`, `abort`, or
`request_operator` intents. It exists because:

- Most real failure modes during long runs are mundane: vibration, sample
  drift, LabSpec file locks, dropped camera frames. None benefit from LLM
  reasoning.
- LLM round-trip latency and cost are too high for per-point monitoring.
- The watchdog must keep working when the LLM is offline or rate-limited.

Trigger rules are deterministic and cheap; thresholds come from
`ExperimentSpec.watchdog_thresholds`:

- N consecutive `stage_error` or `frame_error` events.
- Focus score drops below a configured fraction of the run baseline.
- Kernel heartbeat stops for longer than the configured interval.
- An operator-issued file requests abort.

Watchdog actions are limited to `pause`, `abort`, and `request_operator`. It
does not adjust experiment parameters or issue new motion commands. Adaptive
re-planning belongs to the agent and happens between bounded runs.

## Safety model

Safety policy enforces these rules even if the agent or operator requests an
unsafe command:

1. No movement outside configured axis limits.
2. No laser or acquisition command without confirmed shutter and power state.
3. No autofocus scan outside Z limits.
4. No XY correction above a configured maximum displacement.
5. No repeated retry after the same error without a strategy change.
6. No long run without heartbeat, abort path, and point-by-point persistence.
7. Operator approval before instrument configuration that can damage a sample
   or optical path.

Rejection cascade:

```text
agent request
  -> schema rejection         (params shape wrong)
  -> safety policy rejection  (limits, approvals, state)
  -> adapter rejection        (final defense: driver-level guard)
```

Each rejection returns a typed `ToolResult` with a useful `next_actions` entry.
The adapter still validates because the policy may have stale state.

## Execution flows

### Outer loop: where the agent earns its keep

The agent's value lives in the outer loop, where the parameters of run N+1
depend on the results of run N. The inner loop stays deterministic.

```text
initial goal
  -> PLAN     (research planner: scientific goal -> draft plan)
  -> COMPILE  (protocol compiler: draft -> typed ExperimentSpec)
  -> APPROVE  (safety reviewer + operator: limits, hazards, sample budget)
  -> EXECUTE  (deterministic kernel; watchdog observes)
  -> ANALYZE  (data analyst: read records, compute metrics)
  -> REPLAN   (research planner: propose next ExperimentSpec)
  -> back to APPROVE
```

Stop conditions are declared in the original `ExperimentSpec`, not chosen by
the LLM after each iteration. Examples: target signal-to-noise reached, sample
budget exhausted, wall-clock budget reached, operator stop.

### Inner loop: Raman mapping

Once `EXECUTE` starts, the deterministic kernel runs this loop with no LLM
involvement. The watchdog observes; the agent does not see intermediate state.

```text
PREFLIGHT
  -> read instrument states
  -> validate limits and calibration availability
  -> require operator approval if hardware mode

CALIBRATE
  -> load or create pixel/stage transform
  -> collect focus anchors
  -> fit focus plane

EXECUTE
  -> for each point:
       move to planned XY and predicted Z
       optionally autofocus
       capture image
       estimate and bound XY correction
       optionally verify correction
       acquire Raman spectrum
       append point record

FINALIZE
  -> close instruments
  -> flush events and snapshot
  -> emit run summary artifact for the data analyst
```

The agent reads only the records produced by `EXECUTE` and `FINALIZE`.
Intermediate intervention, if needed, belongs to the watchdog and is limited
to pause / abort.

## Execution modes

| Mode               | Purpose                                                                       | Hardware access                   |
| ------------------ | ----------------------------------------------------------------------------- | --------------------------------- |
| Offline simulation | Test agent planning, state machine, records, and analysis                     | Fakes only                        |
| Dry run            | Validate real device state and command feasibility without motion/acquisition | Read-only or mocked commands      |
| Hardware run       | Execute approved bounded workflow                                             | Real adapters through policy gate |

Default mode is offline simulation. Hardware mode requires explicit operator
selection and a passing dry run.

## Package layout

Existing domain packages stay unchanged:

```text
raman/stage/         motion abstractions and Z controller
raman/microscope/    camera and acquisition
raman/autofocus/     hardware-decoupled autofocus
raman/calibration/   image-based XY calibration
raman/mapping/       MappingRunner and point records
```

New orchestration package:

```text
raman/agent_harness/
  capability.py            instrument descriptor registry
  experiment_spec.py       typed plan accepted by the harness
  channels/
    events.py              append-only event writer/reader
    intents.py             intent bus polled at safe boundaries
  gateway.py               dispatch(tool_name, params, ctx)
  middleware/
    schema.py              JSON-Schema validation
    safety.py              limit and approval checks
    audit.py               event log pre/post entries
  tools/
    macro.py               run_raman_mapping, analyze_run, ...
    medium.py              pause_run, abort_run (watchdog/operator only)
    micro.py               debugging only; not in agent registry
  runner_facade.py         wraps MappingRunner as one L3 tool
  watchdog.py              rule-based monitor; pause/abort only
  analysis.py              run summarization for the next agent step
  records.py               run-level event and artifact index
```

## Agent-callable tools

Expose coarse, safe tools rather than raw device commands.

- `get_lab_state()`
- `validate_experiment_spec(spec)`
- `run_preflight(spec)`
- `collect_focus_anchors(spec)`
- `calibrate_xy_transform(spec)`
- `run_raman_mapping(spec, resume_from=None)`
- `analyze_run(run_id)`
- `plan_next_experiment(run_id, objective)`

`pause_run(run_id)` and `abort_run(run_id)` live on the same gateway surface
but are reserved for the watchdog and the operator UI. The planner agent
should not call them; if reasoning indicates a run should stop, that belongs
in the spec's stopping rules or in the next replan.

Low-level tools such as `move_relative(dx, dy, dz)` are not exposed to the
planner. Operator-only manual tools live behind a separate maintenance gate.

## Implementation roadmap

### Phase 1: Minimal harness skeleton

Offline end-to-end agent loop with no real hardware.

- `ExperimentSpec` dataclass and validator.
- `ToolCall` Protocol and `ToolResult` dataclass.
- Gateway `dispatch()` with three-stage middleware (schema, safety, audit).
- `runner_facade.run_raman_mapping(spec)` wrapping the existing
  `MappingRunner` with `MemoryXYZStage` and `FakeRamanAcquirer`.
- In-process events queue; JSONL persistence as artifact.
- `analysis.summarize_run(run_id)` producing a compact run summary.
- Offline tests for the loop: plan -> execute -> analyze without an LLM.

### Phase 2: Watchdog and intents

- Move events to JSONL; add tail reader.
- Implement watchdog process with the four trigger rules.
- Add `intents.jsonl` and kernel poll at point boundaries.
- Resume from JSONL snapshot.

### Phase 3: Real hardware integration

- Implement real XY/XYZ stage adapter.
- Persist calibration record for `PixelStageTransform`.
- Camera ownership broker between LabSpec6 and microscope preview.
- Hardware smoke tests for safety gates.

### Phase 4: LLM-driven outer loop

- Bind tools to the chosen harness (Claude tool-use first).
- Implement `plan_next_experiment` as a constrained-choice tool:
  enumeration of replan strategies, not free generation.
- Add operator approval UI hook.
- End-to-end run on a real sample with operator in the loop.

### Phase 5: Adaptive experimentation

- Multi-step experiments where run N+1 spec depends on run N analysis.
- Stopping rule library.
- Run history and decision audit trail.

Each phase is independently shippable. Phase 1 alone gives the project a real
agent-facing API while keeping all hardware behavior deterministic and
testable.
