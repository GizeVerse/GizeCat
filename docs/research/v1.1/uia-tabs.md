# Browser tab-strip discovery via UI Automation (Chrome 155 / Edge 156)

**Bottom line:** both browsers expose their tab strip through native UIA with stable, non-localized class names. Reading it costs almost nothing (about 0.3 ms per refresh, +3 MB in the browser) **as long as no web-content node is touched**. A naive search of the whole window permanently switches on the browser's web-page accessibility, which cost about +60 MB and 1–1.5 s of CPU per window in my runs. Recommended: a small C# helper process.

Labels: **VERIFIED** = I read the source or observed it on this machine. **INFERRED** = my reasoning, not executed.

## 1. How Chromium exposes UIA, and what activates it

- **Native UIA is on by default** since Chrome 138 for all Chromium browsers; the old proxy layer is gone. The `UiAutomationProviderEnabled` policy was only supported through Chrome 146 (VERIFIED from https://developer.chrome.com/blog/windows-uia-support-update). At Chrome 155 there is no off-switch, so an MSAA fallback isn't needed.
- **Which queries cost something** (VERIFIED in `AXPlatformNodeWin::NotifyAPIObserverForPropertyRequest`, https://chromium.googlesource.com/chromium/src.git/+/main/ui/accessibility/platform/ax_platform_node_win.cc):
  - It returns early when `!IsWebContent()`, so properties of browser-UI nodes are free.
  - On web nodes, `BoundingRectangle`, `NativeWindowHandle`, `ProcessId`, `RuntimeId`, `FrameworkId`, `IsEnabled` and `HasKeyboardFocus` never cause activation.
  - On web nodes, `ControlType`, `Name`, `ClassName`, `IsOffscreen`, `AutomationId`, `IsControlElement` and similar call `OnPropertiesUsed` plus `OnExtendedPropertiesUsed`. That turns on `kAXModeBasic | kExtendedProperties` (definitions in https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/accessibility/ax_mode.h).
- **Browser-UI use turns on only `kNativeAPIs`.** `browser_accessibility_state_impl.cc` maps browser-UI property use to `kNativeAPIs`, commented as "little perf impact" (VERIFIED). I found no auto-disable path, so once web mode is on it probably stays on until the browser restarts (INFERRED).
- **Firefox is untested here (UNVERIFIED, not installed).** Firefox 143 turns native UIA on by default; the pref is `accessibility.uia.enable` (0 off, 1 force, 2 on unless an incompatible client is detected), per https://groups.google.com/a/mozilla.org/g/dev-platform/c/qljNUMTNtyA. Leave Firefox out of v1.1.

## 2. Measured probe (REAL)

Setup: my own throwaway instances only, each with a temp `--user-data-dir`. Pages were a 20,000-paragraph data: page, a small data: page and about:blank. Every run went through the machine lock. Both profiles were deleted, all 32 of my processes per run exited after WM_CLOSE (0 killed, 0 left), and I sent no input.

**Window and launch**
- `--window-position=100,100 --window-size=1100,700` are in DIP. Result: GetWindowRect `[125,125,1375×875]`, DWM frame `[133,125,1359×867]` (8 px invisible border left/right/bottom, none on top).
- The window belongs to a **child** of the PID I launched, in both browsers. Tests must match by process tree.
- Time to window: Edge 591–622 ms, Chrome 432 ms.

**UIA tree paths** (VERIFIED; class names are not localized)
- Edge: `Pane:BrowserRootView > Pane:NonClientView > Pane:EdgeBrowserFrameViewWin > Pane:BrowserView > Tab:EdgeTabStripRegionView > Pane:EdgeTabStrip > Tab:EdgeTabContainerImpl > TabItem:EdgeTab`
- Chrome: `… > Pane:BrowserFrameViewWin > Pane:BrowserView > Pane:HorizontalTabStripRegionViewOld > Pane:TabStrip > Tab:TabContainerImpl > TabItem:Tab`
- Caption buttons sit in `Pane:BrowserCaptionButtonContainer`, a sibling of BrowserView: at `[1186/1187, 1, 172–173, 49]`, made of `Button:EdgeWindowsCaptionButton` / `WindowsCaptionButton`, each 57–59×49. One of the four has an empty rect (the hidden maximize/restore twin).
- Edge strip, left to right: `EdgeTabActionsMenuButton [6,0,40,45]`, `EdgeTabStrip [41,0,918,52]`, `EdgeNewTabButton [953,0,40,52]`, `FrameGrabHandle [993,0,193,52]`.
- Chrome strip, left to right: `TabStripComboButton [8,0,36,52]` (tab search), `TabStrip [36,0,916,52]`, `TabStripControlButton` (new tab) `[943,0,36,52]`, `FrameGrabHandle [993,0,194,52]`.
- Hidden vertical-tab containers also exist: `EdgeVerticalTabContainerView` and `VerticalTabStripRegionView`.

**Tab items** (rects relative to the DWM frame)
- 3 tabs, about 320×52 each: Edge at x = 41/340/638, Chrome at 36/333/631. Neighbouring rects **overlap by about 22 px**.
- 24 tabs: 64–67 px wide, all `IsOffscreen=false`. The Edge new-tab button moves to x=1093.
- Maximized: frame `[0,0,1920,1200]`. Edge tabs from x=40, new tab at 1655, grab handle 1695–1748, captions 1748–1920. Chrome new tab at 1646, captions from 1749.
- A TabItem rect covers the **full strip height from the frame top**, not the visible tab shape.

**Visible top edge**, measured with PrintWindow on my own window only (images deleted afterwards):
| | Edge | Chrome |
|---|---|---|
| Row 0 (restored) | 1 px border `#666666` | 1 px border `#61666f` |
| Frame colour | `#e3e3e3`, rows 1–48 | `#d3e3fd`, rows 1–6 |
| Active tab begins | y = 4–5 | y = 7–8 |
| Inactive tabs | no visible shape | no visible shape |
| Strip/toolbar seam | y = 49 | y = 49–50 |
| Maximized | same offsets from screen y = 0 | same |

**Timings**
- First `AutomationElement.FromHandle`: 64–92 ms.
- Pruned discovery walk: 187–267 ms for 234–291 nodes.
- Tab refresh (`GetUpdatedCache`, TreeScope.Children, mode None): **median 0.28 ms (Chrome) / 0.34–0.37 ms (Edge), max 0.55 ms** over 20 runs.
- Re-finding the container from the HWND with 7 Children-scoped `FindFirst` calls on class name: 7–11 ms.
- Subscribing to events: 21–69 ms. `RemoveAllEventHandlers`: 3–7 ms.

**Adding tabs from outside** (a second `browser --user-data-dir=same url` launch)
- The launcher exits 0 after 52–64 ms.
- Tab count change seen by polling: 103 ms (Chrome) / 169 ms (Edge). A batch of 20: 320 / 688 ms.
- `SelectionItemPattern.ElementSelectedEvent` fired once per new foreground tab.
- `StructureChanged ChildAdded` fired once, but **from the content view** (rect `6,100,1348,762`), not from the tab strip.
- **No BoundingRectangle change events from the tab subtree** across 21 additions plus maximize/restore. Only the window element raised one per maximize/restore.

**Activation cost**
| | Edge | Chrome |
|---|---|---|
| Scoped queries only (browser private memory) | 63.2 → 66.3 MB | 64.1 → 64.0 MB |
| Scoped queries only (heavy renderer) | no increase | no increase |
| Naive `FindAll(Descendants, ControlType=TabItem)`, heavy tab active: 1st call | 26 ms | 20 ms |
| Same query, next call (web mode now on) | 804 ms | 543 ms |
| Browser private after naive query | +59 MB | +62 MB |
| Heavy renderer after naive query | +29.5 MB | +35.9 MB |
| Browser CPU | +1.17 s | +0.83 s |
| Renderer CPU | +313 ms | +328 ms |

When a small page was active, the naive query stayed at 20–24 ms, so the cost scales with the active page.

**Probe helper itself:** 29.7 KB exe; 23 MB private / 28 MB working set after loading UIA, about 34 / 50 MB with event handlers; 105–150 ms in-process startup (118–332 ms wall).

## 3. Implementation options

**(a) C# helper.** csc 4.8 plus WPF `UIAutomationClient`, `UIAutomationTypes` and `WindowsBase`; it compiled and ran (VERIFIED). Key calls:
- `AutomationElement.FromHandle(IntPtr)`
- `CacheRequest { TreeFilter = Automation.RawViewCondition, TreeScope = Element|Children, AutomationElementMode = None }` plus `GetUpdatedCache(cr)` / `CachedChildren`
- `FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.ClassNameProperty, …))`
- `Automation.AddAutomationEventHandler(SelectionItemPattern.ElementSelectedEvent, container, TreeScope.Subtree, h)`
- `Automation.AddStructureChangedEventHandler(browserView, TreeScope.Children, h)`
- `Automation.RemoveAllEventHandlers()`

The managed API is the older wrapper; Microsoft points new work at the COM API (https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview), but it was enough for this.

**(b) koffi COM vtable.** Feasible (VERIFIED in plain Node):
- `CoCreateInstance(CLSID_CUIAutomation {ff48dba4-60ef-4201-aa87-54103eef594e}, …, IID_IUIAutomation {30cbe57d-d9d0-452a-ab13-7ac5ac4825ee})` took 3.7 ms.
- Slots read from the type library in UIAutomationCore.dll: IUIAutomation 5 `GetRootElement`, 6 `ElementFromHandle`; element 10 `GetCurrentPropertyValue`, 21 `ControlType`, 30 `ClassName`, 38 `IsOffscreen`, 43 `BoundingRectangle`.
- The VARIANT came back as `vt=0x2005` and needed `SafeArrayAccessData` plus `VariantClear`. BSTRs need `SysFreeString`.
- **My remembered IID was wrong and gave E_NOINTERFACE**; take GUIDs from the type library.
- Electron 44's main thread is an **STA**: `CoInitializeEx(MTA)` returns `0x80010106` (VERIFIED). A `worker_thread` is in the MTA and CoCreateInstance works there (VERIFIED).
- Microsoft's guidance is to make UIA calls and register handlers on an MTA thread that owns no windows (https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading).
- Event handlers would mean hand-building COM objects (QueryInterface/AddRef/Release/Handle…) from `koffi.register` callbacks. Those are queued to the JS thread and can deadlock (https://koffi.dev/callbacks).

**Recommendation: (a), a long-running helper speaking JSON lines over stdin/stdout.** Reasons:
- **Isolation (INFERRED):** a hung or crashed browser provider blocks or crashes only the helper, never Electron's main thread or the cat.
- **Threading:** the right model comes for free.
- **Cost:** about 25–35 MB and 0.1–0.3 s startup.
- **Build:** compile at build time; ship the exe in `app.asar.unpacked`.

Risks (all INFERRED):
- An unsigned, rarely-seen exe that reads other processes' UI may draw AV heuristics; SmartScreen applies to downloaded files, not to a child process of the installed app.
- AppLocker/WDAC may block it.
- Mitigation: the feature fails closed (window-top perching only), the helper is restarted with backoff, and it gets signed when a signing identity exists.

## 4. Safe walkable region

**Discovery (in the helper)**
1. Accept only top-level `Chrome_WidgetWin_1` HWNDs whose image is `msedge.exe` or `chrome.exe` (main already knows these).
2. Follow the known class path with Children-scoped `FindFirst`.
3. If the path breaks (Chrome's class is literally named `…Old`, so expect renames), fall back to a breadth-first search from BrowserView, depth ≤ 4, for a `Tab` whose children are `TabItem`s.
4. **Never enumerate children of** `Document` / `*WebView` / child `Chrome_WidgetWin_1` panes / `Chrome_RenderWidgetHostHWND`. Check those first using only `NativeWindowHandle` + Win32 `GetClassName`, which are activation-free.
5. **Never request `Name`.** Tab names are page titles plus localized hover text (observed "probe1 - Bellek kullanımı - 110 MB"), which breaks the project's window-title invariant. Caption names are localized too (Turkish UI here).

**Triggers**
- Existing WinEvent `EVENT_OBJECT_LOCATIONCHANGE` / foreground events on that HWND.
- UIA `ElementSelected` and content `StructureChanged`.
- A 1 Hz poll (0.3 ms each) only while the cat is on or heading to that strip, because tab rects raise no change events.
- Drop the cached container on `ElementNotAvailableException`.

**Segment** (physical px; F = DWM frame; tabs = non-empty rects, sorted by x):
- `L = max(firstTab.left, leftButton.right)`, where leftButton is `EdgeTabActionsMenuButton` or `TabStripComboButton`.
- `R = min(lastTab.right, newTabButton.left, captionContainer.left)`.
- Inset each end by `m = round(6·dpi/96)` plus half the cat's width; reject the segment if `R − L < catWidth`.
- `FrameGrabHandle` and the caption area are never part of the segment.

**Standing height**
- Strip: feet at `y = F.top`. Inactive tabs have no visible top, so the strip's visual top is the frame top.
- Optional ledge on the active tab: `y = F.top + a`, with `a ≈ 3 DIP` (Edge) / `6 DIP` (Chrome), measured as 4 / 7 px at 125 % only. Restrict it to the active tab's x-range inset about 12 px for its rounded corners.
- Disable the surface when maximized or whenever `F.top − monitor.top < catHeight`.
- Also disable it when the horizontal container's rect is empty (vertical tabs are on) or when the existing z-order logic says the strip is occluded.

Other pitfalls:
- The helper must call `SetProcessDpiAwarenessContext(-4)` first; with it, the desktop root reads 1920×1200 (VERIFIED). Without it, rects come back in logical units (INFERRED).
- Write numbers in JSON with InvariantCulture (this machine runs a Turkish locale).

Scratch evidence, all in `<local scratch>\v11research\uia-tabstrip\`:
- `probe\probe.cs` (probe source)
- `edge-run2.jsonl`, `chrome-run1.jsonl` (run logs)
- `koffi-uia\uia-vtable.cjs`, `koffi-uia\electron-apartment.cjs`, `koffi-uia\tlb.cs` (koffi and type-library checks)

No repository files were modified.
