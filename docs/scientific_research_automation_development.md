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

首版不需要同时实现全部 extension。优先把公共数据契约定清楚，让后续 extension 可以逐步接入。

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

### ExperimentDecision

每次运行实验、停止实验或改变策略都应写入 decision audit。

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

Recommended top-level stores:

```text
.pi/research/
  hypotheses/
    <hypothesis-id>.json
  decisions/
    decisions.jsonl
  conclusions/
    <conclusion-id>.json
  reports/
    <report-id>.md

.pi/literature/
  papers/
  searches/
  reviews/
  evidence/
  references.bib

.pi/experiment-runs/
  experiments/
  runs/

.pi/analysis/
  plans/
  runs/
  qc/
  figures/
```

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
- `approve_hardware_run`
- `register_sample`
- `override_qc`
- low-level hardware tools

## Development Phases

### Phase 0: Research Object Contracts

Goal: define shared schemas and records.

- Add `HypothesisRecord`, `AnalysisPlan`, `ExperimentDecision`, `ScientificConclusion`.
- Add `.pi/research/` and `.pi/analysis/` storage conventions.
- Add schema tests and fixture examples.

Exit criteria:

- A fake workflow can link literature evidence to a hypothesis and a planned experiment without running hardware.

### Phase 1: Literature and Hypothesis Loop

Goal: answer “why this experiment?”

- Implement minimal `literature-research` metadata search and evidence extraction.
- Implement `create_hypothesis`.
- Link `HypothesisRecord` to evidence and experiment objective.
- Add `reviewId/evidenceIds/hypothesisId` to experiment planning inputs.

Exit criteria:

- Every proposed experiment can cite supporting literature evidence or explicitly say evidence is missing.

### Phase 2: Protocol Compiler

Goal: make experiment design auditable.

- Implement `compile_experiment_spec`.
- Record rejected protocol alternatives.
- Generate `AnalysisPlan` before execution.
- Require `analysisPlanId` in experiment records.

Exit criteria:

- Agent can explain why the selected protocol matches the hypothesis and constraints.

### Phase 3: Analysis and QC Pipeline

Goal: answer “does the result support the hypothesis?”

- Implement deterministic artifact processing.
- Implement domain QC rules.
- Implement statistical analysis against `AnalysisPlan`.
- Generate `ScientificConclusion`.

Exit criteria:

- A run result updates hypothesis status through QC and statistics, not raw summary text.

### Phase 4: Multi-Round Research Loop

Goal: close the adaptive research loop.

- Extend `plan_next_experiment` to use evidence, hypothesis status, analysis results, and stopping criteria.
- Record decision audit for repeat/refine/stop/change_strategy.
- Add comparison across multiple runs.

Exit criteria:

- Agent can justify the next experiment or stopping decision from structured records.

### Phase 5: Reporting and External Integrations

Goal: produce research outputs and connect lab systems.

- Implement `build_research_report`.
- Add Zotero/BibTeX export flow.
- Add optional ELN/LIMS connectors.
- Add figure and methods export.

Exit criteria:

- A report can be generated from records with citations, methods, figures, results, limitations, and decision history.

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
