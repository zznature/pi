# Instrument-orchestration Agent Architecture

This document distills the general design principles for exposing laboratory
instruments to an LLM agent harness for automated experimentation. It is
deliberately harness-neutral and instrument-neutral, and it incorporates the
lessons learned while building the working implementation.

Companion documents — engineering detail lives there, not here:

- `pi_agent_experiment_research_adaptation.md` — how these principles are
  realized inside pi-agent: extension points, field-level data contracts,
  tool surface, records layout.
- `raman_hardware_integration.md` — the first domain: Raman bridge process,
  action set, calibration workflow, real-hardware acceptance TODOs.

In scope:

- How an agent calls instruments: tools, admission, audit.
- How a single bounded run executes deterministically and safely.
- How a non-LLM watchdog provides live safety off the LLM loop.
- How results feed back into the next agent decision.

Out of scope:

- Real-time LLM intervention inside a running experiment.
- Hardware drivers themselves; they live in domain packages.
- Prompt engineering specifics.

## Core principles

1. **Intelligence and execution are split.** The LLM plans, compiles,
   reviews, and analyzes *between* bounded runs. A bounded run (one mapping,
   one calibration sweep) is executed by a deterministic kernel with no LLM
   in the loop. The kernel must reach a safe state even when the watchdog
   and the agent are both offline.

2. **One execution entry, layered admission.** Free-text agent output is
   compiled into a typed `ExperimentSpec` — the only thing the kernel
   accepts. Every spec passes a synchronous, pure, unit-testable admission
   chain before any hardware side effect:

   ```text
   schema (shape) -> semantics (spec self-consistency) -> policy (lab
   state, mode, approvals) -> preflight (capability + live feasibility)
   -> reserve (run id, directory, spec hash) -> start
   ```

   Each layer has a single owner; semantic checks never leak into schema,
   runtime-state checks never leak into semantics.

3. **Durable records are the single source of truth.** Run registry,
   events, lineage, and approvals are persisted append-only and can
   reconstruct the full decision chain of any run. Conversation memory and
   compaction summaries are never experiment state; a resumed session
   rebuilds from the records first.

4. **Start and observe are separate; wakeup is event-driven.** Starting a
   run returns a run id immediately and the planner's turn ends. A
   background watcher wakes the planner with a summary at terminal states.
   The planner never polls and never blocks a tool call for the duration of
   a run.

5. **Protocol -> Tool, harness-neutral.** Existing instrument protocols are
   wrapped, not replaced, into agent-callable tools described by
   JSON-Schema. Any harness (pi-agent, Claude tool-use, OpenAI functions,
   MCP) binds through a thin adapter; the layers underneath do not change
   when the harness changes.

6. **Three-tier safety.** Deterministic kernel (owns all hardware commands)
   + rule-based non-LLM watchdog (live monitoring, pause/abort only) + LLM
   advisor (off the hot path, replans between runs).

## System architecture

```text
+----------------------------------------------------------------+
|  Agent runtime  (LLM, off the hot path)                        |
|  planner | protocol compiler | safety reviewer | data analyst  |
+------------------------------+---------------------------------+
                               | macro tool calls
                               v
+----------------------------------------------------------------+
|  Thin dispatch + admission chain                               |
|  schema -> semantics -> policy -> preflight -> reserve         |
+------------------------------+---------------------------------+
                               | one validated ExperimentSpec
                               v
+----------------------------------------------------------------+
|  Deterministic kernel  (run lifecycle owner)                   |
|    events   --- tail --->  Watchdog (non-LLM)                  |
|    intents  <-- append --  Watchdog / Operator                 |
+------------------------------+---------------------------------+
                               | unit-level macro commands
                               v
+----------------------------------------------------------------+
|  Device side: long-lived bridge process + adapters             |
|  atomic I/O, compound algorithmic actions, enum error codes    |
+----------------------------------------------------------------+
```

| Component       | Responsibility                                     | Owns                        |
| --------------- | -------------------------------------------------- | --------------------------- |
| Agent runtime   | Plans and analyzes between bounded runs            | Prompts, LLM client         |
| Dispatch        | Routes tools, runs admission, normalizes results   | No business state           |
| Kernel          | Run lifecycle, unit sequencing, persistence        | Run state, records          |
| Watchdog        | Live rule-based monitoring                         | Events tail, intent emit    |
| Bridge/adapters | Device I/O and on-device algorithms                | Driver and connection state |

Dependency arrows point upward only: adapters and the bridge never import
from the agent layer. Dispatch holds no business state; clock, capabilities,
run store, id generation, and kernel handles are injected, which keeps the
core deterministic, testable, and reentrant. Idempotency is contractual:
replaying the same command id returns the same reserved run or the same
error, never a duplicate run.

## Action space

Tools split by granularity. Macro is the only layer the planner sees; the
other layers share the same dispatch surface but are caller-gated.

| Layer  | Examples                                                  | Callable by              | Why this layer                                            |
| ------ | --------------------------------------------------------- | ------------------------ | --------------------------------------------------------- |
| Macro  | `run_experiment(spec)`, `analyze_run`, `plan_next_experiment` | Planner (exclusive)      | A run takes hours; LLM round-trips must not happen inside |
| Medium | `poll_run`, `pause_run`, `abort_run`, `request_operator`  | Watchdog, operator       | Must react faster than an LLM round-trip                  |
| Micro  | `move_z`, `snap_image`, `serial_send`                     | Operator maintenance     | Debugging only; never registered for the agent            |

Three rules baked into this split:

- **`poll_run` is deliberately a medium tool.** Giving it to the planner
  invites turn-long polling loops. The planner's only views of a run are
  the wakeup summary and the registry state.
- **Side-effect tools declare sequential execution.** Harnesses execute
  tool batches in parallel by default, which races the run store and
  leases within a single batch. A store-level single-writer lock is the
  backstop, not the mechanism.
- **Replanning is a constrained choice, not free generation.**
  `plan_next_experiment` returns a strategy from an enum (repeat, refine
  region, add replicates, reduce scope, stop, plus typed domain
  strategies); the protocol compiler turns the chosen strategy into the
  next spec, which re-enters the same admission chain.

If planner reasoning concludes a run should stop, that belongs in the
spec's stopping rules or in the next replan — never in a mid-run command.

## Run lifecycle and communication

Admission (principle 2) is a synchronous function call. Everything after it
is an asynchronous lifecycle owned by the kernel:

```text
start(runId, spec)             side effects begin only after reserve
poll(runId)   -> RunState      queued | running | paused | aborted | completed | failed
events(runId) -> append-only stream (heartbeat, unit, error)
signal(runId, intent)          pause | abort | resume, applied at unit boundaries
```

### Three channels

- **Events** — append-only, written by kernel and bridge, tailed by the
  watchdog, read post-run by the agent. Single source of truth for what
  happened.
- **Intents** — written by operator and watchdog, consumed by the kernel
  only at safe unit boundaries. Carries pause / abort / request_operator.
- **Tools** — synchronous request/response between agent and dispatch.
  Every call returns a bounded result; no "wait forever" tools exist.

### Rules learned in implementation

- **Reserve before start.** The run store must allocate run id, run
  directory, spec hash, and initial state before any execution side
  effect; otherwise a crash leaves a started but untrackable run. Run ids
  must be collision-proof — multiple sessions may share one lab.
- **Two cancellation primitives, never mixed.** The harness abort signal
  attached to a tool call only cancels the synchronous admission chain.
  Cancelling a *run* always goes through an abort intent honored at the
  next safe boundary. Wiring run cancellation to tool-call cancellation
  kills runs whenever the LLM stream is interrupted.
- **Heartbeat cadence is decoupled from action duration.** Long device
  actions emit heartbeat/progress at a fixed rhythm (seconds); the
  watchdog timeout is a small multiple of that rhythm, independent of how
  long an integration or scan takes.
- **Event-driven wakeup, never LLM polling.** A background watcher
  subscribes to run events and triggers a new agent turn at terminal
  states. Watcher subscriptions are session-scoped: they must be cleaned
  up on shutdown, and captured context goes stale across session
  replacement.

## Contracts

Field-level shapes live in the adaptation document; this section fixes what
each contract must guarantee.

### ExperimentSpec

The only input the kernel accepts. Generic fields stay instrument-agnostic:
objective, subject, mode, resources, a unified limits block (motion, power,
acquisition, duration, cost, sample budget), plan, stopping rules, approval
flag. Instrument-specific parameters go in a typed `domain` extension
block — typed, never free-form passthrough, so domain checks get the same
schema/semantics treatment as generic ones.

A canonical **spec hash** is computed by the run store — never written by
the agent — and stamped into the run record, preflight report, and approval
record. Dry run, hardware run, and replay all use it to decide whether two
specs are the same experiment. Promotion from dry run to hardware is a hash
comparison, not a natural-language judgment.

### ToolResult

Every tool returns one discriminated structure: status, summary, next
actions, artifact refs, plus identity (a per-call command id for idempotent
replay and a correlation id linking result -> events -> records).

The recovery contract: every error result carries an enum error code (no
free strings), an explicit retry-safe flag, and at least one next action,
so the agent can distinguish "retry as is", "change strategy", and "stop"
without guessing.

Bounded observation: only a compact summary plus key identifiers enter the
LLM context; the full structured result goes to logs and UI; bulk data
(spectra, images, raw records) enters only as artifact references. Nothing
run-sized is ever inlined into context.

### Capabilities and leases

Static capability/resource config — stable id, kind, units and coordinate
convention, software limits, hazards, simulation availability, lease
policy — is what the agent plans against. Live reachability, calibration,
and occupancy are re-verified at preflight and dry-run time. A dynamic
descriptor registry was considered and rejected: static config plus a live
probe covers the need with far less machinery.

Anything a run holds exclusively or semi-exclusively (devices, sample
slots, output directories, budget, operator attention) is modeled as a
lease with a fencing token; concurrency policy reasons about leases, not
ad-hoc flags. Hardware that shares one physical chokepoint (e.g. a stage,
camera, and spectrometer on one workstation) is leased as a single
compound resource so two runs cannot interleave on it.

### Events

The event log is versioned, typed, append-only, and crash-safe: monotonic
sequence numbers, enum event types, correlation ids, defined recovery
semantics for partial writes. If the event log cannot reconstruct a run,
the audit story is fiction.

## Process boundary: the device bridge

The kernel lives in the harness process; device I/O lives in a long-lived
bridge process spawned per run and tied to the run's lease. Three rules set
the boundary, all learned from a failed first attempt (per-call synchronous
subprocess):

- **Never block the harness event loop on hardware I/O.** One blocking
  call during a long integration froze the UI, starved heartbeats, broke
  the watchdog, and invalidated the start/observe split wholesale.
- **Boundary granularity = one kernel unit.** The kernel sends unit-level
  macro commands (visit / focus / acquire / combined unit). Compound,
  algorithm-driven actions — an autofocus scan, a drift correction — are
  closed loops over device I/O and execute wholly on the device side;
  neither the kernel nor the LLM orchestrates them stepwise. Numeric
  algorithms stay next to the device runtime that has the math libraries;
  the kernel consumes scalar results.
- **Errors cross the boundary as enum codes**, never as parsed tracebacks.
  The protocol stream stays clean — logs and diagnostics go to a separate
  channel — and protocol corruption maps to a single "bridge crashed"
  failure that puts the lab into a recovering state. No silent
  restart-and-resume: after a bridge crash the device state is unknown.

Abort is double-covered: intents apply between units; within a unit the
bridge accepts an out-of-band stop honored at safe checkpoints (between
scan steps, between integration polls). Segments that are truly
non-interruptible are declared as such and rely on timeout plus human
recovery instead of pretending stop is instant.

## Agent roles

Several small roles instead of one free-form lab agent — prompt modes over
the same runtime, not separate processes:

| Role              | Responsibility                                              | Hardware access |
| ----------------- | ------------------------------------------------------------ | --------------- |
| Research planner  | Scientific goal -> bounded plan, stopping criteria, metrics  | None            |
| Protocol compiler | Plan -> typed `ExperimentSpec`                               | None            |
| Safety reviewer   | Reviews spec before approval: limits, hazards, preconditions | None            |
| Data analyst      | Post-run records -> metrics -> next-run proposal             | None            |

There is no "run supervisor" agent: per-unit execution belongs to the
kernel, live monitoring to the watchdog.

## Watchdog

A rule-based, non-LLM monitor tails the event stream and may emit `pause`,
`abort`, or `request_operator` intents — nothing else. It exists because:

- most real failures during long runs are mundane (vibration, drift, file
  locks, dropped frames) and need no reasoning;
- LLM latency and cost are unacceptable for per-unit monitoring;
- it must keep working when the LLM is offline or rate-limited.

Trigger thresholds come from the spec, not from watchdog config: N
consecutive unit/adapter errors, a domain quality metric below a fraction
of the run baseline, heartbeat timeout, operator-issued abort. The watchdog
never adjusts parameters, never issues motion commands, never replans —
adaptive behavior belongs to the agent, between runs.

## Safety model

Policy enforces these invariants even against an explicit agent or operator
request:

1. No motion outside configured axis limits.
2. No emission or acquisition without confirmed instrument state.
3. No closed-loop correction above a configured maximum displacement.
4. No repeated retry after the same error without a strategy change.
5. No long run without heartbeat, abort path, and unit-level persistence.
6. Operator approval before anything that can damage a sample or the
   optical path. Hardware approvals bind to the canonical spec hash and a
   capability snapshot, not to a natural-language summary.
7. Limits that software cannot actually enforce (e.g. a laser power knob
   set by hand) are demoted honestly to operator-attested checklist items
   in the approval record, instead of pretending a software gate exists.

Rejection cascades through independent layers, each returning a typed
result with a useful next action:

```text
agent request
  -> schema rejection      (shape)
  -> semantics rejection   (spec self-inconsistency)
  -> policy rejection      (limits, approvals, lab state)
  -> adapter rejection     (final defense: driver-level guard)
```

The adapter still validates because policy state may be stale.

Lab-wide state is an explicit, persistently owned machine —
`idle | active(run) | paused(run) | recovering(run)` — otherwise guards
like "a run is already active" degrade into dead code. A discovered active
run with a missing heartbeat enters `recovering` and requires explicit
recovery, never a silent reset to idle.

## Execution flows

### Outer loop — where the agent earns its keep

```text
objective -> PLAN -> COMPILE -> APPROVE -> EXECUTE -> ANALYZE -> REPLAN
                        ^                                          |
                        +------------------------------------------+
```

The agent's value lives here: parameters of run N+1 depend on the analysis
of run N. Lineage (parent run, strategy, evidence artifacts) is recorded so
every run traces to the evidence that motivated it, under one experiment
id. Stop conditions are declared in the spec up front — target
signal-to-noise, sample budget, wall-clock budget, operator stop — never
chosen by the LLM mid-experiment.

### Inner loop — deterministic unit loop

```text
PREFLIGHT -> CALIBRATE / SETUP
for each unit (from resume point):
    consume intents            (pause/abort apply at this boundary)
    watchdog evaluates
    execute unit via bridge    (compound actions inside the device process)
    append unit record + events
FINALIZE -> close instruments, flush events, emit run summary artifact
```

The agent sees only the records produced by execution and finalization.
Unit records persist point-by-point so a crash resumes from a snapshot
instead of restarting the sample.

## Execution modes

| Mode                 | Purpose                                                            | Hardware access            |
| -------------------- | ------------------------------------------------------------------ | -------------------------- |
| Simulation (default) | Full loop against fakes: planning, state machine, records, analysis | None                       |
| Dry run              | Validate real device state and feasibility, zero motion/emission   | Read-only probe            |
| Hardware run         | Execute the approved bounded workflow                              | Real adapters behind policy |

The three modes are interchangeable behind one kernel interface and return
the same result shapes, so analysis and replanning code cannot
special-case any of them. The promotion gate is cumulative: a hardware run
requires a passed dry run of the *same canonical spec hash*, an operator
approval bound to that hash, and an active (or explicitly waived)
watchdog. Probes that do produce side effects — a test frame, a smoke
acquisition — are operator-only maintenance actions and never part of dry
run.

## Development status (June 2026)

The architecture is implemented as a project-local pi-agent extension
(`.pi/extensions/experiment-research`): TypeScript admission chain, run
store, thin dispatch, records, watchdog rules, compaction-safe summaries,
plus the long-lived Python device bridge. The full software loop — plan ->
compile -> validate -> preflight -> execute -> analyze -> replan — passes
the phase 4–7 regression suite across simulation, dry-run, and
bridge-backed hardware modes with fake instruments. The Raman domain
(typed domain block, autofocus, XY correction, calibration tools, spectrum
acquisition, production-readiness validation record) is integrated end to
end, including the event-driven terminal-run watcher and sequential
declarations on all side-effect tools.

Where implementation diverged from the original sketch — now canon:

- a thin dispatch replaced the planned generic middleware chain;
- static capability config replaced the dynamic descriptor registry;
- the kernel lives in the harness extension (TypeScript) with hardware
  behind a per-run Python bridge, rather than a standalone Python
  `agent_harness` package;
- admission gained an explicit semantics layer between schema and policy.

Open items, tracked in the companion documents:

- real-instrument acceptance of the Raman stack: LabSpec worker interop,
  long-integration behavior, first minimal acquisition run, real autofocus
  and XY calibration, first production-ready validation record (see the
  TODO list in `raman_hardware_integration.md`);
- the research layer above experiment management (hypothesis / analysis
  plan / evidence / conclusion), scoped in
  `scientific_research_automation_development.md`;
- extraction into a formal package once schemas, policy, dispatch, and
  records stabilize; until then it stays a project-local extension.
