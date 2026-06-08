using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

internal sealed class NFActiveXHost : AxHost
{
    public NFActiveXHost() : base("084B94EF-4DA1-4964-A142-6AD6C4B3E1C9")
    {
    }

    public object OcxObject
    {
        get { return GetOcx(); }
    }
}

internal sealed class AcquisitionForm : Form
{
    private const int AcqSpectrum = 0;
    private const int AcqCancel = 8;

    private readonly int acquisitionMode;
    private readonly NFActiveXHost host = new NFActiveXHost();
    private readonly double integrationTimeSeconds;
    private readonly int accumulations;
    private readonly double acqFromNm;
    private readonly double acqToNm;
    private readonly int timeoutSeconds;
    private readonly int pollMilliseconds;
    private readonly string labSpecRoot;
    private readonly bool probeOnly;
    private readonly bool skipInit;
    private readonly bool skipScriptPath;
    private readonly bool skipErrorInfo;
    private readonly bool workerAcq;
    private readonly int initRoot;
    private readonly int initStatus;

    private int exitCode = 1;
    private bool acquisitionStarted;
    private volatile bool acqReturned;
    private volatile bool acqFailed;
    private object acqReturnValue;
    private Exception acqException;

    public AcquisitionForm(
        double integrationTimeSeconds,
        int accumulations,
        double acqFromNm,
        double acqToNm,
        int acquisitionMode,
        int timeoutSeconds,
        int pollMilliseconds,
        string labSpecRoot,
        bool probeOnly,
        bool skipInit,
        bool skipScriptPath,
        bool skipErrorInfo,
        bool workerAcq,
        int initRoot,
        int initStatus)
    {
        this.integrationTimeSeconds = integrationTimeSeconds;
        this.accumulations = accumulations;
        this.acqFromNm = acqFromNm;
        this.acqToNm = acqToNm;
        this.acquisitionMode = acquisitionMode;
        this.timeoutSeconds = timeoutSeconds;
        this.pollMilliseconds = pollMilliseconds;
        this.labSpecRoot = labSpecRoot;
        this.probeOnly = probeOnly;
        this.skipInit = skipInit;
        this.skipScriptPath = skipScriptPath;
        this.skipErrorInfo = skipErrorInfo;
        this.workerAcq = workerAcq;
        this.initRoot = initRoot;
        this.initStatus = initStatus;

        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Width = 1;
        Height = 1;

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
        BeginInvoke(new Action(RunAcquisition));
    }

    private void RunAcquisition()
    {
        object ocx = null;
        DateTime started = DateTime.Now;
        try
        {
            host.CreateControl();
            ocx = host.OcxObject;
            if (ocx == null)
            {
                throw new InvalidOperationException("NFActiveX OCX object was not created.");
            }

            Console.WriteLine("NFActiveX host created.");
            InitializeControl(ocx);
            if (probeOnly)
            {
                ProbeControl(ocx, skipErrorInfo);
                exitCode = 0;
                Close();
                return;
            }

            Console.WriteLine(
                "Starting Acq(mode={0}, integration={1}, accumulations={2}, from={3}, to={4}) at {5:yyyy-MM-dd HH:mm:ss}",
                acquisitionMode,
                integrationTimeSeconds,
                accumulations,
                acqFromNm,
                acqToNm,
                started);

            acquisitionStarted = true;
            if (workerAcq)
            {
                Console.WriteLine("Starting Acq on worker thread while UI STA pumps messages.");
                StartWorkerAcq(ocx);
            }
            else
            {
                object ret = Invoke(ocx, "Acq", acquisitionMode, integrationTimeSeconds, accumulations, acqFromNm, acqToNm);
                acqReturned = true;
                acqReturnValue = ret;
                Console.WriteLine("Acq returned: {0}", ret ?? "<null>");
            }

            DateTime deadline = DateTime.Now.AddSeconds(timeoutSeconds);
            int spectrumId = 0;
            int polls = 0;
            while (DateTime.Now <= deadline)
            {
                Application.DoEvents();
                if (acqFailed)
                {
                    throw acqException;
                }
                if (acqReturned && polls == 0)
                {
                    Console.WriteLine("Acq returned: {0}", acqReturnValue ?? "<null>");
                }
                object idValue = Invoke(ocx, "GetAcqID");
                spectrumId = Convert.ToInt32(idValue);
                polls += 1;
                if (spectrumId > 0)
                {
                    TimeSpan duration = DateTime.Now - started;
                    Console.WriteLine(
                        "SUCCESS SpectrumID={0} polls={1} duration_s={2:F3}",
                        spectrumId,
                        polls,
                        duration.TotalSeconds);
                    exitCode = 0;
                    Close();
                    return;
                }
                Thread.Sleep(pollMilliseconds);
            }

            Console.WriteLine("TIMEOUT no SpectrumID after {0}s; attempting ACQ_CANCEL", timeoutSeconds);
            TryCancel(ocx);
            exitCode = 2;
            Close();
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
            if (ocx != null && acquisitionStarted)
            {
                TryCancel(ocx);
            }
            exitCode = 1;
            Close();
        }
    }

    private void StartWorkerAcq(object ocx)
    {
        Thread worker = new Thread(delegate()
        {
            try
            {
                acqReturnValue = Invoke(ocx, "Acq", acquisitionMode, integrationTimeSeconds, accumulations, acqFromNm, acqToNm);
                acqReturned = true;
            }
            catch (Exception ex)
            {
                acqException = ex;
                acqFailed = true;
            }
        });
        worker.IsBackground = true;
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();
    }

    private void InitializeControl(object ocx)
    {
        object status = "";
        string root = Path.GetFullPath(labSpecRoot);
        string servicePath = Path.Combine(root, "SERVICE");
        if (!skipInit)
        {
            Console.WriteLine("Calling InitNA({0}, {1})", initRoot, initStatus);
            object initRet = Invoke(ocx, "InitNA", initRoot, initStatus);
            Console.WriteLine("InitNA returned: {0}", initRet ?? "<null>");
        }

        if (!skipScriptPath)
        {
            Console.WriteLine("Calling SetScriptPath(path={0})", servicePath);
            object pathRet = Invoke(ocx, "SetScriptPath", servicePath);
            Console.WriteLine("SetScriptPath returned: {0}", pathRet ?? "<null>");
        }
    }

    private static void ProbeControl(object ocx, bool skipErrorInfo)
    {
        Console.WriteLine("Probe: calling TickCount");
        Console.WriteLine("TickCount returned: {0}", Invoke(ocx, "TickCount") ?? "<null>");
        if (!skipErrorInfo)
        {
            Console.WriteLine("Probe: calling GetLastErrorInfo");
            Console.WriteLine("GetLastErrorInfo returned: {0}", Invoke(ocx, "GetLastErrorInfo") ?? "<null>");
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

    private static void TryCancel(object ocx)
    {
        try
        {
            object ret = Invoke(ocx, "Acq", AcqCancel, 0.0, 0, 0.0, 0.0);
            Console.WriteLine("Cancel returned: {0}", ret ?? "<null>");
        }
        catch (Exception ex)
        {
            Console.WriteLine("Cancel failed: {0}", ex.Message);
        }
    }
}

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        double integrationTimeSeconds = GetDouble(args, "--integration-time", 1.0);
        int accumulations = GetInt(args, "--accumulations", 1);
        double acqFromNm = GetDouble(args, "--from-nm", 0.0);
        double acqToNm = GetDouble(args, "--to-nm", 0.0);
        int acquisitionMode = GetInt(args, "--mode", 0);
        int timeoutSeconds = GetInt(args, "--timeout", 20);
        int pollMilliseconds = GetInt(args, "--poll-ms", 200);
        string labSpecRoot = GetString(args, "--labspec-root", @"C:\HORIBA\LabSpec_6_5_1");
        bool probeOnly = HasFlag(args, "--probe-only");
        bool skipInit = HasFlag(args, "--skip-init");
        bool skipScriptPath = HasFlag(args, "--skip-script-path");
        bool skipErrorInfo = HasFlag(args, "--skip-error-info");
        bool workerAcq = HasFlag(args, "--worker-acq");
        int initRoot = GetInt(args, "--init-root", 0);
        int initStatus = GetInt(args, "--init-status", 0);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        AcquisitionForm form = new AcquisitionForm(
            integrationTimeSeconds,
            accumulations,
            acqFromNm,
            acqToNm,
            acquisitionMode,
            timeoutSeconds,
            pollMilliseconds,
            labSpecRoot,
            probeOnly,
            skipInit,
            skipScriptPath,
            skipErrorInfo,
            workerAcq,
            initRoot,
            initStatus);
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

    private static double GetDouble(string[] args, string name, double defaultValue)
    {
        string value = GetArg(args, name);
        return value == null ? defaultValue : double.Parse(value, CultureInfo.InvariantCulture);
    }

    private static int GetInt(string[] args, string name, int defaultValue)
    {
        string value = GetArg(args, name);
        return value == null ? defaultValue : int.Parse(value);
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
