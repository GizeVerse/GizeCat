# DesktopCatUia: the tab-strip helper

A small C# 5 / .NET Framework 4.x console program. It reads the geometry of Edge and Chrome tab strips, and from protocol 2 the WinUI `TabView` title-bar strips of Windows Terminal and File Explorer, through UI Automation (`System.Windows.Automation`), so the cat can walk on them. Decisions: ADR 0002 §3, ADR 0003 §7. Measurements and traps: `docs/research/v1.1/uia-tabs.md`, `docs/research/v1.2/tab-discovery.md`.

## Protocol 2 (v1.2)

- `ping` answers `"version":2` and `"kinds":["chromium","tabview"]`; every strip carries `"kind"`. The app compares the version exactly (`src/main/uia/protocol.ts`), so both ends move together; protocol-1 strips (no `kind`) still parse as Chromium.
- **Allow-list gate, Win32 only, before any UI Automation call** (`Native.CheckTabWindow`, mirrored by `src/main/uia/allowList.ts`): top-level, visible, uncloaked, not iconic, not hung, and one rule matching the top-level class, the process image and a required child window class (`FindWindowEx`, class only):

  | kind | top-level class | image | required child |
  |---|---|---|---|
  | `chromium` | `Chrome_WidgetWin_1` | `msedge.exe`, `chrome.exe` (any path) | none |
  | `tabview` | `CabinetWClass` | `%WINDIR%\explorer.exe` exactly | `Microsoft.UI.Content.DesktopChildSiteBridge` |
  | `tabview` | `CASCADIA_HOSTING_WINDOW_CLASS` | `WindowsTerminal.exe` in `%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_*` | `Windows.UI.Composition.DesktopWindowContentBridge` |

  Everything else is `rejected` without `FromHandle`. Firefox, VS Code / Electron and Notepad are also never sent by the app (`UIA_NEVER_QUERY`). Whether the Explorer rule is used is the app's decision (soak gate, rate limit, kill switch: ADR 0003 §7.2).
- **TabView discovery**: island > input site > `Microsoft.UI.Xaml.Controls.TabView` > `ListView` with children-scoped `FindFirst`; validated (TabView top within 16 DIP of the frame top, horizontal list, `TabItem` children). The fallback search starts at the island, reads the activation-free `BoundingRectangle`, `NativeWindowHandle` and `FrameworkId` first, enters XAML nodes only (and the input site's own window), stays in the top 56 DIP, depth 4 and 200 nodes, and never expands documents, edit or text nodes, text boxes or the terminal control. Geometry is never taken from the island root pane (it may report DIP).
- **Response**: `container` = the tab list, `tabs` from one cache request; `newTab` = the Button/SplitButton child of the TabView right of the list (type and position only); `grab` = the drag child window (`TITLE_BAR_SCAFFOLDING_WINDOW_CLASS`, `DRAG_BAR_WINDOW_CLASS`) by `GetWindowRect`; `captions` = the Win32 title bar's buttons; `leftButton` null; `vertical` false. `newTab` and `captions` are re-read only when the frame size or the tab count changes (or every 30 s).
- **Events**: `ElementSelected` and `StructureChanged` on the tab list only (its subtree is the tab headers); never on the TabView, whose subtree holds the tab content.
- **Never read** in this reader or anywhere in the helper: the Name property, AutomationId, the legacy MSAA properties, the Value and Text patterns, help text, full descriptions, item status, web content. `tests/unit/uia/neverRead.test.ts` greps the C# sources for them.

### Measured (REAL, 2026-10-29, Windows 11 26200, 125 %, own windows only, `scripts/uia-probe.mjs --apps terminal,explorer`)

| | Windows Terminal 1.24.12741 | File Explorer (own `opennewprocess` window) |
|---|---|---|
| First `strip`, including discovery | 91–108 ms | 92–118 ms |
| `strip` refresh: helper-side median / max | 1.33–1.47 / 2.1–2.7 ms | 1.21–1.29 / 2.2–2.4 ms |
| `strip` refresh: round-trip median | 1.9–2.1 ms | 1.6–1.8 ms |
| Owner private memory across discovery, refreshes and the watch | −1.4 to −1.6 MB | +0.2 MB |
| Helper events while idle (Terminal: `ping` printing in both tabs) | 0 / s over 10 s | 0 / s over 5 s |
| Tab added to our window (`wt -w <name> new-tab`) | 4 events, first after 74–76 ms; count 3 | not triggered |
| Segment (frame-relative) | 100.5–583.5 px, rest 399.5–578.5 | 67.5–256.5 px, rest 72.5–251.5 |

## Build

```
node scripts/build-uia-helper.mjs          # -> out/native/DesktopCatUia.exe (also run by scripts/build.mjs)
node scripts/build-uia-helper.mjs --strict # exit 1 when csc.exe is missing
```

- The compiler is the one that ships with Windows: `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. You don't need an SDK.
- The build references `WPF\UIAutomationClient.dll`, `UIAutomationTypes.dll` and `WindowsBase.dll`, plus `System.dll` and `System.Core.dll`.
- The flags are fixed: `/optimize+ /nologo /noconfig /target:exe /platform:anycpu /langversion:5 /debug-`.
- The build is idempotent. A stamp file next to the exe records a hash of the sources, flags and compiler, and the exe is rebuilt only when that hash changes. This legacy compiler has no `/deterministic` switch, so rebuilt bytes differ in the PE timestamp.
- After compiling, the build runs `--version` on the new exe as a smoke check before it replaces the old one. The stamp is written only after the check passes; when it fails, the exe and the stamp are deleted, so the next run compiles and checks again.
- If `csc.exe` is missing, the build logs that tab strips will be unavailable and still succeeds. At run time the app then reports `tabStrips: 'unavailable'` with a reason, and window tops keep working.
- Packaging: `electron-builder.yml` copies the exe to `resources/native/DesktopCatUia.exe` through `extraResources`, never into the asar. `resolveUiaHelperPath` in `src/main/uia/index.ts` finds it there, or at `out/native` in development.

## Protocol (version 2; version 1 without `kind`/`kinds`)

One JSON object per line on stdin and stdout, UTF-8 with `\n` endings. Numbers are written with `InvariantCulture`.

| Request | Response |
|---|---|
| `{"id":1,"op":"ping"}` | `{"id":1,"ok":true,"pong":true,"version":2,"dpi":"permonitorv2","watching":0,"prunedRender":0,"prunedOther":0,"kinds":["chromium","tabview"]}` |
| `{"id":2,"op":"strip","hwnd":"<decimal>"}` | `{"id":2,"ok":true,"strip":{frame,work,dpi,container,tabs:[{x,y,w,h,selected}],count,leftButton,newTab,grab,captions,maximized,vertical,path,ms,kind}}` |
| `{"id":3,"op":"watch","hwnds":["<decimal>",...]}` | `{"id":3,"ok":true,"watching":N,"failed":[...]}`. The list replaces the watched set; at most 16 HWNDs. |
| `{"op":"quit"}` | No response. The helper exits. |

- **Events:** `{"event":"selected"|"structure","hwnd":"<decimal>"}`. They are coalesced to at most one line per kind and window per 250 ms.
- **Errors:** `{"id":N|null,"ok":false,"error":"<code>","detail":"<exception type>"|null}`. The codes are:
  - `bad-json`, `bad-request`, `bad-op`, `too-long` (a request line over 16 K chars), `busy`
  - `gone`, `rejected` (not a window of an allow-listed app, see Protocol 2), `hidden`, `minimized`, `hung` (Windows reports the window as not responding; checked before any UI Automation call), `not-found` (no tab strip), `unavailable`, `internal`
- **Rects:** every rect is `{x,y,w,h}` in physical px, or `null` when the element is missing or empty.
- **`frame`:** the DWM extended frame bounds.
- **`path`:** `class` when the known class path was used, `bfs` when the bounded fallback search was used.
- **Exit:** the helper exits on `quit`, when stdin closes, or 3 s after stdin closes if a provider call hangs.

## Safety rules (enforced in the source)

- `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` is the first call.
- It accepts only top-level, visible windows of the allow-list above (Win32 class, process image, required child window), and checks this on every request before any UI Automation call.
- A window that Windows reports as not responding (`IsHungAppWindow`) is answered `hung` without touching UI Automation, and its event handlers are not removed while it hangs (removal can call into the browser). `IsHungAppWindow` does not flag a browser that was suspended while idle (REAL, Edge 156, 2026-10-29). The helper handles one request at a time, so a call into a browser that stalls blocks it. The app then times the request out, quarantines that window (30 s, doubling) and starts a new helper without it, outside the restart budget (`src/main/uia/service.ts`).
- **It never requests `Name`.** Tab names are page titles. Other strings read from the browser are never printed: the output holds only rects, flags, counts, decimal HWNDs and fixed protocol words. `tests/integration/uia/probe.ts` checks this against real output.
- It never touches web content. Discovery follows the class path with `Children`-scoped `FindFirst` on `ClassName`.
- Where the class path breaks (for example a renamed frame view), a fallback breadth-first search takes over in up to two phases:
  1. Only if BrowserView was not reached: from the **top-level window element** to the node of class `BrowserView`. This phase evaluates `BrowserRootView`, `NonClientView`, the frame views and the caption container.
  2. Only if the tab container was not reached: from **BrowserView** to a horizontal `Tab` whose children are `TabItem`s.
- Each phase is bounded: depth 4, a 200-node budget, and only the top band of the window. Before it asks a node for anything else, it reads only the activation-free `BoundingRectangle` and `NativeWindowHandle`.
- Both phases skip child HWNDs (render widgets, checked with `GetClassName`). They never descend into `Document`, `*WebView*`, `*WebContents*` or child `Chrome_WidgetWin_*` / `Chrome_RenderWidgetHost*` nodes.
- Asking a web node for `ControlType`, `ClassName` or `Name` permanently turns on the browser's web accessibility, measured at about +60 MB and +1 s CPU.
- Tabs are refreshed with one `CacheRequest`: `TreeScope.Element|Children`, `AutomationElementMode.None`, raw view.
- Events:
  - `SelectionItemPattern.ElementSelectedEvent` on the tab-strip region (`Subtree`).
  - `StructureChanged` on BrowserView, `Children` scope only.
  - Handlers never touch the sender.
  - Handlers are removed on unwatch, and `RemoveAllEventHandlers` runs on quit.
- `ElementNotAvailableException` drops the cached elements, and the request is retried once. Other provider exceptions return `internal` with the exception type only.
- Work per request is bounded: at most 32 cached windows, 256 reported tabs and a 64-entry request queue. Each line is capped at 16 K chars, each JSON string at 256 chars, nesting at 8 levels and each object or array at 64 items.

## Measured (REAL, Windows 11 26200, 125 %, `scripts/uia-probe.mjs`)

| | Edge 156.0.4314.50 | Chrome 155.0.8059.79 |
|---|---|---|
| First `strip`, including discovery | 98–103 ms | 87 ms |
| `strip` refresh: helper-side median / max | 1.1 / 1.7 ms | 0.8 / 1.3 ms |
| `strip` refresh: round-trip median | 1.4 ms | 1.0 ms |
| Helper process: private / working set / CPU | 22.4 / 31.7 MB / 234 ms | 22.5 / 31.7 MB / 203 ms |
| Largest growth of any instance process across the UIA reads and watch, heavy active page (2026-10-29) | +0.2 MB (17 processes) | +0.1 MB (12 processes) |
| Positive control: the same check after a naive `FindAll(Descendants, ControlType=TabItem)` on a second instance | +77.1 MB, detected | +75.1 MB, detected |

The helper's CPU time covers the whole probe run, startup included.

The activation check (`tests/integration/uia/activation.ts`) fails the probe when any process of the instance grows by more than 12 MB. The active tab is a 20,000-paragraph `data:` page, because the activation cost scales with the active page: a review run with `about:blank` tabs only saw the naive query add +0.4 MB, so the earlier browser-process-only check could not fail. Every probe run also runs the positive control and fails if the control is not detected, so a passing check means the measurement could have seen an activation.

`scripts/uia-probe.mjs` launches and closes its own throwaway browser instances (two per browser: the probe and the positive control), each with a temp profile, and never touches other windows. Run it under the machine lock:

```
node scripts/with-lock.mjs uia-probe -- node scripts/uia-probe.mjs --browsers edge,chrome --out report.json
```
