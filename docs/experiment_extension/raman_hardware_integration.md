# Raman 硬件动作与算法接入方案 (V2 架构：Thin HAL + TS Orchestrator)

本文记录 `docs/Raman` 参考栈（stage 运动、autofocus、XY 校正、LabSpec 谱采集）以及未来更多实验设备接入 `.pi/extensions/experiment-research` 的 V2 架构设计与重构方案。

上层契约（准入链、kernel 协议、事件驱动唤醒、ToolResult 双通道）沿用原有设计。本文重点解决 **"多设备高扩展性、长周期稳定性的控制权分配与通信架构"**。

## 核心架构理念：控制倒置 (Invert of Control)

**V1 架构（现状）**：Fat Python, Thin TS。Python 端承担了过多的业务编排（如 `run_unit`、`autofocus` 循环），导致设备紧耦合、错误恢复困难、难以接入新仪器。
**V2 架构（重构目标）**：Thin HAL (Python), Fat Orchestrator (TS)。Python 降级为纯粹的 RPC 设备网关；所有复合流程在 TS 层以 `async/await` 形式编排。LLM (Agent) 在 TS 层上方提供宏观纠错与实验策略。

```text
LLM Agent (Strategy & Recovery)
       │ (通过粗粒度 Tools / 细粒度 Probe Tools)
TS Kernel (Orchestrator & State Machine)
       │ - 负责：并发锁、长周期 Resume 状态机、Autofocus 等复合流程循环
       │ - 负责：Watchdog 评估、向 LLM 投递恢复请求
       │ (JSON-RPC over stdio / 高频原子命令 / < 5ms 延迟)
Python Bridge (Thin Hardware Abstraction Layer)
       │ - 统一的 Device Registry 路由
       │ - A 类原子动作：stage.move, camera.capture
       │ - C 类无状态算法：algorithm.calc_focus, algorithm.phase_correlation
```

## 能力盘点与边界重新划分

我们将所有能力拆解为极简的原语，供 TS 层组装：

### A 类：原子硬件动作（Python HAL 执行）
设备驱动仅暴露无副作用的单次 I/O，**不包含任何重试或循环逻辑**。

| 设备域 | 原子动作 | 传输/耗时预期 |
| --- | --- | --- |
| `stage` | `move_absolute(x,y,z)`, `wait_settled()`, `stop()`, `get_position()` | 毫秒级 RPC + 机械耗时 |
| `camera` | `wait_for_next_frame()` | ≥400 ms/帧 |
| `spectrometer` | `acquire_point(time, accums)` | 积分耗时 (可达数分钟) |
| `thermal` (未来) | `set_target_temp(t)`, `get_current_temp()` | 毫秒级 RPC |

### C 类：无状态纯算法（Python 侧算力服务）
依赖 `numpy`/`FFT` 的重计算留在 Python，但**不直接关联硬件**。TS 传入数据（如图片路径/数组），Python 返回计算结果。

| 算法域 | 动作 | 输入 -> 输出 |
| --- | --- | --- |
| `focus_metric` | `calc_score` | `image_path` -> `score, confidence` |
| `drift_correction`| `phase_correlation` | `ref_img, cur_img, matrix` -> `dx, dy, confidence` |
| `calibration` | `fit_matrix` | `shifts_array` -> `2x2_matrix, residuals` |

### B 类：复合业务流程（**全部上移至 TS 层编排**）
以前在 Python 中的长逻辑，现在由 TS 的 `async/await` 控制。

| 流程 | TS 侧伪代码逻辑 | 优势与稳定性增强 |
| --- | --- | --- |
| **Z Autofocus** | `for (z in range) { await stage.move(z); img = await camera.capture(); score = await alg.calc(img); }` | 避免 Python GIL 阻塞；TS 端捕获 `FRAME_TIMEOUT` 可立即触发 Agent 级恢复策略。 |
| **XY 校正** | `img = await camera.capture(); shift = await alg.phase_corr(ref, img); await stage.move(shift)` | 灵活的介入点。如果置信度极低，TS 可以直接挂起任务并向 LLM 请求人工确认。 |
| **Run Unit** | `await focus(); await correct_xy(); await acquire();` | 方便插入新设备的等待逻辑（例如：在采谱前 `await thermal.wait_stable()`）。 |

## 稳定性与长周期实验保障 (Reliability & Resume)

长周期实验（几十小时甚至数天）的稳定性要求系统能在任何崩溃点无损恢复。

### 1. 状态外置与断点续传 (Resume Snapshot)
- 由于 Python 被剥夺了业务状态（退化为无状态命令执行器），所有进度状态（当前跑到了哪个 Point，当前 Focus 处在第几步）都驻留在 TS 的内存中。
- TS Kernel 每完成一个微步（例如移到一个新点，或者获得一张有效的参考帧），都会将包含上下文的 `resume.snapshot.json` 刷新到磁盘。
- **灾难恢复**：如果 Python 进程崩溃（`bridge_crashed`）甚至 Node 进程重启，TS 重启后读取 snapshot，重新 spawn 一台干净的 Python Bridge，可以**精确到单点级别**恢复实验，而无需从头扫图。

### 2. 精细化的错误隔离与 Agent 介入
- **隔离硬件异常**：底层任何硬件异常（如 `COM` 口断开、超时），Python 仅抛出标准化的 RPC Error（如 `stage_timeout`）。
- **TS 层状态机降级**：TS 捕获错误后，停止当前循环，将系统状态置为 `paused/recovering`。
- **Agent 工具投递**：TS 通过 `ToolResult` 回传错误上下文。LLM 可以调用 `probe_hardware_status` 或请求 `operator_intervention`，实现了“硬件挂掉 -> 软件隔离 -> AI 诊断 / 人工接管”的优雅降级。

## Bridge 进程与 JSON-RPC 协议设计 (V2)

**长驻 `hardware_bridge.py`**：统一的 RPC 服务器，内部按 Device Domain 路由。

### 协议格式升级：引入 Domain Routing
```jsonc
// TS -> Python
{"id":"c-001","domain":"stage","action":"move_absolute","payload":{"xUm":10,"yUm":20}}
{"id":"c-002","domain":"algorithm","action":"calc_focus_score","payload":{"imagePath":"/tmp/a.png"}}

// Python -> TS (保持一致)
{"id":"c-001","ok":true,"result":{"xUm":10,"yUm":20,"zUm":0}}
{"id":"c-002","ok":false,"error":{"code":"FRAME_READ_ERR","message":"..."}}
```

### 多设备锁与资源互斥 (Mutex)
- 在 V2 架构中，Python 不再需要复杂的并发锁来防止一边运动一边采谱。
- **所有的 Mutex 锁定都在 TS 层的 Orchestrator 完成**。例如，TS 在执行采谱前，会获取排他锁 `await resourceManager.acquire('stage_motion')`，确保并发触发的异步任务无法发送运动指令。

## 标定与数据落盘 (Artifacts)

- **算法输出解耦**：C 类纯算法（如 XY 标定矩阵计算 `fit_xy_calibration`）可以甚至放在无外设的云端容器跑。Python 只负责计算并返回数值矩阵，TS 负责将其序列化写入 `.pi/experiment-runs/lab/calibrations/<id>.json`。
- **谱数据与图片**：保持原有规则，Python 只写磁盘，RPC 返回路径引用 (`ArtifactRef`)，TS 负责管理文件生命周期。

## 演进路径 (Strangler Fig Pattern)

为避免“一改全崩”，重构分为三个阶段：

1. **V2 Bridge 破冰**：新建 `hardware_bridge_v2.py`。建立极简的 Device Router。先将最边缘的纯算法（C类）如 `phase_correlation` 迁移到 V2，并在 TS 端重写调用逻辑。
2. **硬件驱动抽离**：将 `MCNewtonXYZStageController` 从原有桥接代码中解耦，注册入 V2 Bridge。在 TS 层实现 V2 版本的 `move` 和 `wait_settled`。
3. **流程倒置**：这是核心攻坚战。在 TS 层用 V2 的原子接口重写 `autofocus` 循环和 `run_unit`。双规运行测试通过后，废弃旧的 `raman_bridge.py`。
4. **扩展新设备**：新增加热台（Thermal）设备，只需编写 30 行 Python 驱动注入 V2 Bridge，TS 即可零成本接入。
