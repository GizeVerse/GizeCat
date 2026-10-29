# DesktopCatUia: the tab-strip helper

A small C# 5 / .NET Framework 4.x console program. It reads the geometry of Edge and Chrome tab strips through UI Automation (`System.Windows.Automation`), so the cat can walk on them. Decisions: ADR 0002 §3. Measurements and traps: `docs/research/v1.1/uia-tabs.md`.

## Build

```
node scripts/build-uia-helper.mjs          # -> out/native/DesktopCatUia.exe (also run by scripts/build.mjs)
node scripts/build-uia-helper.mjs --strict # exit 1 when csc.exe is missing
```

- The compiler is the one that ships with Windows: `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. You don't need an SDK.
- The build references `WPF\UIAutomationClient.dll`, `UIAutomationTypes.dll` and `WindowsBase.dll`, plus `System.dll` and `System.Core.dll`.
- The flags are fixed: `/optimize+ /nologo /noconfig /target:exe /platform:anycpu /langversion:5 /debug-`.
- The build is idempotent. A stamp file next to the exe records a hash of the sources, flags and compiler, and the exe is rebuilt only when that hash changes. This legacy compiler has no `/deterministic` switch, so rebuilt bytes differ in the PE timestamp.
- After compiling, the build runs `--version` as a smoke check.
- If `csc.exe` is missing, the build logs that tab strips will be unavailable and still succeeds. At run time the app then reports `tabStrips: 'unavailable'` with a reason, and window tops keep working.
- Packaging: `electron-builder.yml` copies the exe to `resources/native/DesktopCatUia.exe` through `extraResources`, never into the asar. `resolveUiaHelperPath` in `src/main/uia/index.ts` finds it there, or at `out/native` in development.

## Protocol (version 1)

One JSON object per line on stdin and stdout, UTF-8 with `\n` endings. Numbers are written with `InvariantCulture`.

| Request | Response |
|---|---|
| `{"id":1,"op":"ping"}` | `{"id":1,"ok":true,"pong":true,"version":1,"dpi":"permonitorv2","watching":0,"prunedRender":0,"prunedOther":0}` |
| `{"id":2,"op":"strip","hwnd":"<decimal>"}` | `{"id":2,"ok":true,"strip":{frame,work,dpi,container,tabs:[{x,y,w,h,selected}],count,leftButton,newTab,grab,captions,maximized,vertical,path,ms}}` |
| `{"id":3,"op":"watch","hwnds":["<decimal>",...]}` | `{"id":3,"ok":true,"watching":N,"failed":[...]}`. The list replaces the watched set; at most 16 HWNDs. |
| `{"op":"quit"}` | No response. The helper exits. |

- **Events:** `{"event":"selected"|"structure","hwnd":"<decimal>"}`. They are coalesced to at most one line per kind and window per 250 ms.
- **Errors:** `{"id":N|null,"ok":false,"error":"<code>","detail":"<exception type>"|null}`. The codes are:
  - `bad-json`, `bad-request`, `bad-op`, `too-long` (a request line over 16 K chars), `busy`
  - `gone`, `rejected` (not a top-level Edge/Chrome frame), `hidden`, `minimized`, `not-found` (no tab strip), `unavailable`, `internal`
- **Rects:** every rect is `{x,y,w,h}` in physical px, or `null` when the element is missing or empty.
- **`frame`:** the DWM extended frame bounds.
- **`path`:** `class` when the known class path was used, `bfs` when the bounded fallback search was used.
- **Exit:** the helper exits on `quit`, when stdin closes, or 3 s after stdin closes if a provider call hangs.

## Safety rules (enforced in the source)

- `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` is the first call.
- It accepts only top-level, visible `Chrome_WidgetWin_1` windows whose process image is `msedge.exe` or `chrome.exe`, and checks this on every request.
- **It never requests `Name`.** Tab names are page titles. Other strings read from the browser are never printed: the output holds only rects, flags, counts, decimal HWNDs and fixed protocol words. `tests/integration/uia/probe.ts` checks this against real output.
- It never touches web content. Discovery follows the class path with `Children`-scoped `FindFirst` on `ClassName`.
- The fallback search starts at BrowserView and is bounded: depth 4, a 200-node budget, and only the top band of the window. Before it asks a node for anything else, it reads only the activation-free `BoundingRectangle` and `NativeWindowHandle`.
- The fallback search skips child HWNDs (render widgets, checked with `GetClassName`). It never descends into `Document`, `*WebView*`, `*WebContents*` or child `Chrome_WidgetWin_*` / `Chrome_RenderWidgetHost*` nodes.
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
| Browser private memory across the UIA reads | 54.8 → 54.7 MB | 39.2 → 39.4 MB |

The helper's CPU time covers the whole probe run, startup included.

`scripts/uia-probe.mjs` launches and closes its own throwaway browser instances, each with a temp profile, and never touches other windows. Run it under the machine lock:

```
node scripts/with-lock.mjs uia-probe -- node scripts/uia-probe.mjs --browsers edge,chrome --out report.json
```
