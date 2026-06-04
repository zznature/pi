# pi-agent 实验研究适配方案

本文给出将 pi-agent 适配为科学实验研究 agent 的工程方案。目标不是把
pi-agent 改造成实时仪器控制程序，而是把 pi-agent 作为实验研究外层智能体：
负责规划、协议编译、安全审查、审批交互、结果分析和下一轮实验建议；真实
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

```text
+--------------------------------------------------------------+
| pi-agent                                                     |
| LLM runtime | session | tools | TUI | approval interaction   |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| experiment extension / package                               |
| system prompt | tool registry | gateway | policy | audit     |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| deterministic experiment kernel                              |
| preflight | calibration | bounded run | point records        |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| instrument adapters                                           |
| stage | microscope | spectrometer | file/data systems         |
+--------------------------------------------------------------+
```

pi-agent 只位于外层。一次 bounded run 开始后，执行权转交给 kernel。agent 只在
run 结束、暂停或失败后读取记录并决定下一步。

## pi-agent 改造边界

优先用 extension/package 扩展，而不是先改 pi-agent core。

应使用的现有能力：

- `registerTool()`：注册实验宏工具。
- `before_agent_start`：注入实验研究专用 system prompt。
- `tool_call`：在工具执行前做策略拦截。
- `tool_result`：统一补充 agent 可读的 recovery 信息。
- `sendMessage()`：写入实验状态、审批记录和 run summary。
- `setActiveTools()`：按模式启用工具集合。
- TUI dialogs：实现 operator approval。
- session JSONL：保留对话、决策和审批痕迹。

不建议直接改动：

- provider 和模型流式调用层。
- 通用 agent loop。
- 内置文件和 shell 工具语义。
- pi session 树结构。

## 推荐包结构

先做 project-local extension，稳定后再提炼为 package。

```text
.pi/extensions/experiment-research/
  index.ts                 extension 入口
  prompt.ts                实验研究 system prompt
  schemas.ts               ExperimentSpec 和工具参数 schema
  gateway.ts               dispatch(tool_name, params, ctx)
  session.ts               实验 session state
  policy.ts                safety policy
  audit.ts                 events/intents/run records
  tools/
    lab-state.ts
    validate-spec.ts
    preflight.ts
    run-experiment.ts
    analyze-run.ts
    recommend-next.ts
  kernel/
    simulation.ts          fake stage/camera/acquirer
    facade.ts              deterministic kernel facade
  watchdog/
    rules.ts
    process.ts
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

`ExperimentSpec` 是 kernel 唯一接受的执行输入。agent 产生的自由文本必须先编译
为该结构，再经过验证和审批。

必备字段：

- `objective`
- `sampleId`
- `mode`: `simulation | dry_run | hardware`
- `allowedInstruments`
- `motionLimitsUm`
- `energyOrPowerLimits`
- `acquisitionLimits`
- `grid` 或 `points`
- `focusStrategy`
- `calibrationPolicy`
- `stoppingRules`
- `watchdogThresholds`
- `operatorApprovalRequired`

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

### InstrumentDescriptor

每个仪器 adapter 在启动时注册 capability card：

- stable instrument id
- supported commands
- units and coordinate convention
- software limits
- required preconditions
- estimated duration
- hazards
- simulation availability
- calibration dependencies

agent 只基于 descriptor 做规划。执行前仍由 policy 和 adapter 重新验证 live state。

## 工具设计

只暴露宏工具给 planner。

### Agent 可调用工具

- `get_lab_state()`
- `validate_experiment_spec(spec)`
- `run_preflight(spec)`
- `run_experiment(spec, resumeFrom?)`
- `analyze_run(runId)`
- `recommend_next_experiment(runId, objective)`

### Operator / watchdog 工具

- `pause_run(runId)`
- `abort_run(runId)`
- `request_operator(reason)`

这些工具可以使用同一个 gateway，但不进入 planner 默认工具集合。

### 不暴露给 planner 的工具

- `move_relative`
- `move_z`
- `snap_image`
- `serial_send`
- `set_laser_power`

低层命令只允许 maintenance 模式或独立 operator UI 使用。

## Gateway 和中间件

所有实验工具调用进入统一 gateway。

```text
schema_validate -> safety_policy -> approval_gate -> audit -> adapter
```

职责划分：

- `schema_validate`：TypeBox/JSON Schema 参数校验。
- `safety_policy`：限位、功率、模式、预算、重试和前置状态检查。
- `approval_gate`：hardware run 或高风险配置变更前请求 operator approval。
- `audit`：写入 `events.jsonl`、tool call、result、审批记录。
- `adapter`：调用 simulation kernel 或真实 deterministic kernel。

pi-agent 的 `tool_call` hook 做第一道拦截；gateway policy 做最终可测试的策略层。

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
  -> research planner drafts plan
  -> protocol compiler creates ExperimentSpec
  -> validate_experiment_spec
  -> run_preflight
  -> operator approval if needed
  -> run_experiment
  -> analyze_run
  -> recommend_next_experiment
  -> stop or next bounded run
```

stop condition 必须写进 `ExperimentSpec.stoppingRules`，不能由 LLM 在实验进行中随意决定。

## System Prompt 策略

实验研究 extension 应在 `before_agent_start` 注入以下约束：

- 你是实验研究 agent，只能规划 bounded runs。
- 真实硬件运行前必须先生成 `ExperimentSpec`。
- 不得请求低层硬件命令。
- 不得在 run 进行中实时调整参数。
- 任何硬件风险都必须走 approval。
- 错误恢复必须说明 `retry as-is`、`change strategy` 或 `stop`。
- 下一轮实验建议必须引用上一轮 run summary 和 artifacts。

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

### Phase 1: Simulation MVP

- 创建 project-local extension。
- 定义 `ExperimentSpec`、`ToolResult`、`InstrumentDescriptor` schema。
- 注册宏工具。
- 实现 in-process gateway、policy、audit。
- 实现 fake kernel。
- 跑通无真实硬件的完整外循环。
- 添加针对 gateway 和 policy 的单元测试。

### Phase 2: Records and Watchdog

- 将 events/intents 落到 JSONL。
- 实现 watchdog rule loop。
- kernel 在安全边界轮询 intents。
- 支持从 run snapshot resume。

### Phase 3: Hardware Adapter

- 接入真实 stage/camera/spectrometer adapter。
- 实现 dry run。
- 强制 hardware approval。
- 加硬件 smoke test checklist。

### Phase 4: Research Loop

- 增强 `analyze_run`。
- 实现 constrained `recommend_next_experiment`。
- 加 run history 和 decision audit trail。
- 支持多轮 bounded run 的停止规则。

### Phase 5: Productization

- 从 `.pi/extensions` 提炼为 `packages/experiment-agent`。
- 文档化 extension 配置、仪器 descriptor、operator 流程。
- 增加 changelog、示例 fake experiment、CI 检查。

## 测试策略

- schema tests：非法 spec 必须被拒绝。
- policy tests：越界、超功率、未审批、错误重试必须被拒绝。
- gateway tests：middleware 顺序、audit 写入、adapter failure 结果结构。
- simulation loop tests：plan -> execute -> analyze 不依赖真实 LLM 和硬件。
- watchdog tests：事件序列触发 pause/abort/request_operator。
- extension tests：工具注册、active tools、`tool_call` 拦截。

测试默认使用 fake provider 和 fake instruments，不使用真实 API key 或付费调用。

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| LLM 请求低层硬件动作 | 不注册低层工具，`tool_call` hook 和 gateway 双重拦截 |
| 参数越界 | schema + policy + adapter 三层校验 |
| 长实验中断 | point-level persistence + resume snapshot |
| LLM 实时干预导致不确定行为 | run 中不接受 LLM 参数更新 |
| 审批记录缺失 | hardware mode 必写 approvals.jsonl |
| artifact 太大污染 session | session 只保存摘要和引用 |

## 推荐起点

先实现 `.pi/extensions/experiment-research` 的 simulation MVP。这个路径改动小，
能最快验证 pi-agent 是否适合作为实验研究外层 agent；等工具契约和 policy 稳定
后，再决定是否抽成正式 package。
