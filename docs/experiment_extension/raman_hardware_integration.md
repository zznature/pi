# Raman 硬件动作与算法接入方案

本文记录 `docs/Raman` 参考栈（stage 运动、autofocus、XY 校正、LabSpec 谱采集）接入
`.pi/extensions/experiment-research` 的工程设计与当前进展。上层契约（准入链、kernel 协议、
事件驱动唤醒、ToolResult 双通道）沿用 `pi_agent_experiment_research_adaptation.md`，
本文只解决"硬件动作和算法以什么粒度、经什么进程边界进入 kernel"。

## docs/Raman 能力盘点

按"接入形态"把 Raman 栈分为三类，这决定每个能力放在边界的哪一侧：

### A 类：原子硬件动作（单次设备 I/O）

| 动作 | 实现 | 传输 | 关键参数/单位 |
| --- | --- | --- | --- |
| XYZ 移动 + settle | `MCNewtonXYZStageController.move_absolute_um/wait_settled` | RS-232 串口（µm，内部转 mm） | 容差 1.0 µm，稳定阈值 0.2 µm |
| 位置读取 | `get_position_um()` | 串口 `[check:pos?]` | µm |
| 急停 | `stop()` | 串口 `[stop]`，best-effort 永不抛错 | — |
| 取一帧图像 | `LabSpecFileBridgeFrameProvider.wait_for_next()` | LabSpec 文件桥（request/result JSON + TIFF） | ≥400 ms/帧 |
| 谱采集 | `LabSpecFileBridgeRamanAcquirer.acquire_point()` | LabSpec 文件桥 | integration_time_s（默认 360 s）、accumulations、nm 范围 |

### B 类：复合动作（算法驱动多次设备 I/O，必须整体执行）

| 动作 | 实现 | 内部循环规模 | 失败模式 |
| --- | --- | --- | --- |
| Z autofocus | `AutofocusController.run_single()`：粗扫 → 验证 → 细扫 → 抛物线峰估计 → backlash 补偿 → 终验 | 约 20–30 次 Z 移动 + 60–90 帧 | `NO_PEAK / LOW_CONFIDENCE / OUT_OF_RANGE / STAGE_ERROR / FRAME_ERROR` |
| XY 漂移纠正 | `estimate_and_apply_xy_correction()`：取帧 → phase correlation → 反向移动 | 1 帧 + 1 次移动 | `LowConfidenceError / SingularTransformError` |

### C 类：纯算法（无设备 I/O，numpy/FFT）

- focus metrics（tenengrad、laplacian_variance、brenner、normalized_variance、labspec_spot_compactness）
- phase correlation 平移估计 + 亚像素拟合 + 置信度
- `PixelStageTransform`（2×2 像素↔µm 矩阵及其逆）

C 类是 B 类的内部组件，依赖 numpy，**留在 Python，不移植 TS**。TS 侧只消费数值结果
（focusScore、confidence、shift）。

## 接入原则

```text
TS kernel（experiment-research extension）          Python bridge（raman_bridge.py）
拥有：run 生命周期、events/records、policy、        拥有：设备连接与 I/O、B 类复合动作、
watchdog、limits 校验、lease、审批                  C 类数值算法、异常→错误码映射
            |                                                    |
            +---------- JSON-lines over stdio，unit 级宏命令 -----+
```

- 边界粒度 = **unit 级宏命令**（visit / autofocus / acquire / correct 或其组合），与
  kernel 的 `unitKind=point` 对齐。不暴露 move/snap 级别的细粒度命令给 TS 循环，
  更不暴露给 planner。
- LLM 永远不进入该边界以内；agent 只消费 RunSummary 与 analysis。
- 错误以**枚举错误码**跨边界（见协议节），TS 侧 watchdog、UnitRecord 与 analysis 直接消费，
  不解析 Python traceback 文本。`ToolResult.errorCode` 只承载工具/运行级故障；若要返回
  Raman 专属错误，必须同步扩展 TS schema union。

为什么是长驻 bridge 而不是旧 phase 4 的 per-call `stage_bridge.py`：

1. `spawnSync` 阻塞 Node 事件循环——360 s 积分期间整个 pi 进程冻结（TUI 无响应、
   heartbeat 无法写入、watchdog 误判、intents 无法消费），整体作废"start 与 observe 分离"契约；
2. 每次调用重建进程与串口，丢失 controller 的 settle 收敛状态与帧桥 `connect()` 生命周期；
3. autofocus 等 B 类复合动作是 stage 与 frame 交织的闭环，必须在 Python 内整体执行，
   不能由 TS 跨进程逐步编排，更不能由 LLM 编排。

## Bridge 进程设计

**长驻 `raman_bridge.py`**：kernel 在 run 准入完成后 spawn 一个 bridge 进程
（`child_process.spawn`，非 Sync），run 结束/中止时 shutdown。进程归 run 所有，
与 resource lease 同生命周期。

### 协议：JSON-lines over stdio

```jsonc
// TS -> Python（每行一个请求）
{"id":"c-0007","action":"run_unit","payload":{...}}

// Python -> TS：终结响应（每请求恰好一条）
{"id":"c-0007","ok":true,"result":{...}}
{"id":"c-0007","ok":false,"error":{"code":"autofocus_no_peak","message":"...","detail":{...}}}

// Python -> TS：异步事件（无 id，长动作期间持续发出）
{"event":"heartbeat","ts":1234.5}
{"event":"progress","action":"autofocus","phase":"coarse","step":12,"total":17}
{"event":"progress","action":"acquire_spectrum","elapsedS":42.0,"integrationTimeS":360.0}
```

- bridge 在任何长动作（autofocus 扫描、谱积分轮询）内部以固定节奏（如 2 s）发
  `heartbeat`/`progress` 事件；TS 侧转写入 `events.jsonl` 并刷新 `lastHeartbeatMs`。
  watchdog 的 `heartbeatTimeoutMs` 因此只需大于事件节奏（事件节奏的 3–5 倍，如 10 s），
  与积分时长解耦。
- 请求串行：bridge 同一时刻只执行一个动作（设备本身独占）；TS 侧维护单飞队列。
- bridge 内部分为 **command reader** 与 **action worker**：reader 持续消费 stdin，
  worker 串行动作；reader 收到 `stop` 后只设置共享 abort event，不等待当前动作返回。
- `stop` 是唯一允许插队的请求：动作内部在安全检查点轮询 abort event，收到后调用
  `stage.stop()` 并让当前动作以 `aborted` 终结。这是 abort intent 在 Python 侧的落点。
- 长动作必须尽量实现为可轮询步骤；如果 LabSpec 或外部进程调用是不可中断阻塞调用，
  该段必须显式标记为 non-interruptible，并依赖 timeout + 后置人工恢复，而不是承诺
  `stop` 立即生效。
- stdout 只允许写 JSON-lines 协议；Python logging、依赖版本、traceback 与诊断输出全部写
  stderr，防止普通日志污染 TS 侧协议解析。协议损坏在 TS 侧映射为 `bridge_crashed`。

### Action 集合

| action | payload | result | 对应 Python 实现 |
| --- | --- | --- | --- |
| `connect` | stage{port,channels…}、frames{bridgeDir}、acquirer{bridgeDir} | 各组件连接报告 | `MCNewton…connect()` + `FrameProvider.connect()` |
| `probe` | 同上（readOnly） | `{stage:{reachable,idn}, labspecWorker:{reachable,latencyMs}, outputDirWritable}` | IDN 查询 + 依赖版本 + 目录/worker reachability |
| `active_probe` | `{captureFrame?,acquireSpectrumSmoke?}` | `{artifacts,sideEffects}` | 取帧/短采谱 smoke，需 operator approval |
| `visit_point` | `xUm,yUm,zUm?,settleTimeoutMs` | `{before,after}` 位置 | `move_absolute_um` + `wait_settled` |
| `autofocus` | AutofocusParams 子集（见 domain 块） | `{status,zBestUm,finalScore,confidence,curveArtifact}` | `AutofocusController.run_single()` |
| `acquire_spectrum` | `integrationTimeS,accumulations,fromNm,toNm,savePath,saveFormat` | `{outputPath,metadata}` | `LabSpec…acquire_point()` |
| `xy_correct` | `referenceFramePath,transform(2x2),minConfidence,maxCorrectionUm` | `{shiftUm,confidence,applied}` | `estimate_and_apply_xy_correction()` |
| `run_unit` | `{point, autofocus?, xyCorrection?, acquisition?}` | `UnitRecord`（见下） | 按序组合上述动作 |
| `stop` | — | — | `stage.stop()`，置 abort 标志 |
| `shutdown` | — | — | 断开全部连接，进程退出 |

`run_unit` 是 hardware-pilot 主循环的唯一常规调用；单独的 `visit_point`/`autofocus`/
`xy_correct` 仅供 maintenance 模式和 dry run probe 使用，不进入 planner 路径。

### 错误码映射

| Python 异常 / 状态 | 错误码 | watchdog 语义 |
| --- | --- | --- |
| `StageConnectionError` | `stage_connection_error` | 立即 pause |
| `StageCommandError` | `stage_command_error` | 计入 consecutiveErrors |
| `StageTimeoutError` | `stage_timeout` | 计入 consecutiveErrors |
| `FrameTimeoutError` | `frame_timeout` | 计入 consecutiveErrors |
| `FocusStatus.NO_PEAK` | `autofocus_no_peak` | 按 spec `onFailure` 策略 |
| `FocusStatus.LOW_CONFIDENCE` | `autofocus_low_confidence` | 同上 |
| `FocusStatus.OUT_OF_RANGE` | `autofocus_out_of_range` | 立即 pause（疑似标定/限位问题） |
| calibration `LowConfidenceError` | `calibration_low_confidence` | 跳过纠正并计数 |
| `SingularTransformError` | `calibration_singular_transform` | 立即 pause |
| 采集 `result.ok == false` | `acquisition_failed` | 计入 consecutiveErrors |
| bridge 进程退出/协议损坏（TS 侧产生） | `bridge_crashed` | 立即进入 `recovering` |

这些错误码属于 Raman run 记录与 analysis 层面的 `RamanErrorCode`。只有 `bridge_crashed`、
schema/protocol corruption、preflight fatal 这类工具/运行级故障需要暴露为 `ToolResult.errorCode`；
否则保持在 `UnitRecord.errorCode`，避免扩大通用工具错误码的表面积。

### UnitRecord（HardwarePointRecord 扩展）

```typescript
interface HardwarePointRecord extends ExperimentPoint {
  status: "success" | "error" | "skipped";
  positionBefore?: StagePosition;
  positionAfter?: StagePosition;
  autofocus?: { zBestUm: number; finalScore: number; confidence: number };
  xyCorrection?: { dxUm: number; dyUm: number; confidence: number; applied: boolean };
  spectrum?: { artifactId: string; integrationTimeS: number; accumulations: number };
  errorCode?: RamanErrorCode;
  error?: string;
}
```

谱数据本体（txt/csv 文件）**绝不内联**，按 `ArtifactRef` 落到
`runs/<runId>/artifacts/spectra/point_<n>.<ext>`，record 只存 `artifactId`。
autofocus 的 ScanCurve（诊断用）同样以 artifact 形式存
`artifacts/autofocus/point_<n>.curve.json`。

## ExperimentSpec：domain.raman 扩展块

已实现为 typed `domain.raman` schema（非 free-form passthrough），通用 ExperimentSpec
字段保持稳定：

```jsonc
"domain": {
  "raman": {
    "autofocus": {
      "enabled": true,
      "every": { "kind": "everyNPoints", "n": 1 },   // 或 once | onQualityDrop
      "zMinUm": -50, "zMaxUm": 50,
      "coarseRangeUm": 80, "coarseStepUm": 10,
      "fineRangeUm": 15, "fineStepUm": 2,
      "metric": "labspec_spot_compactness",
      "minConfidence": 0.2,
      "onFailure": "pause"                            // skip_point | pause | abort
    },
    "xyCorrection": {
      "enabled": false,
      "phase": "postFocusCorrection",                  // preCorrection | postFocusCorrection | both
      "transformArtifactId": "cal-20260601-a",        // 引用 lab 级标定 artifact
      "minConfidence": 0.4,
      "maxCorrectionUm": 20
    },
    "acquisition": {
      "integrationTimeS": 10,
      "accumulations": 1,
      "fromNm": 100, "toNm": 3500,
      "saveFormat": "txt"
    }
  }
}
```

### 校验分层落点

- **结构 schema**：`domain.raman` 各块的形状与枚举。
- **spec 语义**（只依赖 spec 自身）：
  - autofocus 扫描窗（每点 z ± coarseRangeUm）⊆ `limits.motion.zUm`；
  - `integrationTimeS * 1000 ≤ limits.acquisition.maxExposureMs`；
  - 单点耗时估计（settle + autofocus 帧数 × 帧间隔 + 积分 × accumulations）×
    总点数 ≤ `stoppingRules.maxRuntimeMinutes`，超出直接拒绝而不是跑到一半超时；
  - `maxCorrectionUm` ⊆ XY 运动限位余量。
- **运行时 policy**：`transformArtifactId` 存在、未过期且与当前物镜/放大倍率匹配；
  capability snapshot 中 LabSpec worker 可用；laser power 审批项已确认（见下）。

## Capabilities 与 Resource Lease

1. `lab-camera`、`lab-acquirer` 为 `hardwarePilotAvailable: true`，并带传输配置
   （LabSpec bridge 目录、帧 pattern、轮询参数）。
2. **复合资源 `labspec-workstation`（exclusive lease）**：stage 串口、LabSpec 帧桥
   和谱采集共享同一台 LabSpec 工作站与同一个 VBS worker，视频流与谱采集很可能互斥。
   三者作为一个 lease 整体获取，杜绝"一个 run 在对焦取帧、另一个 run 在采谱"。
3. **laser power 无法软件强制**：`request_labspec_spectrum.py` 没有功率参数，激光功率
   在 LabSpec 内手动设置。因此 `maxLaserPowerMw` 从软件 limits 语义降级为
   **approval checklist 项**：hardware 审批时 operator 必须确认当前功率 ≤ spec 限值，
   approval record 记录确认值（`ramanSafety` 确认块）。capability 的 `hazards` 字段声明
   这一点，policy 检查 approval record 中存在该确认，而不是假装软件能拦截。

## hardware-pilot 主循环

```text
准入链通过 -> spawn raman_bridge -> connect -> (异步循环，不阻塞事件循环)
for each point（从 resumeFrom 起）:
  消费 intents（pause/abort 在此边界生效）
  watchdog.evaluate()
  bridge.run_unit({ point, autofocus?, xyCorrection?, acquisition? })
       期间持续收 heartbeat/progress -> 写 events.jsonl
  写 unit_completed / unit_error 事件 + UnitRecord
run 终态 -> bridge.shutdown -> 释放 lease -> watcher 经 sendMessage 唤醒 agent
```

- 整个循环是 **async 后台任务**，`run_experiment` 启动后立即返回 `runId`，与适配方案的
  事件驱动唤醒一致。`poll_run` 是 operator/watchdog 工具（不在 planner 集合），只读 RunState。
- unit 内部默认顺序固定为 **move predicted XYZ → autofocus → capture reference frame →
  postFocusCorrection → optional verify → acquire**，由 bridge 的 `run_unit` 实现，TS 不参与
  单元内编排。原因是 autofocus 的 Z 移动和图像重取可能引入 XY 漂移；把唯一的
  `xyCorrection` 默认放在 autofocus 前会把采谱坐标锁在旧帧上。若确有粗略预纠偏需求，
  用 `xyCorrection.phase=preCorrection|postFocusCorrection|both` 显式表达。
- abort 路径双保险：intents 在 unit 边界生效（现有机制）；unit 内部经 bridge `stop`
  请求在动作安全检查点生效（autofocus 扫描步间、积分轮询间）。
- bridge 进程意外退出：TS 侧立即把 run 标记 `failed`（或带 resume snapshot 的
  `paused`），lab state 进入 `recovering`，禁止静默重启 bridge 续跑。

### watchdog 规则

- `autofocus confidence` 连续 N 点低于 baseline 比例 -> pause（疑似样品漂移/失焦）。
- `xy_correct` 纠正量连续增长或超过 `maxCorrectionUm` -> request_operator（疑似标定失效）。
- `frame_timeout`/`stage_timeout` 计入现有 consecutiveErrors。

## analyze_run 扩展

保持"确定性代码、不进 LLM"的纪律：

- bridge 在采集时顺带计算并随 result 返回轻量指标（总强度、估计 SNR、饱和标志），
  进入 UnitRecord —— 数值在 Python 算（有 numpy），TS 只聚合。
- `QualityMetrics` 含 focus confidence 统计、纠正量漂移趋势、SNR 分布
  （`meanSnrEstimate`、`minSnrEstimate`、`saturatedSpectra`）。
- `plan_next_experiment` 的 domain 策略含 `refocus_and_repeat`、
  `increase_integration_time`（编译期映射为新 spec 的 `acquisition.integrationTimeS`，
  仍受 limits 约束）。

## Dry run：两级 probe

- `readOnlyProbe` 用于 dry run gate：串口 IDN 查询成功（连接后立即断开，不发运动命令）；
  Python 依赖版本可读；输出目录可写、bridge 目录存在；LabSpec worker 可达性检查不触发
  取帧或采谱。结果与 canonical `specHash`、capability snapshot 一起写入 preflight report，
  满足 hardware gate 既有要求。
- `activeProbe` 仅用于 maintenance/operator approval：经 operator-only `raman_active_probe`
  工具取一帧即弃、启动/停止视频流或短采谱 smoke test，side effect、artifact 与
  operator approval 全部写入记录。dry run 永不触发 active probe。

## 标定 artifact：来源与持久化

`PixelStageTransform` 的 `pixel_per_um` 矩阵在 `docs/Raman` 中只有消费端，生成流程
设计为 maintenance 模式的 operator 工作流（不经 planner）：

```text
operator 触发自动标定（maintenance 工具）
  -> bridge：取参考帧 -> 已知步距移动（如 ±20 µm 十字）-> 每步取帧 + phase correlation
  -> 最小二乘拟合 2x2 矩阵 -> 写 .pi/experiment-runs/lab/calibrations/<id>.json
     { matrix, objective/magnification, createdAt, validUntil?, confidence }
```

三个 operator-only 工具覆盖不同输入形态：

- `raman_record_xy_calibration`：直接记录已知矩阵为 artifact；
- `raman_fit_xy_calibration`：从非共线 stage shifts + reference/current frame pairs
  做 phase correlation + 最小二乘拟合后记录；
- `raman_auto_xy_calibration`：自动驱动 stage 十字步距、采帧、拟合、记录的完整序列。

spec 经 `transformArtifactId` 引用；preflight 校验存在性、矩阵可逆性与时效；hardware run
在未提供维护 override 时从该 artifact 读取矩阵。标定 artifact 绑定物镜元数据，
policy 校验与当前物镜/倍率匹配。

## 开发进展（截至 2026-06）

软件侧（自动化门槛）已全部落地，`node --test` 回归覆盖 phase4–7 共 50 个测试通过，
其中 `test/phase7.test.ts` 为 Raman 专项：

- **契约**：typed `domain.raman` schema + 语义校验（扫描窗、曝光、总时长估计、纠正余量）；
  Raman hardware policy 强制 `labspec-workstation` lease、采集要求 acquirer、
  autofocus/XY 要求 camera；`ramanSafety` 激光功率审批 gate；dry-run 与 hardware spec
  的 canonical `specHash` 一致性 gate。fixtures：`raman-dry-run-spec.json`、
  `raman-hardware-spec.json`。
- **Python 依赖**：`docs/Raman/mapping/` helper 自包含落地（request/result model、
  LabSpec helper），`raman_bridge.py` 及 autofocus/microscope/acquire-spectrum 文件桥
  模块在无硬件环境可导入；bridge `connect` 上报 numpy/PIL/pyserial 版本。
- **Bridge**：长驻 `raman_bridge.py` + JSON-lines 协议 + stderr-only 诊断 +
  reader/worker/stop 模型；TS 侧 `RamanBridgeClient`（`kernel/raman-bridge.ts`）；
  错误码 union 落入 `schemas.ts`。
- **异步硬件循环**：`run_experiment(mode=hardware)` 对 Raman spec 走 bridge-backed
  async loop，立即返回 `runId`；resume snapshot、intents/abort、`bridge_crashed` → failed
  均已实现（`kernel/raman-hardware.ts`）。
- **谱采集**：`acquire_spectrum` / `run_unit(visit+acquire)` 双后端——`fake`（无硬件回归）
  与 `labspec_file_bridge`（LabSpec worker request/result 目录协议）；SNR/saturation
  metadata 进 UnitRecord 与 analysis 聚合。
- **Autofocus**：fake + 真机可用 `labspec_file_bridge` 后端；`autofocus_*` 错误码；
  focus confidence 进 records/analysis。
- **XY correction**：fake + `phase_correlation` 后端；三个标定工具（record/fit/auto）；
  preflight 拒绝缺失/不可逆/过期 `transformArtifactId`；correction metadata 贯穿
  run records 到 analysis。
- **Productization 门禁**：operator-only `raman_record_hardware_validation` 汇集
  read-only preflight、active smoke、最小 Raman run、可选 calibration 与 checklist
  evidence，`evidenceDigest`（SHA-256）固定引用内容，拒绝 fake/memory 证据、缺失数据
  文件或拼接证据成为 `productionReady`，并要求 preflight 与最小 run 的 `specHash` 一致。
- **工具注册面**：planner 宏工具集不含任何 Raman 专属工具；operator-only 工具为
  `raman_active_probe`、三个标定工具、`raman_record_hardware_validation`，`poll_run`
  同属 operator/watchdog 集合（planner 不轮询，靠事件驱动唤醒回报）。

## TODO：真机验收

软件路径已就绪但**尚无真实仪器执行记录**的部分，按依赖序排列（一次现场窗口可顺序覆盖）：

1. **LabSpec worker 互通**：fake worker 替换为真实 worker 后，request/result 字段无需
   改 schema 即可互通；验证视频流与谱采集是否互斥——若互斥，`run_unit` 在采谱前
   stop_video、采后恢复，时序全部在 bridge 内。
2. **长积分行为**：真实积分期间 TUI/`poll_run` 不冻结；operator abort 在安全检查点
   生效，或对不可中断阻塞段明确走 timeout + 人工恢复路径。
3. **最小采谱 run**：operator 手动对焦后对 1–3 个点采谱；run 目录含完整 records、
   谱 artifact 与 approval；谱文件可被 LabSpec/下游脚本读取；失败时错误码为
   `acquisition_failed` 而非 Python traceback。这是第一个有科学产出的里程碑。
4. **真实 autofocus**：真实相机流下完成粗扫/细扫，最终 Z 回到 `zBestUm`；
   低置信度/无峰时按 spec `onFailure` 执行 pause/skip/abort。
5. **真实 XY 标定与纠正**：MC.Newton + LabSpec 自动标定序列（operator 监督）；
   用已知位移或标定片验证 correction 方向和幅值；超过 `maxCorrectionUm` 时不移动
   并触发 operator 检查。
6. **production-ready validation record**：用现场证据（至少各一次 read-only probe、
   active smoke、最小 Raman run）生成首份 `productionReady` validation record，
   人工确认 laser power、LabSpec worker、Windows sleep/lock 策略、instrument IDs
   与 `operatorAttestedRealHardware`。
7. **`stage_bridge.py` 退役**：stage-only 真机 parity 通过后移除旧 per-call 路径。

需真机才能回答的开放问题：

| 开放问题 | 现有兜底 |
| --- | --- |
| LabSpec 视频流与谱采集是否互斥 | TODO 1 现场验证；互斥则 bridge 内编排 stop/restart video |
| 360 s 级积分期间 Windows 睡眠/锁屏 | operator checklist 项；watchdog heartbeat 缺失会暴露 |
| COM 口被 LabSpec 或其他程序占用 | probe 阶段即失败（`stage_connection_error`），不进入运行期 |
| bridge 崩溃后设备实际状态 | lab state `recovering` + 人工恢复；禁止自动重连续跑 |
| 标定矩阵随物镜/倍率失效的实际幅度 | artifact 绑定物镜元数据 + policy 匹配校验；现场标定验证 |
