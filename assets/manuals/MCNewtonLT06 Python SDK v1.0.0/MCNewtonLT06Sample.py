"""
下方代码为Sample General Usage Demo，此Demo用于理解控制器通用控制流程

使用前，请确认：
	1.已正确连接设备与位移台控制线缆
	2.已正确连接设备通讯线缆
	3.控制器处于开机状态

此Demo使用流程：

上电操作
	1.Connect Device:连接设备(connect,Python初始化默认连接设备串口)
	2.Initialize Parameter:打开通道，初始化参数:
	    参数设置: (set_cap/set_volt/set_freq)

	3.Move Device:可执行的运动方式及查询命令:
		开环运动: (move_open_pulse_positive/move_open_pulse_negative/
		         move_open_positive_until_stop/move_open_negative_until_stop)
		闭环运动: (move_close_target)
		停止运动: (move_stop)
		参数查询: (read_pulse/sens_voltage/check_position)

下电操作
	1.Move to Zero:建议将位移台移动回0位置
	2.Close Channel:关闭通道
	3.Disconnect Device:断开设备连接

其他操作
	步进模式: (move_slid/move_step)
	单位显示: (change_units_angle/change_units_mm)
	通讯模式: (change_tcp/change_usart)

"""

import time
from NewtonLT06.MCNewtonLT06 import *

# 上电操作
# region 1.Connect Device:连接设备(connect,Python初始化默认连接设备串口)
newtonLT06 = MCNewtonLT06("COM11")
status, hardidn = newtonLT06.hard_idn()
print("查询设备型号" + str(status))
if status == MFMCNewtonStatus.NoError:
    print("设备型号:" + hardidn)
else:
    exit()
# endregion

# region 2.Initialize Parameter:打开通道，初始化参数
# 打开1通道
status = newtonLT06.channel1_on()
# status = newtonLT06.channel_set(1, ChannelSwitch.ON)
# 打开2、3、4、5、6通道
# status = newtonLT06.channel2_on()
# status = newtonLT06.channel3_on()
# status = newtonLT06.channel4_on()
# status = newtonLT06.channel5_on()
# status = newtonLT06.channel6_on()
print("打开通道" + str(status))

# 设置电容值为1nF
cap = 1
status = newtonLT06.set_cap(cap)
print("设置电容值:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print(f"电容值成功设置为{cap}nF")

# 设置电压值为19V
volt = 19
status = newtonLT06.set_volt(volt)
print("设置电压值:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print(f"电压值成功设置为{volt}V")

# 设置频率值为500Hz
freq = 500
status = newtonLT06.set_freq(500)
print("设置频率:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print(f"频率成功设置为{freq}Hz")


# endregion

# region 3.Move Device:当前状态下，可以执行以下几种步进方式
# 开环运动
def wait_move_over():
    """
    持续查询脉冲数和位置，直至运动剩余脉冲数为0

    :return:
    """
    status, pulse = newtonLT06.read_pulse()
    print(status)
    print(f"pulse remain {pulse}")
    status, position = newtonLT06.check_position()
    print(status)
    print(f"position: {position}")
    while pulse != 0:
        time.sleep(0.1)
        status, pulse = newtonLT06.read_pulse()
        print(f"pulse remain {pulse}")
        status, position = newtonLT06.check_position()
        print(f"position: {position}")

# 正方向步进2000个脉冲
pulse = 2000
status = newtonLT06.move_open_pulse_positive(pulse)
print("正方向步进设置:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print(f"正方向步进成功设置{pulse}个脉冲")
wait_move_over()
# 反方向步进2000个脉冲
status = newtonLT06.move_open_pulse_negative(pulse)
print("反方向步进设置:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print(f"反方向步进成功设置{pulse}个脉冲")
wait_move_over()
# 反方向步进时停止
pulse = 1000
newtonLT06.move_open_pulse_negative(pulse)
time.sleep(0.10)
status = newtonLT06.move_stop()
print("设置停止运动:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print("成功设置停止运动")

stop_flag = False
def wait_to_stop():
    status = newtonLT06.move_stop()
    print("设置停止运动:" + str(status))
    if status is MFMCNewtonStatus.NoError:
        print("成功设置停止运动")
    global stop_flag
    stop_flag = True
def check_move():
    while not stop_flag:
        status, position = newtonLT06.check_position()
        print(f"position: {position}")
        time.sleep(0.1)
# 正方向持续运动
status = newtonLT06.move_open_positive_until_stop()
print("设置正方向持续运动:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print("成功设置正方向持续运动")
threading.Timer(2, wait_to_stop).start() # 2s后发送停止命令
check_move() # 持续查询当前运动状态
stop_flag = False
# 反方向持续运动
status = newtonLT06.move_open_negative_until_stop()
print("设置反方向持续运动:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print("成功设置反方向持续运动")
threading.Timer(2, wait_to_stop).start() # 2s后发送停止命令
check_move() # 持续查询当前运动状态
stop_flag = False

# 闭环运动
# 运动到5.0mm(°)位置处
status, response = newtonLT06.move_close_target(5.000)
print("闭环运动设置:" + str(status))
if response:
    print("闭环运动设置返回异常值" + response)
wait_move_over()
# 闭环运动时停止
status, response = newtonLT06.move_close_target(2.000)
print("闭环运动设置:" + str(status))
if response:
    print("闭环运动设置返回异常值" + response)
time.sleep(0.10)
status = newtonLT06.move_stop()
print("设置闭环运动停止:" + str(status))

# 运动到零位
status, response = newtonLT06.move_close_target(0)
print("设置运动到零位:" + str(status))
if response:
    print("闭环运动设置返回异常值" + response)
wait_move_over()
# endregion

time.sleep(2)

# 下电操作
# region 1.Move to Zero:建议将位移台移动回0位置
status, response = newtonLT06.move_close_target(0)
print("设置运动到零位:" + str(status))
if response:
    print("闭环运动设置返回异常值" + response)
wait_move_over()
# endregion

# region 2.Close Channel:关闭通道
# 关闭1通道
status = newtonLT06.channel1_off()
# status = newtonLT06.channel_set(1, ChannelSwitch.ON)
# 关闭2、3、4、5、6通道
# status = newtonLT06.channel2_off()
# status = newtonLT06.channel3_off()
# status = newtonLT06.channel4_off()
# status = newtonLT06.channel5_off()
# status = newtonLT06.channel6_off()
print("关闭通道:" +str(status))
# endregion

# region 3.Disconnect Device:断开设备连接
status = newtonLT06.disconnect()
print("设置断开设备连接:" + str(status))
if status is MFMCNewtonStatus.NoError:
    print("设置断开设备连接成功")
# endregion



# region 其他操作
# 如需此操作，请取消注释使用

# # 设置步进方式为slide模式
# status = newtonLT06.move_slid()
# print("设置步进方式为slide模式:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("步进方式成功设置为slide模式")
#
# # 设置步进方式为step模式
# status = newtonLT06.move_step()
# print("设置步进方式为step模式:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("步进方式成功设置为step模式")
#
# # 切换屏幕显示位置单位为mm
# status = newtonLT06.change_units_mm()
# print("设置切换屏幕显示位置单位为mm:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("成功设置切换屏幕显示位置单位为mm")
#
# # 切换屏幕显示位置单位为°
# status = newtonLT06.change_units_angle()
# print("设置切换屏幕显示位置单位为°:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("成功设置切换屏幕显示位置单位为°")
#
# # 切换通讯为网口模式
# status = newtonLT06.change_tcp()
# print("设置切换切换通讯为网口模式:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("成功设置切换通讯为网口模式")
#
# # 切换通讯为串口模式
# status = newtonLT06.change_usart()
# print("设置切换通讯为串口模式:" + str(status))
# if status is MFMCNewtonStatus.NoError:
#     print("成功设置切换通讯为串口模式")

# endregion