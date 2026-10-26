// FreeAudit.exe — the portable FreeAudit app: one file, no installer.
//
// The SAME program plays two roles:
//
//  1. The downloaded FreeAudit.exe carries the whole app (portable Node, the
//     browser engine, node_modules, the code) as a zip appended to the exe. On
//     double-click it unpacks into %LOCALAPPDATA%\Programs\FreeAudit — the folder
//     the old installer used, so an existing install keeps its logins — creates
//     the shortcuts, then hands off to the copy of itself inside that folder.
//
//  2. That in-folder FreeAudit.exe (no payload) is the launcher every shortcut
//     points at: self-update from GitHub, start the engine, wait until it ANSWERS,
//     then open the app window. It replaces freeaudit-launcher.vbs + freeaudit.ps1,
//     whose hidden-PowerShell chain is what failed on new PCs (blocked scripts,
//     an invisible splash, nothing on screen to say why).
//
// Flags: --engine-only (Startup shortcut: update + engine + agent, no window)
//        --stop        (stop the engine and agent)
//
// Built by build-portable.ps1 with the C# 5 compiler that ships with .NET
// Framework 4 on every Windows PC — so keep this to C# 5 (no $"", no ?.).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("FreeAudit")]
[assembly: AssemblyProduct("FreeAudit")]
[assembly: AssemblyCompany("Freedom")]

static class FreeAuditApp
{
    const string Magic = "FAPAYLD1";
    const string Repo = "MTucker-1/freeaudit-app";
    const string Branch = "main";

    // FREEAUDIT_HOME is for testing only: unpack/run somewhere other than the real install.
    static readonly string AppDir = Path.GetFullPath(Environment.GetEnvironmentVariable("FREEAUDIT_HOME") ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "FreeAudit"));
    static string SelfPath { get { return Application.ExecutablePath; } }
    static string LauncherPath { get { return Path.Combine(AppDir, "FreeAudit.exe"); } }
    static string LogDir { get { return Path.Combine(AppDir, "logs"); } }
    static string PidFile { get { return Path.Combine(AppDir, "server.pid"); } }
    static string engineLog;

    // Per-user files: written only when missing, so unpacking a new download
    // never wipes somebody's saved logins and settings.
    static readonly HashSet<string> KeepIfPresent = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "config.json", "fullbay-credentials.json", "vorto-credentials.json", "google-credentials.json",
        "users.json", "sessions.json", "update.json"
    };

    [STAThread]
    static int Main(string[] args)
    {
        // GitHub needs TLS 1.2; .NET Framework 4 doesn't offer it by default.
        try { ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072 | (SecurityProtocolType)768 | SecurityProtocolType.Tls; } catch { }
        bool engineOnly = Has(args, "--engine-only");
        bool stop = Has(args, "--stop");

        try
        {
            if (stop) { StopEngine(); StopAgent(); return 0; }
            if (engineOnly) { RunEngineOnly(); return 0; }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            long payloadOffset, payloadLength;
            bool hasPayload = FindPayload(SelfPath, out payloadOffset, out payloadLength);
            bool isInstalledCopy = string.Equals(Path.GetFullPath(SelfPath), Path.GetFullPath(LauncherPath), StringComparison.OrdinalIgnoreCase);

            using (var mutex = new Mutex(false, @"Local\FreeAuditApp"))
            {
                bool owned = false;
                // A hand-off from the downloaded exe waits for it to let go.
                try { owned = mutex.WaitOne(Has(args, "--handoff") ? 20000 : 0); } catch (AbandonedMutexException) { owned = true; }
                if (!owned)
                {
                    // Already starting in another window. A click should still
                    // bring the app up if the engine is serving.
                    if (EngineUp()) OpenAppWindow();
                    return 0;
                }
                var splash = new Splash();
                var worker = new Thread(delegate () { Work(splash, hasPayload, isInstalledCopy, payloadOffset, payloadLength); });
                worker.IsBackground = true;
                splash.Shown += delegate { worker.Start(); };
                Application.Run(splash);
                try { mutex.ReleaseMutex(); } catch { }
            }
            return 0;
        }
        catch (Exception e)
        {
            if (!engineOnly && !stop)
                MessageBox.Show("FreeAudit couldn't start:\r\n\r\n" + e.Message, "FreeAudit", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
    }

    static bool Has(string[] args, string flag)
    {
        foreach (var a in args) if (string.Equals(a, flag, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    // ------------------------------------------------------------------ flow
    static void Work(Splash ui, bool hasPayload, bool isInstalledCopy, long off, long len)
    {
        try
        {
            CleanupOldLaunchers();
            if (hasPayload)
            {
                Unpack(ui, off, len);
                CreateShortcuts();
                if (!isInstalledCopy && File.Exists(LauncherPath))
                {
                    // Let the installed launcher (which updates itself) do the rest.
                    ui.Status("Starting FreeAudit...", null);
                    var psi = new ProcessStartInfo(LauncherPath, "--handoff") { WorkingDirectory = AppDir, UseShellExecute = false };
                    Process.Start(psi);
                    ui.Done();
                    return;
                }
            }
            else if (!File.Exists(Path.Combine(AppDir, "server.js")))
            {
                ui.Fail("FreeAudit isn't unpacked on this PC yet. Double-click the FreeAudit.exe you downloaded.", false);
                return;
            }
            else if (!File.Exists(Path.Combine(AppDir, "shortcuts.v2")))
            {
                // Once: moves installer-era shortcuts off the old .vbs launcher.
                // Not every launch, or a deleted desktop icon would keep coming back.
                CreateShortcuts();
            }

            ui.Status("Starting FreeAudit...  checking for updates", null);
            if (TryUpdate(ui)) StopEngine();

            StartAndWait(ui);
        }
        catch (Exception e)
        {
            ui.Fail("Something went wrong starting FreeAudit: " + e.Message, true);
        }
    }

    internal static void StartAndWait(Splash ui)
    {
        ui.Status("Starting FreeAudit...  starting the engine", null);
        EnsureEngine();
        EnsureAgent();
        var started = DateTime.Now;
        int restarts = 0;
        while (true)
        {
            if (EngineUp()) { OpenAppWindow(); ui.Done(); return; }
            double s = (DateTime.Now - started).TotalSeconds;
            if (s > 4 && !EngineProcessAlive() && restarts < 2) { restarts++; StartEngine(); }
            if (s > 15) ui.Status("Starting FreeAudit...  starting the engine\r\n(the first start on a new PC can take a minute while Windows scans the files)", null);
            if (s > 120) { ui.Fail("FreeAudit's engine didn't answer after 2 minutes.", true); return; }
            Thread.Sleep(500);
        }
    }

    static void RunEngineOnly()
    {
        if (!File.Exists(Path.Combine(AppDir, "server.js"))) return;
        if (TryUpdate(null)) StopEngine();
        EnsureEngine();
        EnsureAgent();
    }

    // --------------------------------------------------------------- payload
    // Layout: [launcher exe][zip][8-byte zip length, little-endian]["FAPAYLD1"]
    static bool FindPayload(string exe, out long offset, out long length)
    {
        offset = length = 0;
        try
        {
            using (var fs = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                if (fs.Length < 16) return false;
                fs.Seek(-16, SeekOrigin.End);
                var b = new byte[16];
                if (fs.Read(b, 0, 16) != 16) return false;
                if (Encoding.ASCII.GetString(b, 8, 8) != Magic) return false;
                length = BitConverter.ToInt64(b, 0);
                offset = fs.Length - 16 - length;
                return length > 0 && offset > 0;
            }
        }
        catch { return false; }
    }

    static void Unpack(Splash ui, long off, long len)
    {
        string marker = Path.Combine(AppDir, "payload.id");
        using (var fs = new FileStream(SelfPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var zip = new ZipArchive(new SubStream(fs, off, len), ZipArchiveMode.Read))
        {
            string payloadVer = "0";
            var ve = zip.GetEntry("version.json");
            if (ve != null) using (var r = new StreamReader(ve.Open())) payloadVer = ReadVersion(r.ReadToEnd()) ?? "0";
            string id = payloadVer + ":" + len;
            if (File.Exists(marker) && File.ReadAllText(marker).Trim() == id && File.Exists(Path.Combine(AppDir, "node.exe")))
                return;   // this exact download is already unpacked

            ui.Status("Setting up FreeAudit on this PC (one time, about a minute)...", 0);
            Directory.CreateDirectory(AppDir);
            // node.exe and Chromium are locked while running, so stop ours first.
            StopEngine(); StopAgent(); KillOurNode();

            string installedVer = File.Exists(Path.Combine(AppDir, "version.json"))
                ? ReadVersion(File.ReadAllText(Path.Combine(AppDir, "version.json"))) : null;
            // Code that already self-updated past this download must not be rolled back.
            bool writeCode = installedVer == null || CompareVersions(payloadVer, installedVer) >= 0;

            int n = zip.Entries.Count, i = 0;
            foreach (var e in zip.Entries)
            {
                i++;
                if (i % 200 == 0) ui.Status(null, (int)(100L * i / n));
                string name = e.FullName.Replace('\\', '/');
                if (name.EndsWith("/")) continue;
                string target = Path.GetFullPath(Path.Combine(AppDir, name.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(AppDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) continue;
                bool top = name.IndexOf('/') < 0;
                if (top && KeepIfPresent.Contains(name) && File.Exists(target)) continue;
                if (IsCode(name) && !writeCode && File.Exists(target)) continue;
                if (string.Equals(target, Path.GetFullPath(SelfPath), StringComparison.OrdinalIgnoreCase)) continue;
                // Unchanged since the last unpack: skip (makes re-running a download fast).
                if (File.Exists(target))
                {
                    var fi = new FileInfo(target);
                    if (fi.Length == e.Length && Math.Abs((fi.LastWriteTime - e.LastWriteTime.LocalDateTime).TotalSeconds) < 2.5) continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                ReplaceFile(target, delegate (string tmp) { e.ExtractToFile(tmp, true); });
                try { File.SetLastWriteTime(target, e.LastWriteTime.LocalDateTime); } catch { }
            }
            File.WriteAllText(marker, id);
            ui.Status(null, 100);
        }
    }

    static bool IsCode(string name)
    {
        if (name.StartsWith("public/", StringComparison.OrdinalIgnoreCase)) return true;
        if (name.IndexOf('/') >= 0) return false;
        string ext = Path.GetExtension(name).ToLowerInvariant();
        return ext == ".js" || ext == ".ps1" || ext == ".vbs" || name.Equals("version.json", StringComparison.OrdinalIgnoreCase)
            || name.Equals("FreeAudit.exe", StringComparison.OrdinalIgnoreCase);
    }

    // Write via a temp file, and move a locked target aside (Windows lets you
    // rename a running exe, not overwrite it).
    static void ReplaceFile(string target, Action<string> write)
    {
        string tmp = target + ".new";
        write(tmp);
        if (File.Exists(target))
        {
            try { File.Delete(target); }
            catch { File.Move(target, target + ".old-" + DateTime.Now.Ticks); }
        }
        File.Move(tmp, target);
    }

    static void CleanupOldLaunchers()
    {
        try { foreach (var f in Directory.GetFiles(AppDir, "*.old-*")) try { File.Delete(f); } catch { } } catch { }
    }

    // ---------------------------------------------------------------- update
    // Same channel as installer\update.ps1: code only, never node/browsers/
    // node_modules/credentials. Fails safe — any problem means "run what we have".
    static bool TryUpdate(Splash ui)
    {
        try
        {
            string vpath = Path.Combine(AppDir, "version.json");
            string local = File.Exists(vpath) ? ReadVersion(File.ReadAllText(vpath)) : null;
            string remote = ReadVersion(Download("https://raw.githubusercontent.com/" + Repo + "/" + Branch + "/version.json", 10000));
            if (remote == null || (local != null && CompareVersions(remote, local) <= 0)) return false;

            if (ui != null) ui.Status("Starting FreeAudit...  downloading the latest version", null);
            string tmp = Path.Combine(Path.GetTempPath(), "fa-update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tmp);
            try
            {
                string zipPath = Path.Combine(tmp, "code.zip");
                using (var wc = new TimeoutWebClient(120000))
                    wc.DownloadFile("https://codeload.github.com/" + Repo + "/zip/refs/heads/" + Branch, zipPath);
                using (var zip = ZipFile.OpenRead(zipPath))
                {
                    foreach (var e in zip.Entries)
                    {
                        string name = e.FullName.Replace('\\', '/');
                        int slash = name.IndexOf('/');
                        if (slash < 0) continue;
                        string rel = name.Substring(slash + 1);   // drop "freeaudit-app-main/"
                        if (rel.Length == 0 || rel.EndsWith("/")) continue;
                        string dest = null;
                        string ext = Path.GetExtension(rel).ToLowerInvariant();
                        if (rel.IndexOf('/') < 0 && (ext == ".js" || rel == "version.json")) dest = rel;
                        else if (rel.StartsWith("public/")) dest = rel;
                        else if (rel.StartsWith("installer/") && rel.LastIndexOf('/') == 9 && (ext == ".ps1" || ext == ".vbs")) dest = rel.Substring(10);
                        else if (rel == "launcher/FreeAudit.exe") dest = "FreeAudit.exe";
                        if (dest == null) continue;
                        string target = Path.Combine(AppDir, dest.Replace('/', Path.DirectorySeparatorChar));
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        var entry = e;
                        ReplaceFile(target, delegate (string t) { entry.ExtractToFile(t, true); });
                    }
                }
                // Keep the old PowerShell updater's bookkeeping in step.
                try
                {
                    File.WriteAllText(Path.Combine(AppDir, "update.json"),
                        "{ \"repo\": \"" + Repo + "\", \"branch\": \"" + Branch + "\", \"version\": \"" + remote + "\" }", new UTF8Encoding(false));
                }
                catch { }
                return true;
            }
            finally { try { Directory.Delete(tmp, true); } catch { } }
        }
        catch { return false; }
    }

    class TimeoutWebClient : WebClient
    {
        readonly int ms;
        public TimeoutWebClient(int ms) { this.ms = ms; }
        protected override WebRequest GetWebRequest(Uri address)
        {
            var r = base.GetWebRequest(address);
            r.Timeout = ms;
            return r;
        }
    }

    static string Download(string url, int timeoutMs)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Timeout = timeoutMs; req.ReadWriteTimeout = timeoutMs;
        req.Headers["Cache-Control"] = "no-cache";
        using (var resp = req.GetResponse())
        using (var r = new StreamReader(resp.GetResponseStream())) return r.ReadToEnd();
    }

    static string ReadVersion(string json)
    {
        if (json == null) return null;
        var m = Regex.Match(json, "\"version\"\\s*:\\s*\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value.Trim() : null;
    }

    static int CompareVersions(string a, string b)
    {
        var pa = a.Split('.'); var pb = b.Split('.');
        for (int i = 0; i < Math.Max(pa.Length, pb.Length); i++)
        {
            int x = 0, y = 0;
            if (i < pa.Length) int.TryParse(pa[i], out x);
            if (i < pb.Length) int.TryParse(pb[i], out y);
            if (x != y) return x.CompareTo(y);
        }
        return 0;
    }

    // ---------------------------------------------------------------- engine
    static int Port
    {
        get
        {
            try
            {
                var m = Regex.Match(File.ReadAllText(Path.Combine(AppDir, "config.json")), "\"webPort\"\\s*:\\s*(\\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
            catch { }
            return 4477;
        }
    }

    // Up = answers HTTP on loopback. Any response counts (the login page, a 401).
    static bool EngineUp()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/");
            req.Timeout = 1500; req.Proxy = null;
            using (req.GetResponse()) return true;
        }
        catch (WebException e) { if (e.Response != null) { e.Response.Close(); return true; } return false; }
        catch { return false; }
    }

    static bool EngineProcessAlive()
    {
        try
        {
            int pid = int.Parse(File.ReadAllText(PidFile).Trim());
            var p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch { return false; }
    }

    static void EnsureEngine()
    {
        using (var m = new Mutex(false, @"Local\FreeAuditEngineStart"))
        {
            try { m.WaitOne(15000); } catch (AbandonedMutexException) { }
            try { if (!EngineUp() && !EngineProcessAlive()) StartEngine(); }
            finally { try { m.ReleaseMutex(); } catch { } }
        }
    }

    // Output goes to logs\ so a failure on somebody else's PC can be read.
    // cmd does the redirect: piping node's output through this launcher would
    // break the engine the moment the launcher exits.
    static void StartEngine()
    {
        Directory.CreateDirectory(LogDir);
        PruneLogs("engine-*.log", 10);
        engineLog = Path.Combine(LogDir, "engine-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".log");
        var p = StartHidden("watch-server.js", engineLog);
        if (p != null) File.WriteAllText(PidFile, p.Id.ToString());
    }

    static Process StartHidden(string script, string log)
    {
        string node = Path.Combine(AppDir, "node.exe");
        var psi = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            "/d /c \"\"" + node + "\" " + script + " >> \"" + log + "\" 2>&1\"");
        psi.WorkingDirectory = AppDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"] = Path.Combine(AppDir, "browsers");
        return Process.Start(psi);
    }

    // The portal agent: only when this install has agent credentials. agent.js
    // keeps itself to one per PC, so starting it when one runs is harmless.
    static void EnsureAgent()
    {
        try
        {
            if (!File.Exists(Path.Combine(AppDir, "agent-credentials.json")) || !File.Exists(Path.Combine(AppDir, "agent.js"))) return;
            string pidf = Path.Combine(AppDir, "agent.pid");
            if (File.Exists(pidf))
            {
                try { if (!Process.GetProcessById(int.Parse(File.ReadAllText(pidf).Trim())).HasExited) return; } catch { }
            }
            Directory.CreateDirectory(LogDir);
            StartHidden("agent.js", Path.Combine(LogDir, "agent.log"));
        }
        catch { }
    }

    internal static void StopEngine()
    {
        try
        {
            if (!File.Exists(PidFile)) return;
            Taskkill(File.ReadAllText(PidFile).Trim());
            File.Delete(PidFile);
        }
        catch { }
    }

    static void StopAgent()
    {
        try
        {
            string pidf = Path.Combine(AppDir, "agent.pid");
            if (File.Exists(pidf)) Taskkill(File.ReadAllText(pidf).Trim());
        }
        catch { }
    }

    // Before unpacking: any node.exe running from our folder holds files open.
    static void KillOurNode()
    {
        foreach (var p in Process.GetProcessesByName("node"))
        {
            try
            {
                if (p.MainModule.FileName.StartsWith(AppDir, StringComparison.OrdinalIgnoreCase)) Taskkill(p.Id.ToString());
            }
            catch { }
        }
        Thread.Sleep(500);
    }

    static void Taskkill(string pid)
    {
        int n;
        if (!int.TryParse(pid, out n)) return;
        var psi = new ProcessStartInfo("taskkill", "/PID " + n + " /T /F") { CreateNoWindow = true, UseShellExecute = false };
        try { using (var p = Process.Start(psi)) p.WaitForExit(10000); } catch { }
    }

    static void PruneLogs(string pattern, int keep)
    {
        try
        {
            var files = new DirectoryInfo(LogDir).GetFiles(pattern);
            Array.Sort(files, delegate (FileInfo a, FileInfo b) { return b.LastWriteTime.CompareTo(a.LastWriteTime); });
            for (int i = keep; i < files.Length; i++) try { files[i].Delete(); } catch { }
        }
        catch { }
    }

    internal static string LastLogLines()
    {
        try
        {
            string f = engineLog;
            if (f == null || !File.Exists(f))
            {
                var files = new DirectoryInfo(LogDir).GetFiles("engine-*.log");
                if (files.Length == 0) return "";
                Array.Sort(files, delegate (FileInfo a, FileInfo b) { return b.LastWriteTime.CompareTo(a.LastWriteTime); });
                f = files[0].FullName;
            }
            string text;
            using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (var r = new StreamReader(fs)) text = r.ReadToEnd();
            var lines = new List<string>();
            foreach (var l in text.Split('\n')) if (l.Trim().Length > 0) lines.Add(l.TrimEnd('\r'));
            return string.Join("\r\n", lines.GetRange(Math.Max(0, lines.Count - 8), Math.Min(8, lines.Count)).ToArray());
        }
        catch { return ""; }
    }

    internal static void OpenLogFolder()
    {
        try { Directory.CreateDirectory(LogDir); Process.Start("explorer.exe", "\"" + LogDir + "\""); } catch { }
    }

    // -------------------------------------------------------------- window
    // No address bar — looks like a desktop app.
    internal static void OpenAppWindow()
    {
        string url = "http://localhost:" + Port + "/";
        string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "";
        string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "";
        string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] candidates = {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(lad, @"Google\Chrome\Application\chrome.exe"),
        };
        foreach (var c in candidates)
        {
            if (c.Length > 0 && File.Exists(c))
            {
                Process.Start(c, "--app=" + url + " --window-size=1320,880");
                return;
            }
        }
        Process.Start(url);
    }

    // ------------------------------------------------------------ shortcuts
    static void CreateShortcuts()
    {
        if (!File.Exists(LauncherPath)) return;
        if (Environment.GetEnvironmentVariable("FREEAUDIT_HOME") != null) return;   // a test copy must not take over the real shortcuts
        string icon = File.Exists(Path.Combine(AppDir, "logo.ico")) ? Path.Combine(AppDir, "logo.ico") : LauncherPath;
        string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "FreeAudit");
        try { Directory.CreateDirectory(programs); } catch { }
        Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "FreeAudit.lnk"), "", icon, "Open FreeAudit");
        Shortcut(Path.Combine(programs, "FreeAudit.lnk"), "", icon, "Open FreeAudit");
        Shortcut(Path.Combine(programs, "Stop FreeAudit.lnk"), "--stop", icon, "Stop the FreeAudit engine");
        // Engine (and portal agent) back after a reboot, with no window at login.
        string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        Shortcut(Path.Combine(startup, "FreeAudit Engine.lnk"), "--engine-only", icon, "Starts the FreeAudit engine at login (no window)");
        // The engine-only start runs the agent too; the old separate one would just duplicate it.
        try { File.Delete(Path.Combine(startup, "FreeAudit Agent.lnk")); } catch { }

        // freeaudit:// links on the FLSS dashboard start FreeAudit on this PC.
        try
        {
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\freeaudit"))
            {
                k.SetValue("", "URL:FreeAudit Protocol");
                k.SetValue("URL Protocol", "");
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\freeaudit\DefaultIcon")) k.SetValue("", icon + ",0");
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\freeaudit\shell\open\command"))
                k.SetValue("", "\"" + LauncherPath + "\" \"%1\"");
        }
        catch { }
        try { File.WriteAllText(Path.Combine(AppDir, "shortcuts.v2"), DateTime.Now.ToString("s")); } catch { }
    }

    static void Shortcut(string lnk, string args, string icon, string desc)
    {
        try
        {
            var t = Type.GetTypeFromProgID("WScript.Shell");
            object sh = Activator.CreateInstance(t);
            object sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, sh, new object[] { lnk });
            var st = sc.GetType();
            st.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { LauncherPath });
            st.InvokeMember("Arguments", BindingFlags.SetProperty, null, sc, new object[] { args });
            st.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { AppDir });
            st.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { icon });
            st.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { desc });
            st.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, null);
        }
        catch { }   // a missing shortcut must never stop FreeAudit opening
    }
}

// A read-only window onto part of a stream — the zip appended to the exe.
class SubStream : Stream
{
    readonly Stream inner; readonly long start, length; long pos;
    public SubStream(Stream inner, long start, long length) { this.inner = inner; this.start = start; this.length = length; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return length; } }
    public override long Position { get { return pos; } set { pos = value; } }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count)
    {
        long left = length - pos;
        if (left <= 0) return 0;
        if (count > left) count = (int)left;
        inner.Position = start + pos;
        int n = inner.Read(buffer, offset, count);
        pos += n;
        return n;
    }
    public override long Seek(long offset, SeekOrigin origin)
    {
        if (origin == SeekOrigin.Begin) pos = offset;
        else if (origin == SeekOrigin.Current) pos += offset;
        else pos = length + offset;
        return pos;
    }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}

// "Starting FreeAudit..." — visible from the first moment, says what it is
// doing, and on failure says why and offers Try again / the log folder.
class Splash : Form
{
    readonly Label label = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button retry = new Button(), logs = new Button(), close = new Button();

    public Splash()
    {
        Text = "FreeAudit";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        ClientSize = new Size(480, 130);
        Font = new Font("Segoe UI", 9.5f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        label.SetBounds(18, 16, 444, 64);
        label.Text = "Starting FreeAudit...";
        bar.SetBounds(18, 90, 444, 16);
        bar.Style = ProgressBarStyle.Marquee; bar.MarqueeAnimationSpeed = 30;
        retry.Text = "Try again"; logs.Text = "Open log folder"; close.Text = "Close";
        retry.Visible = logs.Visible = close.Visible = false;
        retry.Click += delegate { Retry(); };
        logs.Click += delegate { FreeAuditApp.OpenLogFolder(); };
        close.Click += delegate { Close(); };
        Controls.AddRange(new Control[] { label, bar, retry, logs, close });
    }

    void OnUi(Action a)
    {
        if (IsDisposed) return;
        try { if (InvokeRequired) BeginInvoke(a); else a(); } catch { }
    }

    // text null = keep; percent null = keep the bar as it is (marquee).
    public void Status(string text, int? percent)
    {
        OnUi(delegate
        {
            if (text != null) label.Text = text;
            if (percent.HasValue)
            {
                bar.Style = ProgressBarStyle.Continuous;
                bar.Value = Math.Max(0, Math.Min(100, percent.Value));
            }
        });
    }

    public void Done() { OnUi(delegate { Close(); }); }

    public void Fail(string why, bool showLog)
    {
        OnUi(delegate
        {
            string tail = showLog ? FreeAuditApp.LastLogLines() : "";
            label.Text = why + "\r\n\r\n" +
                (showLog ? "Try again, or restart the PC. If it keeps happening, send the newest file in the log folder to your FreeAudit admin.\r\n\r\n" +
                    (tail.Length > 0 ? "Last engine output:\r\n" + tail : "The engine wrote no output. Antivirus may be blocking node.exe in the FreeAudit folder.") : "");
            bar.Visible = false;
            ClientSize = new Size(600, 320);
            label.SetBounds(18, 16, 564, 250);
            retry.SetBounds(18, 278, 100, 30);
            logs.SetBounds(126, 278, 130, 30);
            close.SetBounds(482, 278, 100, 30);
            retry.Visible = showLog; logs.Visible = showLog; close.Visible = true;
            Activate();
        });
    }

    void Retry()
    {
        retry.Visible = logs.Visible = close.Visible = false;
        ClientSize = new Size(480, 130);
        label.SetBounds(18, 16, 444, 64);
        bar.Visible = true; bar.Style = ProgressBarStyle.Marquee;
        var self = this;
        var t = new Thread(delegate ()
        {
            try { FreeAuditApp.StopEngine(); FreeAuditApp.StartAndWait(self); }
            catch (Exception e) { self.Fail("Something went wrong starting FreeAudit: " + e.Message, true); }
        });
        t.IsBackground = true;
        t.Start();
    }
}
