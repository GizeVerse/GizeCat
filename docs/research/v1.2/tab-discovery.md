# v1.2 research: generic tab-strip discovery beyond Edge/Chrome

Date: 2026-10-29. Machine: Windows 11 Home 10.0.26200.9711, one 1920×1200 display at 125 % (DPI 120), auto-hide bottom taskbar. Code base: `feat/v1.2-lively` at `e9133bd` (= v1.1.1). Phase: diagnosis only; no product source changed.

Labels: **REAL** = executed on this machine against windows this research started itself. **SIMULATED** = the shipped pure code run on REAL inputs. **UNVERIFIED** = desk research (source read or documentation) or inference, not executed here.

## Bottom line

- **File Explorer and Windows Terminal expose their title-bar tab strips through UI Automation, cheaply and without any activation cost (REAL).** Both use the WinUI `Microsoft.UI.Xaml.Controls.TabView` inside a XAML-island child window. A refresh takes 0.31–0.41 ms (median, one cache request). The owning process grew ≤ 0.7 MB across discovery, 20 refreshes and two re-finds.
- **Notepad 11 was not probed live.** The user has a saved Notepad session (23 tab-state files), so launching Notepad would restore the user's tabs into the probe window, and closing it would rewrite their session. It ships on Windows App SDK 2.x, which is the WinUI 3 stack Explorer's tab strip uses, so the same adapter very probably fits (UNVERIFIED).
- **Win32 `SysTabControl32`, WinForms and WPF tab controls are fully readable (REAL), but they sit inside the client area, not on the window's top edge.** They are not top-edge surfaces, and walking on them would cover app content. Not recommended.
- **Firefox and Electron apps (VS Code, Obsidian…) cannot be queried without switching on an expensive accessibility engine** (UNVERIFIED desk research, source-backed). They must stay rejected *before any UIA call*. Their window tops already work.
- **Recommendation:** a second adapter kind `tabview` inside the existing helper and protocol (version 2, additive). A Win32-only allow-list gate runs before any UIA call. The class path is `island > input site > TabView > ListView > TabItem`. Rect discipline is unchanged: never `Name`, no `AutomationId`. The shipped `computeTabStripSegment` accepts the measured TabView geometry unchanged (SIMULATED).

## 1. Method and safety (REAL)

- **Probe.** `C:\Users\enes1\.claude\jobs\4f08f8fb\tmp\v12\tabs\src\TabProbe.cs`: C# 5, compiled with the .NET Framework `csc.exe` and the same WPF UIA references as `scripts/build-uia-helper.mjs`; `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` is its first call.
- **What the probe never does.**
  - It never requests `Name`; a grep of the source finds no `NameProperty`, `Current.Name`, Value, Text or LegacyIAccessible access.
  - `AutomationId` is compared in process against a fixed list of template-part names; any other value is printed as `*`.
  - Printed `ClassName` and `FrameworkId` strings pass a `[A-Za-z0-9_.:#\- ]` filter.
  - Child HWNDs whose Win32 class is Chromium, WebView, Gecko or `Internet Explorer_Server` are never inspected beyond the activation-free `BoundingRectangle` and `NativeWindowHandle`.
  - Only nodes whose top lies inside a band of 44–48 DIP (120 DIP for in-client controls) are expanded. In Explorer this kept the address bar (`AutoSuggestBox` at y = 61 px) and the command bars unexpanded.
- **What the probe measures.**
  - Walk: a bounded breadth-first raw-view walk.
  - Container path, rects and patterns.
  - Refresh: 20 × `GetUpdatedCache(Element|Children, mode None, ControlType+BoundingRectangle+IsSelected)`, the shipped helper's request.
  - Re-finds: by index path and by a naive `FindFirst(Descendants)`.
  - Events: `ElementSelected` (Subtree), `StructureChanged` (Subtree) and `BoundingRectangle` property changes on the container's parent.
  - Triggers: an added tab (a second launch or the window's own add button), then `SelectionItemPattern.Select()` on another tab of the **probe's own** window.
  - Owner-process private memory, working set and CPU at A (before UIA), B (after the walk), C (after the refreshes), D (after the triggers) and E (3 s later).
- **Isolation.**
  - Every session snapshots the top-level windows of the target class, launches the app, and takes the window that appeared afterwards (checked by class and process image), or matches its own test app by PID.
  - It closes its windows and reports whether they and their processes went away.
  - All runs went through `node scripts/with-lock.mjs`, one at a time. No input was sent, and no user window was focused, moved or queried.
  - Pre-checks were counts only: windows per class, a registry value, and tab-state file counts.
- **Explorer special case.** `OpenFolderInNewTab` is absent here, and the 26200 default opens externally launched folders as a **new tab in an existing Explorer window** ([ElevenForum](https://www.elevenforum.com/t/open-desktop-folders-and-external-folder-links-in-new-tab-in-file-explorer-in-windows-11.30886/)). The user had 2 Explorer windows open, so `explorer.exe <dir>` could have added a tab to *their* window.
  - The probe instead invoked the shell verb `opennewprocess` (`HKCR\Folder\shell\opennewprocess`, `LaunchExplorerFlags 3`) on its own temp folder.
  - That created a fresh `explorer.exe /factory,{ceff45ee-c862-41de-aee2-a022c81eda92} -Embedding` host (started 19:09:06, the moment of the launch), not the shell's process (`ownerIsShell:false`).
  - The host exited by itself a few minutes after its window closed.
- **Closure (REAL).**

  | Session | Closed by | Result |
  |---|---|---|
  | WinForms ×2, WPF, System Properties | WM_CLOSE (System Properties: WM_CLOSE = Cancel) | closed in 101–111 ms, processes gone |
  | Windows Terminal ×2 | self-ending `cmd /c ping` tabs (no "close all tabs?" dialog) | `exited-by-itself`, host process gone, 0 `CASCADIA_HOSTING_WINDOW_CLASS` windows left |
  | File Explorer | **a posted WM_CLOSE was ignored by the tabbed frame (2 tabs)**; `WM_SYSCOMMAND/SC_CLOSE` closed it in 215 ms | user's window count back to 2; host 49520 exited |

## 2. Current approach: Edge and Chrome (summary of the shipped code)

- **Gate.** `Native.CheckBrowserWindow` (`native/uia-helper/Native.cs:163-177`) accepts only top-level, visible, uncloaked, non-hung `Chrome_WidgetWin_1` windows whose image is `msedge.exe` or `chrome.exe`, on every request. Main pre-filters with `TAB_STRIP_BROWSERS` (`src/main/uia/service.ts:38`, `:269-274`) and the provider with `category === 'browser'` (`src/main/surfaces/provider.ts:943`).
- **Discovery** (`TabStrips.cs:187-229`). Children-scoped `FindFirst` on `ClassName` along `BrowserRootView > NonClientView > *BrowserFrameView* > BrowserView > *TabStripRegionView* > *TabStrip > *TabContainerImpl`. A two-phase bounded BFS (depth 4, 200 nodes, top 64 DIP band) takes over where the path breaks. It reads only `BoundingRectangle`/`NativeWindowHandle` until a node is known to be browser UI, and never descends into child HWNDs, `Document`, `*WebView*`/`*WebContents*` or `Chrome_*` nodes.
- **Refresh** (`TabStrips.cs:361-460`). One cache request on the container. The response (`src/main/uia/protocol.ts:22-37`) is geometry only: frame, work, dpi, container, tabs `{x,y,w,h,selected}`, count, leftButton, newTab, grab, captions, maximized, vertical, path, ms.
- **Events** (`TabStrips.cs:534-573`). `ElementSelected` on the strip region (Subtree) and `StructureChanged` on BrowserView (Children). Coalesced per window per 250 ms.
- **Why so careful.** Any `ControlType`/`ClassName`/`Name` request on a web-content node switches on Chromium's web accessibility for good: +59/+62 MB in the browser and +30/+36 MB in the renderer, measured in `docs/research/v1.1/uia-tabs.md` §2.
- **Measured.** Refresh 0.8–1.7 ms helper-side, ~22 MB helper (`native/uia-helper/README.md`).

## 3. Classification per app

| App (version) | Top-level window known | Tab-strip region known | Individual tabs known | Walkable surface feasible | Evidence |
|---|---|---|---|---|---|
| Edge 156 / Chrome 155 | yes | yes | yes | **yes (shipped)** | REAL (v1.1) |
| File Explorer (Win11 26200) | yes: `CabinetWClass` + `explorer.exe` | yes: TabView `[1,3,1078,48]` in the title bar | yes: TabItem rects + `IsSelected` | **yes**, same model as browsers | REAL |
| Windows Terminal 1.24.12741 | yes: `CASCADIA_HOSTING_WINDOW_CLASS` + `WindowsTerminal.exe` | yes: TabView `[1,11,725,40]` | yes | **yes** | REAL |
| Notepad 11.2607.14 | expected: `Notepad.exe`, class not observed | expected: WinUI 3 TabView | expected | expected yes | UNVERIFIED (not launched; see §1) |
| Win32 `SysTabControl32` (System Properties) | yes | yes (`#32770 > SysTabControl32`) | yes, 5 items | **no**: in the client area, 48 px below the frame top | REAL |
| WinForms `TabControl` (own app) | yes | yes | yes (wrong scale if DPI-unaware, §5) | no (client area) | REAL |
| WPF `TabControl` (own app) | yes | yes | yes | no (client area) | REAL |
| Firefox (not installed) | yes: `MozillaWindowClass` (Win32 only) | **not without activating Gecko accessibility** | not without activation | window top only (shipped) | UNVERIFIED (desk) |
| VS Code 1.134 / Electron / CEF / WebView2 apps | yes: `Chrome_WidgetWin_1` + exe | **not without activating Chromium web accessibility** | not without activation | window top only (shipped) | UNVERIFIED (desk; deliberately not queried) |

## 4. Per-app findings

### File Explorer (REAL, `runs/explorer.jsonl`)

- **Path.** `Window:CabinetWClass[Win32] > Pane:Microsoft.UI.Content.DesktopChildSiteBridge{child HWND} > Pane:InputSiteWindowClass[XAML]{child HWND} > Tab:Microsoft.UI.Xaml.Controls.TabView[XAML] > List:ListView (TabListView) > TabItem:ListViewItem`. Depth 4, 6 index steps; the island is the root's 3rd child.
- **Siblings.**
  - `TITLE_BAR_SCAFFOLDING_WINDOW_CLASS`, a child HWND at `[361,0,718,43]`, is the empty drag area right of the tabs.
  - Win32 `TitleBar` caption buttons sit at x = 901–1080.
  - `ShellTabWindowClass` holds the tab content from y = 170.
  - Below the TabView inside the same island: `ApplicationBar`, address `AutoSuggestBox` and command bars (not expanded).
- **Tabs.** 1 tab `[7,11,310,40]` (frame-relative px); `AddButton` `[321,17,40,30]`. After adding: `[12,11,300,40]`, `[307,11,310,40]`. Tab tops sit 11 px below the frame top, as in browsers (feet at the frame top).
- **Patterns.** TabView `Selection`; ListView `Selection, Scroll`; items `SelectionItem`; AddButton and per-tab CloseButton `Invoke`.
- **Timing.** FromHandle 49 ms; bounded walk 89 ms for 31 nodes; **refresh median 0.31 ms (max 2.2)**; index-path re-find 5.7 ms; naive `FindFirst(Descendants)` 75 ms.
- **Memory (owner, private).** 131.7 → 131.7 → 131.7 MB across walk, refresh and re-finds (**+0.0 MB**). After the add-button tab (a Home page tab), 189.9 MB: the new tab's own cost, not UIA (Terminal control below).
- **Events.**
  - Add: tab count change seen by polling at **660 ms**. `ElementSelected` ×3, `StructureChanged ChildAdded` ×6 and `ChildRemoved` ×1 arrived only **1675 ms** after the trigger (Explorer's UI thread was busy building the tab).
  - Select: `ElementSelected` ×3 within 12–74 ms; selection seen by polling at 67 ms.
  - **No BoundingRectangle change events** although tab widths changed.

### Windows Terminal (REAL, `runs/wt.jsonl`, `runs/wt-control.jsonl`)

- **Launch.** `wt.exe -w dcprobe --pos 300,200 --size 100,24 cmd /c ping … ; new-tab …`. A named new window and its own `WindowsTerminal.exe` (no WT window was open, no persisted layouts).
- **Path.** `Window:CASCADIA_HOSTING_WINDOW_CLASS > Pane:Windows.UI.Composition.DesktopWindowContentBridge{child HWND} > Pane:Windows.UI.Input.InputSite.WindowClass[XAML]{child HWND} > Tab:Microsoft.UI.Xaml.Controls.TabView > List:ListView (TabListView) > TabItem:ListViewItem`. The package depends on `Microsoft.UI.Xaml.2.8` (WinUI 2, system XAML island), but the class names match Explorer's WinUI 3.
- **Siblings.**
  - `DRAG_BAR_WINDOW_CLASS` child HWND `[726,1,516,50]`: the drag area.
  - New-tab `SplitButton` `[647,16,79,30]`.
  - XAML caption buttons (one has AutomationId `CloseButton`), plus Win32 `TitleBar` buttons.
  - `TermControl` (Text) from y = 51, not expanded.
  - The island root pane reports a rect in DIP (`[1,1,992,497]` for a 1241×622 px area) while its children are in px. Never derive geometry from the island pane.
- **Tabs.** `[40,11,299,40]`, `[334,11,310,40]`; after adding, three tabs of 297–307 px.
- **Timing.** FromHandle 43 ms; walk 69 ms for 35 nodes; **refresh median 0.41 ms (max 2.6)**; index-path re-find 4.7 ms; descendants 7.4 ms.
- **Events.**
  - `wt -w dcprobe new-tab`: count change seen by polling at **164 ms**; `ElementSelected` at 70 and 214 ms; `StructureChanged ChildAdded` ×5 at 215 ms.
  - `Select()`: `ElementSelected` ×3 at 22–32 ms, seen by polling at 37 ms.
  - No rect events.
- **Memory.**
  - UIA phases: 96.6 → 96.9 → 97.3 MB (**+0.7 MB**). After the added tab: 120.2 MB.
  - **Control without any UIA call:** the same added tab took 96.7 → 119.6 MB (**+22.9 MB**, identical). The jump is the new terminal tab's own cost; UIA itself added ≤ 0.7 MB.

### Notepad 11 (UNVERIFIED)

- **Not launched.** `%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState` holds 23 files (`WindowState`: 2), so a session restore is pending. Launching Notepad would open the user's saved tabs, possibly unsaved notes, in the probe window, and closing it would rewrite that session.
- **Framework.** `Get-AppxPackage`: dependency `Microsoft.WindowsAppRuntime.2 2.5.1.0`, i.e. WinUI 3, as in Explorer's `Microsoft.UI.Content.DesktopChildSiteBridge` island.
- **To verify before enabling:** the top-level class (expected `Notepad`) and the island class, on a machine or profile without a saved Notepad session.

### Win32 / WinForms / WPF tab controls (REAL, `runs/sysdm.jsonl`, `runs/winforms*.jsonl`, `runs/wpf.jsonl`)

- **System Properties.**
  - `SystemPropertiesComputerName.exe`: `Window:#32770[Win32] > Tab:SysTabControl32{hwnd}`, 5 TabItems at y = 48 px, h = 21.
  - Refresh 1.43 ms; FromHandle 54 ms; walk 45 ms for 28 nodes; owner memory 2.9 → 2.9 → 2.9 MB.
  - Events on `Select()`: `ChildrenInvalidated`, `ElementSelected`, `ChildAdded` at 149 ms.
- **WinForms** (`WindowsForms10.SysTabControl32…`, FrameworkId `WinForm`). Refresh **6.6–7.7 ms**: the managed client-side proxy reads each item cross-process. Owner +3.3 MB through C (proxy and provider objects).
- **WPF `TabControl`.** Refresh 1.8 ms; `ElementSelected` only, no structure events.
- **Not walkable.** In all three the tabs sit inside the client area below the caption (y ≈ 38–48 px). They are not a visible top edge; a cat standing there would stand inside the window over its content, which the surface model does not support.

### Firefox (UNVERIFIED, desk research; not installed)

- **The tab strip is Gecko-rendered chrome.** "The Firefox UI is represented by a single local tree in the parent process" and "the accessibility tree from each content process is cached in the parent process" ([Firefox Source Docs, Architecture](https://firefox-source-docs.mozilla.org/accessible/Architecture.html)). Unlike Chromium's views, there is no separate native browser-UI layer whose properties are free to read.
- **The first UIA/MSAA contact starts the engine.**
  - `AutomationElement.FromHandle` / `AccessibleObjectFromWindow` send `WM_GETOBJECT`. Gecko answers by creating the root accessible: "Respond to WM_GETOBJECT with our IRawElementProviderSimple implementation for the root Accessible of the HWND" ([Bug 1886371 commit](https://source-hub.etos-pro.ru/mozilla/gecko-dev/commit/0ea4812cf297d6c60a61bab96365f182f89c2c3b)).
  - Historically, "until this WM_GETOBJECT message is processed, the accessibility.dll is not loaded" ([legacy accessible docs](https://source-hub.etos-pro.ru/mozilla/pjs/raw/commit/3fb1067c09cdcaa8b57b7082276e4fa5f34d3239/accessible/accessible-docs.html)).
- **Activation reaches every content process.** `ContentParent::Observe` on `a11y-init-or-shutdown` = `'1'`: "Make sure accessibility is running in content process when accessibility gets fully initiated in chrome process" → `SendActivateA11y(...)` ([dom/ipc/ContentParent.cpp](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/dom/ipc/ContentParent.cpp), source read).
- **Known user impact.** Bug reports describe slowdowns when third-party software instantiates Firefox accessibility, fixed by `accessibility.force_disabled = 1` (e.g. [Bug 1777875](https://bugzilla.mozilla.org/show_bug.cgi?id=1777875), [Bug 1726887](https://bugzilla.mozilla.org/show_bug.cgi?id=1726887)). about:support records the instantiator; a user report shows `UIAUTOMATION` there ([SUMO 1189904](https://support.mozilla.org/questions/1189904), not renderable for quoting).
- **UIA status.** Native UIA was planned on by default from Firefox 143; `accessibility.uia.enable` takes 0 / 1 / 2, where 2 = on unless an incompatible client is detected ([intent to ship](https://groups.google.com/a/mozilla.org/g/dev-platform/c/qljNUMTNtyA)). The engine underneath is the same either way.
- **Conclusion.** There is no activation-free subset. Even the gate must not call UIA on `MozillaWindowClass`. Keep Firefox on window tops. A geometric guess at the tab row (top ~40 DIP of the frame) is possible from Win32 alone, but it is unverified and not recommended.

### VS Code and other Electron / CEF / WebView2 apps (UNVERIFIED, desk research; deliberately not queried)

- **The whole client area is web content.** Same top-level class as the browsers (`Chrome_WidgetWin_1`), but no views browser-UI tree: the tabs are DOM elements in one render widget. Any query that can tell a tab from other content (`ControlType`, `ClassName`, `Name` on web nodes) takes the expensive path. In Chromium that turns on `kAXModeBasic | kExtendedProperties` (`ax_platform_node_win.cc`, cited in `docs/research/v1.1/uia-tabs.md` §1), measured in v1.1 at about +60 MB and +0.8–1.2 s CPU for a heavy page. The activation-free properties (`BoundingRectangle`, `NativeWindowHandle`, `FrameworkId`, …) cannot identify a tab.
- **Electron makes it app-visible.** `accessibility-support-changed` is "Emitted when Chromium's accessibility support changes", and `app.accessibilitySupportEnabled` reports detected assistive technology. "Rendering accessibility tree can significantly affect the performance of your app" ([Electron app API](https://www.electronjs.org/docs/latest/api/app)).
- **VS Code reacts visibly.** Its default `editor.accessibilitySupport: auto` follows Electron's detection and switches to *Screen Reader Optimized* mode, which turns off folding, minimap and word wrap. False positives are documented ([VS Code accessibility docs mirror](https://vscode-docs-arc.readthedocs.io/en/latest/editor/accessibility/)). Whether UIA property reads alone flip Electron's flag is UNVERIFIED; the risk alone rules it out.
- **Today's code already rejects them (REAL by code reading):** `Code.exe` is not in `TAB_STRIP_BROWSERS`, and the helper's image check rejects it.

## 5. Pitfalls found (REAL)

1. **Explorer opens external folders as tabs in an existing window by default.** Test harnesses must use the `opennewprocess` verb on their own folder, never `explorer.exe <dir>`, and must close with `SC_CLOSE`. A posted `WM_CLOSE` was ignored by a 2-tab window.
2. **DPI-virtualized Win32 apps report item rects in unscaled units.**
   - DPI-unaware WinForms at 125 %: frame and caption buttons in physical px (frame 1107 px wide for a 900 DIP form), but TabItems `42×18` at x = 3/45/87.
   - The same app per-monitor aware: `48×21` at x = 3/51/99.
   - Interpretation (UNVERIFIED): the client-side proxy does not scale item rects. Any future in-client use must cross-check items against the container.
3. **XAML island root panes report DIP-sized rects** (Terminal) while their descendants report px.
4. **TabView raises no BoundingRectangle change events** when tabs resize (Explorer, Terminal), the same as Chromium. Selection/structure events are duplicated (×2–3) and can arrive late (Explorer: 1.7 s after the add). Polling while relevant (the shipped 1 Hz / 3 s policy) remains necessary; events only hint.
5. **`ControlType` for Explorer's `ApplicationBar` is unknown to the managed client** (empty programmatic name, a newer UIA control type id). Matching must use `ClassName`, not only `ControlType`.
6. **Tab names are private in every TabView app:** folder paths (Explorer), shell titles that may include paths or commands (Terminal), file names (Notepad). The never-`Name` rule must carry over unchanged.

## 6. Recommended adapter design

Fits `src/main/uia/protocol.ts` and the helper's single-threaded request loop. Additive, so Edge/Chrome behaviour is unchanged.

**Gate: Win32 only, before any UIA call.** Replace `Native.CheckBrowserWindow` (`Native.cs:163`) with `CheckTabWindow(h) -> (kind | reject code)`. It applies the same visible / uncloaked / iconic / `IsHungAppWindow` checks and a fixed table:

| kind | top-level class | image (lower case) | required child HWND (`FindWindowEx`, class only) |
|---|---|---|---|
| `chromium` | `Chrome_WidgetWin_1` | `msedge.exe`, `chrome.exe` | — (as today) |
| `tabview` | `CabinetWClass` | `explorer.exe` | `Microsoft.UI.Content.DesktopChildSiteBridge` |
| `tabview` | `CASCADIA_HOSTING_WINDOW_CLASS` | `windowsterminal.exe` | `Windows.UI.Composition.DesktopWindowContentBridge` |
| `tabview` (enable after a REAL probe) | `Notepad` (to verify) | `notepad.exe` | `Microsoft.UI.Content.DesktopChildSiteBridge` (to verify) |

Everything else is `rejected` without `FromHandle`. `FromHandle` alone sends `WM_GETOBJECT`, which starts Gecko's engine and, in general, any lazily loaded accessibility layer of an unknown toolkit. **No class-only or "any XAML island" heuristic:** a WinUI app may host WebView2 content under the island.

**TabView discovery** (new `DiscoverTabView`, beside `Discover` at `TabStrips.cs:187`):

1. `FromHandle` under the activation-free cache request (`BoundingRectangle`, `NativeWindowHandle`).
2. Children `FindFirst(ClassName = island class)`, then `FindFirst(ClassName = InputSiteWindowClass | Windows.UI.Input.InputSite.WindowClass)`, then `FindFirst(ClassName = Microsoft.UI.Xaml.Controls.TabView)`, then `FindFirst(ControlType = List ∧ ClassName = ListView)`. This is the measured path: 4.7–5.7 ms re-found, 43–49 ms with the first `FromHandle`.
3. Validate: the TabView's top lies within 16 DIP of the frame top (measured 3 and 11 px), the List is horizontal and has `TabItem` children. Otherwise `not-found`: tabs not in the title bar (e.g. Terminal `showTabsInTitlebar:false`, UNVERIFIED), focus mode, or a single tab hidden.
4. Fallback BFS from the island: depth ≤ 4, 200 nodes, 56 DIP band. Read `FrameworkId` (activation-free) first and descend only into `XAML` nodes. Skip child HWNDs other than the input site; never expand `Document`/`Edit`/`Text`/`TermControl`.

**Response.** Keep `WireStripSchema` and add `kind: 'chromium' | 'tabview'` (protocol version 2; `ping` reports it).

| Field | TabView value |
|---|---|
| `container` | the ListView |
| `tabs` | the same cache request as Chromium (0.31–0.41 ms) |
| `newTab` | the `Button`/`SplitButton` child of TabView right of the List, chosen by ControlType + position, **no AutomationId** |
| `grab` | the drag child HWND's rect via `GetWindowRect` (`TITLE_BAR_SCAFFOLDING_WINDOW_CLASS`, `DRAG_BAR_WINDOW_CLASS`) or null |
| `captions` | the Win32 `TitleBar` element's rect |
| `leftButton` | null |
| `vertical` | false |
| `path` | `class` or `bfs` |

**Events** (`Subscribe`, `TabStrips.cs:534`):

- For `tabview`: `ElementSelected` and `StructureChanged`, both Subtree, on the **TabView** element. Its subtree is small and app-UI only, unlike Chromium's BrowserView.
- Keep the 250 ms coalescing; the duplicates are expected.
- No rect events exist, so the main-side polling stays.

**Main side.**

- `TAB_STRIP_BROWSERS` (`service.ts:38`) becomes `TAB_STRIP_APPS = ['msedge.exe','chrome.exe','explorer.exe','windowsterminal.exe']`.
- `isBrowserCandidate` / `candidateRejection` (`service.ts:269-274`): `unsupportedBrowser` becomes `unsupportedApp`.
- The provider's `usable` (`provider.ts:943`) drops `category === 'browser'` for this allow-list: explorer.exe is `system` and windowsterminal.exe is `terminal` in `processNames.ts`.
- `computeTabStripSegment` (`segment.ts:88`) needs no change. Fed with the REAL rects it gives:
  - Explorer, 1 tab: span 189 px (x0/x1 = 67.5/256.5 px frame-relative), rest on the active tab, feet at the frame top.
  - Terminal, 2 tabs: span 483 px, rest 698.5–877.5 px.
  - (SIMULATED, `work/seg-check.mjs`.)
- Excluded windows (process or title exclusions) keep being dropped before any request. Hung or slow windows (Explorer's UI thread was busy for over 1 s) keep the existing timeout → quarantine → helper-replacement path.

**Privacy and cost.**

- No new data leaves the helper: only rects, flags, counts, a fixed `kind` slug and decimal HWNDs. The README rule and `tests/integration/uia/probe.ts` checks apply as they are.
- Measured cost per refresh is lower than Chromium's. The owner processes showed no activation (≤ 0.7 MB, with a no-UIA control).

**Tests to add.**

- Pure: the gate table and the TabView validation (top-of-frame, horizontal, tab children).
- REAL, under the lock, own windows only: Explorer via `opennewprocess` + `SC_CLOSE`, and Terminal via a named window with self-ending tabs. Extend `scripts/uia-probe.mjs` / `tests/integration/uia/realBrowser.ts` with an owner-memory check on both. A positive control is not needed: there is no activation mode to detect, which is the finding.

## 7. Not verified (UNVERIFIED)

- Notepad 11 live structure and top-level class (reason in §4). Terminal with `showTabsInTitlebar:false`, focus mode or a single hidden tab. Explorer maximized or with many tabs (overflow scroll buttons).
- Other WinUI TabView apps (none installed and probed), Windows 10 Explorer (no tabs there), RTL layouts, scales other than 125 %, multi-monitor.
- Firefox and Electron statements are desk research; no Firefox, VS Code or other Electron window was opened or queried.
- Whether the Explorer `opennewprocess` host always exits after its window closes: once observed, after more than 30 s and under a few minutes.

## Evidence (scratch, outside the repository)

`C:\Users\enes1\.claude\jobs\4f08f8fb\tmp\v12\tabs\`:

- Sources: `src\TabProbe.cs` (probe), `src\TabApp.cs` (own WinForms/WPF windows).
- Raw JSON lines: `runs\{explorer,wt,wt-control,sysdm,winforms,winforms-pmv2,wpf}.jsonl` (rects, timings, memory, events; no names or titles).
- `work\seg-check.mjs` (segment check on the measured rects).
