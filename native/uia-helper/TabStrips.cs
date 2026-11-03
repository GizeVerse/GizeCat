// Tab-strip discovery and refresh through System.Windows.Automation (geometry only).
//
// Safety rules (docs/research/v1.1/uia-tabs.md):
//  - Only browser-UI nodes are ever asked for ControlType/ClassName; web content is never touched.
//    Asking a web-content node for those switches on the browser's web accessibility for good
//    (+~60 MB, +1 s CPU per window, measured).
//  - The Name property (tab titles, localized captions) is never requested.
//  - Discovery follows the known class path with Children-scoped FindFirst calls in the raw view.
//    Where the path breaks, a bounded breadth-first search takes over in up to two phases:
//    (1) only if BrowserView was not reached, from the top-level window element down to the node
//    of class BrowserView (this covers BrowserRootView, NonClientView, the frame views and the
//    caption container); (2) only if the tab container was not reached, from BrowserView down to a
//    horizontal Tab with TabItem children. Each phase is bounded (depth 4, 200 nodes) and never
//    descends into child HWNDs (render widgets), Document/WebView nodes, child widget panes,
//    hidden views or anything below the top band of the window (where web content lives).
//  - Every rectangle is physical px (the process is per-monitor DPI aware).
//
// Protocol 2 adds the WinUI TabView reader (File Explorer, Windows Terminal; ADR 0003 §7.1,
// docs/research/v1.2/tab-discovery.md). Its rules on top of the above:
//  - Only windows that passed Native.CheckTabWindow (Win32 class, full image path, the XAML island
//    child window) are ever handed to UI Automation.
//  - The path island > input site > TabView > ListView is followed with Children-scoped FindFirst;
//    the fallback search reads the activation-free FrameworkId first and enters XAML nodes only,
//    never another child window (tab content), a document, edit or text node, or the terminal
//    control; it stays within depth 4, 200 nodes and the top 56 DIP of the frame.
//  - The tab list must sit at the frame top (within 16 DIP), be horizontal and hold TabItems.
//  - Events are subscribed on the tab ListView only (its subtree is the tab headers), never on the
//    TabView, whose subtree includes the tab content.
//  - Island root panes may report DIP-sized rectangles: no geometry is ever taken from them.
//  - Strings read here (class names, framework ids) are compared in process and never printed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Automation;

namespace DesktopCat.Uia
{
    /// <summary>App-UI elements of one window's tab strip.</summary>
    internal sealed class StripElements
    {
        public IntPtr Hwnd;
        /// <summary>Reader kind ("chromium" or "tabview") of the rule the window matched.</summary>
        public string Kind;
        public TabWindowRule Rule;
        public AutomationElement Window;
        public AutomationElement BrowserView;
        public AutomationElement Captions;
        public AutomationElement Region;
        public AutomationElement Container;
        /// <summary>TabView reader: the TabView element (parent of the tab list), or null.</summary>
        public AutomationElement TabView;
        public string Path;
        public long UsedAt;
        // TabView reader: the add-tab button and caption buttons are read again only when the frame
        // size or the tab count changed (or every ControlsMaxAgeMs), not on every refresh.
        public bool ControlsKnown;
        public int ControlsFrameW;
        public int ControlsFrameH;
        public int ControlsCount;
        public long ControlsAt;
        /// <summary>Add-tab button: x relative to the tab list's right edge, y relative to the frame top.</summary>
        public Rect NewTabRel = Rect.Empty;
        /// <summary>Caption buttons: x relative to the frame's right edge, y relative to the frame top.</summary>
        public Rect CaptionsRel = Rect.Empty;
    }

    /// <summary>Event subscriptions of one watched window.</summary>
    internal sealed class WatchEntry
    {
        /// <summary>Tab-strip region (or container, or the TabView's tab list): ElementSelected, subtree (app UI only).</summary>
        public AutomationElement Target;
        /// <summary>BrowserView (StructureChanged on its direct children) or the TabView's tab list (its subtree), or null.</summary>
        public AutomationElement Content;
        public TreeScope ContentScope;
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

        // TabView reader (measured class path: docs/research/v1.2/tab-discovery.md §4).
        private static readonly string[] InputSites = { "InputSiteWindowClass", "Windows.UI.Input.InputSite.WindowClass" };
        private static readonly string[] TabViewClasses = { "Microsoft.UI.Xaml.Controls.TabView" };
        private const string TabListClass = "ListView";
        private const string XamlFramework = "XAML";
        /// <summary>The TabView's top lies this close to the frame top (DIP; measured 3 and 11 px at 125 %).</summary>
        private const double TabViewTopToleranceDip = 16;
        /// <summary>Band below the frame top the TabView fallback search stays in (DIP).</summary>
        private const double TabViewBandDip = 56;
        /// <summary>XAML classes the fallback search never enters (text boxes, the terminal control).</summary>
        private static readonly string[] NeverExpandXaml = { "TermControl", "AutoSuggestBox", "TextBox", "RichEditBox", "PasswordBox" };
        /// <summary>A title bar wider than this fraction of the frame is not a caption-button group.</summary>
        private const double MaxCaptionFraction = 0.4;
        /// <summary>The add-tab and caption buttons are re-read at least this often (ms) even when nothing else changed.</summary>
        private const long ControlsMaxAgeMs = 30000;

        /// <summary>Child HWNDs skipped by the fallback search (diagnostics; main thread only).</summary>
        internal static int PrunedRenderWidgets;
        internal static int PrunedOtherWindows;

        private readonly Dictionary<string, StripElements> cache = new Dictionary<string, StripElements>(StringComparer.Ordinal);
        private readonly Dictionary<string, WatchEntry> watches = new Dictionary<string, WatchEntry>(StringComparer.Ordinal);
        private readonly EventSink events;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        /// <summary>A hung window's handlers were left registered (see Unwatch).</summary>
        private bool orphanedHandlers;

        private readonly CacheRequest safeRequest;
        private readonly CacheRequest infoRequest;
        private readonly CacheRequest tabsRequest;
        private readonly CacheRequest regionRequest;
        private readonly CacheRequest rectRequest;
        private readonly CacheRequest childTypesRequest;
        private readonly CacheRequest childRectsRequest;
        private readonly CacheRequest frameworkRequest;

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
            // App-UI nodes only (TabView children, title-bar buttons).
            childRectsRequest = NewRequest(TreeScope.Element | TreeScope.Children, AutomationElementMode.None, AutomationElement.ControlTypeProperty, AutomationElement.BoundingRectangleProperty);
            // Activation-free: which UI framework a node belongs to (the TabView search enters XAML nodes only).
            frameworkRequest = NewRequest(TreeScope.Element, AutomationElementMode.None, AutomationElement.FrameworkIdProperty);
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
            TabWindowRule rule;
            string reject = Native.CheckTabWindow(h, out rule);
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
                    StripElements s = GetElements(hwndText, h, rule);
                    string line = rule.IsTabView ? BuildTabViewStrip(id, s, sw) : BuildStrip(id, s, sw);
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

        private StripElements GetElements(string key, IntPtr h, TabWindowRule rule)
        {
            StripElements s;
            // A recycled HWND of another app (another rule) is discovered afresh.
            if (cache.TryGetValue(key, out s) && !string.Equals(s.Kind, rule.Kind, StringComparison.Ordinal)) cache.Remove(key);
            if (!cache.TryGetValue(key, out s))
            {
                s = rule.IsTabView ? DiscoverTabView(h, rule) : Discover(h, rule);
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

        private StripElements Discover(IntPtr h, TabWindowRule rule)
        {
            var s = new StripElements();
            s.Hwnd = h;
            s.Kind = rule.Kind;
            s.Rule = rule;
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
            w.Key("kind").Value("chromium");
            w.EndObject().EndObject();
            return w.ToString();
        }

        // ------------------------------------------------------------------ TabView (protocol 2)

        private StripElements DiscoverTabView(IntPtr h, TabWindowRule rule)
        {
            var s = new StripElements();
            s.Hwnd = h;
            s.Kind = rule.Kind;
            s.Rule = rule;
            s.Path = "class";
            using (safeRequest.Activate())
            {
                s.Window = AutomationElement.FromHandle(h);
            }
            Native.RECT frame;
            if (!Native.TryGetFrame(h, out frame)) return s;
            double scale = Native.DpiForWindow(h) / 96.0;
            AutomationElement island = Child(s.Window, new[] { rule.RequiredChild });
            AutomationElement site = island != null ? Child(island, InputSites) : null;
            AutomationElement tabView = site != null ? Child(site, TabViewClasses) : null;
            AutomationElement list = tabView != null ? TabList(tabView, frame, scale) : null;
            if (list == null || !ValidTabView(tabView, list, frame, scale))
            {
                s.Path = "bfs";
                list = null;
                tabView = island != null ? XamlBfs(island, frame.Top + TabViewBandDip * scale, (ct, cls) => cls == TabViewClasses[0]) : null;
                if (tabView != null)
                {
                    list = TabList(tabView, frame, scale);
                    if (list != null && !ValidTabView(tabView, list, frame, scale)) list = null;
                }
            }
            if (list == null) return s;
            s.TabView = tabView;
            s.Container = list;
            s.Captions = TitleBar(s.Window);
            return s;
        }

        /// <summary>The TabView's horizontal tab list: a direct child, else within two more XAML levels (bounded).</summary>
        private AutomationElement TabList(AutomationElement tabView, Native.RECT frame, double scale)
        {
            Condition condition = new AndCondition(
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.List),
                new PropertyCondition(AutomationElement.ClassNameProperty, TabListClass));
            AutomationElement direct;
            using (safeRequest.Activate())
            {
                direct = tabView.FindFirst(TreeScope.Children, condition);
            }
            if (direct != null) return direct;
            return XamlBfs(tabView, frame.Top + TabViewBandDip * scale, (ct, cls) => ct == ControlType.List && cls == TabListClass, 3);
        }

        /// <summary>The TabView sits in the title bar (top within 16 DIP of the frame top), its list is horizontal and holds tabs.</summary>
        private bool ValidTabView(AutomationElement tabView, AutomationElement list, Native.RECT frame, double scale)
        {
            object tv = tabView.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            object lv = list.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (!(tv is Rect) || !(lv is Rect)) return false;
            Rect t = (Rect)tv;
            Rect l = (Rect)lv;
            if (!Usable(t) || !Usable(l)) return false;
            if (Math.Abs(t.Top - frame.Top) > TabViewTopToleranceDip * scale) return false;
            if (l.Width <= l.Height) return false;
            AutomationElement kids = list.GetUpdatedCache(childTypesRequest);
            AutomationElementCollection children = kids.CachedChildren;
            if (children == null) return false;
            foreach (AutomationElement k in children)
            {
                if (k.Cached.ControlType == ControlType.TabItem) return true;
            }
            return false;
        }

        /// <summary>The window's Win32 title bar (caption buttons), a direct child of the window element.</summary>
        private AutomationElement TitleBar(AutomationElement window)
        {
            using (safeRequest.Activate())
            {
                return window.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TitleBar));
            }
        }

        /// <summary>The add-tab button: a Button/SplitButton child of the TabView right of the list (type and position only).</summary>
        private Rect NewTabRect(AutomationElement tabView, Rect container)
        {
            AutomationElement tv = tabView.GetUpdatedCache(childRectsRequest);
            AutomationElementCollection children = tv.CachedChildren;
            if (children == null) return Rect.Empty;
            double mid = container.Left + container.Width / 2;
            foreach (AutomationElement k in children)
            {
                ControlType ct = k.Cached.ControlType;
                if (ct != ControlType.Button && ct != ControlType.SplitButton) continue;
                Rect r = k.Cached.BoundingRectangle;
                if (!Usable(r) || r.Left + r.Width / 2 <= mid || r.Top >= container.Bottom) continue;
                return r;
            }
            return Rect.Empty;
        }

        /// <summary>The caption buttons: the union of the title bar's buttons, or the bar itself when it is button-sized.</summary>
        private Rect CaptionRect(AutomationElement titleBar, Native.RECT frame)
        {
            AutomationElement t = titleBar.GetUpdatedCache(childRectsRequest);
            Rect union = Rect.Empty;
            AutomationElementCollection children = t.CachedChildren;
            if (children != null)
            {
                foreach (AutomationElement k in children)
                {
                    if (k.Cached.ControlType != ControlType.Button) continue;
                    Rect r = k.Cached.BoundingRectangle;
                    if (Usable(r)) union.Union(r);
                }
            }
            if (Usable(union)) return union;
            Rect own = t.Cached.BoundingRectangle;
            double frameWidth = frame.Right - frame.Left;
            return Usable(own) && own.Width <= MaxCaptionFraction * frameWidth ? own : Rect.Empty;
        }

        /// <summary>
        /// Bounded breadth-first search through XAML app UI below <paramref name="start"/>: a node is
        /// asked for ControlType/ClassName only after its activation-free BoundingRectangle,
        /// NativeWindowHandle and FrameworkId show it is a XAML node inside the band (or the XAML
        /// input site's own child window).
        /// </summary>
        private AutomationElement XamlBfs(AutomationElement start, double bandBottom, Func<ControlType, string, bool> match, int maxDepth = MaxBfsDepth)
        {
            TreeWalker walker = TreeWalker.RawViewWalker;
            var queue = new Queue<Node>();
            var first = new Node();
            first.Element = start;
            first.Depth = 0;
            queue.Enqueue(first);
            int budget = BfsNodeBudget;
            while (queue.Count > 0)
            {
                Node n = queue.Dequeue();
                if (n.Depth >= maxDepth) continue;
                AutomationElement child = walker.GetFirstChild(n.Element, safeRequest);
                while (child != null)
                {
                    if (--budget < 0) return null;
                    AutomationElement next = walker.GetNextSibling(child, safeRequest);
                    if (IsXamlCandidate(child, bandBottom))
                    {
                        AutomationElement full = child.GetUpdatedCache(infoRequest);
                        ControlType ct = full.Cached.ControlType;
                        string cls = full.Cached.ClassName ?? string.Empty;
                        if (match(ct, cls)) return full;
                        if (MayDescendXaml(ct, cls))
                        {
                            var node = new Node();
                            node.Element = full;
                            node.Depth = n.Depth + 1;
                            queue.Enqueue(node);
                        }
                    }
                    child = next;
                }
            }
            return null;
        }

        private bool IsXamlCandidate(AutomationElement el, double bandBottom)
        {
            object hv = el.GetCachedPropertyValue(AutomationElement.NativeWindowHandleProperty);
            int hwnd = hv is int ? (int)hv : 0;
            bool inputSite = false;
            if (hwnd != 0)
            {
                // Only the XAML input site's own window is entered; tab content and any other child window are not.
                if (Array.IndexOf(InputSites, Native.ClassName(new IntPtr(hwnd))) < 0)
                {
                    PrunedOtherWindows++;
                    return false;
                }
                inputSite = true;
            }
            object rv = el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (!(rv is Rect)) return false;
            Rect r = (Rect)rv;
            if (!Usable(r) || r.Top >= bandBottom) return false;
            if (inputSite) return true;
            object fw = el.GetUpdatedCache(frameworkRequest).GetCachedPropertyValue(AutomationElement.FrameworkIdProperty);
            return fw is string && string.Equals((string)fw, XamlFramework, StringComparison.Ordinal);
        }

        private static bool MayDescendXaml(ControlType ct, string cls)
        {
            if (ct == ControlType.Document || ct == ControlType.Edit || ct == ControlType.Text || ct == ControlType.TabItem || ct == ControlType.List) return false;
            if (Array.IndexOf(NeverExpandXaml, cls) >= 0) return false;
            if (cls.IndexOf("WebView", StringComparison.Ordinal) >= 0) return false;
            return true;
        }

        /// <summary>Response line, or null when the window has no usable TabView strip.</summary>
        private string BuildTabViewStrip(long id, StripElements s, Stopwatch sw)
        {
            if (s.Container == null) return null;
            Native.RECT frame;
            if (!Native.TryGetFrame(s.Hwnd, out frame)) return Program.ErrorLine(id, "gone", null);
            Native.RECT work;
            bool hasWork = Native.TryGetWorkArea(s.Hwnd, out work);
            int dpi = Native.DpiForWindow(s.Hwnd);
            bool maximized = Native.IsMaximized(s.Hwnd);

            var tabs = new List<Rect>();
            var selected = new List<bool>();
            int count = 0;
            AutomationElement updated = s.Container.GetUpdatedCache(tabsRequest);
            Rect container = updated.Cached.BoundingRectangle;
            if (!Usable(container)) return null;
            AutomationElementCollection items = updated.CachedChildren;
            if (items != null)
            {
                foreach (AutomationElement k in items)
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

            // The add-tab button and the caption buttons: read when the frame size or the tab count
            // changed (or every ControlsMaxAgeMs), kept relative to what they move with in between, so a
            // steady refresh is the tab list's one cache request.
            int frameW = frame.Right - frame.Left;
            int frameH = frame.Bottom - frame.Top;
            long nowMs = clock.ElapsedMilliseconds;
            if (!s.ControlsKnown || s.ControlsFrameW != frameW || s.ControlsFrameH != frameH || s.ControlsCount != count || nowMs - s.ControlsAt > ControlsMaxAgeMs)
            {
                Rect nt = s.TabView != null ? NewTabRect(s.TabView, container) : Rect.Empty;
                Rect cap = s.Captions != null ? CaptionRect(s.Captions, frame) : Rect.Empty;
                s.NewTabRel = Usable(nt) ? new Rect(nt.Left - container.Right, nt.Top - frame.Top, nt.Width, nt.Height) : Rect.Empty;
                s.CaptionsRel = Usable(cap) ? new Rect(cap.Left - frame.Right, cap.Top - frame.Top, cap.Width, cap.Height) : Rect.Empty;
                s.ControlsKnown = true;
                s.ControlsFrameW = frameW;
                s.ControlsFrameH = frameH;
                s.ControlsCount = count;
                s.ControlsAt = nowMs;
            }
            Rect newTab = s.NewTabRel.IsEmpty ? Rect.Empty : new Rect(container.Right + s.NewTabRel.X, frame.Top + s.NewTabRel.Y, s.NewTabRel.Width, s.NewTabRel.Height);
            Rect captions = s.CaptionsRel.IsEmpty ? Rect.Empty : new Rect(frame.Right + s.CaptionsRel.X, frame.Top + s.CaptionsRel.Y, s.CaptionsRel.Width, s.CaptionsRel.Height);
            Rect grab = Rect.Empty;
            Native.RECT drag;
            if (s.Rule != null && s.Rule.DragChild != null && Native.TryGetChildRect(s.Hwnd, s.Rule.DragChild, out drag))
            {
                grab = new Rect(drag.Left, drag.Top, drag.Right - drag.Left, drag.Bottom - drag.Top);
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
                w.BeginObject();
                WriteRectFields(w, tabs[i]);
                w.Key("selected").Value(selected[i]);
                w.EndObject();
            }
            w.EndArray();
            w.Key("count").Value((long)count);
            w.Key("leftButton").Null();
            w.Key("newTab");
            WriteRect(w, newTab);
            w.Key("grab");
            WriteRect(w, grab);
            w.Key("captions");
            WriteRect(w, captions);
            w.Key("maximized").Value(maximized);
            w.Key("vertical").Value(false);
            w.Key("path").Value(s.Path);
            w.Key("ms").Value(sw.Elapsed.TotalMilliseconds);
            w.Key("kind").Value("tabview");
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
            // With a hung browser's handlers left registered, RemoveAllEventHandlers could block too.
            if (wanted.Count == 0 && !orphanedHandlers)
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
            TabWindowRule rule;
            if (!TryParseHwnd(key, out h) || Native.CheckTabWindow(h, out rule) != null) return false;
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    StripElements s = GetElements(key, h, rule);
                    var entry = new WatchEntry();
                    if (rule.IsTabView)
                    {
                        // The tab list only: its subtree is the tab headers. Never the TabView, whose
                        // subtree holds the tab content (a terminal, a folder view).
                        if (s.Container == null) return false;
                        entry.Target = s.Container;
                        entry.Content = s.Container;
                        entry.ContentScope = TreeScope.Subtree;
                    }
                    else
                    {
                        AutomationElement target = s.Region ?? s.Container;
                        if (target == null) return false;
                        entry.Target = target;
                        entry.Content = s.BrowserView;
                        // Children scope only: the content view (a direct child of BrowserView) reports
                        // tab switches/additions; a subtree registration would reach into web content.
                        entry.ContentScope = TreeScope.Children;
                    }
                    string hwnd = key;
                    // Handlers never touch the sender: it may be a web-content node.
                    entry.Selected = (sender, e) => events.Notify(hwnd, "selected");
                    entry.Structure = (sender, e) => events.Notify(hwnd, "structure");
                    // The active request keeps the event cache to activation-free properties.
                    using (safeRequest.Activate())
                    {
                        Automation.AddAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, entry.Target, TreeScope.Subtree, entry.Selected);
                        if (entry.Content != null) Automation.AddStructureChangedEventHandler(entry.Content, entry.ContentScope, entry.Structure);
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
            events.SetWatched(watches.Keys);
            IntPtr h;
            if (TryParseHwnd(key, out h) && Native.IsHung(h))
            {
                // Removing a handler can call into the browser's provider, which is not responding and
                // would block this single-threaded helper. Its events are no longer forwarded
                // (SetWatched above); the registration is left to RemoveAllEventHandlers at quit.
                orphanedHandlers = true;
                return;
            }
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
