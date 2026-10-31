# Resident sensing helper for the desktop pet (electron/pet/sense.cjs starts and supervises it).
# Windows PowerShell 5.1, hidden window. Keep this file ASCII: 5.1 reads BOM-less files as ANSI.
#
# Two threads of work, so that slow OCR never delays the foreground polling:
#   main runspace   polls the foreground window every second, sends the idle heartbeat, reads stdin;
#   OCR runspace    a worker (started below) that takes OCR requests from a queue, one at a time.
#
# stdout, one JSON line each (ASCII only, non-ASCII is \uXXXX-escaped):
#   {"t":"ready"}
#   {"t":"focus","exe":"starrail.exe","path":"C:\\..\\StarRail.exe","title":"..","pid":123,"hwnd":"65892","fullscreen":"no|borderless|exclusive","rect":{"x":0,"y":0,"w":1920,"h":1080}}
#       only when exe / title / hwnd / fullscreen changed. path is the program's full image path ("" when it cannot
#       be opened); it is for the desktop's policy only. When there has been no foreground window for 3 polls in a
#       row (lock screen, UAC, a failing poll) the line says hwnd "0", exe "" and title "": the desktop stops
#       looking at once instead of keeping the last game.
#   {"t":"idle","s":42}                                every 15 s; also the helper's heartbeat (45 s without any line = dead)
#   {"t":"ocr","id":"..","lines":[..],"ms":120}        (plus "error":".." on failure, with lines [])
#   {"t":"error","message":".."}
# stdin, one JSON line each:
#   {"op":"ocr","id":"..","path":"C:\\..\\x.png","lang":"zh-Hans-CN"}   queued (at most 4); a request that waited
#                                                       more than 10 s is dropped with an "error" reply
#   {"op":"cancel","id":".."}                          the caller gave up: drop it if it has not started (answered "cancelled")
#   {"op":"quit"}
# The helper exits when stdin closes, so it never outlives the app.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$source = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace FireflySense
{
    public static class Wire
    {
        static readonly object gate = new object();
        static Stream stdout;

        public static string Esc(string s)
        {
            if (s == null) s = "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c > 0x7E) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string N(long v) { return v.ToString(CultureInfo.InvariantCulture); }

        /// <summary>One line on stdout. Called from both runspaces; the lock keeps lines whole.</summary>
        public static void Line(string json)
        {
            lock (gate)
            {
                if (stdout == null) stdout = Console.OpenStandardOutput();
                byte[] b = Encoding.ASCII.GetBytes(json + "\n");
                stdout.Write(b, 0, b.Length);
                stdout.Flush();
            }
        }
    }

    /// <summary>Commands from the parent, read on a background thread so the poll loop never blocks on stdin.</summary>
    public static class Inbox
    {
        static readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();
        static readonly AutoResetEvent signal = new AutoResetEvent(false);
        static volatile bool eof;

        public static bool Done { get { return eof && queue.IsEmpty; } }

        public static void Start()
        {
            Thread t = new Thread(new ThreadStart(Pump));
            t.IsBackground = true;
            t.Start();
        }

        static void Pump()
        {
            try
            {
                StreamReader r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = r.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    queue.Enqueue(line);
                    signal.Set();
                }
            }
            catch (Exception) { }
            eof = true;
            signal.Set();
        }

        public static string Next(int waitMs)
        {
            string s;
            if (queue.TryDequeue(out s)) return s;
            if (eof || waitMs <= 0) return null;
            signal.WaitOne(waitMs);
            if (queue.TryDequeue(out s)) return s;
            return null;
        }
    }

    public sealed class OcrJob
    {
        public string Id = "";
        public string ImagePath = "";
        public string Lang = "";
        public long At;
    }

    /// <summary>OCR requests, from the main runspace to the worker. Short on purpose: a caller that gave up must not leave work piling up.</summary>
    public static class OcrQueue
    {
        const int MaxQueued = 4;
        static readonly object gate = new object();
        static readonly List<OcrJob> jobs = new List<OcrJob>();
        static readonly AutoResetEvent signal = new AutoResetEvent(false);
        static volatile bool stopped;

        public static bool Stopped { get { return stopped; } }

        /// <summary>False when the queue is full.</summary>
        public static bool Enqueue(string id, string imagePath, string lang, long at)
        {
            lock (gate)
            {
                if (jobs.Count >= MaxQueued) return false;
                OcrJob j = new OcrJob();
                j.Id = id; j.ImagePath = imagePath; j.Lang = lang; j.At = at;
                jobs.Add(j);
            }
            signal.Set();
            return true;
        }

        /// <summary>Drop a request that has not started (true). One already running cannot be taken back.</summary>
        public static bool Cancel(string id)
        {
            lock (gate) { return jobs.RemoveAll(delegate(OcrJob j) { return j.Id == id; }) > 0; }
        }

        static OcrJob Pop()
        {
            lock (gate)
            {
                if (jobs.Count == 0) return null;
                OcrJob j = jobs[0];
                jobs.RemoveAt(0);
                return j;
            }
        }

        public static OcrJob Take(int waitMs)
        {
            OcrJob j = Pop();
            if (j != null || stopped || waitMs <= 0) return j;
            signal.WaitOne(waitMs);
            return Pop();
        }

        public static void Stop()
        {
            stopped = true;
            signal.Set();
        }
    }

    public sealed class Snap
    {
        public string Exe = "";
        public string ImagePath = "";
        public string Title = "";
        public uint Pid;
        public long Hwnd;
        public string Fullscreen = "no";
        public int X, Y, W, H;
        public bool Ignore;

        public string Key() { return Exe + "|" + Wire.N(Hwnd) + "|" + Fullscreen + "|" + Title; }

        public string ToJson()
        {
            StringBuilder sb = new StringBuilder(256);
            sb.Append("{\"t\":\"focus\",\"exe\":").Append(Wire.Esc(Exe));
            sb.Append(",\"path\":").Append(Wire.Esc(ImagePath));
            sb.Append(",\"title\":").Append(Wire.Esc(Title));
            sb.Append(",\"pid\":").Append(Wire.N(Pid));
            sb.Append(",\"hwnd\":\"").Append(Wire.N(Hwnd)).Append("\"");
            sb.Append(",\"fullscreen\":\"").Append(Fullscreen).Append("\"");
            sb.Append(",\"rect\":{\"x\":").Append(Wire.N(X)).Append(",\"y\":").Append(Wire.N(Y));
            sb.Append(",\"w\":").Append(Wire.N(W)).Append(",\"h\":").Append(Wire.N(H)).Append("}}");
            return sb.ToString();
        }
    }

    public static class Native
    {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
        [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        delegate bool EnumProc(IntPtr h, IntPtr lp);

        sealed class ProcInfo
        {
            public string Name = "";
            public string ImagePath = "";
            public long At;
        }

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr mon, ref MONITORINFO mi);
        [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int index);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO li);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
        [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref int size);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

        const int GWL_STYLE = -16;
        const int GWL_EXSTYLE = -20;
        const int WS_CAPTION = 0x00C00000;
        const int WS_EX_TOPMOST = 0x00000008;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_NOACTIVATE = 0x08000000;
        const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;
        const long CACHE_MS = 30000;

        static readonly Dictionary<uint, ProcInfo> procCache = new Dictionary<uint, ProcInfo>();

        public static long Tick() { return (long)GetTickCount64(); }

        /// <summary>Report real pixels instead of DPI-virtualised ones (window and monitor rects must agree).</summary>
        public static void Init()
        {
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
            catch (Exception) { try { SetProcessDPIAware(); } catch (Exception) { } }
        }

        public static int IdleSeconds()
        {
            LASTINPUTINFO li = new LASTINPUTINFO();
            li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            if (!GetLastInputInfo(ref li)) return 0;
            // dwTime is a 32-bit tick count; truncate the 64-bit one the same way so the subtraction survives wrap-around.
            uint now = unchecked((uint)GetTickCount64());
            uint idle = unchecked(now - li.dwTime);
            return (int)(idle / 1000);
        }

        /// <summary>The program's file name (lower case) and full path. PROCESS_QUERY_LIMITED_INFORMATION is the weakest access there is: no memory, no injection.</summary>
        static ProcInfo InfoOf(uint pid)
        {
            long now = Tick();
            ProcInfo hit;
            if (procCache.TryGetValue(pid, out hit) && now - hit.At < CACHE_MS) return hit;

            string name = "";
            string full = "";
            IntPtr hp = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
            if (hp != IntPtr.Zero)
            {
                try
                {
                    StringBuilder sb = new StringBuilder(1024);
                    int size = sb.Capacity;
                    if (QueryFullProcessImageNameW(hp, 0, sb, ref size))
                    {
                        full = sb.ToString();
                        name = Path.GetFileName(full);
                    }
                }
                finally { CloseHandle(hp); }
            }
            if (name.Length == 0)
            {
                try { name = Process.GetProcessById((int)pid).ProcessName + ".exe"; } catch (Exception) { }
            }
            ProcInfo pi = new ProcInfo();
            pi.Name = name.ToLowerInvariant();
            pi.ImagePath = full;
            pi.At = now;
            if (procCache.Count > 256) procCache.Clear();
            procCache[pid] = pi;
            return pi;
        }

        /// <summary>A Store app in a window is hosted by ApplicationFrameHost; the real app owns a child window.</summary>
        static uint HostedAppPid(IntPtr host, uint hostPid)
        {
            uint found = 0;
            EnumProc cb = delegate(IntPtr child, IntPtr lp)
            {
                uint p;
                GetWindowThreadProcessId(child, out p);
                if (p != 0 && p != hostPid) { found = p; return false; }
                return true;
            };
            EnumChildWindows(host, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return found;
        }

        static string TitleOf(IntPtr h)
        {
            int len = GetWindowTextLengthW(h);
            if (len <= 0) return "";
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowTextW(h, sb, sb.Capacity);
            return sb.ToString();
        }

        /// <summary>The foreground window now, or null when there is none (lock screen, UAC, window switch) or reading it failed.</summary>
        public static Snap Poll()
        {
            try
            {
                IntPtr h = GetForegroundWindow();
                if (h == IntPtr.Zero) return null;
                uint pid;
                GetWindowThreadProcessId(h, out pid);
                if (pid == 0) return null;

                ProcInfo pi = InfoOf(pid);
                string exe = pi.Name;
                if (exe == "applicationframehost.exe")
                {
                    uint inner = HostedAppPid(h, pid);
                    if (inner != 0) { pid = inner; pi = InfoOf(inner); exe = pi.Name; }
                }

                Snap s = new Snap();
                s.Exe = exe;
                s.ImagePath = pi.ImagePath;
                s.Pid = pid;
                s.Hwnd = h.ToInt64();
                s.Title = TitleOf(h);

                RECT r;
                if (!GetWindowRect(h, out r)) return null;
                s.X = r.Left; s.Y = r.Top; s.W = r.Right - r.Left; s.H = r.Bottom - r.Top;

                int style = GetWindowLongW(h, GWL_STYLE);
                int ex = GetWindowLongW(h, GWL_EXSTYLE);
                bool caption = (style & WS_CAPTION) == WS_CAPTION;

                // The pet's own transparent always-on-top window must not look like the user switched away from the game.
                // The main window of the app has a title bar and is reported like any other program.
                bool own = exe.StartsWith("firefly", StringComparison.Ordinal) || exe == "electron.exe";
                if (own && !caption && (ex & (WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) != 0) s.Ignore = true;

                // A window that covers its whole monitor and has no title bar is fullscreen; D3D exclusive mode is
                // told apart by the shell's notification state.
                bool covers = false;
                IntPtr mon = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
                MONITORINFO mi = new MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (mon != IntPtr.Zero && GetMonitorInfoW(mon, ref mi))
                {
                    covers = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top
                          && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
                }
                if (covers && !caption)
                {
                    int qun = 0;
                    try { SHQueryUserNotificationState(out qun); } catch (Exception) { }
                    s.Fullscreen = qun == QUNS_RUNNING_D3D_FULL_SCREEN ? "exclusive" : "borderless";
                }
                return s;
            }
            catch (Exception) { return null; }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
[FireflySense.Native]::Init()

# ---------- OCR worker (Windows.Media.Ocr through PowerShell's WinRT projection) ----------
# It runs in its own runspace, on its own thread: a recognition that takes seconds must not stop the polling.
# The C# types above are shared by name (same process); the worker talks to the main loop only through
# [FireflySense.OcrQueue] and writes its answers with [FireflySense.Wire]::Line.

$ocrWorkerScript = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$staleMs = 10000

$script:ocrReady = $false
$script:engines = @{}
$script:asTask = $null

function Initialize-Ocr {
    if ($script:ocrReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    if ($null -eq $script:asTask) { throw 'WinRT async bridge not found' }
    $script:ocrReady = $true
}

function Await($op, [Type]$type) {
    $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $done = $false
    try { $done = $task.Wait(15000) } catch { }
    if (-not $done) {
        # Wait wraps the real failure in an AggregateException; report the inner message.
        if ($task.IsFaulted) { throw $task.Exception.GetBaseException().Message }
        throw 'WinRT call timed out'
    }
    return $task.Result
}

function Get-Engine([string]$lang) {
    if ($script:engines.ContainsKey($lang)) { return $script:engines[$lang] }
    $engine = $null
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang)) } catch { }
    if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if ($null -eq $engine) { throw 'No OCR language pack is installed' }
    $script:engines[$lang] = $engine
    return $engine
}

function Read-ImageText([string]$path, [string]$lang) {
    Initialize-Ocr
    $engine = Get-Engine $lang
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
        $big = [Math]::Max($decoder.PixelWidth, $decoder.PixelHeight)
        if ($big -gt $max) {
            $transform = [Windows.Graphics.Imaging.BitmapTransform]::new()
            $scale = $max / $big
            $transform.ScaledWidth = [uint32][Math]::Floor($decoder.PixelWidth * $scale)
            $transform.ScaledHeight = [uint32][Math]::Floor($decoder.PixelHeight * $scale)
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync($decoder.BitmapPixelFormat, $decoder.BitmapAlphaMode, $transform)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        } else {
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        }
        try {
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        } finally { $bitmap.Dispose() }
    } finally { $stream.Dispose() }
    return @($result.Lines | ForEach-Object { $_.Text })
}

function Send-Ocr([string]$id, $lines, [long]$ms, $failure) {
    $json = @($lines | ForEach-Object { [FireflySense.Wire]::Esc([string]$_) }) -join ','
    $out = '{"t":"ocr","id":' + [FireflySense.Wire]::Esc($id) + ',"lines":[' + $json + '],"ms":' + $ms
    if ($failure) { $out += ',"error":' + [FireflySense.Wire]::Esc([string]$failure) }
    [FireflySense.Wire]::Line($out + '}')
}

while (-not [FireflySense.OcrQueue]::Stopped) {
    try {
        $job = [FireflySense.OcrQueue]::Take(1000)
        if ($null -eq $job) { continue }
        $started = [FireflySense.Native]::Tick()
        # The caller stopped waiting long ago (it gives up after 8 s): do not spend the time.
        if (($started - $job.At) -gt $staleMs) { Send-Ocr $job.Id @() 0 'dropped: waited too long in the queue'; continue }
        $lines = @()
        $failure = $null
        try {
            $lang = if ($job.Lang) { [string]$job.Lang } else { 'zh-Hans-CN' }
            $lines = @(Read-ImageText ([string]$job.ImagePath) $lang)
        } catch {
            $failure = $_.Exception.Message
        }
        Send-Ocr $job.Id $lines ([FireflySense.Native]::Tick() - $started) $failure
    } catch {
        Start-Sleep -Milliseconds 200
    }
}
'@

$script:ocrWorker = $null
$script:ocrHandle = $null
$script:ocrBornAt = 0

function Start-OcrWorker {
    try {
        if ($null -ne $script:ocrWorker) {
            try { $script:ocrWorker.Dispose() } catch { }
            $script:ocrWorker = $null
        }
        $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
        $rs.Open()
        $ps = [System.Management.Automation.PowerShell]::Create()
        $ps.Runspace = $rs
        $null = $ps.AddScript($ocrWorkerScript)
        $script:ocrHandle = $ps.BeginInvoke()
        $script:ocrWorker = $ps
        $script:ocrBornAt = [FireflySense.Native]::Tick()
    } catch {
        $script:ocrWorker = $null
        Send-Error ('OCR worker did not start: ' + $_.Exception.Message)
    }
}

# A worker that ended by itself (it only ends when told to) is started again, at most every 5 s.
function Test-OcrWorker {
    if ($null -ne $script:ocrHandle -and $script:ocrHandle.IsCompleted -and -not [FireflySense.OcrQueue]::Stopped) {
        if (([FireflySense.Native]::Tick() - $script:ocrBornAt) -ge 5000) { Start-OcrWorker }
    }
}

# ---------- loop ----------

$script:lastErrorAt = 0
$script:lastErrorMsg = ''

function Send-Error([string]$message) {
    # The same failure every second would flood the pipe: repeat it at most every 30 s.
    $now = [FireflySense.Native]::Tick()
    if ($message -eq $script:lastErrorMsg -and ($now - $script:lastErrorAt) -lt 30000) { return }
    $script:lastErrorMsg = $message
    $script:lastErrorAt = $now
    [FireflySense.Wire]::Line('{"t":"error","message":' + [FireflySense.Wire]::Esc($message) + '}')
}

function Send-OcrError([string]$id, [string]$message) {
    [FireflySense.Wire]::Line('{"t":"ocr","id":' + [FireflySense.Wire]::Esc($id) + ',"lines":[],"ms":0,"error":' + [FireflySense.Wire]::Esc($message) + '}')
}

# Returns $true when the parent asked us to quit.
function Handle-Op([string]$line) {
    try { $cmd = $line | ConvertFrom-Json } catch { Send-Error 'bad command line'; return $false }
    if ($cmd.op -eq 'quit') { return $true }
    if ($cmd.op -eq 'ocr') {
        $id = [string]$cmd.id
        Test-OcrWorker
        if ($null -eq $script:ocrWorker) { Send-OcrError $id 'OCR worker is not running'; return $false }
        $lang = if ($cmd.lang) { [string]$cmd.lang } else { 'zh-Hans-CN' }
        if (-not [FireflySense.OcrQueue]::Enqueue($id, [string]$cmd.path, $lang, [FireflySense.Native]::Tick())) {
            Send-OcrError $id 'OCR queue is full'
        }
    } elseif ($cmd.op -eq 'cancel') {
        # Say so, so the parent stops counting the request (a running one answers by itself).
        if ([FireflySense.OcrQueue]::Cancel([string]$cmd.id)) { Send-OcrError ([string]$cmd.id) 'cancelled' }
    }
    return $false
}

[FireflySense.Inbox]::Start()
Start-OcrWorker
[FireflySense.Wire]::Line('{"t":"ready"}')

$nextPoll = 0
$nextIdle = [FireflySense.Native]::Tick() + 15000
$lastKey = $null
$quit = $false
# What a missing foreground window is reported as: no program, no window.
$lostSnap = New-Object FireflySense.Snap
$nullPolls = 0

while (-not $quit) {
    try {
        $now = [FireflySense.Native]::Tick()
        $wait = [int][Math]::Max(0, [Math]::Min([Math]::Min($nextPoll, $nextIdle) - $now, 1000))
        $line = [FireflySense.Inbox]::Next($wait)
        while ($null -ne $line) {
            if (Handle-Op $line) { $quit = $true; break }
            $line = [FireflySense.Inbox]::Next(0)
        }
        if ($quit -or [FireflySense.Inbox]::Done) { break }

        $now = [FireflySense.Native]::Tick()
        if ($now -ge $nextPoll) {
            $snap = [FireflySense.Native]::Poll()
            if ($null -eq $snap) {
                # A single empty poll is a window switch; three in a row mean the foreground is really unknown.
                $nullPolls++
                if ($nullPolls -ge 3) { $snap = $lostSnap }
            } else {
                $nullPolls = 0
            }
            if ($null -ne $snap -and -not $snap.Ignore) {
                $key = $snap.Key()
                if ($key -ne $lastKey) {
                    $lastKey = $key
                    [FireflySense.Wire]::Line($snap.ToJson())
                }
            }
            $nextPoll = $now + 1000
        }
        if ($now -ge $nextIdle) {
            [FireflySense.Wire]::Line('{"t":"idle","s":' + [FireflySense.Native]::IdleSeconds() + '}')
            $nextIdle = $now + 15000
            Test-OcrWorker
        }
    } catch {
        Send-Error $_.Exception.Message
        Start-Sleep -Milliseconds 500
    }
}

[FireflySense.OcrQueue]::Stop()
try { if ($null -ne $script:ocrWorker) { $null = $script:ocrWorker.BeginStop($null, $null) } } catch { }
# A recognition may still be running in the worker: leave now rather than wait for it.
[Environment]::Exit(0)
