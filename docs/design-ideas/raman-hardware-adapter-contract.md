# Raman 硬件与 Tool 接入方案

本文不讨论 kernel 的执行状态机。那部分已经在 `kernel-execution-model.md` 里定义。

本文只回答下面这个问题：

> 以 Raman 为例，一类真实硬件应该怎样接进系统，变成 runtime 可调用的 driver、composite action 和 tool surface？

因此这里的重点是：

- 真实硬件资源如何注册
- Python 脚本如何收敛成 driver
- 哪些能力暴露成 runtime action
- 哪些能力暴露成 planner / operator tool
- 哪些底层能力必须永远不暴露给 Agent

## 1. Raman 在整个设计里的角色

Raman 不是最终架构本身，而是第一块真实硬件样板。

它的价值是：

1. 有实验室里已经试过的 Python 硬件脚本
2. 同时包含多类能力：
   - stage
   - frame capture
   - autofocus
   - XY correction (future/reference only)
   - spectrum acquisition
3. 足够复杂，能逼出一套通用硬件接入边界

所以本文的正确目标不是“把 Raman 做成一个特例系统”，而是：

> 用 Raman 逼出通用硬件接入方案中最难的那部分：真实设备、driver、runtime action、tool surface 的分层。

## 2. 文档分工

为了避免和 `kernel-execution-model.md` 重复，先明确两篇文档各自回答什么。

### `kernel-execution-model.md` 回答

- kernel 怎么编译 `ProcedureSpec`
- `ExecutionUnit` 粒度怎么设计
- run lifecycle 怎么设计
- kernel 和 runtime contract 怎么定义

### 本文回答

- Raman 资源对象长什么样
- `docs/Raman` 哪些脚本属于 driver，哪些属于 composite action
- 哪些能力变成 runtime action
- 哪些能力变成 tool
- planner / operator 分别能看到什么

## 3. 第一性原理

真实硬件接入最容易犯的错误有两个：

1. 把 Python 硬件脚本直接暴露给 Agent
2. 把领域脚本直接当作最终 runtime / kernel

这两条都不成立。

正确拆分应该是：

- `docs/Raman` 提供真实硬件控制能力
- Hardware Runtime 持有 driver session 并调度 action
- Tool surface 只暴露上层真正需要的入口

因此本文坚持三个硬约束：

1. **Raman 脚本不是 planner tool**
2. **Raman 的多点 workflow 不能直接当 kernel**
3. **tool 暴露实验能力，不暴露驱动细节**

## 4. Raman 现有能力盘点

`docs/Raman` 当前已经有几类可复用能力：

| 能力域 | 主要文件 | 当前性质 |
| --- | --- | --- |
| stage | `stage/models.py`, `stage/mc_newton_xyz_stage.py` | 真实 XYZ stage driver |
| autofocus frame bridge | `autofocus/labspec_file_bridge.py` | LabSpec worker frame provider |
| autofocus logic | `autofocus/models.py`, `autofocus/scanner.py`, `autofocus/controller.py` | 单点 autofocus 复合动作 |
| XY correction | `calibration/xy_corrector.py`, `calibration/stage_adapter.py` | reference-only; not part of MVP runtime surface |
| spectrum acquisition | `mapping/labspec.py`, `acquire-spectrum/request_labspec_spectrum.py` | 单点采谱 |
| mapping reference | `mapping/planner.py`, `mapping/runner.py` | 领域参考实现，不是最终 kernel |

这里最关键的判断是：

- `mapping/runner.py` 有参考价值
- 但它不是最终实验执行器

因为它把 workflow state 藏在 Python 循环里，这和新的 kernel 分层冲突。

## 5. Raman 资源注册

Raman 接入的第一步不是写 tool，而是把真实硬件描述成稳定资源。

建议最少定义三类资源：

1. `stage`
2. `frame_provider`
3. `spectrometer`

如果未来把 camera、temperature controller、laser interlock 单独抽出，也应继续沿用同样模式。

### 5.1 示例：stage 资源

```yaml
resourceId: mc_newton_xyz_main
kind: stage
runtime: raman_python
driver: mc_newton_xyz
config:
  port: COM5
  xChannel: 1
  yChannel: 2
  zChannel: 3
  baudrate: 115200
leasePolicy: exclusive
simulationAvailable: true
limits:
  xRangeUm: [0, 50000]
  yRangeUm: [0, 50000]
  zRangeUm: [0, 5000]
```

### 5.2 示例：frame provider 资源

```yaml
resourceId: labspec_frame_main
kind: frame_provider
runtime: raman_python
driver: labspec_file_bridge_frame
config:
  bridgeDir: D:\\RamanLab\\SpecBridge
  imageFormat: tif
  minCaptureIntervalMs: 400
leasePolicy: shared-read
simulationAvailable: false
```

### 5.3 示例：spectrometer 资源

```yaml
resourceId: labspec_main
kind: spectrometer
runtime: raman_python
driver: labspec_file_bridge_spectrum
config:
  bridgeDir: D:\\RamanLab\\SpecBridge
  requestFilename: spectrum_request.ini
  resultFilename: spectrum_result.ini
leasePolicy: exclusive
simulationAvailable: false
```

关键原则：

- planner 不直接写这些 config
- `ProcedureSpec.resources` 只引用 `resourceId`
- runtime 负责把 `resourceId` 解析成真实 driver session

### 5.4 实验室默认配置与本地覆盖

Raman MVP rebuild 将实验室稳定硬件事实固化在可提交配置中：

```text
.pi/raman-lab-config/raman-runtime.lab.json
```

该文件表达实验室默认资源、driver、端口、bridge 目录和 stage limits。
LabAgent 初始化时加载它，把设备能力与边界带入上下文。

如果某台机器需要临时覆盖端口、路径或启用状态，使用 git-ignored 本地文件：

```text
.pi/raman-lab-config/raman-runtime.local.json
```

加载优先级固定为：

```text
raman-runtime.local.json > raman-runtime.lab.json > no live runtime
```

这避免把临时现场调整写回实验室默认配置，同时让设备少变的实验室环境具备稳定初始化上下文。

## 6. Raman Driver 分层

本文把 Raman 接入分成三层：

1. `DeviceDriver`
2. `CompositeAction`
3. `Tool Surface`

### 6.1 `DeviceDriver`

贴近设备原语，不理解实验目标。

#### Stage Driver

建议基于：

- `docs/Raman/stage/models.py`
- `docs/Raman/stage/mc_newton_xyz_stage.py`

对外统一成少量稳定操作：

- `connect`
- `get_position`
- `move_absolute_and_wait`
- `move_relative_and_wait`
- `stop`
- `disconnect`

#### Frame Driver

建议基于：

- `docs/Raman/autofocus/labspec_file_bridge.py`

对外统一成：

- `connect`
- `capture_latest`
- `disconnect`

不要把“启动 video session 后轮询 frame 文件夹”的细节泄漏给上层。

#### Spectrum Driver

建议基于：

- `docs/Raman/mapping/labspec.py`
- `docs/Raman/acquire-spectrum/request_labspec_spectrum.py`

对外统一成：

- `acquire_spectrum`
- `cancel_current`

MVP 不必一开始拆到 `begin / poll / collect`。

### 6.2 `CompositeAction`

这是比 driver 更高一层的设备侧有界动作。

#### Autofocus

基于：

- `autofocus/controller.py`
- `autofocus/scanner.py`
- `autofocus/models.py`

建议暴露为一个动作：

- `autofocus.run_single`

返回：

- `status`
- `zBestUm`
- `finalScore`
- `confidence`
- `coarseCurveArtifact?`
- `fineCurveArtifact?`
- `message`

#### XY Correction（MVP 不实现，reference-only）

> XY correction 在当前 MVP 不接入。本小节保留为 reference，用于未来 mapping 累积误差补偿增量。详见 `implementation-plan.md` 的 Open issues。

基于：

- `calibration/xy_corrector.py`
- `calibration/stage_adapter.py`

未来若启用，建议暴露为：

- `xy_correction.estimate_and_apply`

返回：

- `dxUm`
- `dyUm`
- `confidence`
- `referenceFrameArtifact`
- `currentFrameArtifact`

#### Spectrum Acquisition Wrapper

基于：

- `LabSpecFileBridgeRamanAcquirer.acquire_point()`

建议暴露为：

- `spectrometer.acquire_spectrum`

返回：

- `status`
- `outputPath`
- `requestId`
- `workerResult`
- `durationS`
- `plotArtifact?`

### 6.3 `Tool Surface`

tool 不是 driver API 的镜像。

tool 要回答的是：

- planner 在实验层需要什么能力
- operator 在维护层需要什么能力

而不是：

- 哪些 Python 函数存在

## 7. Planner / Operator Tool 分工

Raman 接入至少应区分两类 tool surface。

### 7.1 Planner-Facing Tools

planner 只能看到实验管理和实验能力入口，例如：

- `get_lab_capabilities`
- `validate_experiment_spec`
- `run_preflight`
- `run_experiment`
- `analyze_run`
- `plan_next_experiment`

这些 tool 的重点是：

- 让 planner 生成与发起 `ProcedureSpec`
- 不让 planner 直接碰 Raman driver

### 7.2 Operator / Maintenance Tools

operator 需要的不是完整实验入口，而是现场维护与证据链工具，例如：

- `poll_run`
- `pause_run`
- `abort_run`
- `raman_get_hardware_status`
- `raman_get_stage_position`
- `raman_stage_move_relative`
- `raman_active_probe`
- `raman_record_xy_calibration`（MVP 不实现，随 XY correction 一并推迟）
- `raman_fit_xy_calibration`（MVP 不实现，随 XY correction 一并推迟）
- `raman_check_hardware_validation`

这些 tool 可以有更明确的硬件意味，但仍然不应退化成裸驱动命令。
其中 `raman_stage_move_relative` 属于 operator 确认后的 stage-only nudge：
它应读取当前位置、计算目标、用 runtime stage resource limits 做硬边界校验；
它不应为了单轴移动构造 Raman 采谱 `ProcedureSpec`，也不应要求 frame provider / spectrometer 参与。

### 7.3 明确不暴露为 Planner Tool 的能力

下面这些不能直接给 planner：

- `move_absolute_um`
- `move_relative_um`
- `serial_send`
- `write_request_file`
- `set_laser_register`
- `start_video_session`
- `glob("frames/*.tif")`

如果这些能力进了 planner surface，Agent 就会直接开始拼驱动调用。

## 8. Raman Runtime Action 面

tool surface 之下，runtime 需要稳定 action contract。

建议 Raman runtime 至少收敛成下面几类 action：

### Stage

```text
stage.get_position
stage.move_absolute_and_wait
stage.move_relative_and_wait
stage.stop
```

### Frame

```text
frame.capture_latest
```

### Autofocus

```text
autofocus.run_single
```

### XY Correction（MVP 不实现，reference-only）

```text
xy_correction.estimate_and_apply
```

### Spectrometer

```text
spectrometer.acquire_spectrum
spectrometer.cancel_current
```

这些 action 是 runtime contract，不是 planner tool 名称。

## 9. Raman `ProcedureSpec` 里的领域参数应该怎样放

Raman 的领域参数应收敛在 typed `domain` block 里，而不是散落在顶层或工具参数里。

示例：

```yaml
procedureId: raman_grid_mapping
resources:
  stage: mc_newton_xyz_main
  spectrometer: labspec_main
  frameProvider: labspec_frame_main
limits:
  maxLaserPowerMw: 1.0
  minObjectiveClearanceUm: 200.0
  # maxXyCorrectionUm: 5.0  # MVP 不实现，随 XY correction 一并推迟
plan:
  kind: grid_scan
  grid:
    origin: { xUm: 1000, yUm: 2000 }
    rows: 10
    cols: 10
    pitchXUm: 5
    pitchYUm: 5
    order: snake
  perPoint:
    - kind: move_to_point
    - kind: autofocus
    - kind: capture_frame
    - kind: acquire_spectrum
domain:
  raman:
    autofocus:
      enabled: true
      roi: { x: 200, y: 120, width: 180, height: 180 }
      params:
        coarseRangeUm: 80
        coarseStepUm: 10
        fineRangeUm: 15
        fineStepUm: 2
    # xyCorrection: MVP 不实现（reference-only），启用前不要把 apply_xy_correction 放进 perPoint
    # xyCorrection:
    #   enabled: true
    #   minConfidence: 0.4
    #   maxCorrectionUm: 5.0
    #   calibrationId: xy-calib-202606
    acquisition:
      integrationTimeS: 10
      accumulations: 1
      saveFormat: txt
      timeoutS: 30
      laserPowerMw: 0.5
```

关键边界：

- `domain.raman` 承载 Raman 特有参数
- resource config 不由 planner 自由填写
- `laserPowerMw` 是请求值
- `limits.maxLaserPowerMw` 是安全上界

## 10. 预检与维护工具如何接 Raman

Raman 是真实硬件，因此只靠 `approve_and_start_run` 不够，还需要 operator-only 的维护入口。

### 10.1 Read-Only Preflight

应检查：

- stage 能否连接并读位置
- frame bridge 目录可用性
- spectrum bridge 目录可用性

MVP rebuild 中，普通状态读取应优先通过 operator tool 完成：

- `raman_get_hardware_status` 返回 runtime 注册状态、preflight readiness、control availability、资源 id 和当前 stage position（若可读）。
- `raman_get_stage_position` 只读取当前 X/Y/Z 坐标。

这两类读取不应要求 agent 构造 `ProcedureSpec`，也不应退回 legacy bridge。

### 10.1.1 Confirmed Stage Nudge

实验现场常见的“小幅移动 stage”不是 Raman 采谱 run。
MVP rebuild 应提供单独的 operator tool：

- 输入：`axis`、`deltaUm`、可选 `timeoutMs`、确认标志
- 读取当前 stage position
- 计算目标 position
- 校验 runtime stage resource limits
- 未确认时只返回目标和风险，不执行移动
- 确认后调用 runtime `stage.move_absolute_and_wait`

该入口仍然是受控硬件动作，但不属于 `raman_single_point_probe`、`raman_parameter_search` 或 `raman_grid_mapping`。

### 10.2 Active Probe

应允许 operator 显式做：

- 抓一张真实 frame
- 做一条最小 smoke spectrum

但这类动作不能混入 planner 的 dry-run 语义。

### 10.3 Calibration Tools（MVP 不实现，随 XY correction 一并推迟）

> 标定工具链服务于 XY correction，当前 MVP 不接入。本小节保留为 reference。

Raman 特有但很现实的一类维护操作是标定：

- 记录 XY calibration
- 拟合 calibration
- calibration artifact review is future/reference only

这些操作不属于 planner 的日常实验策略，而属于 operator / maintenance surface。

## 11. Artifact 策略

Raman 接入时，必须明确哪些产物由 runtime 产出并登记。

MVP 最小必需产物应包括：

- frame 原图
- autofocus coarse/fine 曲线
- spectrum 原始 txt
- spectrum plot
- LabSpec request/result 文件

> `XY correction reference/current frame` artifacts remain future/reference only and are outside the MVP artifact baseline.

这里的原则是：

- 产物可以由 runtime 生成
- 但必须通过结构化 artifact ref 回流
- 不能靠 message 文本告诉上层“文件大概在某个目录里”

## 12. 错误模型

Raman 接入必须把 Python 异常归一化成结构化错误码，而不是把 traceback 暴露给 kernel 或 Agent。

MVP 最小错误模型建议至少区分：

- `stage_connection_error`
- `stage_timeout`
- `frame_timeout`
- `autofocus_no_peak`
- `autofocus_low_confidence`
- `spectrum_request_pending`
- `spectrum_timeout`
- `worker_result_error`
- `bridge_protocol_error`

> `xy_correction_low_confidence` remains a future/reference error code and is outside the MVP error surface.

并且每个错误至少带：

- `retrySafe`
- `needsOperator`
- `safeToResume`

## 13. 为什么 `mapping/runner.py` 只能作为参考

这件事必须写清楚，否则后面很容易走回头路。

`docs/Raman/mapping/runner.py` 的优点是：

- 点执行顺序明确
- point record 结构清晰
- 离线验证方便

但它仍然只能做参考实现，因为：

1. 它持有多点 workflow loop
2. 它没有统一的 kernel-level pause / abort / resume 契约
3. 它不是围绕 `ProcedureSpec -> ExecutionUnit[]` 设计的

因此正确做法是：

- 借鉴它的 point sequencing
- 借鉴它的 point record
- 不直接把它当最终 runtime 或 kernel

## 14. 推荐实施顺序

### Phase 1: 收敛 Raman 资源对象

先固定：

- stage 资源
- frame provider 资源
- spectrometer 资源

### Phase 2: 收敛 Raman Drivers

先完成：

- stage driver
- frame driver
- spectrum driver

### Phase 3: 收敛 Composite Actions

再完成：

- autofocus
- single spectrum acquisition wrapper
- （XY correction 推迟，MVP 不实现）

### Phase 4: 收敛 Tool Surface

分别整理：

- planner-facing experiment tools
- operator-facing maintenance tools

### Phase 5: 校验能否推广到下一类设备

只有当这套分层能平移到温控台、电化学或别的仪器时，才说明 Raman 样板没有长成特例。

## 15. 结论

`raman-hardware-adapter-contract.md` 应该收敛到下面这句话：

> Raman 的任务不是定义 kernel，而是把真实硬件资源、Python 驱动、设备侧复合动作和 planner/operator tool surface 串起来，形成一套可复用的接入模板。

kernel 的编译、执行、状态机和恢复边界，交给 `kernel-execution-model.md`。
