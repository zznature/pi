"""
Capture one frame from an IDS uEye camera through the ActiveX/COM DirectShow path.

The IDS uEye DirectShow component (ueyecapture.ax) is a COM filter, not an
IDispatch automation object. pywin32 is used to initialize/check COM from
Python, while a small in-process .NET DirectShow interop helper performs the
vtable calls needed for graph construction and Sample Grabber frame capture.
"""

from __future__ import annotations

import argparse
import os
import struct
import subprocess
import sys
import tempfile
import textwrap
import time
import winreg
from pathlib import Path

import pythoncom


VIDEO_INPUT_CATEGORY = r"CLSID\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\Instance"
DEFAULT_NAME_CONTAINS = "UI358x"


CSHARP_SOURCE = r"""
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

[ComImport, Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")]
class SystemDeviceEnumCapture {}

[ComImport, Guid("E436EBB3-524F-11CE-9F53-0020AF0BA770")]
class FilterGraphCapture {}

[ComImport, Guid("BF87B6E1-8C27-11D0-B3F0-00AA003761C5")]
class CaptureGraphBuilder2Capture {}

[ComImport, Guid("C1F400A0-3F08-11D3-9F0B-006008039E37")]
class SampleGrabberCapture {}

[ComImport, Guid("C1F400A4-3F08-11D3-9F0B-006008039E37")]
class NullRendererCapture {}

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICreateDevEnumCapture {
    [PreserveSig] int CreateClassEnumerator(ref Guid clsidDeviceClass, out IEnumMoniker ppEnumMoniker, int dwFlags);
}

[ComImport, Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBaseFilterCapture {}

[ComImport, Guid("3127CA40-446E-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IErrorLogCapture {}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyBagCapture {
    [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, out object pVar, IErrorLogCapture pErrorLog);
    [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, ref object pVar);
}

[ComImport, Guid("56A8689F-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFilterGraphCapture {
    [PreserveSig] int AddFilter([In] IBaseFilterCapture pFilter, [In, MarshalAs(UnmanagedType.LPWStr)] string pName);
    [PreserveSig] int RemoveFilter([In] IBaseFilterCapture pFilter);
    [PreserveSig] int EnumFilters(out object ppEnum);
    [PreserveSig] int FindFilterByName([In, MarshalAs(UnmanagedType.LPWStr)] string pName, out IBaseFilterCapture ppFilter);
    [PreserveSig] int ConnectDirect(IntPtr ppinOut, IntPtr ppinIn, IntPtr pmt);
    [PreserveSig] int Reconnect(IntPtr ppin);
    [PreserveSig] int Disconnect(IntPtr ppin);
    [PreserveSig] int SetDefaultSyncSource();
}

[ComImport, Guid("56A868A9-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphBuilderCapture : IFilterGraphCapture {}

[ComImport, Guid("56A868B1-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
interface IMediaControlCapture {
    [PreserveSig] int Run();
    [PreserveSig] int Pause();
    [PreserveSig] int Stop();
    [PreserveSig] int GetState(int msTimeout, out int pfs);
    [PreserveSig] int RenderFile([MarshalAs(UnmanagedType.BStr)] string strFilename);
    [PreserveSig] int AddSourceFilter([MarshalAs(UnmanagedType.BStr)] string strFilename, out object ppUnk);
    [PreserveSig] int get_FilterCollection(out object ppUnk);
    [PreserveSig] int get_RegFilterCollection(out object ppUnk);
    [PreserveSig] int StopWhenReady();
}

[ComImport, Guid("93E5A4E0-2D50-11D2-ABFA-00A0C9C6E38D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICaptureGraphBuilder2Capture {
    [PreserveSig] int SetFiltergraph([In] IGraphBuilderCapture pfg);
    [PreserveSig] int GetFiltergraph(out IGraphBuilderCapture ppfg);
    [PreserveSig] int SetOutputFileName(ref Guid pType, [MarshalAs(UnmanagedType.LPWStr)] string lpstrFile, out IBaseFilterCapture ppbf, out object ppSink);
    [PreserveSig] int FindInterface(ref Guid pCategory, ref Guid pType, IBaseFilterCapture pf, ref Guid riid, out object ppint);
    [PreserveSig] int RenderStream(ref Guid pCategory, ref Guid pType, IBaseFilterCapture pSource, IBaseFilterCapture pCompressor, IBaseFilterCapture pRenderer);
}

[ComImport, Guid("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISampleGrabberCapture {
    [PreserveSig] int SetOneShot([MarshalAs(UnmanagedType.Bool)] bool OneShot);
    [PreserveSig] int SetMediaType([In, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypeCapture pmt);
    [PreserveSig] int GetConnectedMediaType([Out, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypeCapture pmt);
    [PreserveSig] int SetBufferSamples([MarshalAs(UnmanagedType.Bool)] bool BufferThem);
    [PreserveSig] int GetCurrentBuffer(ref int pBufferSize, IntPtr pBuffer);
    [PreserveSig] int GetCurrentSample(IntPtr ppSample);
    [PreserveSig] int SetCallback(IntPtr pCallback, int WhichMethodToCallback);
}

[StructLayout(LayoutKind.Sequential)]
class AMMediaTypeCapture {
    public Guid majorType;
    public Guid subType;
    [MarshalAs(UnmanagedType.Bool)] public bool fixedSizeSamples;
    [MarshalAs(UnmanagedType.Bool)] public bool temporalCompression;
    public int sampleSize;
    public Guid formatType;
    public IntPtr unkPtr;
    public int formatSize;
    public IntPtr formatPtr;
}

[StructLayout(LayoutKind.Sequential)]
struct RectCapture {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
struct BitmapInfoHeaderCapture {
    public int Size;
    public int Width;
    public int Height;
    public short Planes;
    public short BitCount;
    public int Compression;
    public int ImageSize;
    public int XPelsPerMeter;
    public int YPelsPerMeter;
    public int ClrUsed;
    public int ClrImportant;
}

[StructLayout(LayoutKind.Sequential)]
struct VideoInfoHeaderCapture {
    public RectCapture SrcRect;
    public RectCapture TargetRect;
    public int BitRate;
    public int BitErrorRate;
    public long AvgTimePerFrame;
    public BitmapInfoHeaderCapture BmiHeader;
}

public static class DirectShowStillCapture {
    static readonly Guid MEDIATYPE_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
    static readonly Guid MEDIASUBTYPE_RGB24 = new Guid("E436EB7D-524F-11CE-9F53-0020AF0BA770");
    static readonly Guid FORMAT_VideoInfo = new Guid("05589F80-C356-11CE-BF01-00AA0055595A");
    static readonly Guid PIN_CATEGORY_CAPTURE = new Guid("FB6C4281-0353-11D1-905F-0000C0CC16BA");
    static readonly Guid IID_IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");
    static readonly Guid IID_IBaseFilter = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");

    static void CheckHr(string label, int hr) {
        Console.WriteLine(label + " hr=0x" + hr.ToString("X8"));
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    static void FreeMediaType(AMMediaTypeCapture mt) {
        if (mt == null) return;
        if (mt.formatPtr != IntPtr.Zero) {
            Marshal.FreeCoTaskMem(mt.formatPtr);
            mt.formatPtr = IntPtr.Zero;
        }
        if (mt.unkPtr != IntPtr.Zero) {
            Marshal.Release(mt.unkPtr);
            mt.unkPtr = IntPtr.Zero;
        }
    }

    static string ReadFriendlyName(IMoniker moniker) {
        object bagObj = null;
        try {
            Guid iidPropertyBag = IID_IPropertyBag;
            moniker.BindToStorage(null, null, ref iidPropertyBag, out bagObj);
            IPropertyBagCapture bag = (IPropertyBagCapture)bagObj;
            object nameObj;
            int hr = bag.Read("FriendlyName", out nameObj, null);
            return hr == 0 && nameObj != null ? Convert.ToString(nameObj) : "<unknown>";
        } finally {
            if (bagObj != null) Marshal.ReleaseComObject(bagObj);
        }
    }

    static IMoniker SelectVideoDevice(string nameContains, out string selectedName) {
        ICreateDevEnumCapture devEnum = (ICreateDevEnumCapture)new SystemDeviceEnumCapture();
        IEnumMoniker enumMoniker;
        Guid category = CLSID_VideoInputDeviceCategory;
        CheckHr("CreateClassEnumerator", devEnum.CreateClassEnumerator(ref category, out enumMoniker, 0));
        if (enumMoniker == null) throw new InvalidOperationException("No DirectShow video input devices found.");

        IMoniker[] monikers = new IMoniker[1];
        IntPtr fetched = Marshal.AllocCoTaskMem(IntPtr.Size);
        try {
            while (enumMoniker.Next(1, monikers, fetched) == 0) {
                string name = ReadFriendlyName(monikers[0]);
                Console.WriteLine("Found video device: " + name);
                if (name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) {
                    selectedName = name;
                    return monikers[0];
                }
                Marshal.ReleaseComObject(monikers[0]);
            }
        } finally {
            Marshal.FreeCoTaskMem(fetched);
            Marshal.ReleaseComObject(enumMoniker);
            Marshal.ReleaseComObject(devEnum);
        }

        throw new InvalidOperationException("No DirectShow video input device matched: " + nameContains);
    }

    static void WriteBmp(string outputPath, byte[] data, int width, int height, int bitCount) {
        if (bitCount != 24) {
            throw new InvalidOperationException("Only RGB24 capture is supported by this script. BitCount=" + bitCount);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath)));
        int fileHeaderSize = 14;
        int infoHeaderSize = 40;
        int pixelOffset = fileHeaderSize + infoHeaderSize;
        int fileSize = pixelOffset + data.Length;

        using (FileStream fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read))
        using (BinaryWriter bw = new BinaryWriter(fs)) {
            bw.Write((byte)'B');
            bw.Write((byte)'M');
            bw.Write(fileSize);
            bw.Write((short)0);
            bw.Write((short)0);
            bw.Write(pixelOffset);

            bw.Write(infoHeaderSize);
            bw.Write(width);
            bw.Write(height);
            bw.Write((short)1);
            bw.Write((short)bitCount);
            bw.Write(0);
            bw.Write(data.Length);
            bw.Write(0);
            bw.Write(0);
            bw.Write(0);
            bw.Write(0);
            bw.Write(data);
        }
    }

    public static int Capture(string nameContains, string outputPath, int timeoutMs) {
        Console.WriteLine("Process bitness: " + (IntPtr.Size * 8) + "-bit");

        IMoniker moniker = null;
        IBaseFilterCapture sourceFilter = null;
        IBaseFilterCapture sampleGrabberFilter = null;
        IBaseFilterCapture nullRenderer = null;
        IGraphBuilderCapture graph = null;
        ICaptureGraphBuilder2Capture captureBuilder = null;
        IMediaControlCapture mediaControl = null;

        try {
            string selectedName;
            moniker = SelectVideoDevice(nameContains, out selectedName);
            Console.WriteLine("Selected device: " + selectedName);

            object sourceObj;
            Guid iidBaseFilter = IID_IBaseFilter;
            moniker.BindToObject(null, null, ref iidBaseFilter, out sourceObj);
            sourceFilter = (IBaseFilterCapture)sourceObj;

            object sampleGrabberObj = new SampleGrabberCapture();
            sampleGrabberFilter = (IBaseFilterCapture)sampleGrabberObj;
            ISampleGrabberCapture grabber = (ISampleGrabberCapture)sampleGrabberObj;

            AMMediaTypeCapture requested = new AMMediaTypeCapture();
            requested.majorType = MEDIATYPE_Video;
            requested.subType = MEDIASUBTYPE_RGB24;
            requested.formatType = FORMAT_VideoInfo;
            CheckHr("SampleGrabber.SetMediaType", grabber.SetMediaType(requested));
            CheckHr("SampleGrabber.SetBufferSamples", grabber.SetBufferSamples(true));
            CheckHr("SampleGrabber.SetOneShot", grabber.SetOneShot(false));

            nullRenderer = (IBaseFilterCapture)new NullRendererCapture();
            graph = (IGraphBuilderCapture)new FilterGraphCapture();
            captureBuilder = (ICaptureGraphBuilder2Capture)new CaptureGraphBuilder2Capture();

            CheckHr("CaptureGraphBuilder.SetFiltergraph", captureBuilder.SetFiltergraph(graph));
            CheckHr("Graph.Add source", ((IFilterGraphCapture)graph).AddFilter(sourceFilter, "IDS uEye Source"));
            CheckHr("Graph.Add sample grabber", ((IFilterGraphCapture)graph).AddFilter(sampleGrabberFilter, "Sample Grabber"));
            CheckHr("Graph.Add null renderer", ((IFilterGraphCapture)graph).AddFilter(nullRenderer, "Null Renderer"));

            Guid pinCategory = PIN_CATEGORY_CAPTURE;
            Guid mediaType = MEDIATYPE_Video;
            CheckHr("CaptureGraphBuilder.RenderStream", captureBuilder.RenderStream(ref pinCategory, ref mediaType, sourceFilter, sampleGrabberFilter, nullRenderer));

            AMMediaTypeCapture connected = new AMMediaTypeCapture();
            CheckHr("SampleGrabber.GetConnectedMediaType", grabber.GetConnectedMediaType(connected));
            if (connected.formatPtr == IntPtr.Zero) {
                throw new InvalidOperationException("Sample Grabber returned no video format.");
            }

            VideoInfoHeaderCapture vih = (VideoInfoHeaderCapture)Marshal.PtrToStructure(connected.formatPtr, typeof(VideoInfoHeaderCapture));
            int width = vih.BmiHeader.Width;
            int height = vih.BmiHeader.Height;
            int bitCount = vih.BmiHeader.BitCount;
            Console.WriteLine("Connected format: " + width + "x" + height + " bitCount=" + bitCount);

            mediaControl = (IMediaControlCapture)graph;
            CheckHr("MediaControl.Run", mediaControl.Run());

            int size = 0;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline) {
                int hr = grabber.GetCurrentBuffer(ref size, IntPtr.Zero);
                if (hr >= 0 && size > 0) break;
                Thread.Sleep(50);
            }
            if (size <= 0) {
                throw new TimeoutException("Timed out waiting for a frame from Sample Grabber.");
            }

            IntPtr buffer = Marshal.AllocCoTaskMem(size);
            try {
                CheckHr("SampleGrabber.GetCurrentBuffer", grabber.GetCurrentBuffer(ref size, buffer));
                byte[] data = new byte[size];
                Marshal.Copy(buffer, data, 0, size);
                WriteBmp(outputPath, data, width, height, bitCount);
                Console.WriteLine("Saved BMP: " + outputPath);
                Console.WriteLine("Bytes: " + size);
            } finally {
                Marshal.FreeCoTaskMem(buffer);
            }

            CheckHr("MediaControl.Stop", mediaControl.Stop());
            FreeMediaType(connected);
            return 0;
        } finally {
            if (mediaControl != null) Marshal.ReleaseComObject(mediaControl);
            if (captureBuilder != null) Marshal.ReleaseComObject(captureBuilder);
            if (graph != null) Marshal.ReleaseComObject(graph);
            if (nullRenderer != null) Marshal.ReleaseComObject(nullRenderer);
            if (sampleGrabberFilter != null) Marshal.ReleaseComObject(sampleGrabberFilter);
            if (sourceFilter != null) Marshal.ReleaseComObject(sourceFilter);
            if (moniker != null) Marshal.ReleaseComObject(moniker);
        }
    }
}
"""


POWERSHELL_WRAPPER = r"""
param(
    [Parameter(Mandatory=$true)][string]$NameContains,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][int]$TimeoutMs,
    [Parameter(Mandatory=$true)][string]$SourcePath
)

$ErrorActionPreference = "Stop"
$source = Get-Content -LiteralPath $SourcePath -Raw
Add-Type -TypeDefinition $source
[DirectShowStillCapture]::Capture($NameContains, $OutputPath, $TimeoutMs)
"""


def discover_directshow_devices() -> list[dict[str, str]]:
    devices: list[dict[str, str]] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, VIDEO_INPUT_CATEGORY) as root:
            index = 0
            while True:
                try:
                    subkey_name = winreg.EnumKey(root, index)
                except OSError:
                    break
                index += 1

                with winreg.OpenKey(root, subkey_name) as subkey:
                    values: dict[str, str] = {"registry_key": subkey_name}
                    for value_name in ("FriendlyName", "CLSID"):
                        try:
                            value, _ = winreg.QueryValueEx(subkey, value_name)
                            values[value_name] = str(value)
                        except OSError:
                            pass
                    devices.append(values)
    except OSError:
        return []
    return devices


def default_output_path() -> Path:
    script_dir = Path(__file__).resolve().parent
    capture_dir = script_dir.parent / "captures"
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return capture_dir / f"ids_ui358x_activex_{stamp}.bmp"


def run_capture(name_contains: str, output_path: Path, timeout_ms: int) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory(prefix="ids_activex_capture_") as tmp:
        tmp_path = Path(tmp)
        csharp_path = tmp_path / "DirectShowStillCapture.cs"
        wrapper_path = tmp_path / "run_capture.ps1"
        csharp_path.write_text(CSHARP_SOURCE, encoding="utf-8")
        wrapper_path.write_text(POWERSHELL_WRAPPER, encoding="utf-8")

        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(wrapper_path),
            "-NameContains",
            name_contains,
            "-OutputPath",
            str(output_path),
            "-TimeoutMs",
            str(timeout_ms),
            "-SourcePath",
            str(csharp_path),
        ]
        return subprocess.run(command, text=True, capture_output=True, check=False)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture one IDS uEye frame through the ActiveX/COM DirectShow path."
    )
    parser.add_argument(
        "--name-contains",
        default=DEFAULT_NAME_CONTAINS,
        help="Substring used to select the DirectShow camera friendly name.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output_path(),
        help="BMP output path.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=5000,
        help="Maximum time to wait for one frame.",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="List registered DirectShow video input devices and exit.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    pythoncom.CoInitialize()
    try:
        print(f"Python: {sys.version.split()[0]}; process bitness: {struct.calcsize('P') * 8}-bit")
        print("pywin32 COM initialized.")

        devices = discover_directshow_devices()
        if not devices:
            print("No DirectShow video input devices found in registry.", file=sys.stderr)
            return 2

        print("Registered DirectShow video devices:")
        for device in devices:
            print(
                "  "
                + device.get("FriendlyName", "<unknown>")
                + "  "
                + device.get("CLSID", "")
            )

        if args.list_devices:
            return 0

        args.output = args.output.resolve()
        args.output.parent.mkdir(parents=True, exist_ok=True)

        result = run_capture(args.name_contains, args.output, args.timeout_ms)
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        if result.returncode != 0:
            return result.returncode
        if not args.output.exists() or args.output.stat().st_size == 0:
            print(f"Capture command completed but output file is missing/empty: {args.output}", file=sys.stderr)
            return 1

        print(f"Output file: {args.output}")
        print(f"Output size: {args.output.stat().st_size} bytes")
        return 0
    finally:
        pythoncom.CoUninitialize()


if __name__ == "__main__":
    raise SystemExit(main())
