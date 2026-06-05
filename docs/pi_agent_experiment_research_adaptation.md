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
- 保留 pi-agent 的现有优势：模型接入、session、工具调用、扩展系统、TUI、审计对话。

## 非目标

- 不让 LLM 进入实时硬件控制循环。
- 不暴露 `move_z`、`serial_send`、`snap_image` 等低层命令给 planner。
- 不在 pi-agent core 中直接实现仪器 driver。
- 不绕过 deterministic kernel 的限位、心跳、持久化和 abort 路径。

## 总体架构

第一版采用最小底层闭环，不先建设完整 middleware 框架或动态仪器注册系统。

```text
+--------------------------------------------------------------+
| pi-agent                                                     |
| LLM runtime | session | macro tools | TUI approval           |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| experiment extension                                          |
| prompt | schemas | thin dispatch | policy | records          |
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

底层主链收敛为：

```text
ExperimentSpec
  -> validateSchema()
  -> validatePolicy()
  -> preflight()
  -> runLabAgentKernel()
  -> appendRunRecords()
  -> summarizeRun()
```

pi-agent 只位于外层。一次 bounded run 开始后，执行权转交给 lab-agent kernel。agent 只在
run 结束、暂停或失败后读取 summary 和 records，再决定是否生成下一份 `ExperimentSpec`。

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
  records.ts               run records、summary、artifact refs
  capabilities.ts          Phase 0-2 使用静态 capability config
  tools/
    lab-state.ts
    validate-spec.ts
    preflight.ts
    run-experiment.ts
    analyze-run.ts
    plan-next.ts
  kernel/
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

### ExperimentSpec

`ExperimentSpec` 是 lab-agent kernel 唯一接受的执行输入。agent 产生的自由文本必须先编译
为该结构，再经过 schema、policy、preflight 和必要审批。

第一版必备字段保持最小：

- `objective`
- `sampleId`
- `mode`: `simulation | dry_run | hardware`
- `allowedInstruments`
- `limits`: motion、power/energy、acquisition 的统一限制块
- `grid` 或 `points`
- `stoppingRules`
- `operatorApprovalRequired`

以下字段第一版放入可选扩展块，避免过早绑定具体硬件：

- `focusStrategy`
- `calibrationPolicy`
- `watchdogThresholds`
- 仪器特定 acquisition 参数

### ToolResult

所有实验工具返回统一结构：

- `status`: `success | warning | error`
- `summary`
- `nextActions`
- `artifacts`
- `runId`
- `commandId`
- `stateBefore`
- `stateAfter`
- `errorCode`
- `retrySafe`
- `stopConditionMet`

错误结果必须包含 `errorCode`、`retrySafe` 和至少一个 `nextActions`。

### Capabilities

第一版不实现完整 `InstrumentDescriptor` 注册系统，只使用静态 capability config：

- stable instrument id
- units and coordinate convention
- software limits
- hazards
- simulation availability

agent 基于静态 capability 规划。进入 dry run 后，再由 live state probe 和 adapter 重新验证
设备可达性、calibration、限位和前置状态。

## 工具设计

只暴露宏工具给 planner。

### Agent 可调用工具

- `get_lab_state()`
- `validate_experiment_spec(spec)`
- `run_preflight(spec)`
- `run_experiment(spec, resumeFrom?)`
- `analyze_run(runId)`
- `plan_next_experiment(runId, objective)`

`plan_next_experiment` 第一版不直接自由生成完整 spec，而是返回受限 strategy，例如
`repeat_same`、`increase_resolution`、`reduce_range`、`stop`，再由 protocol compiler 编译成
新的 `ExperimentSpec`。

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
纯函数和 lab-agent kernel。

```text
dispatch(tool, params)
  -> validateSchema(params)
  -> validatePolicy(spec, labState, ctx)
  -> preflight(spec, capabilities, labState)
  -> runLabAgentKernel(spec)
  -> appendRunRecords(result)
  -> summarizeRun(runId)
```

职责划分：

- `dispatch`：路由工具、捕获错误、归一化 `ToolResult`。
- `validateSchema`：TypeBox/JSON Schema 参数校验。
- `validatePolicy`：限位、模式、审批状态、重试和前置状态检查。
- `preflight`：检查 capability、输出目录、simulation/dry run 可行性。
- `runLabAgentKernel`：调用 simulation kernel 或后续真实 deterministic kernel。
- `appendRunRecords`：追加 `events.jsonl`、summary、artifact refs 和审批记录。

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

### Hardware Run

必须满足：

- `mode = hardware`
- dry run 已通过。
- `operatorApprovalRequired = true`
- operator 明确确认。
- watchdog 已启动或明确降级为 operator-only monitoring。

## Watchdog

watchdog 是非 LLM 进程或任务，读取事件并写入 intent。

输入：

- `events.jsonl`
- kernel heartbeat
- point records

输出：

- `pause`
- `abort`
- `request_operator`

触发规则：

- 连续 N 次 stage/camera/acquirer error。
- focus score 低于 baseline 指定比例。
- heartbeat 超时。
- operator 写入 abort intent。

watchdog 不修改实验参数，不发新 motion command，不做 replan。

## Agent 工作流

```text
user objective
  -> research planner drafts bounded plan
  -> protocol compiler creates ExperimentSpec
  -> validate_experiment_spec
  -> run_preflight
  -> operator approval if hardware
  -> run_experiment
  -> analyze_run
  -> plan_next_experiment
  -> stop or compile next ExperimentSpec
```

stop condition 必须写进 `ExperimentSpec.stoppingRules`，不能由 LLM 在实验进行中随意决定。
`plan_next_experiment` 只能基于上一轮 summary、artifacts 和停止条件提出下一轮 bounded plan。

## System Prompt 策略

实验研究 extension 应在 `before_agent_start` 注入以下约束：

- 你是实验研究 agent，只能规划 bounded runs。
- 真实硬件运行前必须先生成 `ExperimentSpec`。
- 不得请求低层硬件命令。
- 不得在 run 进行中实时调整参数。
- 任何硬件风险都必须走 approval。
- 错误恢复必须说明 `retry as-is`、`change strategy` 或 `stop`。
- 下一轮实验规划必须引用上一轮 run summary 和 artifacts。

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
  runs/
    <run-id>/
      spec.json
      events.jsonl
      intents.jsonl
      summary.json
      artifacts.json
      approvals.jsonl
```

pi session 只保存人机决策和摘要；大文件、光谱、图片和 raw records 放 artifact
目录，由 `ArtifactRef` 引用。

## 实施阶段

阶段按“最快产出可演示、可测试、不会触碰真实硬件的最小闭环”切分。Phase 0-2 只建设
`ExperimentSpec -> schema -> policy -> preflight -> lab-agent kernel -> records -> summary` 主链；
复杂 middleware、动态 descriptor、独立 watchdog 和 package 化全部后置。

### Phase 0: Contract Spike

目标：用最小代码确认 extension 能加载、工具能注册、schema 能拒绝非法实验规格。

- 创建 project-local extension 骨架：`.pi/extensions/experiment-research`。
- 定义最小 `ExperimentSpec`、`ToolResult` 和静态 capabilities schema。
- 注册 `get_lab_state()` 和 `validate_experiment_spec(spec)` 两个只读/校验工具。
- 在 `before_agent_start` 注入实验研究约束 prompt。
- 添加 `valid-spec.json`、`invalid-spec.json` fixtures。
- 实现 `validateSchema()`，暂不接 kernel、records、watchdog。

退出标准：extension 可启动；两个工具可调用；非法 spec 被拒绝；不接入 kernel、不触碰硬件。

### Phase 1: Simulation Closed Loop

目标：形成第一版可用闭环，让研究人员能从目标得到一次 simulation run 的 summary。

- 实现 thin `dispatch(tool, params)`，只做路由、错误捕获和 `ToolResult` 归一化。
- 实现 `validatePolicy(spec, labState, ctx)` 纯函数。
- 实现 `preflight(spec, capabilities, labState)`，只检查 simulation 可行性和输出目录。
- 实现 `runLabAgentKernel(spec)` 的 simulation 分支，产生 point records 和 summary artifact。
- 注册宏工具：`run_preflight(spec)`、`run_experiment(spec)`、`analyze_run(runId)`。
- 默认 `mode = simulation`，只启用 simulation 工具集合。
- `analyze_run` 先返回规则化摘要，不依赖真实 LLM 或外部 API。
- 添加 schema、policy、dispatch、simulation loop 单元测试。

退出标准：能跑通 `目标 -> ExperimentSpec -> validate -> preflight -> simulation run -> analyze`；
失败结果包含 `errorCode`、`retrySafe` 和 `nextActions`；测试不依赖真实 API key 或硬件。

### Phase 2: Operator-Usable Records and Planning

目标：让 simulation 闭环具备可审计记录、session 摘要和受限下一轮规划。

- 按 run id 落盘 `spec.json`、`events.jsonl`、`summary.json`、`artifacts.json`。
- 将早期 audit 简化为 `appendRunRecords()`，不单独实现 audit middleware。
- 使用 `sendMessage()` 将 run summary 写回 session。
- 实现 `plan_next_experiment(runId, objective)`，只返回受限 strategy：`repeat_same`、`increase_resolution`、`reduce_range`、`stop`。
- 在 `tool_result` hook 统一补充 agent 可读的 recovery 信息。
- 在 `tool_call` hook 做低层工具和模式越权拦截。
- 使用 `setActiveTools()` 区分 planner macro tools 和 operator/watchdog tools。

退出标准：任意一次 simulation run 可由 JSONL 和 summary 重建关键决策链；下一轮计划来自受限 strategy；planner 看不到低层硬件命令。

### Phase 3: Dry Run Readiness

目标：连接真实实验环境的只读状态和可行性检查，但仍不执行运动、采集或功率变更。

- 将静态 capabilities 扩展为真实或半真实 capability loader。
- 实现 live state probe，检查 adapter 可达、calibration 存在、limits 满足、输出目录可写、abort/intents 路径存在。
- 实现 `dry_run` 模式的 `run_preflight(spec)`，明确列出会执行的 bounded run 和不会执行的硬件动作。
- 要求从 simulation 升级到 dry run 时重新 validate spec，不能复用未验证的旧结果。
- 增加 TUI approval 记录：`approvals.jsonl`。
- 增加 fake capability 测试和人工硬件 smoke checklist。

退出标准：dry run 能在真实实验环境中完成可行性检查且不产生运动/采集副作用；report 足以支持 operator 判断是否进入 hardware pilot。

### Phase 4: Minimal Hardware Pilot

目标：只接入一个最窄的硬件实验路径，验证 deterministic kernel、审批、审计和安全停止能共同工作。

- 选择单一仪器组合和小范围实验类型，避免一开始泛化到所有 stage/camera/spectrometer。
- hardware run 必须满足：同一 spec 的 dry run 已通过、`operatorApprovalRequired = true`、operator 明确批准。
- kernel 只接受 `ExperimentSpec`，按 point 持久化 record，并在安全边界轮询 intents。
- 实现最小 watchdog 规则函数：heartbeat timeout、连续错误、operator abort。
- 仅在 hardware pilot 前决定是否把 watchdog 进程化；Phase 4 可以先从规则函数和 intents 文件开始。
- 支持暂停/中止到安全状态；resume 只从最后一个完成 point 开始。
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
- dispatch tests：工具路由、错误捕获、`ToolResult` 归一化。
- records tests：events、summary、artifact refs 和 approvals 写入正确。
- simulation loop tests：plan -> execute -> analyze 不依赖真实 LLM 和硬件。
- watchdog rule tests：事件序列触发 pause/abort/request_operator intent。
- extension tests：工具注册、active tools、`tool_call` 拦截。

测试默认使用 fake provider 和 fake instruments，不使用真实 API key 或付费调用。

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| LLM 请求低层硬件动作 | 不注册低层工具，`tool_call` hook 和 dispatch 双重拦截 |
| 参数越界 | schema + policy + lab-agent kernel 三层校验 |
| 过早抽象拖慢可用性 | Phase 0-2 不做复杂 middleware、动态 descriptor 或独立 watchdog 进程 |
| 长实验中断 | point-level persistence + resume snapshot |
| LLM 实时干预导致不确定行为 | run 中不接受 LLM 参数更新 |
| 审批记录缺失 | hardware mode 必写 approvals.jsonl |
| artifact 太大污染 session | session 只保存摘要和引用 |

## 推荐起点

先实现 `.pi/extensions/experiment-research` 的 Contract Spike 和 Simulation Closed Loop。这个路径改动小，
能最快验证 pi-agent 是否适合作为实验研究外层 agent；等 schema、policy、dispatch 和 records
稳定后，再决定是否抽成正式 package。
