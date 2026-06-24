# MVP 实验安全简化方案 (Problems → Solutions → Checklists)

> 适用范围：`.pi/extensions/experiment-research`
> 阶段目标：MVP 在实验室真机上跑通最小 Raman 自动化闭环。
> 安全范围：MVP 只防两类**不可逆物理损伤**——`laser burn`（烧样）与 `collision`（撞物镜）。
> 其余一切（合规、追溯、质量护栏）一律降级为非阻断诊断。

本文给出：当前安全设计的问题清单、简化后的目标模型、以及 agent 可直接照做的 checklist。
**本文是计划文档，不含代码改动。** 落地实现按文末"Implementation Tasks"分步进行。

---

## 0. 第一性原理：两类损伤各由什么唯一决定

```
collision (撞物镜)  ⟺  任何实到 Z  >  collision ceiling (Z 上限)
laser burn (烧样)   ⟺  实到激光功率 >  laser ceiling   (功率上限)
```

- 这两条不变式 (invariant) 是 MVP 安全的**全部内核**。
- 其余检查（operator approval、dry-run specHash 匹配、坐标审计、V2 证据链、质量/预算护栏）都**不直接拦截这两类损伤**，因此 MVP 阶段不应阻断 `run_experiment`。

★ Insight ─────────────────────────────────────────
- 物理损伤 ≠ 流程合规。合规检查担保"谁批的、是否可追溯"，拦不住烧样/撞镜。
- 当前两类损伤的防护是**纯启动期静态检查**，运行时 kernel 对 Z/功率**零二次防护**——这是 MVP 上真机前必须补的缺口。
- 坐标(coordinate) 与 安全上限(limit) 是两件事：坐标能从硬件读回，上限读不到、必须由实验室常量配置。
─────────────────────────────────────────────────

---

## 1. Problems（现状问题清单）

### P1 — 文档 / prompt / 代码三方不一致（最高优先级）

`feat 7aa7b37` 只把 `validateHardwareGate` 降到两条限位，但 **`runHardwareExperiment` 仍在它之前调用 `enforceLaunchGate`**（`dispatch.ts:576` → `579`）。`enforceLaunchGate` 至今强制以下四项，全部仍 **block** 启动：

| 旧门控 (`dispatch.ts:527-551`) | 性质 | 现状 |
| --- | --- | --- |
| `realRamanBackendIssues` 后端类型校验 | 配置 | 仍 block |
| `realRamanV2ValidationIssues` V2 证据记录 | 追溯 | 仍 block |
| `coordinateAuditIssues` 坐标审计 | 配准 | 仍 block |
| `realHardwareApprovalIssues` 审批 + dry-run specHash 匹配 | 合规 | 仍 block |

而 `README.md:122-159` 声称这些"已降级为可选追溯"，`prompt.ts:42-48` 仍指示 agent 必须提供它们。
**真实有效的启动门远比文档描述严苛。** 在自相矛盾的基线上做简化只会更乱——必须先对齐。

### P2 — 运行时无 Z/功率二次防护

`kernel/raman/run.ts` 在 `visit_point` / `run_unit` 前**没有任何** Z 上限或功率上限断言（已 grep 确认）。
两类损伤的防护完全依赖"bridge 老实按 plan 走"这一假设。autofocus 是动态 Z 运动，一旦 bridge 偏离 plan 或有 bug，纯启动期检查就是盲区。

### P3 — 坐标审计依赖 operator 逐次人工填写

`coord-audit.ts`（238 行）要求 operator 用 `record_hardware_coordinate_audit` 人工录入并审批一份 hash 绑定 subject+plan 的记录。
但当前坐标**能从硬件直接读回**——`stage.get_position` 已是现成 read 级 action（`hardware_bridge_v2.py:1639`，无副作用）。人工填写既冗余又易错。

### P4 — V2 证据链过度工程

`kernel/raman/validation.ts`（约 700 行）的 `evidenceDigest` / `validatedCoverage` 机制是为"硬件全量验证"设计的，对 MVP 最小闭环是不成比例的负担。

### P5 — watchdog 混装了"损伤护栏"与"质量/预算护栏"

`watchdog.ts` 同时管 `operatorIntent` / `heartbeatTimeout`（损伤相关：人能叫停 / 失联即停）和 `qualityMetrics` / `artifactGuard` / `budgetGuard`（质量/预算，与物理损伤无关）。MVP 运行时只需前两者。

---

## 2. Solutions（简化后的目标模型）

### S1 — 对齐到"两不变式"启动门

从 `runHardwareExperiment` **移除 `enforceLaunchGate` 调用**。`validateHardwareGate`（Z 上限 + 功率上限）成为**唯一硬门**。
`enforceLaunchGate` 内部四个函数保留，但**仅供 `run_preflight` 的非阻断 readiness 诊断复用**（`assessLaunchReadinessPreview` 这条通道已存在）。

### S2 — 新增运行时 bridge 断言（defense-in-depth，唯一必须新增的安全代码）

在 Python bridge 每个危险动作边界各加一行断言：

```python
# stage.move_absolute / visit_point 之前
assert target_z_um <= z_ceiling_um, "collision guard"
# set_laser_power / run_unit 之前
assert laser_power_mw <= laser_ceiling_mw, "burn guard"
```

把"只信启动期一次检查"升级为"每个动作边界都检查"，消除 autofocus / bridge 偏离 plan 的整类风险。成本两行，收益是避免一次不可逆物镜/样品损坏。**此条不可省。**

### S3 — 坐标改为启动时自动读回（替代人工审计）

删除 `coord-audit.ts` 人工审批 + hash 匹配机制。改为 **dispatch 在 launch 内部自动执行**：

```
run_experiment(hardware) 启动前，dispatch 内部:
  1. 调 stage.get_position (read 级, 无副作用)         ← dispatch 自己做, agent 无法伪造
  2. 写 run 记录 coordinate-readback.json (provenance)  ← 保留可复现性
  3. 门检查:
       a. 读回成功 & stage 已连接              (坐标系锚点存在)
       b. 读回位置 ∈ limits.motion             (坐标系自洽, 防原点漂移/丢步)
       c. plan 所有目标点 ∈ limits.motion       (已有, policy.ts)
```

**关键：读回必须由 dispatch 紧贴 launch 内部执行，不能由 agent 传参。** 安全 provenance 不可由被监管方自报。
`hardware_bridge_v2_read(stage, get_position)` 仍供 agent **规划用**，但与启动门读回是两条独立路径。

> 区分两类语义，不可合并：
> - **坐标 / 坐标系锚点**：硬件能读 → 自动读回。
> - **安全上限 (Z 上限 / 功率上限)**：硬件读不到 → 实验室常量配置（见 S4）。

### S4 — 安全上限提升为实验室级常量

Z 上限、功率上限来自实验室物理保护常量（建议放 lab capabilities 配置层），**spec 只能更严、不能更松**。
避免"每次 spec 自填上限"带来的逐次放松风险。`validateHardwareGate` 校验 spec.limits 不得超过实验室常量上限。

### S5 — 降级 / 移出 MVP 路径

| 项 | 处理 |
| --- | --- |
| operator approval / dry-run specHash 匹配 | 降级为 `run_preflight` 非阻断 readiness 诊断 |
| `coordinateAuditExemption='bounded_z_adjustment'` 特例 (`dispatch.ts:325-360`) | 删除 |
| V2 validation 证据链 (`kernel/raman/validation.ts`) | 移出 MVP 启动路径（移到 `experimental/` 留作后续硬件全量验证的种子） |
| watchdog `qualityMetrics` / `artifactGuard` / `budgetGuard` | MVP 运行时不强制（保留代码，不接线） |
| watchdog `operatorIntent` + `heartbeatTimeout` | **保留**（人工闸 + 失联即停，MVP 运行时安全底线） |

### 简化后启动门全貌

```
run_experiment(hardware)
  ├─ validate_experiment_spec           (schema + 语义)
  ├─ policy: 点 ∈ motion limits           (静态 collision 下界)
  ├─ ★ 自动读回 stage.get_position ★      (S3: 锚点 + 坐标系自洽, dispatch 内部)
  ├─ ★ validateHardwareGate ★           (S1+S4: Z 上限 + 功率上限, 不得超实验室常量)
  └─ ★ 运行时 bridge 断言 ★              (S2: move/power 前每动作边界二次钳制)
approval / dry-run 匹配 / V2 证据  →  run_preflight 非阻断 readiness 诊断
```

---

## 3. Checklists（给 agent 照做）

### CL-A — 编译硬件 ExperimentSpec 时（规划期）

- [ ] 坐标使用**绝对机械坐标系**，不使用猜测原点 / 占位坐标 / 杜撰位置。
- [ ] 当前硬件坐标缺失时，用 `hardware_bridge_v2_read(stage, get_position)` 读回作为规划输入；不要凭记忆/对话历史填坐标。
- [ ] plan 所有目标点的 `xUm/yUm/zUm` 落在 `limits.motion` 范围内。
- [ ] `limits.motion.zUm.maxUm` = collision ceiling，不得超过实验室物理上限。
- [ ] `limits.powerEnergy.maxLaserPowerMw` = laser ceiling，不得超过实验室物理上限。
- [ ] autofocus 的 `zMaxUm` ≤ `limits.motion.zUm.maxUm`。
- [ ] **绝不**为通过门控而放宽 limits、改安全参数、扩点数。

### CL-B — 启动硬件 run 前（顺序执行）

- [ ] `validate_experiment_spec` 通过。
- [ ] `run_preflight` 通过（readiness 诊断仅供参考，不是审批门）。
- [ ] 确认两条硬不变式将被满足：
  - [ ] 所有规划 Z ≤ `limits.motion.zUm.maxUm`
  - [ ] 请求激光功率 ≤ `limits.powerEnergy.maxLaserPowerMw`
- [ ] 调用 `run_experiment`。**坐标读回与自洽校验由系统在 launch 内部自动完成，agent 无需传坐标审计参数。**
- [ ] 若启动门返回 `hardware_gate_failed`：读 issues，按提示收紧 spec 后重试；不得绕过。

### CL-C — run 进行中

- [ ] **不**实时改参数。需要调整 → 读 run 记录/summary 后规划**新的**有界 run。
- [ ] **不**轮询 planner 进度；run 在边界/终态通过 run 记录回报。
- [ ] 需要人工介入时才用 `pause_run` / `abort_run`（operator 工具，operator-directed 时使用）。
- [ ] 失联 / 连续错误超限 → watchdog 自动 abort 在安全边界，无需 agent 干预。

### CL-D — run 之后

- [ ] `analyze_run`（传 runId）。
- [ ] `plan_next_experiment` 仅在读完 run 历史 / analysis / 决策审计 / 停止规则判断后调用。
- [ ] 后续 run 保持同一 `experimentId`，引用父 run 的 summary / artifacts / lineage。
- [ ] 跟进策略只能选：`repeat_same` / `refine_region` / `add_replicates` / `reduce_scope` / `stop`。

---

## 4. Implementation Tasks（落地分步，给开发期 agent）

> 每步独立、可单测、可回滚。按序执行；每步后 `npm run check` + 跑该步相关测试。

1. **T1 对齐启动门 (S1)**：从 `runHardwareExperiment` 移除 `enforceLaunchGate` 调用；其内部函数改接入 `assessLaunchReadinessPreview`（已存在的非阻断通道）。更新 `prompt.ts` 删除 coordinateAudit / approval / V2 指令，改为两不变式表述。同步 `README.md`。
2. **T2 运行时断言 (S2)**：在 `hardware_bridge_v2.py` 的 `stage.move_absolute` / Raman `run_unit` / 功率写入前加 Z / 功率断言；ceiling 由 spec.limits 透传至 bridge。补 bridge 侧单测（越界即 raise）。
3. **T3 坐标读回 (S3)**：dispatch 在 hardware launch 内部调 `stage.get_position`，写 `coordinate-readback.json`，加三条门检查（a/b/c）。删除 `coord-audit.ts` + `record_hardware_coordinate_audit` 工具 + 相关 schema。
4. **T4 实验室常量上限 (S4)**：在 capabilities 层加 Z / 功率物理上限常量；`validateHardwareGate` 增加"spec.limits 不得超常量"校验。
5. **T5 降级/移出 (S5)**：删除 `coordinateAuditExemption` 逻辑；`kernel/raman/validation.ts` 移到 `experimental/`；watchdog 仅接线 `operatorIntent` + `heartbeatTimeout`。
6. **T6 文档收尾**：更新本文勾选状态、`docs/CODEMAPS/experiment-research.md`、lab_tests task-00 安全条款，保证三方（doc / prompt / code）一致。

---

## 5. 已知技术债（MVP 后回收，不要遗忘）

- **DT1 特征配准缺失**：去掉人工坐标审计后，无环节确认"plan 点真落在目标样品特征上"。MVP 接受（采错位置仅浪费一次采集，不伤硬件）。升级到"要出有效数据"时，用 camera `capture_frame` + 视觉配准补回，**不要**退回人工填坐标。
- **DT2 软限位硬件读取**：bridge 当前无 travel-limit / soft-limit 读取 action，安全上限只能靠常量配置。未来若驱动暴露软限位，应改为读回校验，与 S3 坐标读回对称。
- **DT3 V2 证据链复活路径**：`validation.ts` 移出而非删除，硬件全量验证阶段按需接回。
