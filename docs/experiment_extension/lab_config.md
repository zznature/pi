# Lab Config

将动态的属性进行配置，给Agent提供实验环境信息。

## 1. 资源配置：仪器型号、连接方式（例如COM口、GPIB、IP地址）、仪器状态（例如是否可用）

例如位移台：

intrument_name: stage
intrument_id: mc-newton-xyz-stage
intrument_type: motion
intrument_connection: serial
intrument_connection_port: COM3
intrument_status: available
intrument_usage: exclusive

例如cryostat：

intrument_name: cryostat
intrument_id: ppms_001
intrument_type: cryostat
intrument_connection: tcp
intrument_connection_ip: 192.168.1.100
intrument_connection_port: 10000
intrument_status: available
intrument_resource: helium>50% for magnetic field

## 2. 样品配置：样品ID、样品成分、安全要求(例如激光功率、安全窗口)

例如石墨烯：

sample_id: graphene-001
sample_composition: graphene
sample_safety_requirements: laser_power_10_mw, current_1_ma


