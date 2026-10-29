// Win32 calls used by the helper. Only class names, process image names, window state and
// geometry are read; window text is never requested.
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
        private static extern IntPtr GetAncestor(IntPtr h, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassNameW(IntPtr h, StringBuilder buffer, int max);

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

        /// <summary>Lower-case image basename of the process owning the window, or null.</summary>
        internal static string ProcessImageBaseName(IntPtr h)
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
                string full = sb.ToString(0, (int)size);
                int cut = Math.Max(full.LastIndexOf('\\'), full.LastIndexOf('/'));
                return full.Substring(cut + 1).ToLowerInvariant();
            }
            finally
            {
                CloseHandle(process);
            }
        }

        /// <summary>
        /// Null when the window is a visible top-level Edge/Chrome browser frame; otherwise the
        /// protocol error code ("gone", "rejected", "hidden" or "minimized").
        /// </summary>
        internal static string CheckBrowserWindow(IntPtr h)
        {
            if (h == IntPtr.Zero || !IsWindow(h)) return "gone";
            if (GetAncestor(h, GA_ROOT) != h) return "rejected";
            if (!string.Equals(ClassName(h), ChromeWindowClass, StringComparison.Ordinal)) return "rejected";
            string exe = ProcessImageBaseName(h);
            if (exe == null) return "rejected";
            if (!string.Equals(exe, "msedge.exe", StringComparison.Ordinal) && !string.Equals(exe, "chrome.exe", StringComparison.Ordinal)) return "rejected";
            if (!IsWindowVisible(h)) return "hidden";
            if (IsIconic(h)) return "minimized";
            int cloaked;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return "hidden";
            return null;
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
}
