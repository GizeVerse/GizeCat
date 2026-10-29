// Tab-strip discovery and refresh through System.Windows.Automation (geometry only).
//
// Safety rules (docs/research/v1.1/uia-tabs.md):
//  - Only browser-UI nodes are ever asked for ControlType/ClassName; web content is never touched.
//    Asking a web-content node for those switches on the browser's web accessibility for good
//    (+~60 MB, +1 s CPU per window, measured).
//  - The Name property (tab titles, localized captions) is never requested.
//  - Discovery follows the known class path with Children-scoped FindFirst calls in the raw view.
//    The fallback breadth-first search starts at BrowserView, is bounded in depth and nodes, and
//    never descends into child HWNDs (render widgets), Document/WebView nodes, child widget panes,
//    hidden views or anything below the top band of the window (where web content lives).
//  - Every rectangle is physical px (the process is per-monitor DPI aware).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Automation;

namespace DesktopCat.Uia
{
    /// <summary>Browser-UI elements of one window's tab strip.</summary>
    internal sealed class StripElements
    {
        public IntPtr Hwnd;
        public AutomationElement Window;
        public AutomationElement BrowserView;
        public AutomationElement Captions;
        public AutomationElement Region;
        public AutomationElement Container;
        public string Path;
        public long UsedAt;
    }

    /// <summary>Event subscriptions of one watched window.</summary>
    internal sealed class WatchEntry
    {
        /// <summary>Tab-strip region (or container): ElementSelected, subtree (browser UI only).</summary>
        public AutomationElement Target;
        /// <summary>BrowserView: StructureChanged on its direct children (the content view reports tab switches/additions), or null.</summary>
        public AutomationElement Content;
        public AutomationEventHandler Selected;
        public StructureChangedEventHandler Structure;
    }

    internal sealed class TabStripReader
    {
        private const int MaxCachedWindows = 32;
        private const int MaxTabsReported = 256;
        private const int MaxBfsDepth = 4;
        private const int BfsNodeBudget = 200;
        private const int MaxWatched = 16;
        /// <summary>Height (DIP) of the top band of a window that may hold the tab strip.</summary>
        private const double TopBandDip = 64;

        private static readonly string[] RootViews = { "BrowserRootView" };
        private static readonly string[] NonClientViews = { "NonClientView" };
        private static readonly string[] FrameViews = { "EdgeBrowserFrameViewWin", "BrowserFrameViewWin", "GlassBrowserFrameView", "OpaqueBrowserFrameView" };
        private static readonly string[] BrowserViews = { "BrowserView" };
        private static readonly string[] CaptionContainers = { "BrowserCaptionButtonContainer" };
        private static readonly string[] Regions = { "EdgeTabStripRegionView", "HorizontalTabStripRegionViewOld", "HorizontalTabStripRegionView", "TabStripRegionView" };
        private static readonly string[] Strips = { "EdgeTabStrip", "TabStrip" };
        private static readonly string[] Containers = { "EdgeTabContainerImpl", "TabContainerImpl" };
        private static readonly string[] VerticalRegions = { "EdgeVerticalTabContainerView", "VerticalTabStripRegionView" };
        private static readonly string[] LeftButtons = { "EdgeTabActionsMenuButton", "TabStripComboButton", "TabSearchButton" };
        private static readonly string[] NewTabButtons = { "EdgeNewTabButton", "NewTabButton", "TabStripControlButton" };
        private const string GrabHandle = "FrameGrabHandle";

        /// <summary>Child HWNDs skipped by the fallback search (diagnostics; main thread only).</summary>
        internal static int PrunedRenderWidgets;
        internal static int PrunedOtherWindows;

        private readonly Dictionary<string, StripElements> cache = new Dictionary<string, StripElements>(StringComparer.Ordinal);
        private readonly Dictionary<string, WatchEntry> watches = new Dictionary<string, WatchEntry>(StringComparer.Ordinal);
        private readonly EventSink events;
        private readonly Stopwatch clock = Stopwatch.StartNew();

        private readonly CacheRequest safeRequest;
        private readonly CacheRequest infoRequest;
        private readonly CacheRequest tabsRequest;
        private readonly CacheRequest regionRequest;
        private readonly CacheRequest rectRequest;
        private readonly CacheRequest childTypesRequest;

        internal TabStripReader(EventSink events)
        {
            this.events = events;
            // Properties that never switch on web accessibility, valid on any node.
            safeRequest = NewRequest(TreeScope.Element, AutomationElementMode.Full, AutomationElement.BoundingRectangleProperty, AutomationElement.NativeWindowHandleProperty);
            // Browser-UI nodes only.
            infoRequest = NewRequest(TreeScope.Element, AutomationElementMode.Full, AutomationElement.BoundingRectangleProperty, AutomationElement.NativeWindowHandleProperty, AutomationElement.ControlTypeProperty, AutomationElement.ClassNameProperty);
            tabsRequest = NewRequest(TreeScope.Element | TreeScope.Children, AutomationElementMode.None, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty, SelectionItemPattern.IsSelectedProperty);
            regionRequest = NewRequest(TreeScope.Element | TreeScope.Children, AutomationElementMode.None, AutomationElement.ClassNameProperty, AutomationElement.BoundingRectangleProperty);
            rectRequest = NewRequest(TreeScope.Element, AutomationElementMode.None, AutomationElement.BoundingRectangleProperty);
            childTypesRequest = NewRequest(TreeScope.Element | TreeScope.Children, AutomationElementMode.None, AutomationElement.ControlTypeProperty);
        }

        private static CacheRequest NewRequest(TreeScope scope, AutomationElementMode mode, params AutomationProperty[] properties)
        {
            var request = new CacheRequest();
            request.TreeFilter = Automation.RawViewCondition;
            request.TreeScope = scope;
            request.AutomationElementMode = mode;
            foreach (AutomationProperty p in properties) request.Add(p);
            return request;
        }

        internal static bool TryParseHwnd(string text, out IntPtr hwnd)
        {
            hwnd = IntPtr.Zero;
            if (string.IsNullOrEmpty(text) || text.Length > 20) return false;
            foreach (char c in text) if (c < '0' || c > '9') return false;
            ulong value;
            if (!ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value) || value == 0) return false;
            hwnd = new IntPtr(unchecked((long)value));
            return true;
        }

        // ------------------------------------------------------------------ strip

        internal string Strip(long id, string hwndText)
        {
            var sw = Stopwatch.StartNew();
            IntPtr h;
            if (!TryParseHwnd(hwndText, out h)) return Program.ErrorLine(id, "bad-request", null);
            string reject = Native.CheckBrowserWindow(h);
            if (reject != null)
            {
                if (reject == "gone" || reject == "rejected")
                {
                    Forget(hwndText);
                    Unwatch(hwndText);
                }
                return Program.ErrorLine(id, reject, null);
            }
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    StripElements s = GetElements(hwndText, h);
                    string line = BuildStrip(id, s, sw);
                    if (line != null) return line;
                    Forget(hwndText);
                    return Program.ErrorLine(id, "not-found", null);
                }
                catch (ElementNotAvailableException)
                {
                    Forget(hwndText);
                }
                catch (InvalidOperationException)
                {
                    Forget(hwndText);
                }
            }
            return Program.ErrorLine(id, "unavailable", null);
        }

        private StripElements GetElements(string key, IntPtr h)
        {
            StripElements s;
            if (!cache.TryGetValue(key, out s))
            {
                s = Discover(h);
                if (cache.Count >= MaxCachedWindows)
                {
                    string oldest = cache.OrderBy(kv => kv.Value.UsedAt).First().Key;
                    cache.Remove(oldest);
                }
                cache[key] = s;
            }
            s.UsedAt = clock.ElapsedMilliseconds;
            return s;
        }

        private void Forget(string key)
        {
            cache.Remove(key);
        }

        private StripElements Discover(IntPtr h)
        {
            var s = new StripElements();
            s.Hwnd = h;
            s.Path = "class";
            using (safeRequest.Activate())
            {
                s.Window = AutomationElement.FromHandle(h);
            }
            AutomationElement root = Child(s.Window, RootViews);
            AutomationElement nonClient = root != null ? Child(root, NonClientViews) : null;
            AutomationElement frameView = nonClient != null ? Child(nonClient, FrameViews) : null;
            if (frameView != null)
            {
                s.BrowserView = Child(frameView, BrowserViews);
                s.Captions = Child(frameView, CaptionContainers);
            }
            Native.RECT frame;
            double bandBottom = Native.TryGetFrame(h, out frame) ? frame.Top + TopBandDip * Native.DpiForWindow(h) / 96.0 : double.NegativeInfinity;
            if (s.BrowserView == null)
            {
                AutomationElement unused;
                s.Path = "bfs";
                s.BrowserView = Bfs(s.Window, h, bandBottom, (el, ct, cls) => cls == "BrowserView", out unused);
                if (s.BrowserView == null) return s;
            }
            if (s.Captions == null)
            {
                AutomationElement parent = TreeWalker.RawViewWalker.GetParent(s.BrowserView, safeRequest);
                if (parent != null) s.Captions = Child(parent, CaptionContainers);
            }
            s.Region = Child(s.BrowserView, Regions);
            AutomationElement strip = s.Region != null ? Child(s.Region, Strips) : null;
            s.Container = strip != null ? Child(strip, Containers) : null;
            if (s.Container == null)
            {
                AutomationElement region;
                s.Path = "bfs";
                s.Container = Bfs(s.BrowserView, h, bandBottom, IsHorizontalTabContainer, out region);
                if (s.Container != null) s.Region = region;
            }
            return s;
        }

        /// <summary>First raw-view child with one of the class names (Children scope: only direct children are evaluated).</summary>
        private AutomationElement Child(AutomationElement parent, string[] classes)
        {
            Condition condition;
            if (classes.Length == 1)
            {
                condition = new PropertyCondition(AutomationElement.ClassNameProperty, classes[0]);
            }
            else
            {
                condition = new OrCondition(classes.Select(c => (Condition)new PropertyCondition(AutomationElement.ClassNameProperty, c)).ToArray());
            }
            using (safeRequest.Activate())
            {
                return parent.FindFirst(TreeScope.Children, condition);
            }
        }

        private bool IsHorizontalTabContainer(AutomationElement el, ControlType ct, string cls)
        {
            if (ct != ControlType.Tab) return false;
            Rect r = el.Cached.BoundingRectangle;
            if (!Usable(r) || r.Width <= r.Height) return false;
            AutomationElement kids = el.GetUpdatedCache(childTypesRequest);
            AutomationElementCollection children = kids.CachedChildren;
            if (children == null) return false;
            foreach (AutomationElement k in children)
            {
                if (k.Cached.ControlType == ControlType.TabItem) return true;
            }
            return false;
        }

        private sealed class Node
        {
            public AutomationElement Element;
            public int Depth;
            public AutomationElement FirstLevel;
        }

        /// <summary>
        /// Bounded breadth-first search below <paramref name="start"/>. Only BoundingRectangle and
        /// NativeWindowHandle are read before a node is known to be safe browser UI.
        /// </summary>
        private AutomationElement Bfs(AutomationElement start, IntPtr top, double bandBottom, Func<AutomationElement, ControlType, string, bool> match, out AutomationElement firstLevel)
        {
            firstLevel = null;
            TreeWalker walker = TreeWalker.RawViewWalker;
            var queue = new Queue<Node>();
            var first = new Node();
            first.Element = start;
            first.Depth = 0;
            queue.Enqueue(first);
            int budget = BfsNodeBudget;
            int topHandle = unchecked((int)top.ToInt64());
            while (queue.Count > 0)
            {
                Node n = queue.Dequeue();
                if (n.Depth >= MaxBfsDepth) continue;
                AutomationElement child = walker.GetFirstChild(n.Element, safeRequest);
                while (child != null)
                {
                    if (--budget < 0) return null;
                    AutomationElement next = walker.GetNextSibling(child, safeRequest);
                    if (IsSafeCandidate(child, topHandle, bandBottom))
                    {
                        AutomationElement full = child.GetUpdatedCache(infoRequest);
                        ControlType ct = full.Cached.ControlType;
                        string cls = full.Cached.ClassName ?? string.Empty;
                        AutomationElement levelOne = n.FirstLevel ?? full;
                        if (match(full, ct, cls))
                        {
                            firstLevel = levelOne;
                            return full;
                        }
                        if (MayDescend(ct, cls))
                        {
                            var node = new Node();
                            node.Element = full;
                            node.Depth = n.Depth + 1;
                            node.FirstLevel = levelOne;
                            queue.Enqueue(node);
                        }
                    }
                    child = next;
                }
            }
            return null;
        }

        /// <summary>Decided from activation-free properties only: no child HWND, visible, inside the top band.</summary>
        private static bool IsSafeCandidate(AutomationElement el, int topHandle, double bandBottom)
        {
            object hv = el.GetCachedPropertyValue(AutomationElement.NativeWindowHandleProperty);
            int hwnd = hv is int ? (int)hv : 0;
            if (hwnd != 0 && hwnd != topHandle)
            {
                // A child HWND (Chrome_RenderWidgetHostHWND, D3D surface, ...): never inspected further.
                if (Native.ClassName(new IntPtr(hwnd)).StartsWith("Chrome_RenderWidgetHost", StringComparison.Ordinal)) PrunedRenderWidgets++;
                else PrunedOtherWindows++;
                return false;
            }
            object rv = el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (!(rv is Rect)) return false;
            Rect r = (Rect)rv;
            if (!Usable(r)) return false;
            return r.Top < bandBottom;
        }

        private static bool MayDescend(ControlType ct, string cls)
        {
            if (ct == ControlType.Document || ct == ControlType.TabItem) return false;
            if (cls.IndexOf("WebView", StringComparison.Ordinal) >= 0) return false;
            if (cls.IndexOf("WebContents", StringComparison.Ordinal) >= 0) return false;
            if (cls.StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return false;
            if (cls.StartsWith("Chrome_RenderWidgetHost", StringComparison.Ordinal)) return false;
            return true;
        }

        private static bool Usable(Rect r)
        {
            return !r.IsEmpty && !double.IsInfinity(r.X) && !double.IsInfinity(r.Y) && r.Width > 0 && r.Height > 0;
        }

        private static bool In(string[] set, string value)
        {
            return Array.IndexOf(set, value) >= 0;
        }

        /// <summary>Response line, or null when the window has no usable tab strip.</summary>
        private string BuildStrip(long id, StripElements s, Stopwatch sw)
        {
            Native.RECT frame;
            if (!Native.TryGetFrame(s.Hwnd, out frame)) return Program.ErrorLine(id, "gone", null);
            Native.RECT work;
            bool hasWork = Native.TryGetWorkArea(s.Hwnd, out work);
            int dpi = Native.DpiForWindow(s.Hwnd);
            bool maximized = Native.IsMaximized(s.Hwnd);

            var tabs = new List<Rect>();
            var selected = new List<bool>();
            int count = 0;
            Rect container = Rect.Empty;
            if (s.Container != null)
            {
                AutomationElement updated = s.Container.GetUpdatedCache(tabsRequest);
                container = updated.Cached.BoundingRectangle;
                AutomationElementCollection children = updated.CachedChildren;
                if (children != null)
                {
                    foreach (AutomationElement k in children)
                    {
                        if (k.Cached.ControlType != ControlType.TabItem) continue;
                        count++;
                        if (tabs.Count >= MaxTabsReported) continue;
                        Rect r = k.Cached.BoundingRectangle;
                        if (!Usable(r)) continue;
                        object v = k.GetCachedPropertyValue(SelectionItemPattern.IsSelectedProperty, true);
                        tabs.Add(r);
                        selected.Add(v is bool && (bool)v);
                    }
                }
            }
            bool vertical = false;
            if (!Usable(container))
            {
                vertical = VerticalTabsVisible(s);
                if (!vertical) return null;
            }

            Rect left = Rect.Empty, newTab = Rect.Empty, grab = Rect.Empty;
            if (s.Region != null && !vertical)
            {
                AutomationElement region = s.Region.GetUpdatedCache(regionRequest);
                AutomationElementCollection children = region.CachedChildren;
                if (children != null)
                {
                    foreach (AutomationElement k in children)
                    {
                        Rect r = k.Cached.BoundingRectangle;
                        if (!Usable(r)) continue;
                        string cls = k.Cached.ClassName ?? string.Empty;
                        if (left.IsEmpty && In(LeftButtons, cls) && r.Left <= container.Left + 1) left = r;
                        else if (newTab.IsEmpty && In(NewTabButtons, cls) && r.Left >= container.Left) newTab = r;
                        else if (grab.IsEmpty && cls == GrabHandle) grab = r;
                    }
                }
            }
            Rect captions = Rect.Empty;
            if (s.Captions != null)
            {
                captions = s.Captions.GetUpdatedCache(rectRequest).Cached.BoundingRectangle;
            }

            var w = new JsonWriter();
            w.BeginObject().Id(id).Key("ok").Value(true).Key("strip").BeginObject();
            w.Key("frame");
            WriteRect(w, frame.Left, frame.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
            w.Key("work");
            if (hasWork) WriteRect(w, work.Left, work.Top, work.Right - work.Left, work.Bottom - work.Top);
            else w.Null();
            w.Key("dpi").Value((long)dpi);
            w.Key("container");
            WriteRect(w, container);
            w.Key("tabs").BeginArray();
            for (int i = 0; i < tabs.Count; i++)
            {
                Rect r = tabs[i];
                w.BeginObject();
                WriteRectFields(w, r);
                w.Key("selected").Value(selected[i]);
                w.EndObject();
            }
            w.EndArray();
            w.Key("count").Value((long)count);
            w.Key("leftButton");
            WriteRect(w, left);
            w.Key("newTab");
            WriteRect(w, newTab);
            w.Key("grab");
            WriteRect(w, grab);
            w.Key("captions");
            WriteRect(w, captions);
            w.Key("maximized").Value(maximized);
            w.Key("vertical").Value(vertical);
            w.Key("path").Value(s.Path);
            w.Key("ms").Value(sw.Elapsed.TotalMilliseconds);
            w.EndObject().EndObject();
            return w.ToString();
        }

        private bool VerticalTabsVisible(StripElements s)
        {
            if (s.BrowserView == null) return false;
            AutomationElement v = Child(s.BrowserView, VerticalRegions);
            if (v == null) return false;
            return Usable(v.GetUpdatedCache(rectRequest).Cached.BoundingRectangle);
        }

        private static long Px(double v)
        {
            return (long)Math.Round(v, MidpointRounding.AwayFromZero);
        }

        private static void WriteRect(JsonWriter w, long x, long y, long width, long height)
        {
            w.BeginObject().Key("x").Value(x).Key("y").Value(y).Key("w").Value(Math.Max(0, width)).Key("h").Value(Math.Max(0, height)).EndObject();
        }

        private static void WriteRect(JsonWriter w, Rect r)
        {
            if (!Usable(r))
            {
                w.Null();
                return;
            }
            w.BeginObject();
            WriteRectFields(w, r);
            w.EndObject();
        }

        private static void WriteRectFields(JsonWriter w, Rect r)
        {
            long x = Px(r.Left), y = Px(r.Top);
            w.Key("x").Value(x).Key("y").Value(y).Key("w").Value(Math.Max(0, Px(r.Right) - x)).Key("h").Value(Math.Max(0, Px(r.Bottom) - y));
        }

        // ------------------------------------------------------------------ watch

        /// <summary>Replaces the watched set: selection events on the tab strip and structure events of the window.</summary>
        internal string Watch(long id, List<string> hwnds)
        {
            if (hwnds == null || hwnds.Count > MaxWatched) return Program.ErrorLine(id, "bad-request", null);
            var wanted = new HashSet<string>(StringComparer.Ordinal);
            foreach (string text in hwnds)
            {
                IntPtr ignored;
                if (!TryParseHwnd(text, out ignored)) return Program.ErrorLine(id, "bad-request", null);
                wanted.Add(text);
            }
            foreach (string key in watches.Keys.ToList())
            {
                if (!wanted.Contains(key)) Unwatch(key);
            }
            if (wanted.Count == 0)
            {
                RemoveAll();
            }
            var failed = new List<string>();
            foreach (string key in wanted)
            {
                if (watches.ContainsKey(key)) continue;
                if (!Subscribe(key)) failed.Add(key);
            }
            events.SetWatched(watches.Keys);
            var w = new JsonWriter();
            w.BeginObject().Id(id).Key("ok").Value(true).Key("watching").Value((long)watches.Count).Key("failed").BeginArray();
            foreach (string f in failed) w.Value(f);
            w.EndArray().EndObject();
            return w.ToString();
        }

        private bool Subscribe(string key)
        {
            IntPtr h;
            if (!TryParseHwnd(key, out h) || Native.CheckBrowserWindow(h) != null) return false;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    StripElements s = GetElements(key, h);
                    AutomationElement target = s.Region ?? s.Container;
                    if (target == null) return false;
                    var entry = new WatchEntry();
                    entry.Target = target;
                    entry.Content = s.BrowserView;
                    string hwnd = key;
                    // Handlers never touch the sender: it may be a web-content node.
                    entry.Selected = (sender, e) => events.Notify(hwnd, "selected");
                    entry.Structure = (sender, e) => events.Notify(hwnd, "structure");
                    // The active request keeps the event cache to activation-free properties.
                    using (safeRequest.Activate())
                    {
                        Automation.AddAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, entry.Target, TreeScope.Subtree, entry.Selected);
                        // Children scope only: the content view (a direct child of BrowserView) reports
                        // tab switches/additions; a subtree registration would reach into web content.
                        if (entry.Content != null) Automation.AddStructureChangedEventHandler(entry.Content, TreeScope.Children, entry.Structure);
                    }
                    watches[key] = entry;
                    return true;
                }
                catch (ElementNotAvailableException)
                {
                    Forget(key);
                }
                catch (InvalidOperationException)
                {
                    Forget(key);
                }
            }
            return false;
        }

        private void Unwatch(string key)
        {
            WatchEntry entry;
            if (!watches.TryGetValue(key, out entry)) return;
            watches.Remove(key);
            try
            {
                Automation.RemoveAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, entry.Target, entry.Selected);
            }
            catch (Exception)
            {
                // The window is gone or the provider failed; nothing left to remove.
            }
            if (entry.Content != null)
            {
                try
                {
                    Automation.RemoveStructureChangedEventHandler(entry.Content, entry.Structure);
                }
                catch (Exception)
                {
                    // Same as above.
                }
            }
            events.SetWatched(watches.Keys);
        }

        private void RemoveAll()
        {
            watches.Clear();
            events.SetWatched(watches.Keys);
            try
            {
                Automation.RemoveAllEventHandlers();
            }
            catch (Exception)
            {
            }
        }

        internal int WatchCount
        {
            get { return watches.Count; }
        }

        internal void Shutdown()
        {
            RemoveAll();
            cache.Clear();
        }
    }
}
