# LabAgents Data Model

本文定义 LabAgents 的核心数据模型，用于约束人和 agent 在实验流程中的交互数据。
原则上，研究语义、执行输入、运行约束和运行时状态必须分层建模，禁止跨层偷渡。

## Core Objects

### 1. `ExperimentIntent`

**作用**

- 给 planner / analyst / lineage 用
- 表达研究目标、假设、为什么做这一轮
- 不进入 kernel

**生产者**

- 用户
- planner
- analyst
- lineage / replan

**消费者**

- planner
- protocol compiler
- analyst
- lineage store
- UI / 审批展示

**应包含**

- `intentId`
- `experimentId`
- `objective`
- `hypothesis?`
- `question?`
- `motivation`
- `successCriteria`
- `constraints`
- `parentIntentId?`
- `evidenceRefs[]`
- `notes?`

**不应包含**

- 具体硬件执行步骤
- 运行时状态
- lease / approval 决策结果
- driver / adapter 参数

### 2. `ProcedureSpec`

**作用**

- 给 kernel 用
- 表达“执行哪个 procedure、参数是什么、资源是什么、停止条件是什么”
- 这是唯一执行输入

**生产者**

- protocol compiler
- 受限的 procedure builder

**消费者**

- dispatch
- admission chain
- kernel
- procedure runner

**应包含**

- `procedureSpecId`
- `experimentId`
- `intentId`
- `procedureId`
- `procedureVersion`
- `mode`
- `resourceBindings[]`
- `parameters`
- `limits`
- `stoppingRules`
- `outputPlan?`
- `idempotencyKey?`

**不应包含**

- hypothesis / why
- approval record
- live lab state
- progress / heartbeat
- artifact results
- next-step strategy

### 3. `RunPolicy`

**作用**

- 给 admission / supervisor confirmation / lease / mode gate 用
- 表达 lab readiness、监督人在场、危险场景确认与资源并发约束
- 不属于 procedure 本体

**生产者**

- policy engine
- operator supervision flow
- lab state service
- resource manager

**消费者**

- admission chain
- preflight
- watchdog
- operator UI

**应包含**

- `policyId`
- `experimentId`
- `applicableProcedureSpecId`
- `executionMode`
- `requiresSupervisorPresence`
- `startChecks`
- `hazardControls`
- `resourceLeaseRequirements`
- `singleActiveRun`
- `capabilitySnapshotRef?`
- `validityWindow?`

**不应包含**

- procedure 内部参数细节
- runtime progress
- scientific objective
- analysis conclusion

### 4. `RunState`

**作用**

- 给 runtime / records / watcher / resume 用
- 表达进度、heartbeat、unit 状态、pause/abort、artifacts
- 不属于 spec

**生产者**

- kernel
- procedure runner
- watchdog
- record store

**消费者**

- watcher
- analyst
- operator UI
- resume logic
- audit / replay

**应包含**

- `runId`
- `experimentId`
- `procedureSpecId`
- `status`
- `phase`
- `progress`
- `heartbeat`
- `unitStates[]` / `latestUnitState`
- `pauseReason?`
- `abortReason?`
- `errorState?`
- `artifactRefs[]`
- `startedAt`
- `updatedAt`
- `endedAt?`

**不应包含**

- 用户自由文本意图
- 未经归档的推理
- approval 规则定义本体
- 下一轮规划建议

## Ownership Rules

- `ExperimentIntent` owner: planner / analyst
- `ProcedureSpec` owner: compiler
- `RunPolicy` owner: admission / policy engine
- `RunState` owner: kernel / runtime

每个对象都必须有唯一 owner，不允许多个层同时写入同一语义事实。

## Interaction Flow

```text
User / Planner
   -> ExperimentIntent
   -> compile
   -> ProcedureSpec
   -> admission against RunPolicy
   -> supervisor confirms run
   -> kernel.execute(ProcedureSpec)
   -> RunState
   -> summary / artifacts
   -> analyst / replan
```

## Cross-Layer Constraints

1. `ExperimentIntent` 可以影响 `ProcedureSpec`，但不能直接执行。
2. `ProcedureSpec` 可以被 `RunPolicy` 拒绝，但不能自己携带审批结论。
3. `RunState` 只能由 runtime 产生，不能由 planner 预写。
4. kernel 只消费 `ProcedureSpec`，不直接消费 `ExperimentIntent`。

## Persistence Mapping

- `ExperimentIntent`: experiment record / lineage
- `ProcedureSpec`: inlined into `run.json`
- `RunPolicy`: inlined summary into `run.json`
- `RunState`: `run.json` current snapshot + `events.jsonl` append-only history

## Minimal Run Persistence

当前 Raman MVP 的 run 持久化结构保持极简，只保留：

```text
runs/<runId>/
  run.json
  events.jsonl
  artifacts/
```

约束如下：

- `run.json` 是唯一主记录文件，包含 run identity、inlined `ProcedureSpec`、
  当前 `RunState` 快照、supervisor confirmation / lease / capability 的必要摘要，以及 artifact 索引。
- `events.jsonl` 是唯一 append-only 运行日志，记录生命周期事件、unit 事件、
  watchdog 事件、pause/abort 和错误事件。
- `artifacts/` 只放真实实验产物，如光谱、图片、导出数据；records 不是 artifacts。

以下文件在当前极简模型下不再独立存在，应并回 `run.json` 或取消：

- `spec.json`
- `summary.json`
- `resume.snapshot.json`
- `approvals.jsonl`
- `leases.jsonl`
- `capabilities.snapshot.json`
- `artifacts.json`
- `intents.jsonl`

判断原则：

- 只有必须 append-only 的运行历史，才独立放入 `events.jsonl`。
- 只有真实实验产物，才进入 `artifacts/`。
- 其余 run 元数据一律优先并入 `run.json`，避免同一事实在多个文件重复保存。

## Minimal Type Skeleton

```ts
type ExperimentIntent = {
  intentId: string
  experimentId: string
  objective: string
  hypothesis?: string
  motivation: string
  successCriteria: string[]
  constraints?: {
    maxDurationHours?: number
    maxBudget?: number
    sampleLimits?: string[]
    riskNotes?: string[]
  }
  evidenceRefs?: string[]
  parentIntentId?: string
  notes?: string
}

type ProcedureSpec = {
  procedureSpecId: string
  experimentId: string
  intentId: string
  procedureId: string
  procedureVersion: string
  mode: "live-supervised"
  resourceBindings: Array<{ resourceId: string; role: string }>
  parameters: Record<string, unknown>
  limits: Record<string, unknown>
  stoppingRules: Array<{ type: string; value?: unknown }>
}

type RunPolicy = {
  policyId: string
  experimentId: string
  applicableProcedureSpecId: string
  executionMode: "live-supervised"
  requiresSupervisorPresence: true
  startChecks: {
    preflightReady: boolean
    controlAvailable: boolean
  }
  hazardControls: {
    objectiveCollisionGuard: true
    requireUserConfirmationAboveLaserPowerMw: 10
  }
  resourceLeaseRequirements: Array<{
    resourceId: string
    mode: "exclusive-control"
    ttlSec: number
  }>
  singleActiveRun: true
}

type RunState = {
  runId: string
  experimentId: string
  procedureSpecId: string
  status: "queued" | "running" | "paused" | "aborted" | "failed" | "completed"
  phase?: string
  progress?: { completed: number; total?: number; unit?: string }
  heartbeatAt?: string
  artifactRefs: string[]
}
```
