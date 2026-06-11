


## context

实验 agent 的关键 context 很多是结构化状态：
  仪器坐标、光栅/积分时间、calibration version、样品 metadata、spectrum artifact IDs、失败条件。
  把这些只压进自然语言 summary，会有漂移风险。

pi compaction 当作“对话压缩层”，同时为 Raman 加一个外部 durable memory/artifact index：实验状态用 JSON/schema 存储，谱图和图像用文件/artifact 存储，summary 只引用 ID 和关键结论。这样 context window 里放的是索引和当前目标，不是全部实验事实。