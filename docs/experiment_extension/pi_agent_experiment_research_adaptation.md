# pi-agent 实验研究适配方案

本文给出将 pi-agent 适配为科学实验研究 agent 的工程方案与当前状态。参考设计见
`docs/experiment_extension/instrument_agent_design.md`；Raman 领域接入见
`docs/experiment_extension/raman_hardware_integration.md`。

## 核心思想

- **智能与执行分边**：pi-agent 是外层研究智能体（规划、协议编译、安全审查、审批交互、
  结果分析、下一轮规划）；真实执行由确定性 lab-agent kernel 拥有。LLM 永不进入执行回路。
- **唯一执行入口**：自由文本计划必须先编译为 bounded `ExperimentSpec`，经同一条准入链
  （schema → semantics → policy → preflight → reserve）才能交给 kernel。
- **持久化记录是唯一事实来源**：run registry、events、lineage、approvals 全部落盘且可
  重建任意一次 run 的完整决策链；对话记忆和 compaction 摘要不作为实验状态依据。
- **事件驱动耦合**：`run_experiment` 启动即返回 `runId`，agent 结束当前 turn；run 终态由
  后台 watcher 唤醒 agent 进入 analyze/replan。长 run 期间 context 零增长、零推理成本。
- **通用对象 + domain 扩展**：experiment/run/lease/artifact/approval/lineage 用通用对象
  建模，仪器特定字段只进 `domain` 扩展块（Raman 是第一个领域）。

## 目标

- 研究人员用自然语言提出实验目标，agent 编译为可验证的 bounded `ExperimentSpec`；
  kernel 只执行该规格。
- 所有实验工具调用经 schema、policy、preflight、operator approval 约束；任意一次 run
  可从磁盘记录完整重建。
- simulation、dry_run、hardware 三种模式在同一 kernel 接口背后可替换，默认 simulation；
  hardware 必须经同一 canonical `specHash` 的 dry-run gate 加 operator approval。
- 长 run 与 LLM 解耦：启动即返回、事件驱动唤醒、planner 不轮询。
- 实验管理抽象为 experiment/campaign、run、resource lease、artifact、approval、lineage，
  避免 schema 绑定某一种仪器流程。
- 以 project-local extension 实现，保留 pi-agent 的模型接入、session、工具调用、TUI、
  审计对话等现有优势，不改 core。

## 非目标

- 不让 LLM 进入实时硬件控制循环，不参与 unit 内部编排。
- 不暴露 `move_z`、`serial_send`、`snap_image`、`set_laser_power` 等低层命令给 planner。
- 不让 planner 轮询运行中的 run：`poll_run` 是 operator/watchdog 工具。
- 不允许 run 进行中由 LLM 实时修改参数；stop condition 只来自 `spec.stoppingRules`。
- 不在 pi-agent core 中实现仪器 driver；不绕过 kernel 的限位、心跳、持久化和 abort 路径。
- 第一版不建设通用 middleware 框架、动态仪器注册系统或多进程多 agent。

## 总体架构

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
| simulation | dry_run probe | hardware (stage pilot, Raman    |
| bridge)；one validated ExperimentSpec in, records out        |
+------------------------------+-------------------------------+
                               |
                               v
+--------------------------------------------------------------+
| instrument layer                                             |
| static capabilities | fake adapters | raman_bridge.py        |
+--------------------------------------------------------------+
```

底层主链分为**准入链**和**运行生命周期**两段。准入链是同步、纯函数、可单测的：

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

run 完成的感知走事件驱动唤醒，不走 LLM 轮询：

```text
run_experiment 返回 runId -> agent 结束当前 turn（session idle）
extension watcher 订阅 kernel.events(runId)
run 终态或暂停 -> pi.sendMessage(run 摘要, { triggerTurn: true })
  -> 新 turn 开始 -> analyze_run / plan_next_experiment
```

关键底层约束：

- **start 与 observe 分离**：`run_experiment` 只负责启动并立即返回 `runId`，不在一次工具
  调用里阻塞跑完整轮。`poll`/events 供 operator/watchdog 和 TUI 使用，它们才能中途介入。
- **事件驱动唤醒，禁止 LLM 轮询**：不得让 LLM 在 turn 内循环调用 poll 等待 run 结束。
  watcher 必须在 `session_shutdown` 中清理订阅，并注意捕获的 ctx 在
  `newSession`/`fork`/`switchSession`/`reload` 后失效，需重新获取。
- **先 reserve 再 start**：run store 必须在任何执行副作用前预留 `runId`、run 目录、
  `specHash` 和初始状态，否则崩溃时会出现已启动但不可追踪的 run。
- **两种取消原语不可混用**：pi-agent 传给 tool `execute()` 的 `AbortSignal` 只在本次
  streaming 期间有效，只用于取消同步准入链；run 生命周期的取消一律走 abort intent /
  `kernel.signal(runId, abort)`，在最近的安全 unit 边界停到安全状态。
- **simulation 与 hardware 同形可替换**：两者返回同形状的 `RunState`/`RunSummary`
  判别联合，分析与 replan 路径禁止 `as` 强转或对某一种 run 形状做隐式假设。

## pi-agent 改造边界

只用 project-local extension（`.pi/extensions/experiment-research`），不改 pi-agent core
（provider/模型层、agent loop、内置工具语义、session 树均不动）。用到的扩展点：

- `registerTool()` 注册宏工具；`setActiveTools()` 划分 planner / operator 工具集合。
- `before_agent_start` 注入实验研究 system prompt。
- `tool_call` 拦截低层工具与非法模式；`tool_result` 统一补充 recovery 信息。
- `sendMessage()` 写入 run summary；watcher 用 `{ triggerTurn: true }` 在 run 终态唤醒 agent。
- TUI confirm/input 实现 operator approval；session JSONL 保留人机决策痕迹。

## 核心数据契约

### 通用实验管理对象

实验管理层不把一次 run 等同于某个仪器动作。对象与其底层要求：

- `ExperimentRecord`：`experimentId`、`experimentType`、`objective`、`subject`、owner、
  budget、`rootRunIds`、`status`。描述一组相关 run；多轮自适应实验共享同一 `experimentId`。
- `RunRecord`：`runId`、`experimentId`、`mode`、`specId`、`specHash`、`status`、
  `resourceLeaseId?`、record paths、起止时间、`parentRunId?`。磁盘 run registry 是唯一
  权威；`runId` 必须防冲突派生（不可用进程级自增计数器）。
- `ResourceLease`：`leaseId`、resource ids、mode、owner session、`runId`、`expiresAt?`、
  fencing token。所有会被 run 独占或半独占的资源（设备、样品位、输出目录、预算、
  operator attention）都经 lease 管理；policy 基于 lease 判断并发冲突。
- `ApprovalRecord`：scope、approver、decision、reason、`specHash`、timestamp。硬件批准
  必须绑定 canonical spec。
- `ArtifactRef`：artifact id、kind、URI/path、content hash、producer run。大文件只通过
  引用进入 session。
- `Lineage`：`parentRunId`、strategy、输入 artifact refs、新 `specId`。下一轮实验必须能
  追溯到上一轮证据。

`validatePolicy` 依赖的 `labState` 必须有明确拥有者和持久来源（磁盘 registry + lab state
machine：`idle | active(runId) | paused(runId) | recovering(runId)`），否则"已有 run 在跑"
这类守卫会退化为死代码。启动恢复时发现 active run 但 heartbeat 缺失，进入 `recovering`
并要求人工或规则化恢复，不得静默当作 idle。同一 cwd 可能有多个 pi session，共享
`.pi/experiment-runs/` 必须有单写者锁与 lease，避免记录互相覆盖。

### ExperimentSpec

kernel 唯一接受的执行输入。必备字段保持最小：`schemaVersion`、`specId`、
`experimentType`、`objective`、`subject`、`mode`(`simulation | dry_run | hardware`)、
`resources`、`limits`（motion/power/acquisition/duration/cost/sample budget 统一限制块）、
`plan`（`grid`/`points`/`steps` 互斥）、`stoppingRules`、`operatorApprovalRequired`。
仪器特定参数（focus 策略、标定策略、采集参数等）放 `domain` 扩展块，typed 而非
free-form passthrough。

`specHash` 不由 agent 填写，由 run store 对 canonical JSON 计算并写入 `RunRecord`、
preflight report 和 approval record；dry run、hardware run 和 replay 都用它判断是否同一份规格。

### ToolResult

所有实验工具返回统一结构，按 `status` 做判别联合。

**双通道映射（content vs details）**：pi-agent 工具实际返回
`AgentToolResult = { content, details }`——只有 `content` 进入 LLM context 且不做截断，
`details` 只进 session 日志和 UI。结构化 `ToolResult` 完整放入 `details`；`content` 只放
紧凑摘要加关键字段（`runId`、`status`、`nextActions`、错误码）。禁止把完整 `stateAfter`、
capability snapshot 或大段 JSON 写进 `content`。dispatch 归一化时统一执行该映射。

公共字段：`status`(`success | warning | error`)、`summary`、`nextActions`、
`artifacts: ArtifactRef[]`、`commandId`（每次调用唯一，用于幂等去重）、`correlationId`
（串联 `ToolResult -> events.jsonl -> 记录`）、`experimentId?`、`runId?`、`stateAfter`
（按工具类型给出具体类型，不用 `unknown`）。

`status = error` 追加：`errorCode`（枚举集合，不允许自由字符串）、`retrySafe`（必填，
且有真实重试/幂等机制消费）、至少一个 `nextActions`（`retry as-is | change strategy | stop`）。

### RunState 与 RunSummary

- `RunState`：`runId`、`experimentId`、`mode`、`status`、`progress`、`stopReason?`、
  `lastHeartbeatMs`。
- `RunSummary`：以 `mode`/`status` 为判别字段的联合类型。
- `progress` 用通用形状：`completedUnits/totalUnits`、`unitKind`（`point | step | batch | replicate`）。

### 事件契约

`events.jsonl` 是审计与重建的权威来源：版本化、类型化、append-only。顶层带
`schemaVersion`；每条事件有单调 `sequence`、枚举 `type`（`run_reserved | run_started |
unit_started | unit_completed | unit_error | heartbeat | run_stopped | run_summary`）、
`experimentId`、`runId`、`correlationId`、时间戳。写入崩溃安全（原子追加，必要时
fsync），定义部分写/截断的恢复语义。

### 校验分层

三层职责各有唯一归属，不允许语义校验漏进 schema：

- **结构 schema**：纯字段形状与类型。
- **spec 语义**：`plan` 互斥、范围自洽、资源引用存在、与 limits 自洽——只依赖 spec 自身。
- **运行时 policy**：依赖 `labState`、模式、审批、capability 的检查。

### Capabilities 与 Resources

静态 capability/resource config（不做动态 descriptor）：stable resource id、resource
kind、units 与坐标约定、software limits、hazards、simulation availability、lease policy
（exclusive / shared-read / operator-only）。agent 基于静态 config 规划；进入 dry run 后
由 live state probe 和 adapter 重新验证可达性、calibration、限位与占用。

## 工具设计

只暴露宏工具给 planner。

pi-agent 默认**并行**执行同一批 tool calls（`Promise.all`），单批次内即可对 run store /
lease 产生读写竞争。因此所有副作用工具（`run_experiment`、`start_run`、`advance_run`、
`pause_run`、`abort_run`、`request_operator`）注册时必须声明
`executionMode: "sequential"`；只读工具可保持并行。run store 单写者锁仍是兜底，但不应
依赖它串行化同批次调用。

**Planner 工具**：`get_lab_state`、`get_experiment_state`、`validate_experiment_spec`、
`run_preflight`、`run_experiment`、`start_run`、`advance_run`、`analyze_run`、
`plan_next_experiment`。

`plan_next_experiment` 不自由生成完整 spec，返回受限 strategy enum（`repeat_same`、
`refine_region`、`add_replicates`、`reduce_scope`、`stop`；领域策略经 `domain` 扩展定义），
再由 protocol compiler 编译为新 `ExperimentSpec`。

**Operator / watchdog 工具**（注册但不进 planner 默认集合）：`poll_run`、`pause_run`、
`abort_run`、`request_operator`，以及 Raman 维护工具（active probe、XY 标定、hardware
validation，见 Raman 接入文档）。`poll_run` 刻意不给 planner：run 状态对 planner 的入口
只有 watcher 唤醒消息附带的摘要和 `get_lab_state`/`get_experiment_state` 的注册表视图。

**不暴露给 planner**：`move_relative`、`move_z`、`snap_image`、`serial_send`、
`set_laser_power`。低层命令只允许 maintenance 模式或独立 operator UI 使用。

## Thin Dispatch

不实现通用 middleware 框架。所有实验工具经一个薄 dispatch 调用准入链（见总体架构）和
kernel。观测与控制走独立路径：

```text
analyze_run / plan_next_experiment -> ctx.runStore.read(runId)
pause_run / abort_run / request_operator -> 写 intent，kernel 在安全 unit 边界消费
```

职责划分：

- `dispatch`：路由工具、捕获错误、归一化 `ToolResult`（含双通道映射）；不持有业务状态。
- **依赖注入**：clock、capabilities、run store、id 生成器、kernel 句柄经 `ctx` 注入，
  不用模块级单例，核心因此确定性、可单测、可重入。
- **幂等**：相同 `commandId` 重放返回已 reserve 的同一 `runId` 或同一错误结果，不产生
  重复 run 或覆盖记录。
- **取消**：见"两种取消原语不可混用"约束。
- `tool_call` hook 只做第一道模式与低层工具拦截；`validatePolicy` 是最终可测试策略层。
  hardware approval 作为 `validatePolicy` 与 `run_preflight` 的显式检查，不是独立 middleware。

## 实验模式

- **Simulation**（默认）：fake instruments 跑通完整
  `plan -> compile -> validate -> preflight -> execute -> analyze -> replan`。
- **Dry Run**：连接真实设备但零运动/采集/功率写入。验证 adapter 可达、calibration 存在、
  limits 满足、输出目录可写、abort/intents 路径存在、lease 可获得，并把 canonical
  `specHash` 与 capability snapshot 写入 preflight report。
- **Hardware Run** 必须满足：`mode = hardware`；同一 canonical `specHash` 的 dry run 已
  通过；`operatorApprovalRequired = true` 且 operator 明确确认（approval record 绑定
  `specHash`、capability snapshot 和 hardware risk summary）；watchdog 已启动或明确降级
  为 operator-only monitoring。

## Watchdog

非 LLM 进程或任务：读取 `events.jsonl`、kernel heartbeat、unit records，写入
`pause`/`abort`/`request_operator` intent。触发规则：连续 N 次 adapter/unit error、领域
质量指标低于 baseline 比例、heartbeat 超时、operator 写入 abort intent。watchdog 不修改
实验参数，不发新 motion command，不做 replan。

## Agent 工作流

```text
user objective
  -> create or load ExperimentRecord
  -> research planner drafts bounded plan
  -> protocol compiler creates ExperimentSpec
  -> validate_experiment_spec -> run_preflight -> operator approval if hardware
  -> run_experiment（返回 runId，turn 结束）
  -> watcher 唤醒 -> analyze_run -> plan_next_experiment -> append lineage
  -> stop or compile next ExperimentSpec under same experimentId
```

stop condition 必须写进 `ExperimentSpec.stoppingRules`，不能由 LLM 在实验进行中决定。

## System Prompt 策略

`before_agent_start` 注入：只规划 bounded runs；硬件运行前必须生成 `ExperimentSpec`；
不得请求低层命令；不得 run 中实时调参；硬件风险必须走 approval；错误恢复必须说明
`retry as-is | change strategy | stop`；下一轮规划必须引用上一轮 summary 和 artifacts，
保持同一 `experimentId` 并记录 `parentRunId` 与 strategy；不得轮询 run 进度；session
恢复或接手既有 experiment 时第一步必须调用 `get_experiment_state`（必要时加
`get_lab_state`）从持久化记录重建状态——run registry 是唯一事实来源。

不同角色（research planner / protocol compiler / safety reviewer / data analyst）用同一
模型 runtime 的不同 prompt mode 表示，不需要多进程多 agent。

## 审计和记录

```text
.pi/experiment-runs/
  experiments/<experiment-id>/   experiment.json, lineage.jsonl, decisions.jsonl
  runs/<run-id>/                 run.json, spec.json, preflight.json,
                                 capabilities.snapshot.json, events.jsonl,
                                 intents.jsonl, summary.json, artifacts.json,
                                 approvals.jsonl, leases.jsonl, resume.snapshot.json
  lab/calibrations/              XY 标定 artifact（Raman）
```

pi session 只保存人机决策和摘要；大文件（光谱、图片、raw records）放 artifact 目录，
经 `ArtifactRef` 引用。`spec.json` 是 canonical spec；dry run 到 hardware run 的升级经
`specHash`、approval record 和 capability snapshot 串联，不靠自然语言摘要。

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| LLM 请求低层硬件动作 | 不注册低层工具，`tool_call` hook 和 dispatch 双重拦截 |
| 参数越界 | schema + policy + kernel 三层校验 |
| LLM 实时干预或轮询 run | run 中不接受参数更新；poll 不给 planner；事件驱动唤醒 |
| 取消原语误用 | tool AbortSignal 只管准入链；run 取消走 intents/kernel.signal |
| 同批次并行调用、并发 session、runId 冲突 | 副作用工具 sequential + run store 单写者 + lease/fencing + 防冲突 runId |
| 大 JSON/artifact 灌满 context | ToolResult 双通道 + ArtifactRef 引用 |
| 长实验中断或崩溃 | 先 reserve 再 start + unit-level persistence + resume snapshot + `recovering` 态 |
| 规格漂移或审批缺失 | hardware gate 比对 canonical `specHash` + approval record + capability snapshot |
| 事件日志不可重建 | 版本化、append-only、崩溃安全 events schema + correlationId 串联 |
| 领域 schema 绑定单一仪器流程 | 通用管理对象 + typed `domain` 扩展块 |

## 开发状态（截至 2026-06）

`.pi/extensions/experiment-research` 已落地完整软件闭环，phase4–7 共 50 个
`node --test` 测试通过：

- **准入链与记录**：schema/semantics/policy/preflight 分层、run store（reserve、specHash、
  lease、lab state machine、resume snapshot）、append-only events、lineage/decisions、
  approvals 均已实现。
- **三种模式**：simulation 闭环、dry-run read-only probe、hardware（MC.Newton stage pilot
  与 Raman bridge-backed async run）。
- **工具面**：planner 9 个宏工具 + operator 8 个工具（`poll_run`、pause/abort/
  request_operator、Raman 维护工具），经 `session_start` 的 `setActiveTools()` 划分；
  `tool_call` hook 拦截低层工具与非法模式；`tool_result` hook 统一补充 recovery；
  system prompt 含轮询禁令与 session 恢复规则。
- **Raman 领域**：typed `domain.raman`、长驻 `raman_bridge.py`、异步硬件循环、
  fake/`labspec_file_bridge` 采集后端、autofocus、phase-correlation XY 校正、标定工具、
  hardware validation 门禁——详见 `raman_hardware_integration.md` 的进展与真机 TODO。

测试默认使用 fake provider 和 fake instruments，不使用真实 API key 或硬件。

## 待完善事项

按优先级：

1. **事件驱动唤醒 watcher**：设计契约已定（见总体架构），但 extension 尚未实现
   `kernel.events` 订阅 + `sendMessage({ triggerTurn: true })`。当前 hardware async run
   到达终态后没有任何机制唤醒 agent——`run_experiment` 成功后的 summary 消息不触发新
   turn。这是 Raman 真机长积分 run 可用性的直接阻塞项。
2. **副作用工具声明 `executionMode: "sequential"`**：契约已写入本文，代码中所有工具
   尚未声明，同批次并行竞争目前只靠 run store 单写者兜底。
3. **`session_before_compact` 自定义摘要**：长会话 compaction 时保留 `specHash`、
   approval id、`runId` 等精确值，防止摘要丢失准入链关键证据。
4. **Raman 真机验收**：LabSpec worker 互通、长积分行为、最小采谱 run、真实
   autofocus/标定、production-ready validation record——清单见
   `raman_hardware_integration.md` 的 TODO 节。
5. **research 层（hypothesis / analysis plan / evidence / conclusion）**：v1 收敛范围与
   R0–R2 阶段见 `docs/scientific_research_automation_development.md`。
6. **抽成正式 package**：等 schema、policy、dispatch、records 稳定后再考虑，当前保持
   project-local extension。
