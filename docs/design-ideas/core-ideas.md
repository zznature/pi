# LabAgents

## Product Vision

LabAgents 的目标不是成为一个会调用仪器的聊天助手，而是成为一个面向真实实验流程的研究执行系统：用户以自然语言提出研究目标，系统将其收敛为可验证、可执行、可审计的 procedure，并在安全边界内稳定运行。

产品应长期具备以下特征：

1. **目标可表达**  
   用户可以用自然语言描述实验目的、假设与约束，系统能够将其整理为结构化研究意图。

2. **执行可验证**  
   所有进入执行层的内容都必须转化为受约束的 `ProcedureSpec`，并在运行前经过统一准入。

3. **运行可托管**  
   长周期实验由 kernel 稳定托管，具备异步观测、可暂停/中止、可恢复与可追踪能力。

4. **能力可理解**  
   系统对上暴露的是语义化实验能力，而不是零散底层驱动命令，便于 agent 规划、人类审查与安全验证。

5. **安全可执行**  
   安全边界必须体现在产品机制中，包括准入、审批、监控与底层防线，而不是停留在提示词约束。

6. **结果可追溯**  
   每一次运行的输入、状态、事件、产物与审批都应被记录，支持复盘、分析、复现与后续 replan。

## Core Ideas

1. **智能与执行分离。**
LLM 只在 bounded run 之间进行规划、编译、审查与分析，不进入执行热路径。一次 bounded run（如一次 mapping、一次 calibration
sweep）由确定性的 kernel 独立执行，运行过程中不依赖 LLM 介入。

2. **`ProcedureSpec` 是唯一执行入口，kernel 是 procedure executor。**
Agent 的自由文本输出不直接进入 kernel，而是先形成 `ExperimentIntent`，再编译为 typed `ProcedureSpec`。kernel 只接受这一种执行输入；任何硬件副作用发生前，`ProcedureSpec` 都必须先经过统一的 admission：

```text
ExperimentIntent -> ProcedureSpec -> admission -> execution
```

其中，`admission` 是执行前的统一准入阶段，内部细分与数据约束由配套设计文档展开。研究目标属于 intent 层，执行参数属于 procedure 层。kernel 在 run 生命周期内执行 `ProcedureSpec`：加载 procedure runner、推进 phase / unit、处理 pause/abort/resume、写入 records，并在安全边界上与 watchdog 和 runtime 层交互；它不负责解释研究目标、表达审批理由、生成重规划策略，也不直接暴露底层 driver 命令给 planner。

3. **持久化记录是唯一事实来源。**
Run registry、events、lineage 和 approvals 都以 append-only 方式持久化，能够重建任意一次 run 的决策链。对话记忆和 compaction summary 不能作为实验状态；session 恢复时必须先从 records 重建状态。`ProcedureSpec` 是执行输入，records 才是运行时真相。

4. **启动与观测分离，唤醒由调度和事件驱动。**
启动 run 时应立即返回 `runId`，planner 当前 turn 随即结束。后台 watcher 以定时检查和事件触发的方式感知 run 状态，并在需要时唤醒 agent 处理后续分析。长 run 属于后台状态机，而不是一次前台 tool call 的阻塞等待。

5. **仪器接入采用 semantic capability / procedure / runtime action 分层，并保持 harness-neutral。**
上层 harness 只通过薄适配器接入；下层 capability、procedure、runtime action 的结构不应因 harness 改变而变化。演化目标是 **PyMeasure 风格的执行对象 + agent-safe orchestration**。

6. **安全采用 kernel + watchdog + LLM advisor 三层结构。**
高层与准入校验主要针对 semantic capability、`ProcedureSpec` 和 `RunPolicy`；runtime / driver 负责最终硬防线。

## Core Data Boundaries

为了约束人和 agent 在实验流程中的交互数据，核心对象分为四层，且每层都有唯一 owner：

1. **`ExperimentIntent`**
   面向 planner / analyst / lineage，表达研究目标、假设、为什么做这一轮。
   它属于研究层，不进入 kernel。

2. **`ProcedureSpec`**
   面向 kernel，表达“执行哪个 procedure、参数是什么、资源是什么、停止条件是什么”。
   它是 kernel 的唯一执行输入。

3. **`RunPolicy`**
   面向 admission / approvals / lease / mode gate，表达 lab state、审批、安全边界、
   资源并发约束。它约束一次执行，但不属于 procedure 本体。

4. **`RunState`**
   面向 runtime / records / watcher / resume，表达进度、heartbeat、unit 状态、
   pause/abort、artifacts。它属于运行时真相，不属于 spec。

这四层的边界必须保持稳定：

- `ExperimentIntent` 可以影响 `ProcedureSpec`，但不能直接执行。
- `ProcedureSpec` 可以被 `RunPolicy` 拒绝，但不能自行携带审批结论。
- `RunState` 只能由 runtime 产生，不能由 planner 预写。
- kernel 只消费 `ProcedureSpec`，不直接消费 `ExperimentIntent`。

更具体的数据模型、字段归属与关系定义见 `data_model.md`。

## Context management

实验 Agent 的 context 与普通 Agent 有三个本质差异：

1. **硬件建模** — 仪器能力与调用协议本身就是 context 的一部分，仪器即工具，工具即认知边界。

2. **环境感知** — 需主动查询仪器实时状态，掌握实验室当前资源，规划才具备可行性。

3. **结构化存储** — 实验状态不入自然语言 compaction，而以结构化方式持久化，便于索引、回溯与分析。


## Instrument Integration

长周期实验须满足四个性质：安全、可观测、可恢复、可扩展。
仪器接入不应再被理解为“把协议包装成一组 tool”这么简单，而应拆成三层流转：**Agent 基于 semantic capability 理解可做什么 → compiler 生成 `ProcedureSpec` → kernel 通过 procedure runner 调用 runtime action 执行 → 结果回流 agent 分析**。

### 接入与调用要点

1. **语义层与运行时层分离**：GPIB/USB/VISA 等底层协议不直接暴露给 agent。agent 面向的是 semantic capability；kernel 面向的是 `ProcedureSpec`；runtime / driver 面向的是可执行的 action contract。语义层负责描述“能做什么”，运行时层负责确定地执行“怎么做”。

2. **安全校验前置**：硬件指令不可回滚，安全控制不能依赖 LLM 自觉。高层约束应先在 semantic capability 和 `ProcedureSpec` 上验证，执行前再经 `RunPolicy` 准入；底层 adapter / driver 负责最终防线。

3. **状态感知与异步建模**：runtime action 不是无状态纯函数，每次执行都应返回实际状态（如到位坐标、耗时、progress）而非简单 "ok"。长时操作（扫描、温控稳定）不阻塞 planner；启动后由 kernel 接管 run lifecycle，并通过 watcher、events 和 summary 回流上层分析。

4. **结构化错误与降级**：区分 `unavailable`、`out_of_range`、`timeout`、`hardware_fault` 等错误类型。procedure runner、kernel 和 agent 应基于这些结构化错误做不同层级的处理：重试、降级、暂停、通知人工或重新规划。

5. **可观测与审计**：semantic capability 的选择、`ProcedureSpec` 的执行、runtime action 的结果与关键硬件响应都应可追溯，并关联所在 `ProcedureSpec` hash，形成完整调用链。

6. **仿真与回放**：runtime layer 提供 mock/emulation 后端支持无硬件调试；录制真实硬件响应用于回归测试、procedure 验证和 prompt 优化。

**核心原则**：仪器接入是“语义能力层 + procedure 执行层 + runtime action 层”的组合，不是简单 RPC 桥接。LLM 只接触经约束的高层语义能力；kernel 执行 procedure；runtime / driver 负责硬件动作与最终防线。

## Safety

两种使用模型：用户监督，Agent监督

用户监督：快速执行，用户的指令默认用户已经做了审查，只对用户提示风险，常用于寻找合适的实验参数
Agent监督：Agent 自主运行实验，需要注重安全验证

### 三层安全体系

1. **确定性内核** — 所有硬件指令由 kernel 发出，LLM 不直连硬件。
2. **规则看门狗** — 非 LLM 的规则引擎实时监控运行状态，仅具备暂停/中止权限。
3. **LLM 顾问** — 离线路径，在运行之间重新规划，不参与热路径决策。

安全验证也分层放置：主要针对 semantic capability、`ProcedureSpec` 和 `RunPolicy` 做高层与准入校验；runtime / driver 负责最终硬防线。工具接口不是唯一安全边界，更不是全部安全语义的承载层。

### 用户审批策略

高风险不可逆操作（超出预设安全边界、首次执行的参数组合）触发用户审批。
用户同意后可将该操作涉及的参数范围、操作类型、样品等条件纳入安全清单，在前提不变的范围内（如同一样品、同功率上限）后续自动放行，跨越多个 `ProcedureSpec`。
审批记录持久化，关联安全清单条目。
