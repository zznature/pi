# LabAgents

- 研究人员用自然语言提出实验目标，agent 编译为可验证的 bounded ExperimentSpec。
- 实验管理抽象为 experiment/campaign、run、resource lease、artifact、approval、lineage， 避免 schema 绑定某一种仪器流程。
- 实验经过 simulation、dry_run、hardware 验证后在 kernel 执行。
- 实验运行与Agent分离, kernel 只执行ExperimentSpec：启动即返回、事件驱动唤醒、planner 不轮询。
- 实验可从文件记录完整重建。
- 以 project-local extension 实现，保留 pi-agent 的模型接入、session、工具调用、TUI、 审计对话等现有优势，不改 core。

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

## context

实验 agent 的关键 context 很多是结构化状态：
  仪器坐标、光栅/积分时间、calibration version、样品 metadata、spectrum artifact IDs、失败条件。把这些只压进自然语言 summary，会有漂移风险。

pi compaction 当作“对话压缩层”，同时为 Raman 加一个外部 durable memory/artifact index：实验状态用 JSON/schema 存储，谱图和图像用文件/artifact 存储，summary 只引用 ID 和关键结论。这样 context window 里放的是索引和当前目标，不是全部实验事实。

## Safety
