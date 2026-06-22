# Sample Registry (MVP)

本方案的目标不是完整描述实验室环境，而是为 Agent 提供最小且稳定的样品信息上下文。

MVP 阶段只解决一个问题：

> Agent 需要知道实验室里有哪些样品，以及当前测试样品的基本信息。

因此，这份配置只包含样品相关元数据，不包含仪器连接、设备状态、资源占用等运行态信息。

## 1. 设计边界

### 包含内容

- 实验室样品清单
- 当前测试样品的基本信息
- 人工维护的静态描述字段

### 不包含内容

- 仪器型号、串口、IP、GPIB 等连接信息
- 仪器可用性、排队状态、资源占用
- 实验实时状态
- 自动控制参数
- 复杂安全规则

如果未来需要设备控制，应单独设计 `instrument_registry` 或 `runtime_context`，不要继续堆进 `sample_registry`。

## 2. 配置目标

Agent 读取这份配置后，应当能回答以下问题：

1. 实验室里有哪些已登记样品
2. 当前准备测试的是哪个样品
3. 该样品的材料、基底、批次等基本背景是什么
4. 该样品有没有需要备注的人为说明

## 3. 推荐结构

建议使用一个简单的 YAML 文件，分成两部分：

- `sample_catalog`: 实验室已登记样品
- `active_sample`: 当前测试样品

## 4. 字段定义

### 4.1 `sample_catalog`

用于描述实验室中可被 Agent 识别的样品列表。

每个样品建议包含以下字段：

- `sample_id`: 样品唯一标识，必填
- `name`: 样品名称，必填
- `material`: 样品主要材料或体系，必填
- `substrate`: 基底或载体，选填
- `batch`: 批次、来源或制备编号，选填
- `form`: 样品形态，选填，例如 `flake`、`film`、`bulk`
- `storage_location`: 存放位置，选填
- `notes`: 备注，选填

### 4.2 `active_sample`

用于描述当前实验准备测试的样品。

建议字段：

- `sample_id`: 对应 `sample_catalog` 中的样品 ID，必填
- `label_in_experiment`: 当前实验中的人工标签，选填
- `mounted_on`: 当前装载位置，选填，例如 `holder_A1`
- `notes`: 当前测试备注，选填

`active_sample` 应尽量引用 `sample_catalog` 中已有样品，而不是重复填写一整份样品信息，避免信息漂移。

## 5. 示例

```yaml
sample_catalog:
  - sample_id: graphene-001
    name: CVD Graphene on SiO2/Si
    material: graphene
    substrate: SiO2/Si
    batch: CVD-2026-03
    form: film
    storage_location: cabinet-A / box-2
    notes: baseline reference sample

  - sample_id: mos2-007
    name: Exfoliated MoS2 Flake
    material: MoS2
    substrate: SiO2/Si
    batch: EXF-2026-05
    form: flake
    storage_location: cabinet-B / slide-7
    notes: optical contrast is clear near edge

active_sample:
  sample_id: mos2-007
  label_in_experiment: test-sample-01
  mounted_on: holder-A1
  notes: selected for initial Raman verification
```

## 6. MVP 约束

为避免配置失控，MVP 阶段建议遵守以下约束：

- 不在这里写设备信息
- 不在这里写实时实验结果
- 不在这里写复杂 protocol
- 不在这里写细粒度安全联锁逻辑
- 只保留 Agent 识别样品所必需的信息

## 7. 后续扩展方向

当 MVP 跑通后，再考虑拆分以下独立配置：

- `instrument_config`: 仪器静态信息与连接信息
- `experiment_context`: 当前实验任务、目标和步骤
- `safety_constraints`: 与激光功率、温区、电流等相关的约束

当前阶段不建议提前设计这些结构。
