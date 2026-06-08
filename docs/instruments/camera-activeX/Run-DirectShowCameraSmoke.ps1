<#
.SYNOPSIS
    Run a minimal DirectShow graph for the IDS/uEye camera.

.DESCRIPTION
    Binds the DirectShow video source by friendly-name substring, connects it to
    the system Null Renderer through ICaptureGraphBuilder2, runs briefly, then
    stops. This validates the ActiveX/COM DirectShow route without displaying or
    saving frames.
#>

[CmdletBinding()]
param(
    [string]$NameContains = "UI358x",
    [int]$RunMilliseconds = 2000
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

[ComImport, Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")]
class SystemDeviceEnumSmoke {}

[ComImport, Guid("E436EBB3-524F-11CE-9F53-0020AF0BA770")]
class FilterGraphSmoke {}

[ComImport, Guid("BF87B6E1-8C27-11D0-B3F0-00AA003761C5")]
class CaptureGraphBuilder2Smoke {}

[ComImport, Guid("C1F400A4-3F08-11D3-9F0B-006008039E37")]
class NullRendererSmoke {}

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICreateDevEnumSmoke {
    [PreserveSig] int CreateClassEnumerator(ref Guid clsidDeviceClass, out IEnumMoniker ppEnumMoniker, int dwFlags);
}

[ComImport, Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBaseFilterSmoke {}

[ComImport, Guid("3127CA40-446E-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IErrorLogSmoke {}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyBagSmoke {
    [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, out object pVar, IErrorLogSmoke pErrorLog);
    [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, ref object pVar);
}

[ComImport, Guid("56A8689F-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFilterGraphSmoke {
    [PreserveSig] int AddFilter([In] IBaseFilterSmoke pFilter, [In, MarshalAs(UnmanagedType.LPWStr)] string pName);
    [PreserveSig] int RemoveFilter([In] IBaseFilterSmoke pFilter);
    [PreserveSig] int EnumFilters(out object ppEnum);
    [PreserveSig] int FindFilterByName([In, MarshalAs(UnmanagedType.LPWStr)] string pName, out IBaseFilterSmoke ppFilter);
    [PreserveSig] int ConnectDirect(IntPtr ppinOut, IntPtr ppinIn, IntPtr pmt);
    [PreserveSig] int Reconnect(IntPtr ppin);
    [PreserveSig] int Disconnect(IntPtr ppin);
    [PreserveSig] int SetDefaultSyncSource();
}

[ComImport, Guid("56A868A9-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IGraphBuilderSmoke : IFilterGraphSmoke {}

[ComImport, Guid("56A868B1-0AD4-11CE-B03A-0020AF0BA770"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
interface IMediaControlSmoke {
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
interface ICaptureGraphBuilder2Smoke {
    [PreserveSig] int SetFiltergraph([In] IGraphBuilderSmoke pfg);
    [PreserveSig] int GetFiltergraph(out IGraphBuilderSmoke ppfg);
    [PreserveSig] int SetOutputFileName(ref Guid pType, [MarshalAs(UnmanagedType.LPWStr)] string lpstrFile, out IBaseFilterSmoke ppbf, out object ppSink);
    [PreserveSig] int FindInterface(ref Guid pCategory, ref Guid pType, IBaseFilterSmoke pf, ref Guid riid, out object ppint);
    [PreserveSig] int RenderStream(ref Guid pCategory, ref Guid pType, IBaseFilterSmoke pSource, IBaseFilterSmoke pCompressor, IBaseFilterSmoke pRenderer);
}

public static class DirectShowCameraSmoke {
    static void CheckHr(string label, int hr) {
        Console.WriteLine(label + " hr=0x" + hr.ToString("X8"));
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
    }

    public static int Run(string nameContains, int runMilliseconds) {
        Console.WriteLine("Process bitness: " + (IntPtr.Size * 8) + "-bit");

        Guid videoInputDeviceCategory = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
        Guid iidPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");
        Guid iidBaseFilter = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");

        ICreateDevEnumSmoke devEnum = (ICreateDevEnumSmoke)new SystemDeviceEnumSmoke();
        IEnumMoniker enumMoniker;
        CheckHr("CreateClassEnumerator", devEnum.CreateClassEnumerator(ref videoInputDeviceCategory, out enumMoniker, 0));
        if (enumMoniker == null) return 2;

        IMoniker[] monikers = new IMoniker[1];
        IntPtr fetched = Marshal.AllocCoTaskMem(IntPtr.Size);
        IMoniker selectedMoniker = null;
        string selectedName = null;

        while (enumMoniker.Next(1, monikers, fetched) == 0) {
            object bagObj = null;
            string name = "<unknown>";
            try {
                monikers[0].BindToStorage(null, null, ref iidPropertyBag, out bagObj);
                IPropertyBagSmoke bag = (IPropertyBagSmoke)bagObj;
                object nameObj;
                int nameHr = bag.Read("FriendlyName", out nameObj, null);
                if (nameHr == 0 && nameObj != null) name = Convert.ToString(nameObj);
            } finally {
                if (bagObj != null) Marshal.ReleaseComObject(bagObj);
            }

            Console.WriteLine("Found video device: " + name);
            if (selectedMoniker == null && name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0) {
                selectedMoniker = monikers[0];
                selectedName = name;
            } else {
                Marshal.ReleaseComObject(monikers[0]);
            }
        }

        Marshal.FreeCoTaskMem(fetched);
        Marshal.ReleaseComObject(enumMoniker);
        Marshal.ReleaseComObject(devEnum);

        if (selectedMoniker == null) {
            Console.WriteLine("No matching device found for: " + nameContains);
            return 3;
        }

        Console.WriteLine("Selected device: " + selectedName);

        object sourceObj;
        selectedMoniker.BindToObject(null, null, ref iidBaseFilter, out sourceObj);
        IBaseFilterSmoke sourceFilter = (IBaseFilterSmoke)sourceObj;
        IBaseFilterSmoke nullRenderer = (IBaseFilterSmoke)new NullRendererSmoke();
        IGraphBuilderSmoke graph = (IGraphBuilderSmoke)new FilterGraphSmoke();
        ICaptureGraphBuilder2Smoke captureBuilder = (ICaptureGraphBuilder2Smoke)new CaptureGraphBuilder2Smoke();

        Guid pinCategoryCapture = new Guid("FB6C4281-0353-11D1-905F-0000C0CC16BA");
        Guid mediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");

        CheckHr("SetFiltergraph", captureBuilder.SetFiltergraph(graph));
        CheckHr("Add source filter", ((IFilterGraphSmoke)graph).AddFilter(sourceFilter, "IDS uEye Source"));
        CheckHr("Add null renderer", ((IFilterGraphSmoke)graph).AddFilter(nullRenderer, "Null Renderer"));
        CheckHr("RenderStream", captureBuilder.RenderStream(ref pinCategoryCapture, ref mediaTypeVideo, sourceFilter, null, nullRenderer));

        IMediaControlSmoke mediaControl = (IMediaControlSmoke)graph;
        CheckHr("Run", mediaControl.Run());
        Thread.Sleep(runMilliseconds);
        CheckHr("Stop", mediaControl.Stop());

        Marshal.ReleaseComObject(mediaControl);
        Marshal.ReleaseComObject(captureBuilder);
        Marshal.ReleaseComObject(graph);
        Marshal.ReleaseComObject(nullRenderer);
        Marshal.ReleaseComObject(sourceFilter);
        Marshal.ReleaseComObject(selectedMoniker);

        Console.WriteLine("DirectShow smoke run completed.");
        return 0;
    }
}
"@

Add-Type -TypeDefinition $source
[DirectShowCameraSmoke]::Run($NameContains, $RunMilliseconds)
