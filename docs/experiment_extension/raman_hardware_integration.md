# Raman 硬件动作与算法接入方案 (V2 架构：Workflow-Stateful TS + Device-Session-Stateful Raman Runtime)

本文记录 `docs/Raman` 参考栈（stage 运动、autofocus、XY 校正、LabSpec 谱采集）以及未来更多实验设备接入 `.pi/extensions/experiment-research` 的 V2 架构设计与重构方案。

上层契约（准入链、kernel 协议、事件驱动唤醒、ToolResult 双通道）沿用原有设计。本文重点解决 **"多设备高扩展性、长周期稳定性的控制权分配与通信架构"**，目标是让长周期实验满足安全、可观测、可恢复、可扩展四个性质。当前 `docs/Raman` 的优化说明了一个边界修正：**TS 必须拥有实验级 workflow state，但不必把所有硬件邻近闭环都拆成 TS 微步。** 核心判断标准不是语言，而是状态性质：

- **workflow state**：实验跑到哪里、下一步该做什么、哪些 artifact 已落盘、失败后从哪里恢复。这类状态必须由 TS Kernel 持久化管理。
- **device session state**：串口连接、LabSpec 文件桥连接、camera stream、driver 缓存、设备级 stop/cleanup。这类状态贴近硬件，仍由 Python HAL 管理。
- **action-local deterministic state**：backlash 补偿、settle 判据、粗细双扫描、单次采谱内部轮询、局部 timeout/retry 等。这类状态若被封装为**单个有界动作**且能回传 progress/checkpoint/error，可以留在 Python Raman runtime。
- **agent strategy state**：暂停后的诊断、下一轮实验策略、operator-facing recovery plan。LLM 只能在非实时边界介入。

## 核心架构理念：控制倒置 (Inversion of Control)

**V1 架构（问题根源）**：真正的问题不是“Python 里存在复合动作”，而是**实验级 workflow state** 曾被整个藏进 Python 调用栈里，导致 TS 只能在 unit 结束后写 resume snapshot，崩溃恢复粒度偏粗。

**V2 架构（当前推荐）**：TS Kernel 拥有 durable workflow state；Python Bridge / Raman runtime 持有 device session，并允许承载**设备邻近、确定性、可界定恢复语义的复合动作**。TS 负责实验级 sequencing、lease、watchdog、records、resume policy；Python 负责设备连接生命周期、硬件原语、局部安全动作、标准化错误，以及必要时的 progress/checkpoint/cancel。

```text
LLM Agent (Strategy & Recovery, non-realtime)
       │ - 只在 paused/recovering/analysis 边界介入
       │ - 输出诊断建议、operator 请求、下一轮实验策略
TS Kernel (Orchestrator & State Machine)
       │ - 负责：resource lease、主 mutex、watchdog、resume.snapshot、artifact index
       │ - 负责：跨 unit / 跨设备 workflow 编排
       │ - 负责：决定调用 primitive 还是 compound action，以及恢复策略
       │ - 负责：将硬件异常降级为 paused/recovering 并投递给 Agent 或 operator
       │ (JSON-RPC over stdio / bounded timeout / progress / cancel / checkpoint)
Python Bridge / Raman Runtime
       │ - 统一 Device Registry 和 device session lifecycle
       │ - A 类硬件原语：stage.move, camera.capture, stage.stop
       │ - B 类设备侧确定性复合动作：autofocus.run_single, xy_correct.estimate_and_apply, spectrometer.acquire_point
       │ - C 类无状态算法：algorithm.phase_correlation, calibration.fit_matrix
       │ - 防御式 single-flight、局部 timeout/retry、best-effort stop/cleanup
```

## 能力盘点与边界重新划分

我们按**恢复边界**而不是按“是否只有一步调用”来拆能力。当前 Raman 栈已经证明：有些动作虽然内部包含扫描、轮询或补偿，但它们仍然适合作为一个设备侧 deterministic action 暴露给 TS。

### A 类：硬件原语（Python runtime 执行）

设备驱动暴露标准化 primitive。每个 primitive 必须声明 `sideEffectLevel`、`resourcesTouched`、`safeToRetry`、`timeoutMs`、`cancelBehavior`。Python 可以执行 bounded retry、wait loop、driver cleanup，但不得持有**跨 unit 的实验 workflow 进度**。


| 设备域                   | 原子动作                                                                                    | 传输/耗时预期                                      |
| --------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `stage`        | `move_absolute(x,y,z)`, `wait_settled()`, `stop()`, `get_position()` | RPC 毫秒级，机械动作按 timeout 约束 |
| `camera`       | `capture_frame()`, `start_stream()`, `stop_stream()`                 | 单帧通常 ≥400 ms |
| `spectrometer` | `begin/poll/cancel/collect` *或* `acquire_point()`                  | 取决于底层后端是否支持 resume-friendly lifecycle |
| `thermal` (加热台，未来)    | `set_target_temp(t)`, `get_current_temp()`, `wait_stable()`                             | `wait_stable()` 是设备级 wait loop，不是实验 workflow |


### B 类：设备侧确定性复合动作（Python runtime 执行）

这类动作靠近硬件、依赖设备 session 语义，而且已经在 `docs/Raman` 中沉淀为稳定模块。它们不是 agent-facing tool，也不是自由生长的“黑盒脚本”；它们必须有明确输入输出、progress/checkpoint/error contract，以及可审计的 artifact。


| 动作域 | 当前 Raman 参考实现 | 推荐边界 |
| --- | --- | --- |
| `autofocus` | `autofocus.controller.AutofocusController.run_single()` | 保持为单个确定性动作，返回 `FocusResult`、曲线、置信度、失败类型 |
| `xy_correction` | `calibration.stage_adapter.estimate_and_apply_xy_correction()` | 允许在设备侧完成“估计 + 应用”，但必须受 spec 里的位移/置信度 guard 约束 |
| `spectrometer` | `mapping.labspec.*RamanAcquirer.acquire_point()` | 允许内部 poll/cancel/timeout；若未来后端支持更细粒度 lifecycle，再升级为 begin/poll/cancel/collect |
| `point_runner` | `mapping.runner.MappingRunner._run_point()` | 可作为 domain runtime 参考实现；TS 是否直接调用取决于 records/resume 颗粒度要求 |


### C 类：无状态纯算法（Python 侧算力服务）

依赖 `numpy`/`FFT` 的重计算留在 Python，但**不直接关联硬件**。TS 传入数据（如图片路径/数组），Python 返回计算结果。


| 算法域                | 动作                  | 输入 -> 输出                                           |
| ------------------ | ------------------- | -------------------------------------------------- |
| `focus_metric`     | `calc_score`        | `image_path` -> `score, confidence`                |
| `drift_correction` | `phase_correlation` | `ref_img, cur_img, matrix` -> `dx, dy, confidence` |
| `calibration`      | `fit_matrix`        | `shifts_array` -> `2x2_matrix, residuals`          |


### 实验级复合流程（TS 层编排）

TS 仍然拥有实验级 sequencing，但这里的“编排”应发生在 **unit / phase / device coordination** 层，而不是机械地把每一个硬件邻近扫描步都改写成 TS 微步。


| 流程                       | TS 侧伪代码逻辑                                                                                                                                  | 优势与稳定性增强                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Z Autofocus** | `focus = await raman.autofocus.run_single(...)` | TS 记录动作开始/完成、曲线 artifact、失败类型；无需重写 coarse/fine/backlash 细节 |
| **XY 校正** | `corr = await raman.xy_correct.estimate_and_apply(...)` | TS 决定是否启用、是否因低置信度暂停；设备侧负责图像配准与位移执行 |
| **Spectrum Acquisition** | `result = await raman.spectrometer.acquire_point(...)` *或* `begin/poll/cancel/collect` | 生命周期细粒度由后端能力决定；关键是 progress/cancel/recovery contract 清晰 |
| **Run Unit** | `await visit(); await autofocus?; await xy_correct?; await thermal.wait?; await acquire();` | 方便插入新设备等待逻辑，同时保留 Raman 设备侧优化过的局部闭环 |


## 稳定性与长周期实验保障 (Reliability & Resume)

长周期实验（几十小时甚至数天）的稳定性要求系统能在任何崩溃点无损恢复。

### 1. 状态外置与断点续传 (Resume Snapshot)

- Python 不持有**跨 unit / 跨 run** 的 workflow 进度；所有实验进度状态仍由 TS 管理并持久化。
- TS Kernel 至少要在 unit 边界、phase 边界和长动作边界刷新 `resume.snapshot.json`。如果某个设备侧 compound action 能发出更细粒度 checkpoint，TS 应该消费并落盘，但**不要求为了 checkpoint 而把动作强行拆回 TS 微步**。
- snapshot 至少记录：`runId`、`unitIndex`、`phase`、`action`、`commandId`、最近已确认物理位置、已生成 artifact、下一步计划、`safeToResume`。仅当后端真的暴露 acquisition/session id 时，才额外记录该 id。
- **灾难恢复**：如果 Python 进程崩溃（`bridge_crashed`）甚至 Node 进程重启，TS 重启后读取 snapshot，重新 spawn Python Bridge，并先执行 hardware reconcile（例如读取 stage position、确认最近一次 autofocus/采谱是否已产出 artifact、检查 LabSpec 输出文件），再决定 resume / pause / abort。
- 自动恢复只允许发生在显式标记 `safeToResume=true` 的边界；否则进入 `paused/recovering`，要求 operator 审核。

### 2. 精细化的错误隔离与 Agent 介入

- **隔离硬件异常**：底层任何硬件异常（如 `COM` 口断开、超时），Python 仅抛出标准化的 RPC Error（如 `stage_timeout`）。
- **TS 层状态机降级**：TS 捕获错误后，停止当前循环，将系统状态置为 `paused/recovering`。
- **Agent 工具投递**：TS 通过 `ToolResult` 回传错误上下文。LLM 可以调用只读 probe 或请求 operator intervention，实现“硬件挂掉 -> 软件隔离 -> AI 诊断 / 人工接管”的降级。
- **实时控制禁止进入 LLM**：LLM 不能逐步控制 autofocus、stage motion、spectrum polling；这些闭环必须在 TS/Python 确定性代码内完成。

## Bridge 进程与 JSON-RPC 协议设计 (V2)

**长驻 `hardware_bridge.py`**：统一的 RPC 服务器，内部按 Device Domain 路由。Bridge 不持有实验级 workflow，但可以承载设备侧 deterministic action，并对所有 side-effecting 命令执行防御式 single-flight。

### 协议格式升级：引入 Domain Routing

```jsonc
// TS -> Python
{"id":"c-001","domain":"stage","action":"move_absolute","payload":{"xUm":10,"yUm":20},"timeoutMs":3000}
{"id":"c-002","domain":"autofocus","action":"run_single","payload":{"roi":{...},"params":{...}},"timeoutMs":30000}
{"id":"c-003","domain":"spectrometer","action":"acquire_point","payload":{"pointId":"p-001","integrationTimeS":360,"accumulations":1}}

// Python -> TS (保持一致)
{"id":"c-001","ok":true,"result":{"xUm":10,"yUm":20,"zUm":0}}
{"id":"c-002","ok":false,"error":{"code":"FRAME_READ_ERR","message":"..."}}
{"event":"progress","id":"c-003","domain":"spectrometer","elapsedS":42.0,"estimatedTotalS":360.0}
```

每个 action 在注册时声明：

```typescript
interface HardwareActionContract {
  domain: string;
  action: string;
  sideEffectLevel: "read" | "motion" | "acquisition" | "power" | "environment";
  resourcesTouched: string[];
  safeToRetry: boolean;
  cancelBehavior: "none" | "best_effort" | "safe_checkpoint";
  emitsProgress: boolean;
}
```

### 多设备锁与资源互斥 (Mutex)

- TS Orchestrator 是主锁拥有者，负责跨设备、跨 workflow 的 resource lease 和 mutex。例如执行采谱前获取 `labspec-workstation` 和 `stage_motion` 相关锁。
- Python Bridge 仍必须做 defensive single-flight：同一 bridge 进程内若已有 motion/acquisition 命令执行，新的冲突命令必须返回 `resource_busy`，不能假设所有调用都来自正确 TS 路径。
- operator-only 工具、残留 bridge、测试 client 都可能绕过常规编排；双层锁是硬件安全要求，不是重复设计。

## 标定与数据落盘 (Artifacts)

- **算法输出解耦**：C 类纯算法（如 XY 标定矩阵计算 `fit_xy_calibration`）可以在无外设环境运行。Python 返回数值矩阵和 residuals，TS 负责写入 `.pi/experiment-runs/lab/calibrations/<id>.json`。
- **谱数据与图片**：保持原有规则。靠近设备的数据写入可以由 Python 完成，RPC 返回路径引用；TS 负责 artifact index、lineage、hash/evidence digest 和生命周期管理。
- **中途 artifact**：autofocus 曲线、参考帧、phase-correlation 输入输出、LabSpec request/result 文件都应作为可选 artifact 登记，方便 resume 和现场诊断。

## 演进路径 (Strangler Fig Pattern)

为避免“一改全崩”，重构分为五个阶段：

1. **V2 Bridge 破冰**：新建 `hardware_bridge_v2.py`。建立极简的 Device Router。先将最边缘的纯算法（C类）如 `phase_correlation` 迁移到 V2，并在 TS 端重写调用逻辑。
2. **硬件驱动抽离**：将 `MCNewtonXYZStageController` 从原有桥接代码中解耦，注册入 V2 Bridge。在 TS 层实现 V2 版本的 `move` 和 `wait_settled`。
3. **长动作生命周期化**：将谱采集从单次 `acquire_point` 优先迁移为 `begin/poll/cancel/collect`。先保证 heartbeat、operator abort、timeout 和 artifact 落盘语义正确。
4. **按恢复收益决定是否上移**：只有当某个闭环必须与其他设备强协调，或必须暴露更细粒度 resume 语义时，才把它从设备侧 compound action 进一步拆回 TS；否则优先复用 `docs/Raman` 中已经优化过的 deterministic runtime。
5. **扩展新设备**：新增加热台（Thermal）设备。Python 只实现 driver primitive 和 action contract；TS 通过已有 resource lease、snapshot 和 watchdog 机制接入。

## 开发进度与剩余 Goal

当前工作区已经从“V2 设计期”进入“G8 收口期”。下面的状态以现有代码、夹具和 focused tests 为准，而不是按最初规划顺序回顾整个中间过程。

| 范围 | 状态 | 当前结论 |
| --- | --- | --- |
| G1-G4 | 已完成 | `hardware_bridge_v2.py`、TS V2 client、算法/Stage primitive、spectrometer lifecycle 已落地。`test:hardware-bridge-v2` 已覆盖协议、算法、stage、camera、thermal fake primitive、spectrometer lifecycle。 |
| G5 | 已完成 | microstep snapshot、resume/reconcile、artifact 对账已落地。`test:raman-v2-resume` 已覆盖 resume/pause/abort 分支。 |
| G6 | 已完成 | TS 侧 unit orchestration、恢复点管理，以及 autofocus / XY correction / spectrum 的 bridge-backed action integration 已落地。`test:raman-v2-orchestrator` 与 `test:raman-v2-hardware-run` 已覆盖编排、恢复点和 LabSpec file-bridge 路径。 |
| G7 | 已完成（仅 fake thermal） | thermal domain、resource lease 和 wait 语义已接入 V2；但当前 real runtime 仍拒绝 thermal waiting，因此这不等于 real thermal parity 已完成。 |
| G8.1-G8.4 | 已完成 | `v2ValidationId` gate、parity checks、`validatedCoverage`、spec pair / payload draft / readiness tooling、runbook 和 `sample_registry` 已补齐。`test:raman-v2-validation` 当前为 18/18 通过。 |
| G8.5 | 未完成 | 还没有首份 production-ready 的 **real-hardware** V2 validation record。当前缺口不在架构，而在现场证据链。 |
| G8.6 | 未开始 | 在 G8.5 完成前，不应冻结或删除 V1；当前仍需保留 operator-only fallback。 |

这意味着：后续 `/goal` 不应再回到 G1-G4 的基础设施建设，也不应继续展开 G8.1-G8.4 的中间拆分。对当前代码库，真正还有效的开发目标只剩下面两项：

| Goal ID | 当前建议的 `/goal` objective | 完成定义 |
| --- | --- | --- |
| G8.5 | `Produce the first production-ready V2 Raman validation record on real hardware so future mc_newton_xyz + v2_bridge runs can pass the v2ValidationId gate.` | 形成一份带 `workflowBackend: "v2_bridge"`、可被 `raman_check_hardware_validation` 判定为 production-ready 的真实 validation record。 |
| G8.6 | `Freeze the V1 Raman bridge behind operator-only fallback after the real-hardware V2 validation evidence is accepted.` | 默认真实路径切到 `v2_bridge`，V1 仅保留 operator fallback，并同步更新迁移说明与测试。 |

对当前阶段还应明确两点：

- **current real-capable baseline** 是 `.pi/extensions/experiment-research/fixtures/raman-v2-real-validation-*.json` 这一组模板；它覆盖 autofocus、XY correction 和 acquisition，但**不包含 real thermal waiting**。
- `raman-v2-validation-hardware-spec.json` / `raman-v2-validation-dry-run-spec.json` 代表 **future full-surface** 目标覆盖面，当前不能直接当作 real-hardware 放行基线。

## G8 真实硬件验证 Runbook

G8 的目标不是“跑过一次 V2 就算完成”，而是生成一份后续真实 `v2_bridge` 运行可以反复引用的 **production-ready validation record**。推荐按下面顺序执行，且每一步都必须留下可归档证据。

### Step 0. 前置条件

- 仅在 `G1-G7` 已完成、V2 fake-hardware 回归通过后执行。
- 不开启 `PI_EXPERIMENT_ALLOW_SIMULATED_HARDWARE=1`。
- 明确本次验证的真实仪器标识：`labspecWorkstation`、`stageController`、`camera`、`acquirer`。
- 若现场还没有固定这些逻辑 ID，应在独立的 instrument registry 或现场 runbook 中建立本次 validation 的资源映射表，不要写入 `sample_registry`。
- 若 spec 启用了 `xyCorrection`，必须先准备可用的 `xyCalibrationId`。
- 若 spec 启用了 `thermal.waitBeforeAcquisition`，最小验证 run 必须真的经过温度稳定等待，而不是关闭该步骤来缩短验证时间。

### Step 1. 固定一份“最小但覆盖能力”的 V2 硬件 spec

这份 spec 的要求不是“最短”，而是“最小覆盖”。它至少要：

- `mode: "hardware"`
- `hardwareExecution.stageAdapter = "mc_newton_xyz"`
- `hardwareExecution.raman.workflowBackend = "v2_bridge"`
- `hardwareExecution.raman.acquisitionBackend = "labspec_file_bridge"`
- 若启用 autofocus：`hardwareExecution.raman.autofocusBackend = "labspec_file_bridge"`
- 若启用 XY correction：`hardwareExecution.raman.xyCorrectionBackend = "phase_correlation"`
- 至少包含一个真实 point/unit
- 若目标是为某类生产 spec 做 parity evidence，则该最小 run 必须启用同类能力：`autofocus` / `xyCorrection` / `thermal.waitBeforeAcquisition`

仓库内现在有两类模板：

- **current real-capable** 模板：
  - hardware：`.pi/extensions/experiment-research/fixtures/raman-v2-real-validation-hardware-spec.json`
  - dry-run：`.pi/extensions/experiment-research/fixtures/raman-v2-real-validation-dry-run-spec.json`
- **future full-surface** 模板：
  - hardware：`.pi/extensions/experiment-research/fixtures/raman-v2-validation-hardware-spec.json`
  - dry-run：`.pi/extensions/experiment-research/fixtures/raman-v2-validation-dry-run-spec.json`

若现场是从 hardware 模板出发临时调整点位、资源 ID 或其他非能力字段，建议先调用 `raman_prepare_validation_spec_pair` 自动导出 dry-run 对偶，并确认两者的 canonical `specHash` 仍然一致。

可直接参考下面这类调用：

```json
{
  "tool": "raman_prepare_validation_spec_pair",
  "input": {
    "spec": "load .pi/extensions/experiment-research/fixtures/raman-v2-real-validation-hardware-spec.json"
  }
}
```

当前要特别注意：thermal backend 仍是 fake-only，所以真正可执行的 `G8.5` 真实硬件 validation 基线应使用 **current real-capable** 模板；**future full-surface** 模板用于表达最终目标覆盖面，不应在当前 real hardware run 中直接当作放行基线。

这些模板的用途不是直接替代现场 spec，而是作为 **minimum auditable run** 的基线。现场若要调整坐标、仪器 ID 或 runtime 参数，应保持能力覆盖面不变。

换句话说，minimum Raman run 是 **minimum auditable run**，不是 minimum runtime run。

### Step 2. 生成同 spec 家族的 dry-run preflight

先对同一份 spec 生成 dry-run 预检：

1. 使用与目标硬件 spec 语义一致的 dry-run 变体。
2. 调用 `run_preflight`。
3. 归档 `.pi/experiment-runs/preflights/<reportId>/preflight.json`。

这里的关键约束是：后续 minimum Raman run 的 `specHash` 必须能和这份 preflight 对上。不能拿旧 preflight、别的 spec，或者“差不多一样”的 dry-run 抵充。

可直接参考下面这类调用：

```json
{
  "tool": "run_preflight",
  "input": {
    "spec": "load .pi/extensions/experiment-research/fixtures/raman-v2-real-validation-dry-run-spec.json"
  }
}
```

### Step 3. 执行 operator-approved active smoke probe

调用 `raman_active_probe` 生成有副作用但受控的真实硬件 smoke evidence。最小要求：

- operator 已明确审批
- 采到一张真实 LabSpec frame artifact
- 采到一份真实 spectrum smoke artifact
- record 中不得出现 fake/synthetic backend

归档：

- active probe record：`.pi/experiment-runs/maintenance/active-probes/<probeId>/active-probe.json`
- probe artifacts：frame / spectrum 文件本体

可直接参考下面这类调用：

```json
{
  "tool": "raman_active_probe",
  "input": {
    "approval": {
      "approvalId": "appr-raman-v2-active-probe",
      "operator": "operator-name",
      "approved": true,
      "ramanSafety": {
        "laserPowerConfirmed": true,
        "confirmedLaserPowerMw": 1,
        "labSpecWorkerReady": true,
        "windowsPowerPolicyReady": true
      },
      "notes": "Operator-approved active smoke probe for current real-capable Raman V2 validation."
    },
    "captureFrame": true,
    "acquireSpectrumSmoke": true,
    "frameBackend": "labspec_file_bridge",
    "acquisitionBackend": "labspec_file_bridge",
    "frameBridgeDir": "<labspec-frame-bridge-dir>",
    "labspecBridgeDir": "<labspec-spectrum-bridge-dir>",
    "timeoutS": 30,
    "pollIntervalS": 1
  }
}
```

### Step 4. 准备或记录 XY calibration

如果目标 spec 启用了 `xyCorrection`，需要已有真实 calibration artifact：

- 可复用已审查的 `raman_record_xy_calibration`
- 或通过 `raman_fit_xy_calibration`
- 或通过 `raman_auto_xy_calibration`

归档位置：

- `.pi/experiment-runs/lab/calibrations/<calibrationId>.json`

如果目标 spec 不启用 `xyCorrection`，`xyCalibrationId` 可以为空；不要为了“填满字段”去伪造 calibration。

### Step 5. 执行真实 V2 minimum Raman run

调用 `run_experiment` 执行最小真实 V2 run，并确保它留下足够的 parity evidence。最低要求如下：

- run 必须完成，且使用真实 `mc_newton_xyz` stage adapter
- run record 中必须出现 `workflowBackend: "v2_bridge"`
- 至少有一个 completed Raman unit
- unit 必须包含 `spectrumMetadata.backend = "labspec_file_bridge"`
- 如果 spec 启用了 autofocus：至少一个 unit 必须包含 `unit.autofocus`
- 如果 spec 启用了 XY correction：至少一个 unit 必须包含 `unit.xyCorrection`
- 如果 spec 启用了 thermal wait：至少一个 unit 必须包含 `unit.thermal`
- 如果启用了 autofocus 或 XY correction：必须留下 frame artifacts，且文件真实存在
- spectrum artifact 必须存在，且文件真实存在

建议归档的 run 目录最少包括：

- `.pi/experiment-runs/runs/<runId>/spec.json`
- `.pi/experiment-runs/runs/<runId>/summary.json`
- `.pi/experiment-runs/runs/<runId>/events.jsonl`
- `.pi/experiment-runs/runs/<runId>/artifacts.json`

可选但强烈建议一起保留：

- `.pi/experiment-runs/runs/<runId>/resume.snapshot.json`
- autofocus curve / reference frame / phase-correlation 中间 artifact

对 **首份** current real-capable V2 minimum run，当前 runtime 允许一个受控的 operator-only bootstrap 入口：如果还没有任何 production-ready `v2ValidationId`，可以在 `hardwareExecution.approval.bootstrapV2ValidationRun` 中显式设为 `true`，仅用于生成这次最小验证 run 的证据链。这个 flag 不是通用豁免；一旦首份 production-ready validation record 生成，后续真实 V2 run 必须改为显式提供 `hardwareExecution.raman.v2ValidationId`。

首份 bootstrap minimum run 可直接参考下面这类调用：

```json
{
  "tool": "run_experiment",
  "input": {
    "spec": "load .pi/extensions/experiment-research/fixtures/raman-v2-real-validation-hardware-spec.json",
    "hardwareExecution": {
      "stageAdapter": "mc_newton_xyz",
      "raman": {
        "workflowBackend": "v2_bridge",
        "acquisitionBackend": "labspec_file_bridge",
        "autofocusBackend": "labspec_file_bridge",
        "xyCorrectionBackend": "phase_correlation"
      },
      "settleTimeoutMs": 1000,
      "heartbeatTimeoutMs": 10000,
      "maxConsecutiveErrors": 2,
      "approval": {
        "approvalId": "appr-raman-v2-bootstrap-run",
        "operator": "operator-name",
        "approved": true,
        "dryRunReportId": "<dry-run-report-id>",
        "bootstrapV2ValidationRun": true,
        "ramanSafety": {
          "laserPowerConfirmed": true,
          "confirmedLaserPowerMw": 1,
          "labSpecWorkerReady": true,
          "windowsPowerPolicyReady": true
        }
      }
    }
  }
}
```

如果现场并不是跑“首份” real V2 minimum run，而是在已有 production-ready validation record 之后做普通真实 V2 运行，就不要再设置 `bootstrapV2ValidationRun`。

### Step 6. 人工审阅与 validation record 固化

operator 审阅 Step 2-5 的证据后，调用 `raman_record_hardware_validation`。这一步不是重新跑硬件，而是把证据链固定成一份可以被 runtime gate 读取的 validation record。

如果现场想先把字段拼装成一份可审阅草稿，再逐项确认 checklist / approval / hardware attestation，建议先调用 `raman_prepare_hardware_validation_payload` 生成 draft payload，然后再把审阅后的最终值提交给 `raman_record_hardware_validation`。

仓库内也提供了一份可直接对照的 current real-capable 草稿示例：`.pi/extensions/experiment-research/fixtures/raman-v2-real-validation-payload.draft.json`。这份文件是 schema-valid 的 draft，不代表已经完成 operator review。

生成草稿时，可直接参考下面这类调用：

```json
{
  "tool": "raman_prepare_hardware_validation_payload",
  "input": {
    "validationId": "raman-v2-prod-20260621-a",
    "operator": "operator-name",
    "observedAt": "2026-06-21T10:00:00.000Z",
    "evidence": {
      "readOnlyPreflightReportId": "<dry-run-report-id>",
      "activeProbeRecordPath": ".pi/experiment-runs/maintenance/active-probes/<probeId>/active-probe.json",
      "minimumRamanRunId": "<runId>",
      "xyCalibrationId": "v2-validation-calibration",
      "workflowBackend": "v2_bridge"
    },
    "instrumentIds": {
      "labspecWorkstation": "labspec-workstation-main",
      "stageController": "mc-newton-xyz-stage-main",
      "camera": "lab-camera-main",
      "acquirer": "lab-acquirer-main"
    },
    "environmentNotes": "Replace with workstation state, retries, and operator observations.",
    "notes": "Draft only; operator review pending.",
    "confirmedLaserPowerMw": 1
  }
}
```

建议在 `notes` 或 `hardwareEvidence.environmentNotes` 中至少记录：

- LabSpec / camera / acquirer / stage 的现场环境说明
- 当天的人工观察结论
- 如果 thermal 参与，记录温控稳定判据
- 如果做了异常重试，记录重试是否影响证据可信度

当前 validation record 还会显式固化 `validatedCoverage` 元数据，用来声明这份 record 实际验证过哪些能力面（如 autofocus、XY correction、thermal wait、acquisition）。后续 `raman_check_hardware_validation` 和 runtime gate 都会复核该字段与最小 run spec 是否一致。

当 operator 已完成人工确认后，最终提交给 `raman_record_hardware_validation` 的 payload 形状应接近下面这样：

```json
{
  "tool": "raman_record_hardware_validation",
  "input": {
    "validationId": "raman-v2-prod-20260621-a",
    "approval": {
      "approvalId": "appr-raman-v2-prod-20260621-a",
      "operator": "operator-name",
      "approved": true,
      "notes": "Operator reviewed preflight, active probe, minimum run, calibration, and artifacts."
    },
    "evidence": {
      "readOnlyPreflightReportId": "<dry-run-report-id>",
      "activeProbeRecordPath": ".pi/experiment-runs/maintenance/active-probes/<probeId>/active-probe.json",
      "minimumRamanRunId": "<runId>",
      "xyCalibrationId": "v2-validation-calibration",
      "workflowBackend": "v2_bridge"
    },
    "hardwareEvidence": {
      "evidenceMode": "hardware",
      "observedAt": "2026-06-21T10:00:00.000Z",
      "operatorAttestedRealHardware": true,
      "instrumentIds": {
        "labspecWorkstation": "labspec-workstation-main",
        "stageController": "mc-newton-xyz-stage-main",
        "camera": "lab-camera-main",
        "acquirer": "lab-acquirer-main"
      },
      "environmentNotes": "Replace with final workstation observations."
    },
    "checklist": {
      "laserPowerConfirmed": true,
      "confirmedLaserPowerMw": 1,
      "labSpecWorkerValidated": true,
      "cameraStreamValidated": true,
      "stageMotionValidated": true,
      "windowsPowerPolicyReady": true,
      "operatorReviewedArtifacts": true
    },
    "notes": "Current real-capable Raman V2 validation record."
  }
}
```

### Step 7. 用 `v2ValidationId` 绑定未来真实 V2 运行

只有当 validation record 满足以下条件时，才能作为真实 `v2_bridge` 运行的 gate evidence：

- `productionReady === true`
- `issues.length === 0`
- `hardwareEvidence.evidenceMode === "hardware"`
- `hardwareEvidence.operatorAttestedRealHardware === true`
- `evidence.workflowBackend === "v2_bridge"`

建议在真正调用 `run_experiment` 前，先用 `raman_check_hardware_validation` 对目标 `validationId` 做一次只读复核，确认引用证据没有被后续修改、删除或漂移。若已经有候选 real hardware spec，应该把该 spec 一并传入，让工具同时检查 validation record 的覆盖面是否足以支撑这次运行。

复核时可直接参考下面这类调用：

```json
{
  "tool": "raman_check_hardware_validation",
  "input": {
    "validationId": "raman-v2-prod-20260621-a",
    "workflowBackend": "v2_bridge",
    "spec": "load .pi/extensions/experiment-research/fixtures/raman-v2-real-validation-hardware-spec.json"
  }
}
```

而在首份 production-ready validation record 生成之后，后续真实 V2 run 应切换为下面这种形状，不再使用 `bootstrapV2ValidationRun`：

```json
{
  "tool": "run_experiment",
  "input": {
    "spec": "load .pi/extensions/experiment-research/fixtures/raman-v2-real-validation-hardware-spec.json",
    "hardwareExecution": {
      "stageAdapter": "mc_newton_xyz",
      "raman": {
        "workflowBackend": "v2_bridge",
        "v2ValidationId": "raman-v2-prod-20260621-a",
        "acquisitionBackend": "labspec_file_bridge",
        "autofocusBackend": "labspec_file_bridge",
        "xyCorrectionBackend": "phase_correlation"
      },
      "settleTimeoutMs": 1000,
      "heartbeatTimeoutMs": 10000,
      "maxConsecutiveErrors": 2,
      "approval": {
        "approvalId": "appr-raman-v2-real-run",
        "operator": "operator-name",
        "approved": true,
        "dryRunReportId": "<dry-run-report-id>",
        "ramanSafety": {
          "laserPowerConfirmed": true,
          "confirmedLaserPowerMw": 1,
          "labSpecWorkerReady": true,
          "windowsPowerPolicyReady": true
        }
      }
    }
  }
}
```

如果 spec 启用了 `thermal.waitBeforeAcquisition`，当前 real runtime 会直接拒绝执行，因为 thermal backend 仍是 fake-only。也就是说：

- 可以保留 thermal 作为 future full-surface parity 目标
- 但当前 `G8.5` 的真实硬件 production-ready validation record，不应宣称已经完成 real thermal parity

之后的真实 V2 run 必须在 `hardwareExecution.raman.v2ValidationId` 中显式引用这份 validation record。

## G8 最小证据包

下面是当前 schema 下，一份可被 `v2ValidationId` 引用的最小证据包。它不是“所有可能文件”，而是 runtime gate 和人工审核都必须能追溯到的最小集合。


| 证据对象                     | 当前字段                                 | 最低要求                                                                                                       | 典型归档位置                                                                      |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Dry-run preflight        | `evidence.readOnlyPreflightReportId` | 同 spec 家族；`result.valid === true`；包含 Raman read-only probe；stage 和 LabSpec worker reachable                | `.pi/experiment-runs/preflights/<reportId>/preflight.json`                  |
| Active probe record      | `evidence.activeProbeRecordPath`     | operator-approved；包含真实 frame + spectrum smoke；不得是 fake/synthetic backend                                   | `.pi/experiment-runs/maintenance/active-probes/<probeId>/active-probe.json` |
| Minimum Raman run        | `evidence.minimumRamanRunId`         | real MC.Newton + `workflowBackend: "v2_bridge"` + `labspec_file_bridge` spectrum metadata + completed unit | `.pi/experiment-runs/runs/<runId>/`                                         |
| XY calibration           | `evidence.xyCalibrationId`           | 仅当 `xyCorrection` 启用时必需；不得伪造                                                                               | `.pi/experiment-runs/lab/calibrations/<id>.json`                            |
| Workflow backend binding | `evidence.workflowBackend`           | 对真实 V2 gate 必须是 `"v2_bridge"`                                                                              | validation record 内字段                                                       |
| Hardware observation     | `hardwareEvidence.*`                 | `evidenceMode: "hardware"`、`operatorAttestedRealHardware: true`、真实 instrument IDs、有效 observedAt            | validation record 内字段                                                       |
| Safety checklist         | `checklist.*`                        | 全部 operator 确认，包括 laser power、LabSpec worker、camera、stage、Windows 电源策略、artifact review                     | validation record 内字段                                                       |


## `raman_record_hardware_validation` 字段映射

为了避免 operator 记录时遗漏关键字段，下面给出当前 schema 的最小映射关系：

`raman_prepare_hardware_validation_payload` 会生成与下面结构一致的 schema-valid draft，但默认故意把 `approval.approved`、`hardwareEvidence.operatorAttestedRealHardware` 和 checklist 布尔位保留在未确认状态，要求 operator 在最终记录前逐项确认。

```jsonc
{
  "validationId": "raman-v2-prod-20260621-a",
  "approval": {
    "approvalId": "appr-raman-v2-prod-20260621-a",
    "operator": "operator-name",
    "approved": true
  },
  "evidence": {
    "readOnlyPreflightReportId": "<dry-run-report-id>",
    "activeProbeRecordPath": ".pi/experiment-runs/maintenance/active-probes/<probeId>/active-probe.json",
    "minimumRamanRunId": "<runId>",
    "xyCalibrationId": "<optional-when-xy-enabled>",
    "workflowBackend": "v2_bridge"
  },
  "hardwareEvidence": {
    "evidenceMode": "hardware",
    "observedAt": "2026-06-21T10:00:00.000Z",
    "operatorAttestedRealHardware": true,
    "instrumentIds": {
      "labspecWorkstation": "<id>",
      "stageController": "<id>",
      "camera": "<id>",
      "acquirer": "<id>"
    },
    "environmentNotes": "Optional notes about workstation, thermal state, retries, or operator observations."
  },
  "checklist": {
    "laserPowerConfirmed": true,
    "confirmedLaserPowerMw": 1,
    "labSpecWorkerValidated": true,
    "cameraStreamValidated": true,
    "stageMotionValidated": true,
    "windowsPowerPolicyReady": true,
    "operatorReviewedArtifacts": true
  },
  "notes": "Optional validation summary."
}
```

## G8 通过标准

满足下面条件，才能认为 G8.4 已经定义完毕，且 G8.5 可以开始执行：

- runbook 明确规定了 dry-run preflight、active probe、optional calibration、minimum Raman run、validation record 的顺序
- minimum evidence package 与当前 `RamanHardwareValidationParamsSchema` 一一对应
- 明确说明 minimum Raman run 必须覆盖 spec 中启用的 V2 能力，而不是只采一条谱
- 明确说明 validation record 的存储位置和后续 `v2ValidationId` 绑定方式
- 明确禁止用 fake backend、旧 V1 smoke、或不匹配 specHash 的记录充当 V2 parity evidence

## V2 验收标准

- 每个 side-effecting primitive 都有 action contract、timeout、标准错误码、progress/cancel 语义。
- TS snapshot 能覆盖 point index 之外的 microstep，至少覆盖 autofocus 扫描步、XY 校正、谱采集 lifecycle。
- Python Bridge 拒绝冲突命令，并能在 stop/cancel 时执行 best-effort 安全动作。
- fake bridge 回归覆盖：autofocus 中途 crash、move 后 capture 前恢复、acquire 中途 abort、并发 motion/acquisition 被拒绝。
- 真实硬件验收前，不删除 V1 `raman_bridge.py`；V2 与 V1 双轨记录必须能被同一 `analyze_run` 聚合。
- G8 的 production-ready 证据必须显式包含 `workflowBackend: "v2_bridge"` 的 minimum Raman run validation record；真实硬件 `v2_bridge` 运行必须提供 `hardwareExecution.raman.v2ValidationId`，避免把 V1 smoke record 或未审核 run record 误判为 V2 parity。
