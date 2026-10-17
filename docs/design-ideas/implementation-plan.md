# LabAgents MVP Rebuild Implementation Plan

本文把当前已经冻结的 MVP rebuild 路线整理成适合 Codex goal 模型执行的实施计划。

目标不是一次性铺开全部功能，而是按一系列可验证的纵向增量推进，逐步完成：

```text
docs freeze
-> v2 extension skeleton
-> core objects
-> persistence boundaries
-> unit compilation
-> simulation vertical slice
-> planner proposal flow
-> explicit evaluation rules
-> Raman runtime contract
-> real supervised single-point Raman
-> bounded parameter search
-> bounded Raman mapping
```

## Planning principles

整个 rebuild 过程遵循以下原则：

1. 每个 goal 都必须形成一个可验证增量，不做只铺结构不形成闭环的空转开发。
2. 优先做纵向切片，不做大面积横向重构。
3. `.pi/extensions/experiment-research` 只作为 reference implementation，不作为默认继承基线。
4. 新实现必须以 `docs/design-ideas/` 为权威设计来源。
5. 所有真实硬件执行都必须服从 supervised bounded run 边界。

## Definition of done for the rebuild MVP

满足以下条件时，可以认为 MVP rebuild 基本完成：

- `experiment-research-v2` extension 存在并可加载
- 新架构不再以旧 extension 的 `ExperimentSpec` 体系为中心
- 核心对象固定为：
  - `ExperimentIntent`
  - `ProcedureSpec`
  - `ExecutionUnit`
  - `RunState`
- bounded run lifecycle 可运行
- simulation vertical slice 可运行
- supervised Raman single-point run 可运行
- “good enough conditions” 使用显式规则
- parameter search 是 bounded 的
- mapping 是 bounded 的
- 所有新的 effectful hardware run 都要求确认
- run 内不允许热改 spec
- 不允许无界自动搜索

## Standard per-goal workflow

每个 Codex goal 都建议按同一模板执行：

1. 先读与该 goal 直接相关的设计文档
2. 明确本 goal 的 scope 与非 scope
3. 只改与本 goal 直接相关的文件
4. 添加最小必要测试
5. 运行相关测试
6. 在有代码改动后运行 `npm run check`
7. 如实现与设计文档出现偏差，更新 `docs/design-ideas/`
8. 记录遗留问题，但不顺手扩 scope

## Phase 0: Freeze the build contract

### Objective

冻结 MVP rebuild 的产品与架构边界，避免实现过程中发生目标漂移。

### Scope

- 文档冻结
- 产品边界冻结
- 非目标清单冻结

### Checklist

- [ ] 明确：
  - [ ] agent can propose bounded runs
  - [ ] agent can execute approved bounded runs
  - [ ] agent cannot expand search unboundedly
  - [ ] “good enough conditions” use explicit rules
- [ ] `product_usage_example.md` 反映 phase-based supervised workflow
- [ ] `AGENTS.md` 明确旧 extension 仅作 reference
- [ ] 明确 MVP 暂不做：
  - [ ] full watchdog policy
  - [ ] generalized multi-device platform
  - [ ] full Raman calibration lifecycle
  - [ ] autonomous multi-run execution without approval

### Exit criteria

- 文档已经足够约束开发
- 后续 goal 不再需要反复澄清 MVP 边界

### Suggested Codex goal

`Freeze the MVP rebuild contract in docs for the supervised Raman multi-run workflow.`

## Phase 1: Create the v2 extension skeleton

### Objective

创建 `.pi/extensions/experiment-research-v2` 的最小扩展骨架，并保证能被加载。

### Scope

- extension 目录创建
- 最小入口文件
- 最小 tool registration wiring

### Checklist

- [ ] 新建 `.pi/extensions/experiment-research-v2/`
- [ ] 添加最小文件：
  - [ ] `package.json`
  - [ ] `index.ts`
  - [ ] `prompt.ts`
  - [ ] `README.md`
- [ ] 添加目录骨架：
  - [ ] `schemas/`
  - [ ] `planner/`
  - [ ] `kernel/`
  - [ ] `runtime/`
  - [ ] `tools/`
  - [ ] `store/`
  - [ ] `test/`
- [ ] `index.ts` 能注册最小 tool surface
- [ ] 不复制旧 extension 的 dispatch / schema / kernel 结构

### Exit criteria

- v2 extension 可加载
- 目录结构稳定，可作为后续实现基线

### Suggested Codex goal

`Scaffold the experiment-research-v2 extension with minimal loading and tool registration.`

## Phase 2: Define the core objects

### Objective

实现 MVP 所需的核心对象模型：`ExperimentIntent`、`ProcedureSpec`、`ExecutionUnit`、`RunState`。

### Scope

- schema/type 定义
- 最小字段冻结
- 最小 plan kinds 和 semantic steps 冻结

### Checklist

- [ ] 在 `schemas/` 中定义：
  - [ ] `experiment-intent.ts`
  - [ ] `procedure-spec.ts`
  - [ ] `execution-unit.ts`
  - [ ] `run-state.ts`
  - [ ] `tool-result.ts`
- [ ] `ExperimentIntent` 最小字段可用
- [ ] `ProcedureSpec` 最小字段可用
- [ ] `ExecutionUnit` 最小字段可用
- [ ] `RunState` 最小字段可用
- [ ] 支持的 plan kinds：
  - [ ] `grid_scan`
  - [ ] `point_list`
- [ ] 支持的 semantic steps：
  - [ ] `move_to_point`
  - [ ] `autofocus`
  - [ ] `capture_frame`
  - [ ] `acquire_spectrum`
- [ ] `limits` 与 `stoppingRules` 有最小结构

### Exit criteria

- 新核心对象不依赖旧 `ExperimentSpec`
- 类型足以支撑 planner / kernel / runtime

### Suggested Codex goal

`Implement the MVP core schemas for ExperimentIntent, ProcedureSpec, ExecutionUnit, and RunState.`

## Phase 3: Build persistence boundaries

### Objective

把用户意图、冻结 spec、运行快照、事件、产物引用分开持久化，避免事实混写。

### Scope

- store 层
- 路径布局
- append-only event boundary

### Checklist

- [ ] 实现：
  - [ ] `intent-store.ts`
  - [ ] `procedure-spec-store.ts`
  - [ ] `run-store.ts`
  - [ ] `event-store.ts`
  - [ ] `artifact-store.ts`
- [ ] 分开保存：
  - [ ] intents
  - [ ] frozen specs
  - [ ] run snapshot
  - [ ] append-only events
  - [ ] artifact refs
- [ ] 明确 records 目录布局
- [ ] 不混写 planner facts 与 runtime facts

### Exit criteria

- 一次 run 的输入、状态、产物都可独立追踪
- persistence boundary 清晰

### Suggested Codex goal

`Implement clean persistence stores for intents, frozen specs, run state, events, and artifacts.`

## Phase 4: Implement unit compilation

### Objective

将 `ProcedureSpec` 编译为稳定的 `ExecutionUnit[]`，形成 progress、pause、resume 的边界锚点。

### Scope

- compile pipeline
- `grid_scan` / `point_list` 展开
- unit metadata 注入

### Checklist

- [ ] 实现 `kernel/compile-units.ts`
- [ ] 支持：
  - [ ] `point_list -> point units`
  - [ ] `grid_scan -> point units`
- [ ] 每个 unit 生成：
  - [ ] `unitId`
  - [ ] `index`
  - [ ] `unitKind`
  - [ ] point metadata
  - [ ] action list
  - [ ] artifact scope
- [ ] limits 检查具备编译入口
- [ ] 编译结果保持在 semantic action 层，不落到底层 driver 命令

### Exit criteria

- `ExecutionUnit[]` 稳定、可计数、可恢复
- kernel 后续可直接消费编译结果

### Suggested Codex goal

`Compile ProcedureSpec into stable ExecutionUnit arrays for point_list and grid_scan plans.`

## Phase 5: Ship the simulation vertical slice

### Objective

先在 simulation mode 跑通完整 bounded run 生命周期，验证架构主链路成立。

### Scope

- simulation runtime
- run lifecycle
- fake artifacts / fake failures

### Checklist

- [ ] 实现 `runtime/simulation-runtime.ts`
- [ ] 实现 `kernel/run-controller.ts`
- [ ] 支持最小 lifecycle：
  - [ ] start
  - [ ] poll
  - [ ] pause
  - [ ] abort
- [ ] 输出：
  - [ ] run snapshot
  - [ ] progress events
  - [ ] fake artifacts
- [ ] 模拟失败场景：
  - [ ] autofocus low confidence
  - [ ] spectrum timeout
  - [ ] operator pause
- [ ] 提供最小 tool：
  - [ ] `run_procedure`
  - [ ] `poll_run`
  - [ ] `pause_run`
  - [ ] `abort_run`

### Exit criteria

- simulation 能跑通一次 bounded run
- pause / abort / poll 有真实状态变化

### Suggested Codex goal

`Implement the simulation runtime and bounded run lifecycle with start, poll, pause, and abort.`

## Phase 6: Build planner-side proposal flow

### Objective

实现从用户目标到 bounded `ProcedureSpec` proposal 的 planner 侧流程。

### Scope

- intent builder
- procedure spec builder
- proposal vs execution boundary

### Checklist

- [ ] 实现 `planner/intent-builder.ts`
- [ ] 实现 `planner/procedure-spec-builder.ts`
- [ ] 实现最小工具：
  - [ ] `get_lab_capabilities`
  - [ ] `get_lab_state`
  - [ ] `validate_procedure_spec`
  - [ ] `run_preflight`
- [ ] 支持主 procedure：
  - [ ] `raman_single_point_probe`
  - [ ] `raman_parameter_search`
  - [ ] `raman_grid_mapping`
- [ ] proposal 输出包含：
  - [ ] risks
  - [ ] limits
  - [ ] estimated runtime
  - [ ] save path
  - [ ] requires confirmation

### Exit criteria

- agent 能提出 bounded run 草案
- proposal 和 execution 明确分离

### Suggested Codex goal

`Implement planner-side bounded run proposal flow for Raman single-point, parameter-search, and mapping procedures.`

## Phase 7: Encode explicit “good enough” rules

### Objective

用显式规则判断采集条件是否足够好，避免把这一判断交给 LLM 自由发挥。

### Scope

- metrics schema
- rule engine
- decision output

### Checklist

- [ ] 定义结构化 metrics 输入
- [ ] 实现规则判断：
  - [ ] autofocus confidence threshold
  - [ ] not saturated
  - [ ] SNR threshold
  - [ ] target peak / baseline threshold
  - [ ] repeat consistency rule
- [ ] 输出 rule-based decision：
  - [ ] acceptable
  - [ ] continue_search_within_envelope
  - [ ] stop_and_request_user_decision
- [ ] 明确 search envelope：
  - [ ] allowed parameters
  - [ ] max attempts
  - [ ] forbidden expansions

### Exit criteria

- “是否适合进入 mapping” 不依赖 LLM 自由判断
- parameter search 有清晰边界

### Suggested Codex goal

`Implement explicit rule-based evaluation for good-enough Raman acquisition conditions.`

## Phase 8: Add the Raman runtime contract

### Objective

先定义 Raman runtime contract 和资源模型，再决定具体真实硬件接入细节。

### Scope

- resource model
- runtime actions
- action result schema

### Checklist

- [ ] 实现 `runtime/raman/resources.ts`
- [ ] 实现 `runtime/raman/actions.ts`
- [ ] 定义资源：
  - [ ] stage
  - [ ] frame provider
  - [ ] spectrometer
- [ ] 定义 runtime actions：
  - [ ] `stage.move_absolute_and_wait`
  - [ ] `autofocus.run_single`
  - [ ] `frame.capture_latest`
  - [ ] `spectrometer.acquire_spectrum`
- [ ] 统一 action result schema：
  - [ ] status
  - [ ] artifacts
  - [ ] errorCode
  - [ ] retrySafe
  - [ ] needsOperator
  - [ ] safeToResume

### Exit criteria

- kernel 和 Raman 通过 contract 对接
- 真实硬件尚未 fully wired 也不阻碍边界稳定

### Suggested Codex goal

`Define the Raman runtime resource and action contract for stage, frame, autofocus, and spectrum acquisition.`

## Phase 9: Deliver real supervised Raman single-point execution

### Objective

用 v2 架构跑通真实受监督 Raman 单点采谱 bounded run。

### Scope

- real Raman single-point wiring
- preflight minimum checks
- risk gating

### Checklist

- [ ] 将单点 run 接到真实 Raman action path
- [ ] 实现最小真实 preflight 检查
- [ ] 风险分类生效：
  - [ ] `notice`
  - [ ] `confirm_required`
  - [ ] `forbidden`
- [ ] 支持单点流程：
  - [ ] move
  - [ ] autofocus
  - [ ] capture frame
  - [ ] acquire spectrum
- [ ] 完成 artifacts 回流
- [ ] 完成 rule-based analysis

### Exit criteria

- supervised single-point real Raman run 闭环可用
- 不需要先完成 mapping 才能验证架构

### Suggested Codex goal

`Wire supervised real Raman single-point execution through the v2 architecture.`

## Phase 10: Deliver bounded parameter search and mapping

### Objective

将 parameter search 和 Raman mapping 都实现为独立的 supervised bounded runs。

### Scope

- bounded parameter search
- bounded mapping
- progress and failure handling

### Checklist

- [ ] 实现 `raman_parameter_search`
- [ ] search envelope enforced
- [ ] max attempts enforced
- [ ] `grid_scan` mapping compile 可用
- [ ] mapping progress updates 可用
- [ ] 连续失败处理策略明确
- [ ] mapping 不会自动扩大 grid 或自动改参数

### Exit criteria

- parameter search 与 mapping 都是独立 bounded run
- 产品主案例可完整演示

### Suggested Codex goal

`Implement bounded Raman parameter search and bounded Raman mapping runs.`

## Recommended goal sequence

建议按以下顺序创建和执行 Codex goals：

1. `Freeze the MVP rebuild contract in docs for the supervised Raman multi-run workflow.`
2. `Scaffold the experiment-research-v2 extension with minimal loading and tool registration.`
3. `Implement the MVP core schemas for ExperimentIntent, ProcedureSpec, ExecutionUnit, and RunState.`
4. `Implement clean persistence stores for intents, frozen specs, run state, events, and artifacts.`
5. `Compile ProcedureSpec into stable ExecutionUnit arrays for point_list and grid_scan plans.`
6. `Implement the simulation runtime and bounded run lifecycle with start, poll, pause, and abort.`
7. `Implement planner-side bounded run proposal flow for Raman single-point, parameter-search, and mapping procedures.`
8. `Implement explicit rule-based evaluation for good-enough Raman acquisition conditions.`
9. `Define the Raman runtime resource and action contract for stage, frame, autofocus, and spectrum acquisition.`
10. `Wire supervised real Raman single-point execution through the v2 architecture.`
11. `Implement bounded Raman parameter search and bounded Raman mapping runs.`

## Notes on execution style

为避免 rebuild 重新滑回旧系统的复杂性，执行时建议保持以下习惯：

1. 先验证 simulation vertical slice，再接真实硬件。
2. 先验证 single-point，再做 parameter search 和 mapping。
3. 任何“顺手抽象”都要问一句：它是否直接服务当前阶段的主链路？
4. 如果实现与设计冲突，优先回到 `docs/design-ideas/` 澄清，而不是让代码暗中替代设计。
