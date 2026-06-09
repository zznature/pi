# pi-agent 实验研究适配方案

本文给出将 pi-agent 适配为科学实验研究 agent 的工程方案。目标不是把
pi-agent 改造成实时仪器控制程序，而是把 pi-agent 作为实验研究外层智能体：
负责规划、协议编译、安全审查、审批交互、结果分析和下一轮实验规划；真实
实验执行由确定性 kernel 完成。

参考设计见 `docs/instrument_agent_design.md`。

## 目标

- 让研究人员用自然语言提出实验目标，由 agent 转换为可验证的实验规格。
- 将自由文本计划编译为结构化 `ExperimentSpec`，只允许 kernel 执行该规格。
- 通过 schema、policy、audit、operator approval 限制所有实验工具调用。
- 支持 simulation、dry run、hardware run 三种模式，默认 simulation。
- 将实验管理抽象为 experiment/campaign、run、resource lease、artifact、approval 和 lineage，
  避免第一版 schema 只适用于某一种仪器流程。
- 保留 pi-agent 的现有优势：模型接入、session、工具调用、扩展系统、TUI、审计对话。

## 非目标

- 不让 LLM 进入实时硬件控制循环。
- 不暴露 `move_z`、`serial_send`、`snap_image` 等低层命令给 planner。
- 不在 pi-agent core 中直接实现仪器 driver。
- 不绕过 deterministic kernel 的限位、心跳、持久化和 abort 路径。

## 总体架构

第一版采用最小底层闭环，不先建设完整 middleware 框架或动态仪器注册系统。管理层先使用
通用实验对象建模，仪器或领域特定字段只放在 `domain` 扩展块中。

```text
+--------------------------------------------------------------+
| pi-agent                                                     |
| LLM runtime | session | macro tools | TUI approval           |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| experiment management extension                              |
|prompt | schemas | thin dispatch | policy | run store | records|
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| lab-agent kernel                                             |
| simulation kernel first | one validated ExperimentSpec in    |
| run records and summary out                                  |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| instrument layer                                              |
| Phase 0-2: fake/static capabilities | later: real adapters    |
+--------------------------------------------------------------+
```

底层主链分为**准入链**和**运行生命周期**两段。准入链是同步、纯函数、可单测的，只负责把
一个 `ExperimentSpec` 校验到“可以交给 kernel 执行”为止：

```text
ExperimentSpec
  -> validateSchema()      结构校验
  -> validateSemantics()   spec 自洽（plan 互斥、范围和资源一致）
  -> validatePolicy()      运行时策略（依赖 labState、模式、审批）
  -> preflight()           capability、输出目录、live state 可行性
  -> runStore.reserve(spec) 预分配 runId、run 目录和 specHash
  -> kernel.start(runId, spec)
  -> runStore.markRunning(runId)
```

准入之后是**运行生命周期**，由 kernel 拥有，不再是一次同步函数调用：

```text
kernel.start(runId, spec)
kernel.poll(runId)   -> RunState (queued|running|paused|aborted|completed|failed)
kernel.events(runId) -> 追加式事件流（heartbeat、unit、error）
kernel.signal(runId, intent)  -> pause|abort|resume，在安全 unit 边界生效
```

关键底层约束（即使第一版实现极简，这些契约也必须先定清，避免后续返工）：

- **start 与 observe 分离**：`run_experiment` 只负责启动并立即返回 `runId`，不在一次工具调用里阻塞跑完整轮。run 进行中 agent 通过 `poll`/events 观察，operator/watchdog 工具才能真正中途介入；否则它们形同虚设。
- **先 reserve 再 start**：run store 必须在任何执行副作用前预留 `runId`、run 目录、`specHash` 和初始状态。不得先 `kernel.start()` 再登记，否则崩溃时会出现已启动但不可追踪的 run。
- **取消可传播**：kernel loop 必须响应 abort intent 和运行时 `AbortSignal`，在最近的安全 unit 边界停到安全状态。
- **simulation 与 hardware 在同一 kernel 接口背后可替换**：两者返回同形状的 `RunState`/`RunSummary`（见判别联合），分析与 replan 路径不得对某一种 run 形状做隐式假设。

pi-agent 只位于外层。一次 bounded run 开始后，执行权转交给 lab-agent kernel；agent 只在
run 结束、暂停或失败后读取 summary 和 records，再决定是否生成下一份 `ExperimentSpec`。

### 通用实验管理状态

`validatePolicy(spec, labState, ctx)` 依赖的 `labState` 必须有**明确的拥有者和持久来源**，
不能是写死的常量，否则“已有 run 在跑”“lab 处于某模式”这类守卫会退化成永不触发的死代码。

实验管理层不要把一次 run 等同于某个具体仪器动作。通用对象至少包括：

- **experiment/campaign registry**：记录研究目标、实验类型、subject/sample、owner、预算、停止条件、
  run lineage 和可读摘要。多轮自适应实验共享同一个 `experimentId`。
- **run registry**：以磁盘为权威的运行注册表（`runId`、`experimentId`、`specId`、`specHash`、
  模式、状态、起止时间、记录路径、capability snapshot）。`runId` 必须防冲突（不可用进程级自增计数器，重启后会覆盖既有 run 目录）。
- **resource lease**：抽象所有会被 run 独占或半独占的资源，不限于仪器；可以是设备、样品位、
  输出目录、预算配额或 operator attention。policy 必须基于 lease 判断并发冲突。
- **lab state machine**：至少 `idle | active(runId) | paused(runId) | recovering(runId)`，
  由 kernel 生命周期事件驱动；preflight/policy 读它判断能否启动新 run。启动恢复时发现 active
  run 但 heartbeat 缺失，应进入 `recovering` 并要求人工或规则化恢复，而不是静默当作 idle。
- **并发单写者**：同一 cwd 可能有多个 pi session。共享 `.pi/experiment-runs/` 需要单活动 run 锁、
  resource lease 或 per-session 命名空间，避免记录互相覆盖。

## pi-agent 改造边界

优先用 project-local extension 扩展，而不是先改 pi-agent core。

应使用的现有能力：

- `registerTool()`：注册实验宏工具。
- `before_agent_start`：注入实验研究专用 system prompt。
- `tool_call`：执行前做模式和低层工具拦截。
- `tool_result`：统一补充 agent 可读的 recovery 信息。
- `sendMessage()`：写入实验状态、审批记录和 run summary。
- `setActiveTools()`：按模式启用工具集合。
- TUI confirm/input：实现 operator approval。
- session JSONL：保留对话、决策和审批痕迹。

不建议直接改动：

- provider 和模型流式调用层。
- 通用 agent loop。
- 内置文件和 shell 工具语义。
- pi session 树结构。

## 推荐包结构

先做 project-local extension。第一版只保留闭环必需文件，稳定后再考虑抽成 package。

```text
.pi/extensions/experiment-research/
  index.ts                 extension 入口和工具注册
  prompt.ts                实验研究 system prompt
  schemas.ts               ExperimentSpec、ToolResult、tool params schema
  dispatch.ts              薄路由，只做工具分发和 ToolResult 归一化
  policy.ts                validatePolicy(spec, labState, ctx) 纯函数
  records.ts               版本化 events、summary、artifact refs（append-only）
  events.ts                事件 schema 与类型化 append 写入
  experiment-store.ts      experiment/campaign registry 与 run lineage
  run-store.ts             磁盘 run registry + resource lease + lab state machine
  capabilities.ts          Phase 0-2 使用静态 capability config
  tools/
    lab-state.ts
    validate-spec.ts
    preflight.ts
    run-experiment.ts
    analyze-run.ts
    plan-next.ts
  kernel/
    kernel.ts              kernel 协议：start/poll/events/signal 与 RunState/RunSummary
    simulation.ts          fake stage/camera/acquirer
    lab-agent-kernel.ts    deterministic kernel interface for lab agents
  fixtures/
    valid-spec.json
    invalid-spec.json
```

如果后续要发布，可迁移到：

```text
packages/experiment-agent/
  src/
  test/
  CHANGELOG.md
```

## 核心数据契约

### 通用实验管理对象

第一版即使用最小字段，也应先把实验管理对象分开，避免后续从“单次仪器运行”返工到
“多轮实验研究”：

- `ExperimentRecord`：`experimentId`、`experimentType`、`objective`、`subject`、owner、
  budget、`rootRunIds`、`status`、created/updated 时间。它描述一组相关 run，而不是某次执行。
- `RunRecord`：`runId`、`experimentId`、`mode`、`specId`、`specHash`、`status`、
  `resourceLeaseId?`、record paths、start/finish 时间、`parentRunId?`。它是 run registry 的基本行。
- `ResourceLease`：`leaseId`、resource ids、mode、owner session、`runId`、`expiresAt?`、
  fencing token。所有会产生并发冲突的资源都通过 lease 管理。
- `ApprovalRecord`：approval id、scope（spec/preflight/hardware/operator-only monitoring）、
  approver、decision、reason、`specHash`、timestamp。硬件批准必须绑定 canonical spec。
- `ArtifactRef`：artifact id、kind、URI/path、content hash、producer run、metadata。大文件只通过引用进入 session。
- `Lineage`：`parentRunId`、strategy、输入 artifact refs、生成的新 `specId`。下一轮实验必须能追溯到上一轮证据。

### ExperimentSpec

`ExperimentSpec` 是 lab-agent kernel 唯一接受的执行输入。agent 产生的自由文本必须先编译
为该结构，再经过 schema、policy、preflight 和必要审批。

第一版必备字段保持最小：

- `schemaVersion`
- `specId`
- `experimentType`: 例如 `spatial_mapping | synthesis_screen | assay | generic_protocol`
- `objective`
- `subject`: 样品、材料、细胞系、环境或任意被研究对象；Phase 0 可只用 `sampleId` 填充
- `mode`: `simulation | dry_run | hardware`
- `resources`: 需要的仪器、样品位、输出目录、预算配额或人工关注；`allowedInstruments` 只是其中一种资源
- `limits`: motion、power/energy、acquisition、duration、cost、sample budget 的统一限制块
- `plan`: `grid`、`points`、`steps` 或领域特定扩展的互斥计划块
- `stoppingRules`
- `operatorApprovalRequired`

以下字段第一版放入可选扩展块，避免过早绑定具体硬件：

- `focusStrategy`
- `calibrationPolicy`
- `watchdogThresholds`
- 仪器特定 acquisition 参数

`specHash` 不由 agent 填写，而是由 run store 对 canonical JSON 计算并写入 `RunRecord`、
preflight report 和 approval record。dry run、hardware run 和 replay 都用该 hash 判断是否是同一份规格。

### ToolResult

所有实验工具返回统一结构，并按 `status` 做**判别联合**，让 agent 面向的契约是强类型而非松散字段：

公共字段：

- `status`: `success | warning | error`
- `summary`
- `nextActions`
- `artifacts`: `ArtifactRef[]`
- `commandId`: 每次工具调用的唯一 id（不是固定字符串），用于幂等与去重。
- `correlationId`: 关联本次结果与它产生的 events/records 的 id；`ToolResult -> events.jsonl -> 记录` 必须可追溯。
- `experimentId?`
- `runId?`
- `stateAfter`: **按工具类型给出具体类型**，不要用 `unknown`。通用部分可引用 `RunRecord`、
  `ExperimentRecord` 或 `ResourceLease`，领域部分放在判别后的 payload 中。

`status = error` 追加：

- `errorCode`: 取自**枚举集合**（如 `invalid_tool_params | invalid_experiment_spec | policy_rejected | preflight_failed | run_not_found | hardware_gate_failed | tool_not_found`），不允许自由字符串。
- `retrySafe`: 必填；且必须有真实的重试/幂等机制消费它，而不只是一个标志位。
- 至少一个 `nextActions`，明确 `retry as-is | change strategy | stop`。

约定：`stateBefore` 仅在能真实捕获前置状态时填写，否则省略，不要恒为 `null` 占位。

### RunState 与 RunSummary

kernel 暴露统一的运行视图，simulation 与 hardware 必须同形状：

- `RunState`: `runId`、`experimentId`、`mode`、`status`(`queued|running|paused|aborted|completed|failed`)、`progress`、`stopReason?`、`lastHeartbeatMs`。
- `RunSummary`: 以 `mode` 或 `status` 为判别字段的联合类型。分析/replan 读它时必须先判别，禁止 `as` 强转把 hardware summary 当 simulation summary 处理。

`progress` 使用通用形状：`completedUnits/totalUnits`、`unitKind`（如 `point | step | batch | replicate`）。
空间扫描可以把 unit 设为 point，其他实验可以使用 step、batch 或 replicate。

### 事件契约（events schema）

`events.jsonl` 是审计与重建的权威来源，必须是**版本化、类型化、append-only** 的 schema，
而不是临时拼出来的无类型对象：

- 顶层带 `schemaVersion`；每条事件有单调 `sequence`、枚举 `type`（`run_reserved | run_started | unit_started | unit_completed | unit_error | heartbeat | run_stopped | run_summary`）、`experimentId`、`runId`、`correlationId`、时间戳。
- 写入需崩溃安全：原子追加（必要时 fsync），定义部分写/截断的恢复语义。

### 校验分层

三层职责必须各有唯一归属，不允许语义校验漏进 schema：

- **结构 schema**：TypeBox/JSON Schema，纯字段形状与类型。
- **spec 语义**：`plan` 内部互斥、坐标或步骤范围自洽、资源引用存在、点位/步骤与 limits 自洽等——只依赖 spec 自身。
- **运行时 policy**：依赖 `labState`、模式、审批、capability 的检查。

### Capabilities 与 Resources

第一版不实现完整 `InstrumentDescriptor` 或资源调度系统，只使用静态 capability/resource config：

- stable resource id
- resource kind（instrument、sample slot、workspace、budget、operator attention）
- units and coordinate convention
- software limits
- hazards
- simulation availability
- lease policy（exclusive、shared-read、operator-only）

agent 基于静态 capability/resource config 规划。进入 dry run 后，再由 live state probe 和 adapter
重新验证设备可达性、calibration、限位、资源占用和前置状态。

## 工具设计

只暴露宏工具给 planner。

### Agent 可调用工具

- `get_lab_state()`
- `get_experiment_state(experimentId?)`
- `validate_experiment_spec(spec)`
- `run_preflight(spec)`
- `run_experiment(spec, resumeFrom?)`
- `analyze_run(runId)`
- `plan_next_experiment(runId, objective)`

`plan_next_experiment` 第一版不直接自由生成完整 spec，而是返回受限 strategy enum。通用集合可先包含
`repeat_same`、`refine_region`、`add_replicates`、`reduce_scope`、`stop`；领域可以在 `domain`
扩展中定义 `increase_resolution` 等特定策略，再由 protocol compiler 编译成新的 `ExperimentSpec`。

### Operator / watchdog 工具

- `pause_run(runId)`
- `abort_run(runId)`
- `request_operator(reason)`

这些工具可以复用同一个 thin dispatch，但不进入 planner 默认工具集合。

### 不暴露给 planner 的工具

- `move_relative`
- `move_z`
- `snap_image`
- `serial_send`
- `set_laser_power`

低层命令只允许 maintenance 模式或独立 operator UI 使用。

## Thin Dispatch 和底层函数链

第一版不实现通用 middleware 框架。所有实验工具只经过一个薄 dispatch，然后调用少量可测试
纯函数和 lab-agent kernel。`run_experiment` 走启动路径并立即返回 `runId`，不阻塞跑完整轮：

```text
dispatch(tool, params, ctx)
  -> validateSchema(params)
  -> validateSemantics(spec)
  -> validatePolicy(spec, ctx.labState, ctx)
  -> preflight(spec, ctx.capabilities, ctx.labState)
  -> ctx.runStore.reserve(spec, commandId)  // 原子分配 runId、specHash、run 目录和 lease
  -> ctx.kernel.start(runId, spec, signal)  // 执行权转交 kernel
  -> ctx.runStore.markRunning(runId)
```

观测与控制走独立路径，不在启动调用里完成：

```text
analyze_run / plan_next_experiment -> ctx.runStore.read(runId)
pause_run / abort_run / request_operator -> 写 intent，kernel 在安全 unit 边界消费
```

职责划分：

- `dispatch`：路由工具、捕获错误、归一化 `ToolResult`；不持有业务状态。
- **依赖注入**：clock、capabilities、run store、id 生成器、kernel 句柄都经 `ctx` 注入，不用模块级单例。核心因此确定性、可单测、可重入；并发由 run store 的单写者保证兜底。
- `validateSchema` / `validateSemantics` / `validatePolicy`：见“校验分层”，结构、spec 语义、运行时策略各自独立。
- `preflight`：检查 capability、输出目录、live state 可行性。
- `runStore.reserve`：在任何执行副作用前写入 `RunRecord(status=queued)`、canonical `specHash` 和 resource lease。
- `kernel.start`：用已分配的 `runId` 启动 run；生命周期与事件流由 kernel 拥有。
- **幂等**：相同 `commandId` 重放必须返回已 reserve 的同一个 `runId` 或同一个错误结果，不得产生重复 run 或覆盖记录；`runId` 防冲突派生（见通用实验管理状态）。
- **取消**：dispatch 把运行时 `AbortSignal` 透传给 kernel，kernel 在安全边界停止。

pi-agent 的 `tool_call` hook 只做第一道模式和低层工具拦截；`validatePolicy` 是最终可测试
策略层。hardware approval 不作为独立 middleware，先作为 `validatePolicy` 和 `run_preflight`
的显式检查。

## 实验模式

### Simulation

默认模式。使用 fake instruments 跑通完整 loop：

```text
plan -> compile spec -> validate -> preflight -> execute -> analyze -> replan
```

### Dry Run

连接真实设备但不执行运动和采集。验证：

- adapter 是否可用。
- calibration 是否存在。
- limits 是否满足。
- 文件路径和输出目录是否可写。
- abort/intents 路径是否存在。
- resource lease 是否可获得。
- canonical `specHash` 和 capability snapshot 是否已写入 preflight report。

### Hardware Run

必须满足：

- `mode = hardware`
- 同一 canonical `specHash` 的 dry run 已通过。
- `operatorApprovalRequired = true`
- operator 明确确认，approval record 绑定 `specHash`、capability snapshot 和 hardware risk summary。
- watchdog 已启动或明确降级为 operator-only monitoring。

## Watchdog

watchdog 是非 LLM 进程或任务，读取事件并写入 intent。

输入：

- `events.jsonl`
- kernel heartbeat
- unit records

输出：

- `pause`
- `abort`
- `request_operator`

触发规则：

- 连续 N 次 resource adapter error 或 unit error。
- 领域质量指标低于 baseline 指定比例（例如 focus score、signal quality、yield、assay validity）。
- heartbeat 超时。
- operator 写入 abort intent。

watchdog 不修改实验参数，不发新 motion command，不做 replan。

## Agent 工作流

```text
user objective
  -> create or load ExperimentRecord
  -> research planner drafts bounded plan
  -> protocol compiler creates ExperimentSpec
  -> validate_experiment_spec
  -> run_preflight
  -> operator approval if hardware
  -> run_experiment
  -> analyze_run
  -> plan_next_experiment
  -> append lineage
  -> stop or compile next ExperimentSpec under same experimentId
```

stop condition 必须写进 `ExperimentSpec.stoppingRules`，不能由 LLM 在实验进行中随意决定。
`plan_next_experiment` 只能基于上一轮 summary、artifacts、lineage 和停止条件提出下一轮 bounded plan。

## System Prompt 策略

实验研究 extension 应在 `before_agent_start` 注入以下约束：

- 你是实验研究 agent，只能规划 bounded runs。
- 真实硬件运行前必须先生成 `ExperimentSpec`。
- 不得请求低层硬件命令。
- 不得在 run 进行中实时调整参数。
- 任何硬件风险都必须走 approval。
- 错误恢复必须说明 `retry as-is`、`change strategy` 或 `stop`。
- 下一轮实验规划必须引用上一轮 run summary 和 artifacts。
- 多轮实验必须保持同一个 `experimentId`，并记录 `parentRunId` 与 replan strategy。

不同角色可用同一模型 runtime 的不同 prompt mode 表示：

- research planner
- protocol compiler
- safety reviewer
- data analyst

第一版不需要多进程多 agent。

## 审计和记录

建议实验记录目录：

```text
.pi/experiment-runs/
  experiments/
    <experiment-id>/
      experiment.json
      lineage.jsonl
  runs/
    <run-id>/
      run.json
      spec.json
      preflight.json
      capabilities.snapshot.json
      events.jsonl
      intents.jsonl
      summary.json
      artifacts.json
      approvals.jsonl
      leases.jsonl
```

pi session 只保存人机决策和摘要；大文件、光谱、图片和 raw records 放 artifact
目录，由 `ArtifactRef` 引用。

底层要求：

- `events.jsonl` 按“事件契约”写入：版本化、类型化、append-only；写入崩溃安全（原子追加，必要时 fsync）。
- run 目录由 run registry 通过 `reserve` 统一分配，`runId` 防冲突；重启或并发 session 不得覆盖既有目录。
- `spec.json` 必须是 canonical spec，`run.json` 必须记录 `specHash`、`experimentId`、`resourceLeaseId?` 和 capability snapshot id。
- dry run 到 hardware run 的升级必须通过 `specHash`、approval record 和 capability snapshot 串联，不能只靠自然语言摘要。
- 记录、events、`ToolResult` 通过 `correlationId` 串联，使任意一次 run 可从磁盘完整重建决策链。

## 实施阶段

阶段按“最快产出可演示、可测试、不会触碰真实硬件的最小闭环”切分。Phase 0-2 只建设
`ExperimentSpec -> schema -> policy -> preflight -> lab-agent kernel -> records -> summary` 主链；
复杂 middleware、动态 descriptor、独立 watchdog 和 package 化全部后置。

### Phase 0: Contract Spike

目标：用最小代码确认 extension 能加载、工具能注册、schema 能拒绝非法实验规格。

- 创建 project-local extension 骨架：`.pi/extensions/experiment-research`。
- 定义最小 `ExperimentSpec`、`ExperimentRecord`、`RunRecord`、`ToolResult` 和静态 capabilities/resource schema。
- 注册 `get_lab_state()`、`get_experiment_state(experimentId?)` 和 `validate_experiment_spec(spec)` 只读/校验工具。
- 在 `before_agent_start` 注入实验研究约束 prompt。
- 添加 `valid-spec.json`、`invalid-spec.json` fixtures。
- 实现 `validateSchema()` 和 canonical spec hashing，暂不接 kernel、records、watchdog。

退出标准：extension 可启动；只读/校验工具可调用；非法 spec 被拒绝；不接入 kernel、不触碰硬件。

### Phase 1: Simulation Closed Loop

目标：形成第一版可用闭环，让研究人员能从目标得到一次 simulation run 的 summary。

- 实现 thin `dispatch(tool, params, ctx)`，依赖经 `ctx` 注入，只做路由、错误捕获和 `ToolResult` 归一化。
- 实现 `validateSemantics(spec)` 与 `validatePolicy(spec, labState, ctx)` 纯函数；`labState` 来自 run store 而非常量。
- 实现 `preflight(spec, capabilities, labState)`，只检查 simulation 可行性、输出目录和资源 lease 可获得性。
- 实现 `runStore.reserve(spec, commandId)`，在 simulation start 前原子写入 `RunRecord(status=queued)`、`specHash` 和 run 目录。
- 按 kernel 协议实现 simulation 的 `start/poll`（第一版可同步完成内部循环，但对外仍返回 `runId` 并落 RunState），产生统一形状的 unit records 和 `RunSummary`。
- 注册宏工具：`run_preflight(spec)`、`run_experiment(spec)`、`analyze_run(runId)`。
- 默认 `mode = simulation`，只启用 simulation 工具集合。
- `analyze_run` 先返回规则化摘要，不依赖真实 LLM 或外部 API。
- 添加 schema、policy、dispatch、simulation loop 单元测试。

退出标准：能跑通 `目标 -> ExperimentSpec -> validate -> preflight -> simulation run -> analyze`；
失败结果包含 `errorCode`、`retrySafe` 和 `nextActions`；测试不依赖真实 API key 或硬件。

### Phase 2: Operator-Usable Records and Planning

目标：让 simulation 闭环具备可审计记录、session 摘要和受限下一轮规划。

- 由 run store 分配防冲突 `runId` 并登记 RunState，按 run id 落盘 `run.json`、`spec.json`、`events.jsonl`、`summary.json`、`artifacts.json`。
- 将早期 audit 简化为 `appendRunRecords()`（版本化、类型化、append-only 事件），不单独实现 audit middleware。
- 为 events 增加单调 `sequence`，并在启动时写入 `run_reserved` 和 `run_started`。
- 使用 `sendMessage()` 将 run summary 写回 session。
- 实现 `plan_next_experiment(runId, objective)`，只返回受限 strategy：`repeat_same`、`refine_region`、`add_replicates`、`reduce_scope`、`stop`。
- 写入 `experiment.json` 和 `lineage.jsonl`，让多轮 run 能按 `experimentId` 和 `parentRunId` 重建。
- 在 `tool_result` hook 统一补充 agent 可读的 recovery 信息。
- 在 `tool_call` hook 做低层工具和模式越权拦截。
- 使用 `setActiveTools()` 区分 planner macro tools 和 operator/watchdog tools。

退出标准：任意一次 simulation run 可由 JSONL 和 summary 重建关键决策链；下一轮计划来自受限 strategy；planner 看不到低层硬件命令。

### Phase 3: Dry Run Readiness

目标：连接真实实验环境的只读状态和可行性检查，但仍不执行运动、采集或功率变更。

- 将静态 capabilities 扩展为真实或半真实 capability loader。
- 实现 live state probe，检查 adapter 可达、calibration 存在、limits 满足、输出目录可写、abort/intents 路径存在、resource lease 可获得。
- 实现 `dry_run` 模式的 `run_preflight(spec)`，明确列出会执行的 bounded run 和不会执行的硬件动作。
- 要求从 simulation 升级到 dry run 时重新 validate spec，不能复用未验证的旧结果。
- dry run report 必须记录 canonical `specHash` 和 capability snapshot id，供 hardware gate 精确比对。
- 增加 TUI approval 记录：`approvals.jsonl`。
- 增加 fake capability 测试和人工硬件 smoke checklist。

退出标准：dry run 能在真实实验环境中完成可行性检查且不产生运动/采集副作用；report 足以支持 operator 判断是否进入 hardware pilot。

### Phase 4: Minimal Hardware Pilot

目标：只接入一个最窄的硬件实验路径，验证 deterministic kernel、审批、审计和安全停止能共同工作。

- 选择单一仪器组合和小范围实验类型，避免一开始泛化到所有 stage/camera/spectrometer。
- hardware run 必须满足：同一 `specHash` 的 dry run 已通过、`operatorApprovalRequired = true`、operator 明确批准。
- kernel 只接受 `ExperimentSpec`，按 unit 持久化 record，并在安全边界轮询 intents。
- 实现最小 watchdog 规则函数：heartbeat timeout、连续错误、operator abort。
- 仅在 hardware pilot 前决定是否把 watchdog 进程化；Phase 4 可以先从规则函数和 intents 文件开始。
- 支持暂停/中止到安全状态；resume 只从最后一个完成 unit 开始。
- 保留 operator-only monitoring 作为显式降级模式，并在 approval 记录中写明。

退出标准：一次小范围 hardware run 能完成或安全中止；所有硬件动作都有 spec、approval、event 和 summary 记录；run 中没有 LLM 实时改参。

### Phase 5: Research Loop and Productization

目标：在已有安全闭环上增强研究价值，而不是提前扩大硬件能力。

- 增强 `analyze_run`：加入质量指标、异常点、artifact 引用和停止条件判断。
- 增强 `plan_next_experiment`：仍返回可枚举 replan strategy，再由 protocol compiler 编译为新 `ExperimentSpec`。
- 增加 run history 和 decision audit trail，支持多轮 bounded run。
- 补齐 watchdog 规则库和 resume snapshot。
- 需要多进程可靠性时，再将 watchdog 从规则函数提升为独立进程。
- 稳定后再从 `.pi/extensions` 提炼为 `packages/experiment-agent`。
- 文档化 extension 配置、capabilities、operator 流程、示例 fake experiment 和 CI 检查。

退出标准：simulation 中可完成多轮自适应实验；至少一个 hardware pilot 路径稳定；公共 schema 和 dispatch API 不再频繁变化。

### 暂缓项

为保证尽快可用，以下能力不要进入 Phase 0-2：

- 不改 pi-agent core、provider 流式层或通用 agent loop。
- 不发布 package，不做多进程多 agent 编排。
- 不实现复杂 middleware、动态 descriptor 注册或独立 watchdog 进程。
- 不暴露 `move_z`、`serial_send`、`snap_image` 等低层工具给 planner。
- 不做真实 LLM 付费调用测试；测试使用 fake provider 和 fake instruments。
- 不支持 run 中 LLM 实时调整实验参数。

## 测试策略

- schema tests：非法 spec 必须被拒绝。
- policy tests：越界、超功率、未审批、错误重试必须被拒绝。
- resource lease tests：并发 run 争抢独占资源时必须被拒绝或排队。
- dispatch tests：工具路由、错误捕获、`ToolResult` 归一化。
- records tests：events sequence、summary、artifact refs、approvals、lineage 和 `specHash` 写入正确。
- simulation loop tests：plan -> execute -> analyze 不依赖真实 LLM 和硬件。
- recovery tests：active run 启动恢复时能进入 `recovering`，不会被误判为 idle。
- hardware gate tests：不同 `specHash`、过期 capability snapshot 或缺失 approval 必须阻止 hardware run。
- watchdog rule tests：事件序列触发 pause/abort/request_operator intent。
- extension tests：工具注册、active tools、`tool_call` 拦截。

测试默认使用 fake provider 和 fake instruments，不使用真实 API key 或付费调用。

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| LLM 请求低层硬件动作 | 不注册低层工具，`tool_call` hook 和 dispatch 双重拦截 |
| 参数越界 | schema + policy + lab-agent kernel 三层校验 |
| 过早抽象拖慢可用性 | Phase 0-2 不做复杂 middleware、动态 descriptor 或独立 watchdog 进程 |
| 长实验中断 | unit-level persistence + resume snapshot |
| LLM 实时干预导致不确定行为 | run 中不接受 LLM 参数更新 |
| 审批记录缺失 | hardware mode 必写 approvals.jsonl |
| artifact 太大污染 session | session 只保存摘要和引用 |
| 同步阻塞导致 operator/watchdog 无法介入 | start 与 observe 分离，run_experiment 返回 runId 后经 poll/intents 控制 |
| labState 写死导致守卫失效 | labState 来自磁盘 run registry + lab state machine |
| runId 冲突覆盖既有记录 | runId 防冲突派生 + 单写者锁/per-session 命名空间 |
| hardware/simulation 结果形状不一致 | 统一 RunState/RunSummary 判别联合，禁止 as 强转 |
| 事件日志不可重建 | 版本化、类型化、崩溃安全的 events schema + correlationId 串联 |
| dry run 与 hardware run 规格漂移 | hardware gate 比对 canonical `specHash`、approval record 和 capability snapshot |
| 领域 schema 过早绑定某个仪器流程 | 通用 `ExperimentRecord`/`RunRecord`/`ResourceLease` + `domain` 扩展块 |
| 并发 session 抢占同一设备或样品位 | resource lease + fencing token + run store 单写者 |

## 推荐起点

先实现 `.pi/extensions/experiment-research` 的 Contract Spike 和 Simulation Closed Loop。这个路径改动小，
能最快验证 pi-agent 是否适合作为实验研究外层 agent；等 schema、policy、dispatch 和 records
稳定后，再决定是否抽成正式 package。
