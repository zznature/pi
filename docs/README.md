# Documentation Index

本目录记录 pi-agent 向实验研究 agent 适配的设计，以及 Raman/仪器自动化相关原型。
核心方向是：pi-agent 负责 bounded run 之外的规划、校验、审批、分析和再规划；
真实执行交给 deterministic kernel、policy gate、watchdog 和 operator approval。

## 快速结论

- 不让 LLM 进入实时硬件控制循环；run 进行中不接受 LLM 动态改参。
- Agent 只调用宏工具，例如 `validate_experiment_spec`、`run_preflight`、`run_experiment`、`analyze_run`、`plan_next_experiment`。
- `ExperimentSpec` 是 kernel 唯一可执行输入；自由文本计划必须先编译、校验、审批。
- 默认从 simulation 闭环开始，再进入 dry run，最后才做最窄 hardware pilot。
- 仪器相关内容当前主要是 Raman mapping、stage、camera、autofocus、XY calibration 和 LabSpec acquisition 的工程原型(测试中，粗糙版本)。

## 推荐阅读顺序

1. [experiment_extension/pi_agent_experiment_research_adaptation.md](experiment_extension/pi_agent_experiment_research_adaptation.md)：pi-agent 项目内 experiment-research extension 的具体落地方案，包括数据契约、工具、run store、审计记录、阶段计划和风险控制。
2. [experiment_extension/instrument_agent_design.md](experiment_extension/instrument_agent_design.md)：更通用的 instrument-orchestration agent 架构，说明 gateway、middleware、watchdog、safety model、execution modes 和 roadmap。
3. [Raman/README.md](Raman/README.md)：Raman measurement automation 总览，覆盖硬件、环境、目录、运行命令、autofocus、XY calibration 和 LabSpec acquisition。
4. [literature_extension/README.md](literature_extension/README.md)：literature-research extension 方案，覆盖文献检索、论文导入、证据抽取和实验规划联动。
5. [scientific_research_automation_development.md](scientific_research_automation_development.md)：科研流程自动化总体路线图，覆盖文献证据、假设、协议、数据分析、决策审计和报告生成。

## 目录说明

| 路径 | 内容 |
| --- | --- |
| `experiment_extension/instrument_agent_design.md` | 实验仪器 agent 的通用架构设计：Protocol -> Tool、bounded run、deterministic kernel、watchdog、safety policy。 |
| `experiment_extension/pi_agent_experiment_research_adaptation.md` | 将 pi-agent 作为实验研究外层 agent 的实施方案，推荐从 `.pi/extensions/experiment-research` 的 Contract Spike 和 Simulation Closed Loop 开始。 |
| `literature_extension/` | literature-research extension 方案，包括 metadata search、paper import、evidence extraction 和 experiment planning link。 |
| `scientific_research_automation_development.md` | pi 科研流程自动化总体路线图：literature、hypothesis、protocol、experiment、analysis、decision audit、report。 |
| `Raman/` | Raman 自动化相关说明和原型代码，包括 stage、autofocus、calibration 和 LabSpec spectrum acquisition。 |
| `Raman/stage/` | stage 抽象、内存 stage、MC.Newton XYZ/Z stage 控制相关原型。 |
| `Raman/autofocus/` | Z autofocus 的 ROI、metrics、scanner、controller 和 LabSpec file bridge。 |
| `Raman/calibration/` | 图像 phase correlation、pixel/stage transform、XY correction 和 stage adapter。 |
| `Raman/acquire-spectrum/` | LabSpec spectrum request helper。 |
| `Raman/microscope/` | LabSpec worker-backed frame provider prototype。 |

## 当前实施重点

优先实现 `.pi/extensions/experiment-research` 的最小闭环：

```text
ExperimentSpec
  -> schema/semantics/policy validation
  -> preflight
  -> runStore.reserve
  -> simulation kernel
  -> records/events/summary
  -> analyze_run
  -> constrained plan_next_experiment
```

硬件路径应保持最窄：先 dry run 生成绑定 canonical `specHash` 的 readiness report，再由 operator approval 放行 hardware run。任何低层动作如 `move_z`、`serial_send`、`snap_image` 都不应暴露给 planner。

## 补充文档规则

- 架构和 pi-agent 适配方案放在 `docs/` 顶层。
- Raman 相关仪器、硬件流程、probe 脚本和 checklist 放在 `docs/Raman/`。
- 高风险硬件流程用 checklist 写清 preconditions、approval、abort criteria 和 records。
- 新文档应说明其适用阶段：simulation、dry run 或 hardware。
