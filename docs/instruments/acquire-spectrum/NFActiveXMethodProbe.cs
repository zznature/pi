using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal sealed class NFActiveXProbeHost : AxHost
{
    public NFActiveXProbeHost() : base("084B94EF-4DA1-4964-A142-6AD6C4B3E1C9")
    {
    }

    public object OcxObject
    {
        get { return GetOcx(); }
    }
}

internal sealed class ProbeForm : Form
{
    private readonly string method;
    private readonly string labSpecRoot;
    private readonly bool skipInit;
    private readonly bool skipScriptPath;
    private readonly int initRoot;
    private readonly int initStatus;
    private readonly bool visibleHost;
    private readonly bool setDllDirectory;
    private readonly NFActiveXProbeHost host = new NFActiveXProbeHost();

    private int exitCode = 1;

    public ProbeForm(
        string method,
        string labSpecRoot,
        bool skipInit,
        bool skipScriptPath,
        int initRoot,
        int initStatus,
        bool visibleHost,
        bool setDllDirectory)
    {
        this.method = method;
        this.labSpecRoot = labSpecRoot;
        this.skipInit = skipInit;
        this.skipScriptPath = skipScriptPath;
        this.initRoot = initRoot;
        this.initStatus = initStatus;
        this.visibleHost = visibleHost;
        this.setDllDirectory = setDllDirectory;

        ShowInTaskbar = visibleHost;
        WindowState = visibleHost ? FormWindowState.Normal : FormWindowState.Minimized;
        FormBorderStyle = visibleHost ? FormBorderStyle.SizableToolWindow : FormBorderStyle.FixedToolWindow;
        Width = visibleHost ? 640 : 1;
        Height = visibleHost ? 480 : 1;
        Text = "NFActiveX Method Probe";

        host.Dock = DockStyle.Fill;
        Controls.Add(host);
    }

    public int ExitCode
    {
        get { return exitCode; }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        BeginInvoke(new Action(RunProbe));
    }

    private void RunProbe()
    {
        try
        {
            if (setDllDirectory)
            {
                string root = Path.GetFullPath(labSpecRoot);
                string common = Path.Combine(root, "REG64", "COMMON");
                string service = Path.Combine(root, "SERVICE");
                Console.WriteLine("Setting process current directory to {0}", root);
                Directory.SetCurrentDirectory(root);
                Console.WriteLine("Calling SetDefaultDllDirectories");
                SetDefaultDllDirectories(0x00001000 | 0x00000800 | 0x00000400);
                Console.WriteLine("Calling AddDllDirectory({0})", common);
                AddDllDirectory(common);
                Console.WriteLine("Calling AddDllDirectory({0})", service);
                AddDllDirectory(service);
            }

            host.CreateControl();
            object ocx = host.OcxObject;
            if (ocx == null)
            {
                throw new InvalidOperationException("NFActiveX OCX object was not created.");
            }

            Console.WriteLine("NFActiveX host created.");
            InitializeControl(ocx);
            Console.WriteLine("Calling {0}", method);
            object result = InvokeRequestedMethod(ocx, method);
            Console.WriteLine("{0} returned: {1}", method, FormatResult(result));
            exitCode = 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine("FAILED {0}: {1}", ex.GetType().FullName, ex.Message);
            Exception inner = ex.InnerException;
            while (inner != null)
            {
                Console.WriteLine("INNER {0}: {1}", inner.GetType().FullName, inner.Message);
                inner = inner.InnerException;
            }
            exitCode = 1;
        }
        finally
        {
            Close();
        }
    }

    private void InitializeControl(object ocx)
    {
        string root = Path.GetFullPath(labSpecRoot);
        string servicePath = Path.Combine(root, "SERVICE");
        if (!skipInit)
        {
            Console.WriteLine("Calling InitNA({0}, {1})", initRoot, initStatus);
            object initRet = Invoke(ocx, "InitNA", initRoot, initStatus);
            Console.WriteLine("InitNA returned: {0}", FormatResult(initRet));
        }

        if (!skipScriptPath)
        {
            Console.WriteLine("Calling SetScriptPath(path={0})", servicePath);
            object pathRet = Invoke(ocx, "SetScriptPath", servicePath);
            Console.WriteLine("SetScriptPath returned: {0}", FormatResult(pathRet));
        }
    }

    private static object InvokeRequestedMethod(object ocx, string method)
    {
        switch (method.ToLowerInvariant())
        {
            case "tickcount":
                return Invoke(ocx, "TickCount");
            case "convertunit":
                return Invoke(ocx, "ConvertUnit", 532.0, 1);
            case "getlasterrorinfo":
                return Invoke(ocx, "GetLastErrorInfo");
            case "getacqid":
                return Invoke(ocx, "GetAcqID");
            case "getactivespectrum":
                return Invoke(ocx, "GetActiveData", "Spectrum");
            case "getactiveany":
                return Invoke(ocx, "GetActiveData", "");
            case "message":
                return Invoke(ocx, "Message", "NFActiveX probe", 0);
            case "messageex":
                return Invoke(ocx, "MessageEx", "NFActiveX probe", 0);
            case "execstop":
                object emptyParam = Type.Missing;
                return Invoke(ocx, "Exec", 0, 10, emptyParam);
            case "execstopnull":
                return Invoke(ocx, "Exec", 0, 10, null);
            case "acqtemperature":
                return Invoke(ocx, "Acq", 4, 0.0, 0, 0.0, 0.0);
            default:
                throw new ArgumentException("Unsupported method: " + method);
        }
    }

    private static object Invoke(object target, string method, params object[] args)
    {
        return target.GetType().InvokeMember(
            method,
            BindingFlags.InvokeMethod,
            null,
            target,
            args);
    }

    private static string FormatResult(object value)
    {
        IFormattable formattable = value as IFormattable;
        if (value == null)
        {
            return "<null>";
        }
        if (formattable != null)
        {
            return formattable.ToString(null, CultureInfo.InvariantCulture);
        }
        return value.ToString();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetDefaultDllDirectories(int directoryFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr AddDllDirectory(string newDirectory);
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string method = GetString(args, "--method", "TickCount");
        string labSpecRoot = GetString(args, "--labspec-root", @"C:\HORIBA\LabSpec_6_5_1");
        bool skipInit = HasFlag(args, "--skip-init");
        bool skipScriptPath = HasFlag(args, "--skip-script-path");
        bool visibleHost = HasFlag(args, "--visible-host");
        bool setDllDirectory = HasFlag(args, "--set-dll-directory");
        int initRoot = GetInt(args, "--init-root", 0);
        int initStatus = GetInt(args, "--init-status", 0);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        ProbeForm form = new ProbeForm(
            method,
            labSpecRoot,
            skipInit,
            skipScriptPath,
            initRoot,
            initStatus,
            visibleHost,
            setDllDirectory);
        Application.Run(form);
        return form.ExitCode;
    }

    private static string GetArg(string[] args, string name)
    {
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return null;
    }

    private static int GetInt(string[] args, string name, int defaultValue)
    {
        string value = GetArg(args, name);
        return value == null ? defaultValue : int.Parse(value, CultureInfo.InvariantCulture);
    }

    private static string GetString(string[] args, string name, string defaultValue)
    {
        string value = GetArg(args, name);
        return value == null ? defaultValue : value;
    }

    private static bool HasFlag(string[] args, string name)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
