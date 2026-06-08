"""
Persistent DirectShow capture helper for IDS/uEye cameras.

This module starts one long-lived DirectShow graph in a child PowerShell/.NET
process. Python sends simple line commands over stdin:

    GRAB <path>
    EXIT

The C# side prefers 8-bit grayscale formats through IAMStreamConfig before
connecting the graph, then falls back to RGB24 if no grayscale format works.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path


CSHARP_SOURCE = r"""
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

[ComImport, Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")]
class SystemDeviceEnumPersistent {}

[ComImport, Guid("E436EBB3-524F-11CE-9F53-0020AF0BA770")]
class FilterGraphPersistent {}

[ComImport, Guid("BF87B6E1-8C27-11D0-B3F0-00AA003761C5")]
class CaptureGraphBuilder2Persistent {}

[ComImport, Guid("C1F400A0-3F08-11D3-9F0B-006008039E37")]
class SampleGrabberPersistent {}

[ComImport, Guid("C1F400A4-3F08-11D3-9F0B-006008039E37")]
class NullRendererPersistent {}

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICreateDevEnumPersistent {
    [PreserveSig] int CreateClassEnumerator(ref Guid clsidDeviceClass, out IEnumMoniker ppEnumMoniker, int dwFlags);
}

[ComImport, Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBaseFilterPersistent {}

[ComImport, Guid("3127CA40-446E-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IErrorLogPersistent {}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyBagPersistent {
    [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, out object pVar, IErrorLogPersistent pErrorLog);
    [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, ref object pVar);
}

[ComImport, Guid("56A8689F-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFilterGraphPersistent {
    [PreserveSig] int AddFilter([In] IBaseFilterPersistent pFilter, [In, MarshalAs(UnmanagedType.LPWStr)] string pName);
    [PreserveSig] int RemoveFilter([In] IBaseFilterPersistent pFilter);
    [PreserveSig] int EnumFilters(out object ppEnum);
    [PreserveSig] int FindFilterByName([In, MarshalAs(UnmanagedType.LPWStr)] string pName, out IBaseFilterPersistent ppFilter);
    [PreserveSig] int ConnectDirect(IntPtr ppinOut, IntPtr ppinIn, IntPtr pmt);
    [PreserveSig] int Reconnect(IntPtr ppin);
    [PreserveSig] int Disconnect(IntPtr ppin);
    [PreserveSig] int SetDefaultSyncSource();
}

[ComImport, Guid("56A868A9-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphBuilderPersistent : IFilterGraphPersistent {}

[ComImport, Guid("56A868B1-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
interface IMediaControlPersistent {
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
interface ICaptureGraphBuilder2Persistent {
    [PreserveSig] int SetFiltergraph([In] IGraphBuilderPersistent pfg);
    [PreserveSig] int GetFiltergraph(out IGraphBuilderPersistent ppfg);
    [PreserveSig] int SetOutputFileName(ref Guid pType, [MarshalAs(UnmanagedType.LPWStr)] string lpstrFile, out IBaseFilterPersistent ppbf, out object ppSink);
    [PreserveSig] int FindInterface(ref Guid pCategory, ref Guid pType, IBaseFilterPersistent pf, ref Guid riid, out IntPtr ppint);
    [PreserveSig] int RenderStream(ref Guid pCategory, ref Guid pType, IBaseFilterPersistent pSource, IBaseFilterPersistent pCompressor, IBaseFilterPersistent pRenderer);
}

[ComImport, Guid("6B652FFF-11FE-4FCE-92AD-0266B5D7C78F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISampleGrabberPersistent {
    [PreserveSig] int SetOneShot([MarshalAs(UnmanagedType.Bool)] bool OneShot);
    [PreserveSig] int SetMediaType([In, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypePersistent pmt);
    [PreserveSig] int GetConnectedMediaType([Out, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypePersistent pmt);
    [PreserveSig] int SetBufferSamples([MarshalAs(UnmanagedType.Bool)] bool BufferThem);
    [PreserveSig] int GetCurrentBuffer(ref int pBufferSize, IntPtr pBuffer);
    [PreserveSig] int GetCurrentSample(IntPtr ppSample);
    [PreserveSig] int SetCallback(IntPtr pCallback, int WhichMethodToCallback);
}

[ComImport, Guid("C6E13340-30AC-11D0-A18C-00A0C9118956"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAMStreamConfigPersistent {
    [PreserveSig] int SetFormat([In, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypePersistent pmt);
    [PreserveSig] int GetFormat([Out, MarshalAs(UnmanagedType.LPStruct)] AMMediaTypePersistent pmt);
    [PreserveSig] int GetNumberOfCapabilities(out int piCount, out int piSize);
    [PreserveSig] int GetStreamCaps(int iIndex, out IntPtr ppmt, IntPtr pSCC);
}

[StructLayout(LayoutKind.Sequential)]
class AMMediaTypePersistent {
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
struct RectPersistent {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

[StructLayout(LayoutKind.Sequential)]
struct BitmapInfoHeaderPersistent {
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
struct VideoInfoHeaderPersistent {
    public RectPersistent SrcRect;
    public RectPersistent TargetRect;
    public int BitRate;
    public int BitErrorRate;
    public long AvgTimePerFrame;
    public BitmapInfoHeaderPersistent BmiHeader;
}

public static class DirectShowPersistentCapture {
    static readonly Guid MEDIATYPE_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
    static readonly Guid MEDIASUBTYPE_RGB24 = new Guid("E436EB7D-524F-11CE-9F53-0020AF0BA770");
    static readonly Guid MEDIASUBTYPE_RGB8 = new Guid("E436EB7A-524F-11CE-9F53-0020AF0BA770");
    static readonly Guid MEDIASUBTYPE_Y800 = new Guid("30303859-0000-0010-8000-00AA00389B71");
    static readonly Guid MEDIASUBTYPE_GREY = new Guid("59455247-0000-0010-8000-00AA00389B71");
    static readonly Guid MEDIASUBTYPE_Y8 = new Guid("20203859-0000-0010-8000-00AA00389B71");
    static readonly Guid FORMAT_VideoInfo = new Guid("05589F80-C356-11CE-BF01-00AA0055595A");
    static readonly Guid PIN_CATEGORY_CAPTURE = new Guid("FB6C4281-0353-11D1-905F-0000C0CC16BA");
    static readonly Guid IID_IPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");
    static readonly Guid IID_IBaseFilter = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");
    static readonly Guid IID_IAMStreamConfig = new Guid("C6E13340-30AC-11D0-A18C-00A0C9118956");
    static readonly Guid CLSID_VideoInputDeviceCategory = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");

    static readonly Dictionary<Guid, string> SubtypeNames = new Dictionary<Guid, string> {
        { MEDIASUBTYPE_RGB24, "RGB24" },
        { MEDIASUBTYPE_RGB8, "RGB8" },
        { MEDIASUBTYPE_Y800, "Y800" },
        { MEDIASUBTYPE_GREY, "GREY" },
        { MEDIASUBTYPE_Y8, "Y8" },
    };

    static IMoniker moniker;
    static IBaseFilterPersistent sourceFilter;
    static IBaseFilterPersistent sampleGrabberFilter;
    static IBaseFilterPersistent nullRenderer;
    static IGraphBuilderPersistent graph;
    static ICaptureGraphBuilder2Persistent captureBuilder;
    static IMediaControlPersistent mediaControl;
    static ISampleGrabberPersistent grabber;
    static int width;
    static int height;
    static int bitCount;
    static Guid connectedSubtype;

    static void CheckHr(string label, int hr) {
        Console.Error.WriteLine(label + " hr=0x" + hr.ToString("X8"));
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    static string SubtypeName(Guid subtype) {
        return SubtypeNames.ContainsKey(subtype) ? SubtypeNames[subtype] : subtype.ToString();
    }

    static bool IsPreferredGray(Guid subtype, short bits) {
        return bits == 8 && (subtype == MEDIASUBTYPE_Y800 || subtype == MEDIASUBTYPE_GREY || subtype == MEDIASUBTYPE_Y8 || subtype == MEDIASUBTYPE_RGB8);
    }

    static bool IsRgb24(Guid subtype, short bits) {
        return bits == 24 && subtype == MEDIASUBTYPE_RGB24;
    }

    static void FreeMediaType(AMMediaTypePersistent mt) {
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

    static void FreeMediaTypePtr(IntPtr mtPtr) {
        if (mtPtr == IntPtr.Zero) return;
        AMMediaTypePersistent mt = (AMMediaTypePersistent)Marshal.PtrToStructure(mtPtr, typeof(AMMediaTypePersistent));
        FreeMediaType(mt);
        Marshal.FreeCoTaskMem(mtPtr);
    }

    static VideoInfoHeaderPersistent ReadVih(AMMediaTypePersistent mt) {
        if (mt == null || mt.formatPtr == IntPtr.Zero) throw new InvalidOperationException("Media type has no VideoInfo header.");
        return (VideoInfoHeaderPersistent)Marshal.PtrToStructure(mt.formatPtr, typeof(VideoInfoHeaderPersistent));
    }

    static string ReadFriendlyName(IMoniker m) {
        object bagObj = null;
        try {
            Guid iidPropertyBag = IID_IPropertyBag;
            m.BindToStorage(null, null, ref iidPropertyBag, out bagObj);
            IPropertyBagPersistent bag = (IPropertyBagPersistent)bagObj;
            object nameObj;
            int hr = bag.Read("FriendlyName", out nameObj, null);
            return hr == 0 && nameObj != null ? Convert.ToString(nameObj) : "<unknown>";
        } finally {
            if (bagObj != null) Marshal.ReleaseComObject(bagObj);
        }
    }

    static IMoniker SelectVideoDevice(string nameContains, out string selectedName) {
        ICreateDevEnumPersistent devEnum = (ICreateDevEnumPersistent)new SystemDeviceEnumPersistent();
        IEnumMoniker enumMoniker;
        Guid category = CLSID_VideoInputDeviceCategory;
        CheckHr("CreateClassEnumerator", devEnum.CreateClassEnumerator(ref category, out enumMoniker, 0));
        if (enumMoniker == null) throw new InvalidOperationException("No DirectShow video input devices found.");

        IMoniker[] monikers = new IMoniker[1];
        IntPtr fetched = Marshal.AllocCoTaskMem(IntPtr.Size);
        try {
            while (enumMoniker.Next(1, monikers, fetched) == 0) {
                string name = ReadFriendlyName(monikers[0]);
                Console.Error.WriteLine("Found video device: " + name);
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

    static AMMediaTypePersistent CloneMediaTypeFromPtr(IntPtr mtPtr) {
        AMMediaTypePersistent src = (AMMediaTypePersistent)Marshal.PtrToStructure(mtPtr, typeof(AMMediaTypePersistent));
        AMMediaTypePersistent dst = new AMMediaTypePersistent();
        dst.majorType = src.majorType;
        dst.subType = src.subType;
        dst.fixedSizeSamples = src.fixedSizeSamples;
        dst.temporalCompression = src.temporalCompression;
        dst.sampleSize = src.sampleSize;
        dst.formatType = src.formatType;
        dst.unkPtr = IntPtr.Zero;
        dst.formatSize = src.formatSize;
        dst.formatPtr = IntPtr.Zero;
        if (src.formatSize > 0 && src.formatPtr != IntPtr.Zero) {
            dst.formatPtr = Marshal.AllocCoTaskMem(src.formatSize);
            byte[] data = new byte[src.formatSize];
            Marshal.Copy(src.formatPtr, data, 0, src.formatSize);
            Marshal.Copy(data, 0, dst.formatPtr, src.formatSize);
        }
        return dst;
    }

    static AMMediaTypePersistent SelectStreamFormat(IBaseFilterPersistent src) {
        Guid cat = PIN_CATEGORY_CAPTURE;
        Guid mt = MEDIATYPE_Video;
        Guid iid = IID_IAMStreamConfig;
        IntPtr configPtr;
        int hrFind = captureBuilder.FindInterface(ref cat, ref mt, src, ref iid, out configPtr);
        if (hrFind < 0 || configPtr == IntPtr.Zero) {
            Console.Error.WriteLine("IAMStreamConfig unavailable; falling back to SampleGrabber RGB24 request.");
            AMMediaTypePersistent fallback = new AMMediaTypePersistent();
            fallback.majorType = MEDIATYPE_Video;
            fallback.subType = MEDIASUBTYPE_RGB24;
            fallback.formatType = FORMAT_VideoInfo;
            return fallback;
        }

        IAMStreamConfigPersistent config = (IAMStreamConfigPersistent)Marshal.GetObjectForIUnknown(configPtr);
        Marshal.Release(configPtr);
        int count;
        int size;
        CheckHr("IAMStreamConfig.GetNumberOfCapabilities", config.GetNumberOfCapabilities(out count, out size));
        IntPtr caps = Marshal.AllocCoTaskMem(size);
        AMMediaTypePersistent bestGray = null;
        AMMediaTypePersistent bestRgb = null;
        try {
            for (int i = 0; i < count; i++) {
                IntPtr mtPtr;
                int hr = config.GetStreamCaps(i, out mtPtr, caps);
                if (hr < 0 || mtPtr == IntPtr.Zero) continue;
                try {
                    AMMediaTypePersistent candidate = CloneMediaTypeFromPtr(mtPtr);
                    VideoInfoHeaderPersistent vih = ReadVih(candidate);
                    string name = SubtypeName(candidate.subType);
                    if (i < 20) {
                        Console.Error.WriteLine("StreamCap " + i + ": " + name + " " + vih.BmiHeader.Width + "x" + Math.Abs(vih.BmiHeader.Height) + " bits=" + vih.BmiHeader.BitCount);
                    }
                    if (bestGray == null && IsPreferredGray(candidate.subType, vih.BmiHeader.BitCount)) {
                        bestGray = candidate;
                    } else if (bestRgb == null && IsRgb24(candidate.subType, vih.BmiHeader.BitCount)) {
                        bestRgb = candidate;
                    } else {
                        FreeMediaType(candidate);
                    }
                } finally {
                    FreeMediaTypePtr(mtPtr);
                }
            }
        } finally {
            Marshal.FreeCoTaskMem(caps);
        }

        AMMediaTypePersistent selected = bestGray ?? bestRgb;
        if (selected == null) {
            Console.Error.WriteLine("No preferred stream format found; falling back to SampleGrabber RGB24 request.");
            selected = new AMMediaTypePersistent();
            selected.majorType = MEDIATYPE_Video;
            selected.subType = MEDIASUBTYPE_RGB24;
            selected.formatType = FORMAT_VideoInfo;
            return selected;
        }

        VideoInfoHeaderPersistent selectedVih = ReadVih(selected);
        Console.Error.WriteLine("Selected stream format: " + SubtypeName(selected.subType) + " " + selectedVih.BmiHeader.Width + "x" + Math.Abs(selectedVih.BmiHeader.Height) + " bits=" + selectedVih.BmiHeader.BitCount);
        CheckHr("IAMStreamConfig.SetFormat", config.SetFormat(selected));
        return selected;
    }

    static void WriteFrame(string outputPath, byte[] data) {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath)));
        if (bitCount == 8) {
            using (FileStream fs = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.Read))
            using (BinaryWriter bw = new BinaryWriter(fs)) {
                bw.Write(System.Text.Encoding.ASCII.GetBytes("P5\n"));
                bw.Write(System.Text.Encoding.ASCII.GetBytes(width + " " + height + "\n255\n"));
                bw.Write(data);
            }
            return;
        }

        if (bitCount != 24) {
            throw new InvalidOperationException("Only 8-bit grayscale and RGB24 are supported. bitCount=" + bitCount + " subtype=" + SubtypeName(connectedSubtype));
        }

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

    static void Start(string nameContains) {
        string selectedName;
        moniker = SelectVideoDevice(nameContains, out selectedName);
        Console.Error.WriteLine("Selected device: " + selectedName);

        object sourceObj;
        Guid iidBaseFilter = IID_IBaseFilter;
        moniker.BindToObject(null, null, ref iidBaseFilter, out sourceObj);
        sourceFilter = (IBaseFilterPersistent)sourceObj;

        graph = (IGraphBuilderPersistent)new FilterGraphPersistent();
        captureBuilder = (ICaptureGraphBuilder2Persistent)new CaptureGraphBuilder2Persistent();
        CheckHr("CaptureGraphBuilder.SetFiltergraph", captureBuilder.SetFiltergraph(graph));
        CheckHr("Graph.Add source", ((IFilterGraphPersistent)graph).AddFilter(sourceFilter, "IDS uEye Source"));

        AMMediaTypePersistent selectedFormat = SelectStreamFormat(sourceFilter);

        object sampleGrabberObj = new SampleGrabberPersistent();
        sampleGrabberFilter = (IBaseFilterPersistent)sampleGrabberObj;
        grabber = (ISampleGrabberPersistent)sampleGrabberObj;
        AMMediaTypePersistent requested = new AMMediaTypePersistent();
        requested.majorType = MEDIATYPE_Video;
        requested.subType = selectedFormat.subType;
        requested.formatType = FORMAT_VideoInfo;
        CheckHr("SampleGrabber.SetMediaType", grabber.SetMediaType(requested));
        CheckHr("SampleGrabber.SetBufferSamples", grabber.SetBufferSamples(true));
        CheckHr("SampleGrabber.SetOneShot", grabber.SetOneShot(false));

        nullRenderer = (IBaseFilterPersistent)new NullRendererPersistent();
        CheckHr("Graph.Add sample grabber", ((IFilterGraphPersistent)graph).AddFilter(sampleGrabberFilter, "Sample Grabber"));
        CheckHr("Graph.Add null renderer", ((IFilterGraphPersistent)graph).AddFilter(nullRenderer, "Null Renderer"));

        Guid pinCategory = PIN_CATEGORY_CAPTURE;
        Guid mediaType = MEDIATYPE_Video;
        CheckHr("CaptureGraphBuilder.RenderStream", captureBuilder.RenderStream(ref pinCategory, ref mediaType, sourceFilter, sampleGrabberFilter, nullRenderer));

        AMMediaTypePersistent connected = new AMMediaTypePersistent();
        CheckHr("SampleGrabber.GetConnectedMediaType", grabber.GetConnectedMediaType(connected));
        VideoInfoHeaderPersistent vih = ReadVih(connected);
        width = vih.BmiHeader.Width;
        height = Math.Abs(vih.BmiHeader.Height);
        bitCount = vih.BmiHeader.BitCount;
        connectedSubtype = connected.subType;
        Console.Error.WriteLine("Connected format: " + SubtypeName(connectedSubtype) + " " + width + "x" + height + " bits=" + bitCount);
        FreeMediaType(connected);
        FreeMediaType(selectedFormat);

        mediaControl = (IMediaControlPersistent)graph;
        CheckHr("MediaControl.Run", mediaControl.Run());
        Console.WriteLine("READY " + width + " " + height + " " + bitCount + " " + SubtypeName(connectedSubtype));
        Console.Out.Flush();
    }

    static void Grab(string outputPath, int timeoutMs) {
        int size = 0;
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline) {
            int hr = grabber.GetCurrentBuffer(ref size, IntPtr.Zero);
            if (hr >= 0 && size > 0) break;
            Thread.Sleep(20);
        }
        if (size <= 0) throw new TimeoutException("Timed out waiting for a frame from Sample Grabber.");

        IntPtr buffer = Marshal.AllocCoTaskMem(size);
        try {
            CheckHr("SampleGrabber.GetCurrentBuffer", grabber.GetCurrentBuffer(ref size, buffer));
            byte[] data = new byte[size];
            Marshal.Copy(buffer, data, 0, size);
            WriteFrame(outputPath, data);
            Console.WriteLine("OK " + outputPath);
            Console.Out.Flush();
        } finally {
            Marshal.FreeCoTaskMem(buffer);
        }
    }

    static void Stop() {
        try {
            if (mediaControl != null) mediaControl.Stop();
        } catch {}
        if (mediaControl != null) Marshal.ReleaseComObject(mediaControl);
        if (captureBuilder != null) Marshal.ReleaseComObject(captureBuilder);
        if (graph != null) Marshal.ReleaseComObject(graph);
        if (nullRenderer != null) Marshal.ReleaseComObject(nullRenderer);
        if (sampleGrabberFilter != null) Marshal.ReleaseComObject(sampleGrabberFilter);
        if (sourceFilter != null) Marshal.ReleaseComObject(sourceFilter);
        if (moniker != null) Marshal.ReleaseComObject(moniker);
    }

    public static int Run(string nameContains, int timeoutMs) {
        Console.Error.WriteLine("Process bitness: " + (IntPtr.Size * 8) + "-bit");
        try {
            Start(nameContains);
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line == "EXIT") break;
                if (line.StartsWith("GRAB ")) {
                    string path = line.Substring(5);
                    Grab(path, timeoutMs);
                } else {
                    Console.WriteLine("ERR unknown command");
                    Console.Out.Flush();
                }
            }
            return 0;
        } finally {
            Stop();
        }
    }
}
"""


POWERSHELL_WRAPPER = r"""
param(
    [Parameter(Mandatory=$true)][string]$NameContains,
    [Parameter(Mandatory=$true)][int]$TimeoutMs,
    [Parameter(Mandatory=$true)][string]$SourcePath
)

$ErrorActionPreference = "Stop"
$source = Get-Content -LiteralPath $SourcePath -Raw
Add-Type -TypeDefinition $source
[DirectShowPersistentCapture]::Run($NameContains, $TimeoutMs)
"""


class PersistentDirectShowCapture:
    def __init__(self, name_contains: str = "UI358x", timeout_ms: int = 5000):
        self.name_contains = name_contains
        self.timeout_ms = timeout_ms
        self._tmp: tempfile.TemporaryDirectory[str] | None = None
        self._proc: subprocess.Popen[str] | None = None
        self._stderr_file = None
        self._stderr_path: Path | None = None
        self.ready_line: str | None = None

    def start(self) -> str:
        self._tmp = tempfile.TemporaryDirectory(prefix="ids_activex_persistent_")
        tmp_path = Path(self._tmp.name)
        source_path = tmp_path / "DirectShowPersistentCapture.cs"
        wrapper_path = tmp_path / "run_persistent_capture.ps1"
        self._stderr_path = tmp_path / "directshow_persistent_stderr.log"
        source_path.write_text(CSHARP_SOURCE, encoding="utf-8")
        wrapper_path.write_text(POWERSHELL_WRAPPER, encoding="utf-8")
        command = [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(wrapper_path),
            "-NameContains",
            self.name_contains,
            "-TimeoutMs",
            str(self.timeout_ms),
            "-SourcePath",
            str(source_path),
        ]
        self._stderr_file = self._stderr_path.open("w", encoding="utf-8", errors="replace")
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file,
            text=True,
            bufsize=1,
        )
        assert self._proc.stdout is not None
        line = self._proc.stdout.readline().strip()
        if not line.startswith("READY "):
            try:
                stdout_tail, _ = self._proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                stdout_tail, _ = self._proc.communicate()
            stderr = self._read_stderr()
            self.close()
            raise RuntimeError(
                "DirectShow persistent capture did not become ready: "
                f"{line}\nSTDOUT:\n{stdout_tail}\nSTDERR:\n{stderr}"
            )
        self.ready_line = line
        return line

    def grab(self, output_path: Path) -> None:
        if self._proc is None or self._proc.stdin is None or self._proc.stdout is None:
            raise RuntimeError("Persistent DirectShow capture is not running.")
        self._proc.stdin.write(f"GRAB {output_path.resolve()}\n")
        self._proc.stdin.flush()
        line = self._proc.stdout.readline().strip()
        if not line.startswith("OK "):
            stderr = self._read_stderr()
            raise RuntimeError(f"DirectShow grab failed: {line}\n{stderr}")

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                if proc.stdin is not None:
                    proc.stdin.write("EXIT\n")
                    proc.stdin.flush()
            except Exception:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except Exception:
                pass
            self._stderr_file = None
        if self._tmp is not None:
            self._tmp.cleanup()
            self._tmp = None

    def _read_stderr(self) -> str:
        if self._stderr_file is not None:
            try:
                self._stderr_file.flush()
            except Exception:
                pass
        if self._stderr_path is None or not self._stderr_path.exists():
            return ""
        return self._stderr_path.read_text(encoding="utf-8", errors="replace")

    def __enter__(self) -> "PersistentDirectShowCapture":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Start one persistent DirectShow graph and capture frames on demand.")
    parser.add_argument("--name-contains", default="UI358x")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--timeout-ms", type=int, default=5000)
    args = parser.parse_args()

    with PersistentDirectShowCapture(args.name_contains, args.timeout_ms) as cap:
        print(cap.ready_line)
        for index in range(args.count):
            output = args.output
            if args.count > 1:
                output = output.with_name(f"{output.stem}_{index + 1:03d}{output.suffix}")
            cap.grab(output)
            print(output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
