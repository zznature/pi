# Agents

1. stage 控制的端口号需要绑定（实验中为COM17）。
2. 采集谱线和stage位置有强绑定，需要解耦。
3. 激光功率在labspec中设置比例为0.1%, 5%, 10%, 25%，激光功率是通过衰减片控制，不是连续变化。
4. 读取/查询动作默认不用做安全校验，要不然太繁琐。

## 观察.pi\experiment-runs后优化建议

1. 把 stage port/serial health 放进 preflight，而不是等 run 失败

  记录里有 stage.port is required、COM4/COM6 PermissionError、IDN empty、Cannot parse X/Y position response: ''。建议 dry-run preflight 增加：
    - stage port 必填校验和 port discovery 输出。
    - 独占锁检测，提示哪个进程占用串口。
    - 连续 3 次 position read，空响应直接 fail。
    - IDN/read-position 的原始响应归档，方便区分驱动问题、串口占用、设备未上电。

2. 独立验证 motion residual，不完全依赖 stage adapter 的 wait_settled

  .pi/extensions/experiment-research/raman_bridge.py:488 里 visit_point 做了移动和 wait，但 completed run 的 positionAfter 仍可能离目标超过 1 µm。建议：
    - wait_settled 后由 bridge 再读一次 position，计算 dx/dy/dz residual。
    - 超 tolerance 时写 unit_error: stage_residual_out_of_tolerance。
    - 对“用户已聚焦当前位置采集单条光谱”增加 noMove/currentPosition 模式，避免把当前位置任务误编译成 x=0,y=0,z=0 或不必要的绝对移动。

3. 修复事件 sequence 和 record portability

  RamanHardwareRun 里 bridge event 使用 nextSequence()，但主循环局部 sequence 没有同步，导致 sequence 回退。建议把 event sequence 改成一个单一 allocator。另一个记录问题是 run.json 里保存了 D:
  \RamanLab\LabAgents\pi\... 绝对路径，而当前分析目录是 D:\FileSync\Projects\Agents\pi\...，建议 record 内主路径统一用相对 URI，绝对路径只作为 debug metadata。
