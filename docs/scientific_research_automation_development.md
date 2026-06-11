# 科研流程自动化总体开发文档

目标：让 pi 从“能跑实验”升级成“能解释为什么跑这个实验，以及结果是否支持假设”。

本文面向实验科学研究流程，重点覆盖文献证据、假设管理、实验协议、实验执行、数据分析、统计结论、决策审计和报告生成。pi-agent 不应被改造成实时仪器控制程序，而应作为科研流程外层 agent：负责证据驱动的规划、约束检查、结果解释和可追溯决策；真实执行仍交给 deterministic kernel、policy gate、watchdog 和 operator approval。

## Guiding Principle

科研自动化的核心不是“让 agent 做更多事情”，而是让每个科研判断都有可复现的证据链。

```text
literature evidence
  -> hypothesis
  -> protocol / ExperimentSpec
  -> preflight / approval
  -> bounded run
  -> raw data / artifacts
  -> QC / analysis / statistics
  -> conclusion
  -> next decision
```

pi 的升级目标是让上面每个箭头都有结构化记录，而不是只在对话里留下自然语言解释。

## 第一版收敛范围

本文其余部分描述完整目标形态（target state）。为避免一次建满，第一版范围收敛如下，
与 MVP 目标（第一个 Raman auto-research demo）对齐：

**v1 做**（最小科研推理闭环，全部先在 simulation 下验证）：

- 4 个新对象 schema：`HypothesisRecord`、`AnalysisPlan`、`ScientificConclusion`、
  `EvidenceClaim`。evidence 以人工录入/粘贴形式进入（必须带引用），不建检索栈。
- 3 个新 planner 工具：`create_hypothesis`、`register_analysis_plan`、
  `evaluate_hypothesis`。决策审计不新建对象：扩展 experiment-research 既有的
  `decisions.jsonl`（phase 5 已实现）补 `hypothesisId`、`evidenceIds`、
  `rejectedAlternatives` 字段。
- 1 个新存储根：`.pi/research/`，复用 run store 的单写者与原子写纪律（见 Storage
  Layout）；不新建 `.pi/literature/`、`.pi/analysis/` 根。
- 实现位置：先在 `experiment-research` extension 内加 research 层（同一进程、同一
  store 纪律），稳定后再拆独立 extension——沿用"先 project-local、后抽包"的策略。
- 与 Raman 路线衔接：v1 闭环用 simulation kernel 验证；第一个真实 demo 等
  `raman_hardware_integration` Phase 8（谱采集闭环）就绪后，以"假设驱动的 Raman
  mapping"形式合流，不另起硬件路径。

**v1 不做**（移入 Development Phases 的 Deferred）：

- 文献检索/导入/抽取自动化（`search_literature`、`import_paper`、PaperQA2 类栈）
- 正式统计检验库（effect size / CI / power）——v1 只做确定性 QC 与
  `compare_to_prediction`（按 AnalysisPlan 预登记标准判定）
- protocol compiler 独立工具链（v1 由 agent 直接起草 spec + validate，拒绝的备选
  记录进 decision audit）
- report 生成、Zotero/ELN/LIMS 集成
- 多 extension 拆分（literature / hypothesis / protocol-compiler / data-analysis /
  research-report 独立化）

## Current Baseline

当前 pi 已经具备或已有初步设计的能力：

- project-local extension 机制
- `experiment-research` extension
- `ExperimentSpec`
- `validate_experiment_spec`
- `run_preflight`
- simulation / hardware pilot path
- run records、events、summary、artifacts
- 初步 `analyze_run`
- 初步 `plan_next_experiment`
- `literature-research` 设计文档

当前最核心的缺口：

| Area | Missing Capability | Impact |
| --- | --- | --- |
| Literature evidence | 可审计文献检索、论文导入、证据抽取 | agent 无法可靠说明实验设计依据 |
| Hypothesis management | 假设、claim、证据状态和置信度记录 | 多轮实验无法判断是在验证哪个科学命题 |
| Protocol compiler | 自然语言计划到 `ExperimentSpec` 的可审计编译链 | 实验规格生成过程不可追溯 |
| Analysis plan | 实验前定义分析方法、指标、QC 和统计检验 | 容易事后解释或过度拟合 |
| Data pipeline | raw artifacts 到 cleaned data、features、figures 的确定性处理 | 结果解释无法复现 |
| Statistics | replicate、uncertainty、effect size、confidence interval | 无法判断结果是否真的支持假设 |
| Decision audit | 连接文献、假设、实验、数据和下一步决策 | 无法回答“为什么跑这个实验” |
| Report generation | 自动生成方法、结果、图表、引用和限制 | 科研输出仍停留在零散记录 |

## Priority Open Source References

优先参考三类开源方案。它们分别对应本文档的三条关键链路：文献与假设依据、机器可读实验协议、数据与结论 provenance。

### 1. Literature and Hypothesis Evidence

代表项目：

- PaperQA2 / FutureHouse `paper-qa`
- OpenResearcher
- Open Coscientist
- AI Scientist 类项目

对应 pi 模块：

- `.pi/extensions/literature-research`
- `.pi/extensions/hypothesis-research`
- `EvidenceClaim`
- `LiteratureReview`
- `HypothesisRecord`

重点借鉴：

- citation-grounded answer，而不是无出处摘要。
- query decomposition、paper retrieval、citation graph traversal。
- hypothesis generation、ranking、critique、revision loop。
- 将文献 claim 转成结构化 evidence，再进入实验决策。

不建议照搬：

- 不直接采用端到端“自动科学家”架构。
- 不让文献 agent 直接决定硬件执行。
- 不把模型生成的 hypothesis 当作事实；必须绑定 evidence 和 falsification criteria。

### 2. Machine-Readable Protocols

代表项目：

- Autoprotocol
- LabOP

对应 pi 模块：

- `.pi/extensions/protocol-compiler`
- `ExperimentSpec`
- `AnalysisPlan`
- `validate_experiment_spec`
- `run_preflight`

重点借鉴：

- 把自然语言 protocol 编译成机器可读、可校验、可执行的结构。
- 分离 protocol intent、execution constraints、instrument/resource requirements。
- 让实验协议可以被 schema、policy、preflight 和 operator review 检查。
- 记录 rejected protocol alternatives，解释为什么选当前实验设计。

不建议照搬：

- 首版不追求覆盖所有实验室协议标准。
- 不把 protocol schema 过早绑定到单一仪器或单一学科。
- 不让 LLM 直接生成低层硬件指令；只生成受限 `ExperimentSpec`。

### 3. Data Provenance and Scientific Workflows

代表项目：

- DataLad
- Flowcept
- openBIS
- Nextflow
- Galaxy

对应 pi 模块：

- `.pi/extensions/data-analysis`
- `.pi/experiment-runs/`
- `.pi/analysis/`
- `RunRecord`
- `AnalysisPlan`
- `ScientificConclusion`
- artifact references

重点借鉴：

- raw data、processing code、parameters、derived tables、figures 的 lineage。
- workflow step provenance：什么输入经过什么版本的处理产生什么输出。
- FAIR data 和 durable artifact store。
- reproducible analysis pipeline，而不是一次性自然语言分析。

不建议照搬：

- 首版不需要完整 workflow engine。
- 不要把大型数据和全文塞进 pi session；session 只保存摘要和 artifact refs。
- 不要先做复杂分布式执行；先保证本地 deterministic analysis 可复现。

### Reference Mapping

| Reference Class | pi Capability | First Deliverable |
| --- | --- | --- |
| PaperQA2 / OpenResearcher / Open Coscientist | literature and hypothesis evidence | `EvidenceClaim` + `HypothesisRecord` |
| Autoprotocol / LabOP | protocol compiler | `compile_experiment_spec` + `AnalysisPlan` |
| DataLad / Flowcept / openBIS / Nextflow / Galaxy | data provenance and analysis workflow | `QCReport` + `ScientificConclusion` |

这三类参考的优先级高于端到端 AI scientist demo。原因是 pi 的目标是实验科学自动化：必须先保证证据、协议、数据和结论可追溯，再讨论多 agent 协作、论文生成或全自动发现。

## Target Architecture

推荐采用 extension-first 架构。pi-agent core 只提供 session、tools、events、TUI、model runtime 和 resource loading；科研能力由多个可组合 extension 实现。

```text
+----------------------------------------------------------------+
| pi-agent core                                                   |
| session | tools | model runtime | TUI | extension runner        |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| research workflow layer                                         |
| literature | hypothesis | protocol | experiment | analysis      |
| decision audit | report                                         |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| deterministic execution and data layer                          |
| experiment kernel | run store | artifacts | QC | statistics     |
+-------------------------------+--------------------------------+
                                |
                                v
+----------------------------------------------------------------+
| lab / external systems                                          |
| instruments | samples | Zotero | LIMS/ELN | storage | git       |
+----------------------------------------------------------------+
```

Recommended extensions:

```text
.pi/extensions/literature-research/
.pi/extensions/hypothesis-research/
.pi/extensions/protocol-compiler/
.pi/extensions/experiment-research/
.pi/extensions/data-analysis/
.pi/extensions/research-report/
```

首版不需要同时实现全部 extension。上面的拆分是目标形态：v1 全部能力先落在
`experiment-research` 内（见"第一版收敛范围"），公共数据契约定清楚后，后续 extension
按需拆出，跨 extension 只交换 id 与窄记录，不互相 import 内部模块。

## Core Research Objects

### Literature Evidence

文献 evidence 是回答“为什么这个实验值得做”的第一层依据。

```ts
interface EvidenceClaim {
  evidenceId: string;
  paperId: string;
  claim: string;
  evidenceType: "measurement" | "method" | "theory" | "review" | "negative_result" | "limitation";
  citation: {
    title: string;
    doi?: string;
    url?: string;
    section?: string;
    page?: number;
    chunkId?: string;
  };
  confidence: "low" | "medium" | "high";
}
```

文献 evidence 不直接批准实验，只能作为 hypothesis 和 protocol 的输入。

### HypothesisRecord

假设是科研自动化的中心对象。没有假设，agent 只能“继续跑下一个实验”，无法判断结果是否有科学意义。

```ts
interface HypothesisRecord {
  hypothesisId: string;
  statement: string;
  scope: string;
  rationaleEvidenceIds: string[];
  competingHypothesisIds: string[];
  predictedObservations: Array<{
    metric: string;
    direction: "increase" | "decrease" | "no_change" | "threshold" | "pattern";
    expectedValue?: string;
    condition?: string;
  }>;
  falsificationCriteria: string[];
  status: "proposed" | "active" | "supported" | "weakened" | "rejected" | "inconclusive";
  confidence: "low" | "medium" | "high";
  createdAt: string;
  updatedAt: string;
}
```

**状态机归属**：`status` 的迁移只能由 `evaluate_hypothesis` 依据预登记的
`AnalysisPlan.successCriteria/inconclusiveCriteria` 确定性判定驱动——与"stop condition
不得由 LLM 在运行中随意决定"是同一条原则。LLM 可以起草 `ScientificConclusion` 的
文字解释，但 `outcome` 与 `status` 迁移由判定逻辑产生并写入 decision audit；
不暴露自由写 `status` 的工具。

### AnalysisPlan

分析计划应在实验执行前生成并记录。它定义结果如何被解释，防止事后挑指标。

```ts
interface AnalysisPlan {
  analysisPlanId: string;
  hypothesisId: string;
  primaryMetrics: string[];
  secondaryMetrics: string[];
  qcRules: string[];
  statisticalTests: Array<{
    testName: string;
    metric: string;
    assumptions: string[];
    minimumReplicates?: number;
  }>;
  successCriteria: string[];
  inconclusiveCriteria: string[];
}
```

**预登记必须有运行时强制，而不只是流程约定**：

- `AnalysisPlan` 以 canonical JSON 计算 `analysisPlanHash`，由 store 写入——与
  `specHash` 同一套机制。
- `ExperimentSpec` 经**显式 schema 扩展**增加可选 `links` 块（`hypothesisId`、
  `analysisPlanId`、`evidenceIds`）。当前 schema 是 `additionalProperties: false`，
  不能当"预留字段"处理，必须改 schema 并补校验测试（与 `domain.raman` 块同一教训）。
- 准入链 `validatePolicy` 校验：plan 存在、hash 与 preflight/approval 记录一致；
  run 结束后修改 plan 不影响已绑定 run 的解释基准。
- `evaluate_hypothesis` 只依据 run 绑定的那份 plan 判定，运行时杜绝事后换指标。

### ExperimentDecision

每次运行实验、停止实验或改变策略都应写入 decision audit。

注意：experiment-research 已实现 `decisions.jsonl` 决策审计（phase 5，
`plan_next_experiment` 写入）。v1 **不新建对象与存储**，而是给既有 decision 记录
扩展 `hypothesisId`、`evidenceIds`、`rejectedAlternatives` 等字段；下面的接口是
扩展后的目标形状，不是并行的第二套审计。

```ts
interface ExperimentDecision {
  decisionId: string;
  experimentId: string;
  hypothesisId?: string;
  parentRunId?: string;
  decisionType: "start" | "repeat" | "refine" | "stop" | "change_strategy";
  rationale: string;
  evidenceIds: string[];
  reviewId?: string;
  analysisIds: string[];
  selectedSpecId?: string;
  rejectedAlternatives: Array<{ option: string; reason: string }>;
  createdAt: string;
}
```

### ScientificConclusion

结论不应该只是 `analyze_run` 的文本摘要，而应明确回答假设状态。

```ts
interface ScientificConclusion {
  conclusionId: string;
  hypothesisId: string;
  runIds: string[];
  analysisPlanId: string;
  outcome: "supports" | "weakens" | "rejects" | "inconclusive";
  effectSummary: string;
  uncertaintySummary: string;
  qcSummary: string;
  limitations: string[];
  nextActions: string[];
  evidenceRefs: Array<{
    runId?: string;
    artifactId?: string;
    evidenceId?: string;
    analysisId?: string;
  }>;
}
```

## Workflow

### 1. Literature-Grounded Research Question

Tools:

- `search_literature`
- `import_paper`
- `extract_evidence`
- `build_literature_review`

Outputs:

- `PaperRecord`
- `EvidenceClaim`
- `LiteratureReview`
- `references.bib`

Exit criteria:

- Research question has cited prior evidence.
- Known conflicts and gaps are recorded.
- Abstract-only conclusions are marked lower confidence.

### 2. Hypothesis Formation

Tools:

- `create_hypothesis`
- `compare_hypotheses`
- `update_hypothesis_status`

Inputs:

- `EvidenceClaim[]`
- `LiteratureReview`
- user objective

Outputs:

- `HypothesisRecord`
- predicted observations
- falsification criteria

Exit criteria:

- Agent can state what hypothesis the experiment tests.
- Agent can state what result would support, weaken, or falsify it.

### 3. Protocol Compilation

Tools:

- `draft_protocol`
- `compile_experiment_spec`
- `validate_experiment_spec`

Inputs:

- `HypothesisRecord`
- `AnalysisPlan`
- lab capabilities
- sample/resource constraints

Outputs:

- protocol draft
- `ExperimentSpec`
- `AnalysisPlan`

Exit criteria:

- `ExperimentSpec` links back to `hypothesisId`, `evidenceIds`, and `analysisPlanId`.
- Any rejected protocol alternatives are recorded.

### 4. Preflight and Approval

Tools:

- `run_preflight`
- `request_operator`
- `approve_hardware_run`

Outputs:

- preflight report
- capability snapshot
- approval record

Exit criteria:

- Hardware execution requires matching `specHash`, dry-run report, capability snapshot, and operator approval.
- Literature evidence cannot bypass preflight or approval.

### 5. Bounded Execution

Tools:

- `run_experiment`
- `start_run`
- `advance_run`
- `poll_run`
- `pause_run`
- `abort_run`

Outputs:

- `RunRecord`
- `events.jsonl`
- raw artifacts
- run summary

Exit criteria:

- The run is reproducible from `spec.json`, events, artifacts, and capability snapshot.
- Agent cannot change parameters during an active run.

### 6. Data Processing and QC

Tools:

- `process_artifacts`
- `run_qc`
- `extract_features`

Outputs:

- cleaned data
- feature table
- QC report
- generated figures

Exit criteria:

- Raw data, processing code, parameters, and outputs are linked.
- Failed QC prevents unsupported conclusions.

### 7. Statistical Analysis

Tools:

- `run_statistical_analysis`
- `estimate_effect_size`
- `compare_to_prediction`

Outputs:

- statistical result
- effect size
- uncertainty summary
- assumption checks

Exit criteria:

- Conclusion includes uncertainty.
- Replicate and power limitations are explicit.
- Statistical result maps back to the pre-registered `AnalysisPlan`.

### 8. Hypothesis Update and Next Decision

Tools:

- `evaluate_hypothesis`
- `plan_next_experiment`
- `record_decision`

Outputs:

- `ScientificConclusion`
- updated `HypothesisRecord`
- `ExperimentDecision`
- next strategy

Exit criteria:

- Agent can answer: “What did we learn?”
- Agent can answer: “Why is the next experiment justified?”
- Agent can answer: “What evidence would make us stop?”

### 9. Report Generation

Tools:

- `build_research_report`
- `export_methods`
- `export_figures`
- `export_bibliography`

Outputs:

- research report
- methods section
- results section
- figures
- bibliography
- limitations

Exit criteria:

- Report content is generated from records and artifacts, not model memory.
- Claims cite either literature evidence or experimental results.

## Storage Layout

v1 收敛为一个新根 `.pi/research/`，复用既有 `.pi/experiment-runs/`：

```text
.pi/research/
  hypotheses/<hypothesis-id>.json
  plans/<analysis-plan-id>.json        # 含 analysisPlanHash
  evidence/<evidence-id>.json          # v1 人工录入，带引用
  conclusions/<conclusion-id>.json
  reports/                             # deferred

.pi/experiment-runs/                   # 既有结构不变
  experiments/<experiment-id>/         # decisions.jsonl（字段扩展）、lineage.jsonl
  runs/<run-id>/                       # QC 报告、feature 表、figures 作为 run artifacts
```

`.pi/literature/` 与 `.pi/analysis/` 在 v1 不建根：evidence 并入 `.pi/research/evidence/`，
run 级分析产物留在 `runs/<runId>/` 下由 `ArtifactRef` 引用。后续文献栈接入时再立
`.pi/literature/`。

**底层纪律**：新 store 必须复用 run store 已经建立的并发与崩溃语义，而不是只定目录树。
同一 cwd 可能有多个 pi session 并发——`.pi/research/` 同样需要单写者锁、原子写入
（temp file + rename）、append-only jsonl 的部分写恢复、防冲突 id 派生。这些在
run-store 中已实现，research store 直接复用同一套实现，不重写。

The pi session should store summaries and human decisions. Large data, raw measurements, full text, figures, and derived tables should be stored as artifacts and referenced by stable IDs.

## Extension Interfaces

### literature-research -> hypothesis-research

```text
EvidenceClaim[] + LiteratureReview -> HypothesisRecord
```

### hypothesis-research -> protocol-compiler

```text
HypothesisRecord + AnalysisPlan + capabilities -> ExperimentSpec
```

### protocol-compiler -> experiment-research

```text
ExperimentSpec -> validate -> preflight -> run
```

### experiment-research -> data-analysis

```text
RunRecord + artifacts + AnalysisPlan -> QCReport + StatisticalResult
```

### data-analysis -> hypothesis-research

```text
StatisticalResult + QCReport -> ScientificConclusion -> HypothesisRecord update
```

### all extensions -> research-report

```text
EvidenceClaim + HypothesisRecord + ExperimentDecision + RunSummary + StatisticalResult -> report
```

## Tool Exposure Policy

Planner-visible macro tools:

- `search_literature`
- `build_literature_review`
- `create_hypothesis`
- `compile_experiment_spec`
- `validate_experiment_spec`
- `run_preflight`
- `run_experiment`
- `analyze_run`
- `evaluate_hypothesis`
- `plan_next_experiment`
- `build_research_report`

Operator or maintenance tools should not be in the default planner active set:

- `pause_run`
- `abort_run`
- `poll_run`
- `approve_hardware_run`
- `register_sample`
- `override_qc`
- low-level hardware tools

上表是完整目标形态。v1 实际新增的 planner 工具只有三个：`create_hypothesis`、
`register_analysis_plan`、`evaluate_hypothesis`，其余沿用 experiment-research 既有集合。

两条运行时纪律：

- planner 同时可见的工具随研究阶段用 `setActiveTools()` 收窄（假设阶段不暴露 run
  工具，run 进行中不暴露 report/评估工具）。十几个相近宏工具同时可见会推高 LLM
  误选率，且每轮都付全部 schema 的 context 成本。
- 所有新工具遵守 ToolResult 双通道：`content` 只放摘要与 id，完整记录进 `details`
  与磁盘；evidence 原文、统计明细不内联进 context。session 恢复后先经
  `get_experiment_state`（v1 扩展其返回值，附 hypothesis/conclusion 摘要）重建状态。

## Development Phases

阶段编号用 **R 前缀**，避免与 experiment-research extension 的 phase 4–10（hardware
pilot、async lifecycle、Raman bridge）撞号。两条路线并行推进，在 R2 合流。

### Phase R0: Research Object Contracts

Goal: define shared schemas and enforcement.

- `HypothesisRecord`、`AnalysisPlan`、`ScientificConclusion`、`EvidenceClaim` schema、
  fixtures 与 schema 测试。
- `ExperimentSpec.links` 显式扩展（schema + validator 测试）；`analysisPlanHash`
  进准入链 policy 校验。
- `.pi/research/` store，复用 run store 的单写者/原子写实现。
- 既有 `decisions.jsonl` 记录扩展 `hypothesisId`、`evidenceIds`、`rejectedAlternatives`。

Exit criteria:

- fake 数据可以把 evidence -> hypothesis -> plan -> spec 完整链接起来，不跑任何 run；
  缺 plan 或 hash 不一致的 spec 被 policy 拒绝。

### Phase R1: Minimal Scientific Loop (simulation)

Goal: 闭合本文"Recommended Next Step"的最小推理闭环，回答"为什么跑、结果是否支持假设"。

- 人工录入 evidence -> `create_hypothesis` -> `register_analysis_plan`
  -> 既有 validate/preflight/run（simulation）
  -> 确定性 QC 与 `compare_to_prediction`（按预登记标准判定，TS 内聚合）
  -> `evaluate_hypothesis` 产出 `ScientificConclusion` 并迁移 hypothesis 状态
  -> `plan_next_experiment` 写扩展后的 decision audit。
- 按阶段切换 `setActiveTools()`。

Exit criteria:

- 验收标准 1、4–7、9、10 全部可从磁盘记录回答；2–3 以人工 evidence 满足。

### Phase R2: Hypothesis-Driven Raman Demo (hardware 合流)

Goal: 第一个真实 auto-research demo。

- 依赖 `raman_hardware_integration` Phase 8（谱采集闭环）就绪。
- 同一闭环切换 hardware 模式：假设（如"区域 X 存在特征峰 Y"）-> 真实 Raman mapping
  -> bridge 返回的确定性谱指标 -> 结论与下一轮决策。
- 数值计算留在 Python bridge 侧（与 Raman 接入同一边界原则），TS 只消费结果。

Exit criteria:

- 一次真实 Raman 实验的"为什么跑、结果是否支持假设、下一步为什么"全部可从记录重建。

### Deferred（按需启动，不进入 v1）

- 文献检索/导入/抽取自动化（PaperQA2 类栈、citation graph、`.pi/literature/` 根）。
- 正式统计检验库（effect size、CI、power、replicate 设计）；启动时数值实现放
  Python 侧，不在 TS 重写统计库。
- protocol compiler 独立工具链与 rejected alternatives 的结构化对比。
- `build_research_report`、方法/图表导出、Zotero/BibTeX、ELN/LIMS 连接器。
- extension 拆分：literature-research、hypothesis-research、protocol-compiler、
  data-analysis、research-report 独立化与跨 extension 契约。

## Acceptance Criteria

The upgraded pi workflow is acceptable when it can answer these questions from records:

1. What hypothesis is this experiment testing?
2. What literature evidence motivated the hypothesis?
3. What alternative experiments were considered and rejected?
4. What exact `ExperimentSpec` was executed?
5. What preflight, approval, and capability snapshot allowed the run?
6. What raw artifacts were generated?
7. What QC rules passed or failed?
8. What statistical analysis was run and why?
9. Does the result support, weaken, reject, or leave the hypothesis inconclusive?
10. Why is the next experiment or stop decision justified?

## Risks and Controls

| Risk | Control |
| --- | --- |
| Agent invents scientific rationale | Require `EvidenceClaim` or explicit “evidence missing” state |
| Experiment is not actually testing the stated hypothesis | Require `HypothesisRecord.predictedObservations` and `AnalysisPlan` before execution |
| Post-hoc analysis bias | Pre-register `AnalysisPlan` before `run_experiment` |
| Bad data interpreted as discovery | QC report gates statistical conclusion |
| Noisy result overinterpreted | Require effect size, uncertainty, replicate count, and limitations |
| Literature bypasses lab safety | Evidence informs planning only; policy/preflight/approval remain authoritative |
| Session becomes the only source of truth | Store durable records under `.pi/research`, `.pi/literature`, `.pi/experiment-runs`, `.pi/analysis` |
| Multi-extension coupling | Exchange IDs and narrow records, not internal module imports |
| Too much built at once | Implement contracts first, then close one fake workflow before adding real APIs/hardware |

## Recommended Next Step

Build the smallest complete scientific reasoning loop in simulation:

```text
fake literature evidence
  -> create_hypothesis
  -> compile_experiment_spec
  -> run_preflight
  -> run_experiment
  -> run_qc
  -> run_statistical_analysis
  -> evaluate_hypothesis
  -> plan_next_experiment or stop
```

This milestone proves the real upgrade: pi can explain why an experiment was run and whether the result supports the hypothesis, without depending on real hardware, paid APIs, or a large RAG system.
