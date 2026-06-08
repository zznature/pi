<#
.SYNOPSIS
    Probe IDS/uEye DirectShow camera registration and COM binding.

.DESCRIPTION
    Enumerates DirectShow video input devices through System Device Enumerator,
    reads FriendlyName from each moniker, and attempts to bind each moniker to
    IBaseFilter. This verifies the ActiveX/COM DirectShow route without starting
    capture or saving frames.
#>

[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("62BE5D10-60EB-11D0-BD3B-00A0C911CE86")]
class SystemDeviceEnumProbe {}

[ComImport, Guid("29840822-5B84-11D0-BD3B-00A0C911CE86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICreateDevEnumProbe {
    [PreserveSig] int CreateClassEnumerator(ref Guid clsidDeviceClass, out IEnumMoniker ppEnumMoniker, int dwFlags);
}

[ComImport, Guid("3127CA40-446E-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IErrorLogProbe {}

[ComImport, Guid("55272A00-42CB-11CE-8135-00AA004BB851"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyBagProbe {
    [PreserveSig] int Read([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, out object pVar, IErrorLogProbe pErrorLog);
    [PreserveSig] int Write([MarshalAs(UnmanagedType.LPWStr)] string pszPropName, ref object pVar);
}

public static class DirectShowCameraProbe {
    public static int Run() {
        Console.WriteLine("Process bitness: " + (IntPtr.Size * 8) + "-bit");

        Guid videoInputDeviceCategory = new Guid("860BB310-5D01-11D0-BD3B-00A0C911CE86");
        Guid iidPropertyBag = new Guid("55272A00-42CB-11CE-8135-00AA004BB851");
        Guid iidBaseFilter = new Guid("56A86895-0AD4-11CE-B03A-0020AF0BA770");

        ICreateDevEnumProbe devEnum = (ICreateDevEnumProbe)new SystemDeviceEnumProbe();
        IEnumMoniker enumMoniker;
        int hr = devEnum.CreateClassEnumerator(ref videoInputDeviceCategory, out enumMoniker, 0);
        Console.WriteLine("CreateClassEnumerator hr=0x" + hr.ToString("X8"));
        if (hr != 0 || enumMoniker == null) return 2;

        IMoniker[] monikers = new IMoniker[1];
        IntPtr fetched = Marshal.AllocCoTaskMem(IntPtr.Size);
        int index = 0;

        while (enumMoniker.Next(1, monikers, fetched) == 0) {
            index++;
            object bagObj = null;
            string name = "<unknown>";

            try {
                monikers[0].BindToStorage(null, null, ref iidPropertyBag, out bagObj);
                IPropertyBagProbe bag = (IPropertyBagProbe)bagObj;
                object nameObj;
                int nameHr = bag.Read("FriendlyName", out nameObj, null);
                if (nameHr == 0 && nameObj != null) name = Convert.ToString(nameObj);
            } catch (Exception ex) {
                name = "<property bag failed: " + ex.Message + ">";
            }

            Console.WriteLine("Device " + index + ": " + name);

            try {
                object filterObj;
                monikers[0].BindToObject(null, null, ref iidBaseFilter, out filterObj);
                Console.WriteLine("  BindToObject(IBaseFilter): OK, type=" + filterObj.GetType().FullName);
                Marshal.ReleaseComObject(filterObj);
            } catch (Exception ex) {
                Console.WriteLine("  BindToObject(IBaseFilter): FAIL " + ex.GetType().Name + " " + ex.Message);
            }

            if (bagObj != null) Marshal.ReleaseComObject(bagObj);
            Marshal.ReleaseComObject(monikers[0]);
        }

        Marshal.FreeCoTaskMem(fetched);
        Marshal.ReleaseComObject(enumMoniker);
        Marshal.ReleaseComObject(devEnum);
        return 0;
    }
}
"@

Add-Type -TypeDefinition $source
[DirectShowCameraProbe]::Run()
