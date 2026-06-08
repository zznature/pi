# IDS uEye DirectShow/ActiveX camera path

这个目录用于验证并沉淀 IDS uEye 相机的 DirectShow/ActiveX 采帧路线。

当前方案不使用 `pyueye`。原因是实验室机器上可见的 `IDS uEyeCapture.ax` 是 DirectShow COM filter，而不是 `IDispatch` 自动化对象。纯 `win32com.client.Dispatch(...)` 只能调用实现了 `IDispatch::Invoke` 的脚本自动化对象，不能直接按方法名调用这种 DirectShow filter 的 vtable 接口。

因此本目录采用：

```text
Python + pywin32
  -> 初始化 COM、做设备发现、组织命令行和后续业务流程

内嵌 .NET / C# DirectShow interop
  -> 定义 DirectShow COM 接口
  -> 通过 IUnknown/vtable 调用 IBaseFilter、IFilterGraph、ICaptureGraphBuilder2、ISampleGrabber
  -> 构建 graph 并采集帧
```

## 技术路线

`uEyeCapture.ax` 注册后会作为 DirectShow video input filter 出现在系统设备枚举器中。它暴露的是 DirectShow 标准 COM 接口，例如 `IBaseFilter`、`IPin`、`IFilterGraph`、`ICaptureGraphBuilder2`、`IMediaControl`、`ISampleGrabber` 等。

这些接口主要是 `IUnknown + vtable` 风格，不是自动化接口。Python 仍然负责调用 `pythoncom.CoInitialize()` 初始化 COM，但具体 DirectShow 方法调用放在 C# 互操作层中完成。C# 通过 `[ComImport]`、`[Guid]`、`[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]` 明确定义接口 GUID、方法顺序和参数 marshaling，然后由 .NET runtime 完成 vtable 调用。

采帧流程：

```text
枚举 DirectShow video input devices
  -> 按 FriendlyName 选择 IDS/uEye 相机
  -> BindToObject 得到 IBaseFilter
  -> 创建 FilterGraph + CaptureGraphBuilder2
  -> source filter -> SampleGrabber -> NullRenderer
  -> Run graph
  -> SampleGrabber.GetCurrentBuffer()
  -> 写出 BMP 或返回给 Python 上层处理
```

## 文件说明

- `capture_ids_camera_activex.py`
  Python 入口。初始化 COM，枚举 DirectShow 设备，临时编译/运行内嵌 C# DirectShow helper，并通过 Sample Grabber 捕获一帧 BMP。

- `Probe-DirectShowCamera.ps1`
  只做 DirectShow 设备枚举和 `IBaseFilter` 绑定测试，不启动采集。适合先确认 `uEyeCapture.ax` 是否已正确注册。

- `Run-DirectShowCameraSmoke.ps1`
  构建最小 DirectShow graph，连接到 Null Renderer，短时间运行后停止。适合验证 graph 是否能跑通，但不保存图像。

- `test_ids_camera_com.py` / `Test-IdsCameraActiveX.ps1`
  旧的 COM/ActiveX 自动化探测工具。它们仍可用于排查 LabSpec 或其他自动化对象，但不是当前 IDS uEye DirectShow 采帧主路线。

## 依赖

Windows 机器需要安装：

- IDS uEye 驱动和 DirectShow 组件，确保 `uEyeCapture.ax` 已注册。
- Python 3.x。
- `pywin32`，用于 Python 侧 COM 初始化。
- 可用的 .NET/C# 编译运行环境。当前脚本通过 PowerShell `Add-Type` 编译内嵌 C#。

安装 Python 依赖：

```powershell
pip install pywin32
```

如果使用项目级依赖，也可以在 `raman` 目录下执行：

```powershell
pip install -r requirements.txt
```

注意：项目其他模块可能仍列出 `pyueye`，但本目录的 DirectShow/ActiveX 路线不依赖它。

## 运行顺序

建议按下面顺序验证，先确认注册和绑定，再跑 graph，最后采帧。

### 1. 枚举并绑定 DirectShow 相机

```powershell
cd D:\RamanLab\RamanLab\raman\camera-activeX
powershell -ExecutionPolicy Bypass -File .\Probe-DirectShowCamera.ps1
```

成功时应能看到 DirectShow video input device 的 `FriendlyName`，并且 `BindToObject(IBaseFilter): OK`。

### 2. 跑最小 DirectShow graph

默认按 `UI358x` 匹配相机名称：

```powershell
powershell -ExecutionPolicy Bypass -File .\Run-DirectShowCameraSmoke.ps1
```

如果设备名称不同，指定一段 friendly name：

```powershell
powershell -ExecutionPolicy Bypass -File .\Run-DirectShowCameraSmoke.ps1 -NameContains "uEye"
```

这个步骤只验证 source filter 能连接到 Null Renderer 并运行，不保存图像。

### 3. Python 采集一帧

先列出 Python 侧发现的 DirectShow 设备：

```powershell
python .\capture_ids_camera_activex.py --list-devices
```

采集一帧 BMP：

```powershell
python .\capture_ids_camera_activex.py --name-contains "UI358x" --output .\ids_frame.bmp
```

如果设备 friendly name 不包含 `UI358x`，改用实际名称中的稳定子串，例如：

```powershell
python .\capture_ids_camera_activex.py --name-contains "uEye" --output .\ids_frame.bmp
```

## 位数要求

DirectShow filter、PowerShell/.NET 进程、Python 进程的位数必须匹配。脚本会打印当前进程是 32-bit 还是 64-bit。

如果 `uEyeCapture.ax` 只注册为 32-bit，需要使用 32-bit PowerShell 和 32-bit Python。32-bit PowerShell 路径通常是：

```powershell
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
```

## 常见问题

- `win32com.client.Dispatch` 无法调用相机方法
  这是预期现象。`uEyeCapture.ax` 是 DirectShow COM filter，不是 `IDispatch` 自动化对象。应使用本目录的 DirectShow graph 路线。

- 找不到 DirectShow video input device
  优先确认 IDS 驱动和 DirectShow 组件已安装，并确认 `uEyeCapture.ax` 已注册。也要检查 32/64-bit 是否匹配。

- 可以枚举设备，但 graph 跑不起来
  可能是相机被 LabSpec 或其他软件占用，也可能是输出 pin 媒体类型无法自动协商。先关闭占用相机的软件，再用 `Run-DirectShowCameraSmoke.ps1` 缩小问题范围。

- graph 能跑，但采不到 BMP
  可能是 Sample Grabber 连接的媒体类型不符合当前相机输出，或 timeout 太短。可以增大 `--timeout-ms`，并在 C# helper 中继续补充媒体类型协商逻辑。

## 当前结论

本目录的主路线是 DirectShow/COM vtable 调用，不是 `pyueye` SDK 调用，也不是 `IDispatch` 自动化调用。Python 保留为上层控制语言；DirectShow 的底层 graph 构建、接口 marshaling 和采帧由内嵌 .NET/C# 互操作层完成。
