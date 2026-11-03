// Win32 calls used by the helper. Only class names, process image paths (compared in process,
// never printed), window state and geometry are read; window text is never requested.
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DesktopCat.Uia
{
    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MONITORINFO
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
        }

        private const uint GA_ROOT = 2;
        private const uint MONITOR_DEFAULTTONEAREST = 2;
        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        private const int DWMWA_CLOAKED = 14;
        private const int ERROR_ACCESS_DENIED = 5;

        /// <summary>The top-level window class of Chromium browser frames.</summary>
        internal const string ChromeWindowClass = "Chrome_WidgetWin_1";

        /// <summary>
        /// Protocol 2 allow-list (ADR 0003 §7.1; mirrored by src/main/uia/allowList.ts). A window is
        /// read only when its top-level class, its process image (full path where stated) and a
        /// required child window class all match one rule. Decided from Win32 data alone, before
        /// any UI Automation call: the first UIA contact with an unknown toolkit can start its
        /// accessibility engine (Gecko, Electron) or reach hosted web content.
        /// </summary>
        internal static readonly TabWindowRule[] TabWindowRules =
        {
            new TabWindowRule("chromium", ChromeWindowClass, "msedge.exe", ImagePathRule.AnyPath, null, null),
            new TabWindowRule("chromium", ChromeWindowClass, "chrome.exe", ImagePathRule.AnyPath, null, null),
            new TabWindowRule("tabview", "CabinetWClass", "explorer.exe", ImagePathRule.WindowsDirectory, "Microsoft.UI.Content.DesktopChildSiteBridge", "TITLE_BAR_SCAFFOLDING_WINDOW_CLASS"),
            new TabWindowRule("tabview", "CASCADIA_HOSTING_WINDOW_CLASS", "windowsterminal.exe", ImagePathRule.TerminalPackage, "Windows.UI.Composition.DesktopWindowContentBridge", "DRAG_BAR_WINDOW_CLASS"),
        };

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr h);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr h);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr h);

        [DllImport("user32.dll")]
        private static extern bool IsZoomed(IntPtr h);

        [DllImport("user32.dll")]
        private static extern bool IsHungAppWindow(IntPtr h);

        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr h, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr h, StringBuilder buffer, int max);

        /// <summary>Class-only child lookup (the window-name argument is always null: no text is compared).</summary>
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string className, IntPtr windowName);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder buffer, ref uint size);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr h);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr h, out RECT r);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT value, int size);

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr h);

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);

        /// <summary>
        /// Makes the process per-monitor DPI aware (v2) so every UI Automation rectangle is in
        /// physical pixels. Must run before anything touches windows or UI Automation.
        /// </summary>
        internal static string EnableDpiAwareness()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 == (DPI_AWARENESS_CONTEXT)-4
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "permonitorv2";
                if (Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED) return "preset";
            }
            catch (EntryPointNotFoundException)
            {
                // Windows 10 before 1703: fall through to the shcore API.
            }
            try
            {
                if (SetProcessDpiAwareness(2) == 0) return "permonitor";
            }
            catch (DllNotFoundException)
            {
            }
            catch (EntryPointNotFoundException)
            {
            }
            return "unaware";
        }

        internal static string ClassName(IntPtr h)
        {
            var sb = new StringBuilder(257);
            int n = GetClassNameW(h, sb, sb.Capacity);
            return n > 0 ? sb.ToString(0, n) : string.Empty;
        }

        /// <summary>Full image path of the process owning the window (as the system reports it), or null.</summary>
        internal static string ProcessImagePath(IntPtr h)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return null;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                uint size = (uint)sb.Capacity;
                if (!QueryFullProcessImageNameW(process, 0, sb, ref size)) return null;
                return sb.ToString(0, (int)size);
            }
            finally
            {
                CloseHandle(process);
            }
        }

        /// <summary>Lower-case basename of a full image path.</summary>
        internal static string BaseName(string full)
        {
            int cut = Math.Max(full.LastIndexOf('\\'), full.LastIndexOf('/'));
            return full.Substring(cut + 1).ToLowerInvariant();
        }

        /// <summary>The directory part of a path without a trailing separator ("" when there is none).</summary>
        private static string DirectoryOf(string full)
        {
            int cut = Math.Max(full.LastIndexOf('\\'), full.LastIndexOf('/'));
            return cut <= 0 ? string.Empty : full.Substring(0, cut);
        }

        private static string TrimSeparator(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return string.Empty;
            return dir.TrimEnd('\\', '/');
        }

        private static string[] programFiles;
        private static string windowsDirectory;

        private sealed class CachedRule
        {
            public uint Pid;
            public string ClassName;
            /// <summary>The matching rule, or null (rejected).</summary>
            public TabWindowRule Rule;
        }

        /// <summary>Path verdicts per window (main thread only; bounded).</summary>
        private static readonly System.Collections.Generic.Dictionary<long, CachedRule> ruleCache = new System.Collections.Generic.Dictionary<long, CachedRule>();

        /// <summary>Candidate "Program Files" directories of the 64-bit view (an AnyCPU helper may run 32-bit); read once.</summary>
        private static string[] ProgramFilesDirectories()
        {
            if (programFiles != null) return programFiles;
            var list = new System.Collections.Generic.List<string>();
            string w6432 = Environment.GetEnvironmentVariable("ProgramW6432");
            if (!string.IsNullOrEmpty(w6432)) list.Add(TrimSeparator(w6432));
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!string.IsNullOrEmpty(pf)) list.Add(TrimSeparator(pf));
            programFiles = list.ToArray();
            return programFiles;
        }

        /// <summary>%WINDIR% without a trailing separator (read once).</summary>
        private static string WindowsDirectory()
        {
            if (windowsDirectory == null) windowsDirectory = TrimSeparator(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
            return windowsDirectory;
        }

        /// <summary>The image path satisfies the rule's location requirement (case-insensitive, no wildcards beyond the package prefix).</summary>
        internal static bool ImagePathMatches(TabWindowRule rule, string full)
        {
            if (string.IsNullOrEmpty(full) || full.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
            if (!string.Equals(BaseName(full), rule.Image, StringComparison.Ordinal)) return false;
            string dir = DirectoryOf(full);
            switch (rule.PathRule)
            {
                case ImagePathRule.AnyPath:
                    return true;
                case ImagePathRule.WindowsDirectory:
                {
                    // %WINDIR%\explorer.exe exactly (never a copy elsewhere, never SysWOW64).
                    string windir = WindowsDirectory();
                    return windir.Length > 0 && string.Equals(dir, windir, StringComparison.OrdinalIgnoreCase);
                }
                case ImagePathRule.TerminalPackage:
                {
                    // %ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_<version>_<arch>__8wekyb3d8bbwe\WindowsTerminal.exe
                    foreach (string pf in ProgramFilesDirectories())
                    {
                        string root = pf + "\\WindowsApps\\";
                        if (!dir.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                        string package = dir.Substring(root.Length);
                        if (package.IndexOf('\\') >= 0 || package.IndexOf('/') >= 0) continue;
                        if (package.StartsWith("Microsoft.WindowsTerminal_", StringComparison.OrdinalIgnoreCase)) return true;
                    }
                    return false;
                }
            }
            return false;
        }

        /// <summary>A direct child window of this class exists (FindWindowEx, class only).</summary>
        internal static IntPtr FindChildByClass(IntPtr parent, string className)
        {
            if (parent == IntPtr.Zero || string.IsNullOrEmpty(className)) return IntPtr.Zero;
            return FindWindowExW(parent, IntPtr.Zero, className, IntPtr.Zero);
        }

        /// <summary>
        /// The allow-list gate (Win32 data only, before any UI Automation call). Null when the window
        /// is a visible, responding top-level window of an allow-listed app (its rule in
        /// <paramref name="rule"/>); otherwise the protocol error code ("gone", "rejected", "hidden",
        /// "minimized" or "hung"). A window whose UI thread stopped pumping messages would block every
        /// UI Automation call into it, and this helper answers one request at a time. IsHungAppWindow
        /// sends no message, so it is safe to ask first; it flags a window Windows shows as Not
        /// Responding, but not a browser that was suspended while idle (measured), which the app's
        /// request timeout covers.
        /// </summary>
        internal static string CheckTabWindow(IntPtr h, out TabWindowRule rule)
        {
            rule = null;
            if (h == IntPtr.Zero || !IsWindow(h)) return "gone";
            if (GetAncestor(h, GA_ROOT) != h) return "rejected";
            string cls = ClassName(h);
            TabWindowRule byClass = null;
            foreach (TabWindowRule r in TabWindowRules)
            {
                if (string.Equals(cls, r.TopLevelClass, StringComparison.Ordinal))
                {
                    byClass = r;
                    break;
                }
            }
            if (byClass == null) return "rejected";
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return "rejected";
            TabWindowRule match;
            // A window's process (and so its image) never changes: the path verdict is cached per window and pid.
            long key = unchecked((long)h.ToInt64());
            CachedRule cached;
            if (ruleCache.TryGetValue(key, out cached) && cached.Pid == pid && string.Equals(cached.ClassName, cls, StringComparison.Ordinal))
            {
                match = cached.Rule;
            }
            else
            {
                string full = ProcessImagePath(h);
                if (full == null) return "rejected";
                match = null;
                foreach (TabWindowRule r in TabWindowRules)
                {
                    if (string.Equals(cls, r.TopLevelClass, StringComparison.Ordinal) && ImagePathMatches(r, full))
                    {
                        match = r;
                        break;
                    }
                }
                if (ruleCache.Count >= 64) ruleCache.Clear();
                var entry = new CachedRule();
                entry.Pid = pid;
                entry.ClassName = cls;
                entry.Rule = match;
                ruleCache[key] = entry;
            }
            if (match == null) return "rejected";
            if (match.RequiredChild != null && FindChildByClass(h, match.RequiredChild) == IntPtr.Zero) return "rejected";
            if (!IsWindowVisible(h)) return "hidden";
            if (IsIconic(h)) return "minimized";
            int cloaked;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return "hidden";
            if (IsHungAppWindow(h)) return "hung";
            rule = match;
            return null;
        }

        /// <summary>GetWindowRect of a direct child window of the class, if any (px).</summary>
        internal static bool TryGetChildRect(IntPtr parent, string className, out RECT r)
        {
            r = new RECT();
            IntPtr child = FindChildByClass(parent, className);
            if (child == IntPtr.Zero) return false;
            if (!IsWindowVisible(child)) return false;
            return GetWindowRect(child, out r) && r.Right > r.Left && r.Bottom > r.Top;
        }

        /// <summary>The window's thread has not pumped messages for a while (sends no message itself).</summary>
        internal static bool IsHung(IntPtr h)
        {
            return h != IntPtr.Zero && IsHungAppWindow(h);
        }

        internal static bool IsMaximized(IntPtr h)
        {
            return IsZoomed(h);
        }

        /// <summary>Visible frame (DWM extended frame bounds; falls back to the window rect).</summary>
        internal static bool TryGetFrame(IntPtr h, out RECT r)
        {
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
            return GetWindowRect(h, out r);
        }

        internal static int DpiForWindow(IntPtr h)
        {
            try
            {
                uint dpi = GetDpiForWindow(h);
                return dpi == 0 ? 96 : (int)dpi;
            }
            catch (EntryPointNotFoundException)
            {
                return 96;
            }
        }

        internal static bool TryGetWorkArea(IntPtr h, out RECT work)
        {
            work = new RECT();
            IntPtr monitor = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
            if (monitor == IntPtr.Zero) return false;
            var info = new MONITORINFO();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (!GetMonitorInfoW(monitor, ref info)) return false;
            work = info.rcWork;
            return true;
        }
    }

    /// <summary>Where an allow-listed image must live.</summary>
    internal enum ImagePathRule
    {
        /// <summary>Basename only (Edge and Chrome install per user or per machine).</summary>
        AnyPath,
        /// <summary>Directly in %WINDIR% (File Explorer).</summary>
        WindowsDirectory,
        /// <summary>In a %ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_* package directory.</summary>
        TerminalPackage,
    }

    /// <summary>One allow-listed app: Win32 facts that must all hold before any UI Automation call.</summary>
    internal sealed class TabWindowRule
    {
        /// <summary>Reader kind, written as the strip's "kind": "chromium" or "tabview".</summary>
        public readonly string Kind;
        public readonly string TopLevelClass;
        /// <summary>Lower-case image basename.</summary>
        public readonly string Image;
        public readonly ImagePathRule PathRule;
        /// <summary>Class of a direct child window that must exist (the XAML island bridge), or null.</summary>
        public readonly string RequiredChild;
        /// <summary>Class of the direct child window that is the empty drag area of the title bar, or null.</summary>
        public readonly string DragChild;

        public TabWindowRule(string kind, string topLevelClass, string image, ImagePathRule pathRule, string requiredChild, string dragChild)
        {
            Kind = kind;
            TopLevelClass = topLevelClass;
            Image = image;
            PathRule = pathRule;
            RequiredChild = requiredChild;
            DragChild = dragChild;
        }

        public bool IsTabView
        {
            get { return Kind == "tabview"; }
        }
    }
}
