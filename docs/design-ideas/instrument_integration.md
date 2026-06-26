# Kernel 与仪器接入设计

本文定义 LabAgents 在当前阶段的 kernel 重构方向，以及仪器接入应遵循的分层设计。
目标不是把现有 driver 简单包装成更多 tool，而是建立一套同时满足以下要求的结构：

- kernel 是 **procedure executor**
- 执行对象接近 **PyMeasure 风格**
- 上层保留 **agent-safe orchestration**
- 仪器能力既能被 kernel 稳定调用，也能以足够语义化的方式暴露给 agent 和安全校验

## 设计目标

1. kernel 只执行 `ProcedureSpec`，不直接理解研究目标、假设、审批理由或 replan 语义。
2. agent 看到的是少量高层、语义明确的实验能力，而不是大量底层 driver 命令。
3. 仪器运行时接口保持确定性、可恢复、可中止、可观测，适合长周期实验。
4. 安全验证主要发生在语义层和 `ProcedureSpec` 层，而不是依赖 LLM 自觉或只在 driver 层兜底。
5. Raman MVP 保持简单，不为尚未出现的复杂度预留过多抽象。

## 核心结论

仪器接入必须拆成两层接口：

1. **kernel-facing runtime layer**
   给 procedure runner 调用，风格接近 PyMeasure 的 procedure/runtime。

2. **agent-facing semantic layer**
   给 agent 理解、给 policy 做验证、给 UI 做展示。

这两层之间通过明确映射连接，而不是混成一个“既给 agent 看又直接控硬件”的工具层。

## 系统分层

```text
User / Planner / Analyst
    -> ExperimentIntent
    -> semantic capabilities
    -> compile ProcedureSpec

Admission / Policy / Approval / Safety
    -> validate ProcedureSpec against semantic capability contracts

Kernel (procedure executor)
    -> ProcedureRunner
    -> RuntimeAction(s)

Instrument Runtime / Bridge / Drivers
    -> actual hardware I/O
```

## Planner / Compiler / Kernel 对象流

下面这条对象流是固定边界，用来约束 planner、compiler、kernel 分别能看到什么、能产出什么：

```text
User
  -> ExperimentIntent

Planner
  consumes: ExperimentIntent, CapabilityDescriptor, prior summaries/artifacts
  produces: refined ExperimentIntent or execution request

Compiler
  consumes: ExperimentIntent, CapabilityDescriptor, ProcedureDefinition
  produces: ProcedureSpec

Admission / Policy
  consumes: ProcedureSpec, RunPolicy, CapabilityDescriptor
  produces: accepted ProcedureSpec or typed rejection

Kernel
  consumes: ProcedureSpec
  produces: RunState, events.jsonl, artifacts, summary

ProcedureRunner
  consumes: ProcedureSpec
  produces: RuntimeAction sequence + unit progress

Runtime / Drivers
  consumes: RuntimeAction
  produces: device results, progress, hardware errors
```

### 固定约束

- planner 不直接生成 `RuntimeAction`
- planner 不直接调用 driver 命令
- compiler 不直接写 `RunState`
- kernel 不直接消费 `ExperimentIntent`
- runtime / driver 不理解研究目标，只执行 `RuntimeAction`

换句话说：

```text
ExperimentIntent
  -> Capability-guided planning
  -> ProcedureSpec
  -> ProcedureRunner
  -> RuntimeAction
  -> device execution
```

任何绕过这条链路的实现，都意味着边界正在退化。

## 一、Kernel 的职责边界

kernel 重构后的唯一中心职责是执行 procedure，而不是充当“理解所有实验语义的总调度器”。

kernel 应负责：

- 加载 `ProcedureSpec`
- 选择并启动对应 `ProcedureRunner`
- 推进 run lifecycle
- 处理 pause / abort / resume
- 写入 `run.json` 当前状态
- 追加 `events.jsonl`
- 维护 unit 边界上的恢复点
- 产出 summary 和 artifact 索引

kernel 不应负责：

- 理解研究目标和科学假设
- 决定为什么做这轮实验
- 承担 approval 的业务语义
- 暴露底层 driver 命令给 planner
- 把仪器层的所有动作直接变成 agent tool

## 二、Agent-facing Semantic Layer

这一层的作用不是执行硬件，而是让 agent、policy 和 UI 理解“实验能力”。

agent 应看到的是高层语义能力，例如：

- `visit_point`
- `run_autofocus`
- `acquire_raman_spectrum`
- `estimate_and_apply_xy_correction`
- `run_raman_mapping`

而不是：

- `move_absolute`
- `set_laser_power`
- `capture_frame`
- `serial_send`
- `acquire_raw`

### Semantic Capability Descriptor

每个语义能力都应有一个稳定的描述对象，例如 `CapabilityDescriptor`，至少包含：

- `capabilityId`
- `instrumentId`
- `semanticName`
- `description`
- `inputSchema`
- `outputSchema`
- `units`
- `sideEffectLevel`
- `riskLevel`
- `preconditions`
- `supportsSimulation`
- `supportsDryRun`
- `retryPolicy`
- `runtimeActions`

### 这一层的用途

1. 帮助 agent 理解“现在实验室能做什么”
2. 限制 agent 规划空间，避免直接组合底层命令
3. 让 `ProcedureSpec` 的编译有明确目标
4. 让 policy 和 approval 有清晰的校验对象
5. 让 UI / 审计 / 提示词可以引用稳定语义，而不是 driver 细节

## 三、Kernel-facing Runtime Layer

这一层是给 procedure runner 真正调用的执行接口，要求低歧义、强约束、行为稳定。

示例：

- `stage.moveAbsolute({ xUm, yUm, zUm })`
- `stage.waitSettled()`
- `camera.captureFrame({ exposureMs })`
- `spectrometer.acquirePoint({ exposureMs, accumulations })`
- `autofocus.runOnce({ roi, zStartUm, zStopUm, stepUm })`

### Runtime Action Contract

每个 runtime action 应声明：

- `actionId`
- `domain`
- `paramsSchema`
- `timeoutMs`
- `cancelBehavior`
- `safeToRetry`
- `emitsProgress`
- `progressModel`
- `sideEffectLevel`
- `resourcesTouched`

### 这一层的特点

- 面向执行，不面向研究解释
- 接口稳定，适合 procedure runner 调用
- 便于处理 pause / abort / retry / timeout
- 便于记录 progress、unit 边界和恢复点
- 可以通过 bridge / adapter / fake backend 统一实现 simulation、dry-run、hardware

## 四、ProcedureDefinition

当 kernel 是 procedure executor 时，必须引入显式的 procedure 定义，而不是让 kernel 自己理解各种领域流程。

每个 procedure 应有稳定定义，例如：

- `raman.single_point`
- `raman.mapping`
- `raman.autofocus_probe`
- `raman.xy_calibration`

### ProcedureDefinition 至少应包含

- `procedureId`
- `procedureVersion`
- `parametersSchema`
- `requiredCapabilities`
- `unitModel`
- `resumeBoundaries`
- `summaryModel`
- `runnerFactory`

### ProcedureRunner 的职责

`ProcedureRunner` 是 kernel 与 runtime layer 之间的具体执行者。它负责：

- 解释 `ProcedureSpec.parameters`
- 将 procedure 拆成 unit / phase
- 调用 runtime actions
- 在 unit 边界写 progress
- 在失败时提供明确错误语义
- 在完成时产出 summary 和 artifact refs

kernel 不需要知道 Raman mapping 的科学含义，只需要知道自己在运行一个 `ProcedureRunner`。

## 五、三层对象之间的关系

### 1. `ExperimentIntent`

- 研究层对象
- 表达为什么做
- 给 planner / analyst / lineage 用

### 2. `ProcedureSpec`

- 执行层对象
- 表达跑哪个 procedure、用哪些参数、什么资源、何时停止
- kernel 唯一消费对象

### 3. `RuntimeAction`

- 运行时动作对象
- 由 `ProcedureRunner` 调用
- 对应具体硬件操作或局部算法动作

三者关系是：

```text
ExperimentIntent
  -> compile
  -> ProcedureSpec
  -> execute via ProcedureRunner
  -> RuntimeAction(s)
```

任何时候都不应让 agent 直接从 `ExperimentIntent` 跳到底层 runtime action。

## 六、安全验证放在哪一层

安全验证不能只依赖底层 driver，也不能只依赖 LLM 自觉。
应采用三层放置：

### 1. 语义层验证

针对 `CapabilityDescriptor` 和 `ProcedureSpec` 做高层校验，例如：

- 这个 procedure 是否允许在当前 mode 下执行
- Raman 采谱是否要求激光功率审批
- autofocus 的 z 范围是否超过允许边界
- xy correction 的最大位移是否超出安全阈值

### 2. Procedure / policy 层验证

针对 `RunPolicy` 做执行前准入，例如：

- 当前 lab state 是否允许新 run
- 当前资源是否可租用
- 当前审批是否覆盖本次 procedure 参数范围
- 本次运行是否满足 simulation / dry-run / hardware 的 gate

### 3. Runtime / driver 层最终防线

底层 adapter 仍需做最后一道 guard，例如：

- 轴限位
- 参数越界
- 资源 busy
- 非法状态下拒绝发指令

因此，安全验证的主要对象应是：

- 语义能力
- `ProcedureSpec`
- `RunPolicy`

而不是让 policy 直接对一堆裸 driver 调用做业务判断。

## 七、Raman MVP 的建议能力面

当前 Raman MVP 不需要把所有 driver 功能都暴露出来，只需先稳定少量语义能力：

- `visit_point`
- `run_autofocus`
- `acquire_raman_spectrum`
- `estimate_and_apply_xy_correction`
- `run_raman_mapping`

对应 runtime action 可以继续保持细粒度，例如：

- `stage.moveAbsolute`
- `stage.waitSettled`
- `camera.captureFrame`
- `spectrometer.acquirePoint`
- `autofocus.runOnce`

这样能同时满足：

- agent 理解简单
- policy 校验聚焦
- kernel 执行稳定
- runtime 可恢复

## 八、MVP 约束

为了避免抽象过度，当前阶段保持以下约束：

1. 不为每个仪器动作都定义复杂元模型。
2. 不把所有 runtime action 都注册成 agent tool。
3. 不为了“方便解释”而让 agent 看到更多底层 driver 命令。
4. 先围绕 Raman MVP 所需 procedure 定义语义能力，再考虑推广。
5. 如果一个抽象不能同时提升 agent 理解能力和安全验证能力，就暂时不要引入。

## 九、演化路线

### 阶段 1：收紧执行对象

- `ExperimentSpec` 退场
- `ProcedureSpec` 成为 kernel 唯一执行输入
- kernel 按 procedure runner 执行

### 阶段 2：建立语义能力层

- 为 Raman MVP 定义少量 `CapabilityDescriptor`
- 让 agent 和 policy 看这层，而不是看 driver

### 阶段 3：稳定 runtime action 契约

- 为 stage / camera / spectrometer / autofocus 定义统一 action contract
- 统一 timeout / cancel / progress / retry 语义

### 阶段 4：收敛 admission 与安全验证

- 让 admission 主要对 `ProcedureSpec + RunPolicy + CapabilityDescriptor` 工作
- driver 只做最终硬防线

## 十、结论

kernel 重构和仪器接入必须同步推进。单独缩小 `ProcedureSpec` 而不改仪器层，会导致：

- agent 仍然难以理解实验能力
- policy 仍然难以做高层安全验证
- runtime 接口仍然混杂执行和解释语义

目标结构应明确为：

- **kernel = procedure executor**
- **agent 看到 semantic capabilities**
- **procedure runner 调用 runtime actions**
- **driver / bridge 只服务 runtime**

这就是当前阶段的目标：**PyMeasure 风格的执行对象 + agent-safe orchestration + 语义化仪器能力层。**
