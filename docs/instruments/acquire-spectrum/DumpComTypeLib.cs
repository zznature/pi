using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

internal static class DumpComTypeLib
{
    [DllImport("oleaut32.dll", PreserveSig = false)]
    private static extern void LoadTypeLibEx(
        [MarshalAs(UnmanagedType.LPWStr)] string file,
        REGKIND regkind,
        out ITypeLib typeLib);

    private enum REGKIND
    {
        REGKIND_DEFAULT = 0,
        REGKIND_REGISTER = 1,
        REGKIND_NONE = 2,
    }

    private static int Main(string[] args)
    {
        string path = args.Length > 0
            ? args[0]
            : @"C:\HORIBA\LabSpec_6_5_1\REG64\COMMON\NFActiveX.ocx";

        ITypeLib typeLib;
        LoadTypeLibEx(path, REGKIND.REGKIND_NONE, out typeLib);
        int count = typeLib.GetTypeInfoCount();
        Console.WriteLine("TypeLib: {0}", path);
        Console.WriteLine("TypeInfoCount: {0}", count);

        for (int i = 0; i < count; i++)
        {
            ITypeInfo typeInfo;
            typeLib.GetTypeInfo(i, out typeInfo);
            string typeName;
            string doc;
            int helpContext;
            string helpFile;
            typeLib.GetDocumentation(i, out typeName, out doc, out helpContext, out helpFile);
            IntPtr typeAttrPtr;
            typeInfo.GetTypeAttr(out typeAttrPtr);
            try
            {
                System.Runtime.InteropServices.ComTypes.TYPEATTR attr =
                    (System.Runtime.InteropServices.ComTypes.TYPEATTR)Marshal.PtrToStructure(
                        typeAttrPtr,
                        typeof(System.Runtime.InteropServices.ComTypes.TYPEATTR));
                Console.WriteLine("[{0}] {1} kind={2} funcs={3} vars={4}", i, typeName, attr.typekind, attr.cFuncs, attr.cVars);
                for (int f = 0; f < attr.cFuncs; f++)
                {
                    IntPtr funcDescPtr;
                    typeInfo.GetFuncDesc(f, out funcDescPtr);
                    try
                    {
                        System.Runtime.InteropServices.ComTypes.FUNCDESC func =
                            (System.Runtime.InteropServices.ComTypes.FUNCDESC)Marshal.PtrToStructure(
                                funcDescPtr,
                                typeof(System.Runtime.InteropServices.ComTypes.FUNCDESC));
                        string[] names = new string[Math.Max(1, func.cParams + 1)];
                        int nameCount;
                        typeInfo.GetNames(func.memid, names, names.Length, out nameCount);
                        string signature = nameCount > 0 ? names[0] : "<unnamed>";
                        if (nameCount > 1)
                        {
                            string[] paramNames = new string[nameCount - 1];
                            for (int n = 1; n < nameCount; n++)
                            {
                                paramNames[n - 1] = names[n];
                            }
                            signature = signature + "(" + string.Join(", ", paramNames) + ")";
                        }
                        Console.WriteLine(
                            "  func memid={0} invkind={1} params={2} return={3} name={4}",
                            func.memid,
                            func.invkind,
                            func.cParams,
                            DescribeElem(func.elemdescFunc),
                            signature);
                        for (int p = 0; p < func.cParams; p++)
                        {
                            IntPtr elemPtr = new IntPtr(func.lprgelemdescParam.ToInt64() + p * Marshal.SizeOf(typeof(System.Runtime.InteropServices.ComTypes.ELEMDESC)));
                            System.Runtime.InteropServices.ComTypes.ELEMDESC elem =
                                (System.Runtime.InteropServices.ComTypes.ELEMDESC)Marshal.PtrToStructure(
                                    elemPtr,
                                    typeof(System.Runtime.InteropServices.ComTypes.ELEMDESC));
                            Console.WriteLine("    param{0}: {1}", p + 1, DescribeElem(elem));
                        }
                    }
                    finally
                    {
                        typeInfo.ReleaseFuncDesc(funcDescPtr);
                    }
                }
            }
            finally
            {
                typeInfo.ReleaseTypeAttr(typeAttrPtr);
            }
        }
        return 0;
    }

    private static string DescribeElem(System.Runtime.InteropServices.ComTypes.ELEMDESC elem)
    {
        short vt = elem.tdesc.vt;
        string flags = elem.desc.paramdesc.wParamFlags.ToString();
        if (vt == 26 && elem.tdesc.lpValue != IntPtr.Zero)
        {
            short inner = Marshal.ReadInt16(elem.tdesc.lpValue);
            return "VT_PTR->" + inner + " flags=" + flags;
        }
        return "vt=" + vt + " flags=" + flags;
    }
}
