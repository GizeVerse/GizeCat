# Brief: Win32 integration from the Electron main process with koffi 3.x

Labels: **[V]** means I read it in current docs or source. **[I]** means inference. **[U]** means unverified and needs a smoke test. Nothing was run.

## 0. Stack check
- **[V]** Electron 44.9.x is already out of date. v44.10.0 and v45.1.0 were both released on 2026-10-27, and v46 is in alpha (`gh api repos/electron/electron/releases`). Pin 44.10.x, or move to 45.x.
- **[V]** koffi's latest is **3.3.4 (2026-10-24)** ([changelog](https://koffi.dev/changelog)). Use at least 3.1.6, which fixed a crash when `koffi.register()` runs before any `koffi.load()`. Pin the exact version.

## 1. koffi 3.x API
**[V]** Breaking changes from 2.x to 3.x ([migration](https://koffi.dev/migration), [index.d.ts](https://github.com/Koromix/rygel/blob/master/src/koffi/index.d.ts)):
- **Pointers are BigInt.** A non-null pointer comes back as a `bigint` and NULL comes back as `null` (`WrapPointer` in `src/util.hh`). Pointers no longer carry a C type, so passing a pointer of the wrong type is accepted and will probably crash. Compare HWNDs with `===`.
- **Type objects:** `koffi.struct()` and friends return type objects. `koffi.type()` replaces `resolve()`/`introspect()`, which are deprecated.
- **Removed:** `koffi.callback()` (use `koffi.proto()`) and `koffi.handle()` (use `koffi.opaque()`). Use `register(fn.bind(obj), type)` instead of `register(obj, fn, type)`.
- **Signatures:**
  - `lib.func('RET __stdcall Name(T a, _Out_ S *b)')`, or the classic form `lib.func('__stdcall', 'Name', ret, [args])`.
  - `koffi.register(fn, koffi.pointer(Proto)): bigint` and `koffi.unregister(bigint)`. At most 8192 registered callbacks can exist at once.
  - `koffi.decode(ptr, Type)`, `koffi.decode.string16(ptr)`, `koffi.out()`/`koffi.inout()` or `_Out_`/`_Inout_`, `koffi.alias()`.
- **`__stdcall` is ignored on x64** ([load](https://koffi.dev/load)). It does no harm to keep it.
- **koffi `bool` is 1 byte** ([primitives](https://koffi.dev/primitives)). Win32 `BOOL` is a 4-byte int, so alias `BOOL` to `int`. `intptr_t` comes back as a Number.
- **`koffi.view()` is disallowed under Electron** ([pointers](https://koffi.dev/pointers)). Read data with `decode` or copy it into a Buffer instead.
- **Buffers and typed arrays can be passed for any pointer argument** [V]. Use that for UTF-16 output buffers and decode with `buf.toString('utf16le', 0, n * 2)`. `str16`/`wchar_t*` are fine for input strings.
- **No `GetLastError` accessor for sync calls.** The typings only expose `errno`. Calling `GetLastError` through FFI after a failure may return a clobbered value [U]. Rely on return values.

**Callback threading [V]** ([callbacks](https://koffi.dev/callbacks), `RelayCallback` in [call.cc](https://github.com/Koromix/rygel/blob/master/src/koffi/src/call.cc)):
- If the callback fires on the JS main thread outside any koffi call, koffi opens a handle scope and calls JS synchronously with `napi_call_function`, not `napi_make_callback`.
- If it fires on another thread, koffi queues it to the event loop with a threadsafe function and blocks that thread until it has run.
- If the JS callback throws, C receives 0 or NULL.

**Packaging [V]:**
- The `koffi` package has no native code. On Windows x64 its static loader `require`s `@koromix/koffi-win32-x64`, and that package's `index.js` does `require('./win32_x64/koffi.node')` (about 1.05 MB, plus a `koffi.lib`).
- The fallback loader also looks under `process.resourcesPath/{koffi, koffi/build, node_modules/koffi/build}/<triplet>/koffi.node`.
- electron-builder's default `smartUnpack` automatically unpacks any module directory that contains a `.node` file ([unpackDetector.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/asar/unpackDetector.ts)).
- Electron can load a `.node` file from inside an asar by extracting it to a temp file, which costs time and can trigger antivirus ([asar docs](https://github.com/electron/electron/blob/main/docs/tutorial/asar-archives.md)). So unpack explicitly.

```js
// esbuild: keep koffi out of the bundle (its loader requires ~20 optional platform packages)
{ bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'] }
```
```yaml
# electron-builder (koffi must be in "dependencies")
asarUnpack: ["node_modules/@koromix/koffi-*/**"]
npmRebuild: false   # [I] Node-API (napi ≥ 8), ABI-stable; no rebuild needed
```
Pitfalls:
- Never install with `--omit=optional`, or the platform package and its binary are dropped.
- npm only installs the package for the host's architecture, so an arm64 build made on an x64 machine needs `@koromix/koffi-win32-arm64` added explicitly.

## 2. Constants (from MS docs and Wine headers) [V]
- **Hook flags:** `WINEVENT_OUTOFCONTEXT=0`, `SKIPOWNTHREAD=1`, `SKIPOWNPROCESS=2`.
- **Event and object IDs:** `OBJID_WINDOW=0`, `CHILDID_SELF=0`, `OBJID_CURSOR=-9`, `OBJID_CARET=-8`.
- **Window lookup:** `GWL_STYLE=-16`, `GWL_EXSTYLE=-20`, `GA_ROOT=2`, `GA_ROOTOWNER=3`, `GW_OWNER=4`.
- **Extended styles:** `WS_EX_TOPMOST=0x8`, `WS_EX_TRANSPARENT=0x20`, `WS_EX_TOOLWINDOW=0x80`, `WS_EX_WINDOWEDGE=0x100`, `WS_EX_APPWINDOW=0x40000`, `WS_EX_LAYERED=0x80000`, `WS_EX_NOACTIVATE=0x08000000`.
- **Styles:** `WS_THICKFRAME=0x40000`, `WS_DLGFRAME=0x400000`.
- **DWM attributes:** `DWMWA_EXTENDED_FRAME_BOUNDS=9`, `DWMWA_CLOAKED=14` (returns a DWORD: 1 = app, 2 = shell, 4 = inherited).
- **Monitors and processes:** `MONITOR_DEFAULTTONEAREST=2`, `MONITORINFOF_PRIMARY=1`, `PROCESS_QUERY_LIMITED_INFORMATION=0x1000`. This right is allowed even on protected processes.
- **QUNS values:** `NOT_PRESENT=1`, `BUSY=2`, `RUNNING_D3D_FULL_SCREEN=3`, `PRESENTATION_MODE=4`, `ACCEPTS_NOTIFICATIONS=5`, `QUIET_TIME=6`, `APP=7` ([enum](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)). Windows sends no notification when a full-screen app starts or stops, so poll.
- **Events:** `FOREGROUND 0x3`, `MOVESIZESTART/END 0xA/0xB`, `MINIMIZESTART/END 0x16/0x17`, `OBJECT_CREATE/DESTROY/SHOW/HIDE 0x8000–0x8003`, `LOCATIONCHANGE 0x800B`, `NAMECHANGE 0x800C`, `CLOAKED/UNCLOAKED 0x8017/0x8018` ([event constants](https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants)). For `FOREGROUND`, `idObject` is `OBJID_WINDOW` and `idChild` is `CHILDID_SELF`.

## 3. Message pump and callback delivery
- **[V] Microsoft's rule** ([SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)): "The client thread that calls SetWinEventHook must have a message loop." Out-of-context events are delivered on the thread that installed the hook, in sequential order. The hook function can be re-entered while it is still handling an event.
- **[V] The main process has a pump.** Chromium's UI thread runs `MessagePumpForUI`, "a 'traditional' Windows message pump" built on `MsgWaitForMultipleObjectsEx(QS_ALLINPUT)` and `PeekMessage` ([message_pump_win.h](https://github.com/chromium/chromium/blob/main/base/message_loop/message_pump_win.h)).
  - **[I, strong]** Hooks installed from main-process JS therefore fire with no extra pump. Several Electron apps do exactly this with koffi 3 and no pump: [omi nativeForeground.ts](https://github.com/BasedHardware/omi/blob/main/desktop/windows/src/main/usage/nativeForeground.ts) and [MintBot winEventHook.ts](https://github.com/Momordicin/MintBot/blob/main/electron/main/winEventHook.ts).
  - Plain Node needs a pump ([SO 53772437](https://stackoverflow.com/questions/53772437)).
- **[V] Microtasks are deferred.** Electron's browser and utility processes use the `kExplicit` microtask policy ([node_util.cc](https://github.com/electron/electron/blob/main/shell/common/node_util.cc)), and koffi calls JS without a callback scope.
  - **[I]** Promises or `nextTick` work queued inside the callback may not run until a later tick.
  - Keep the callback synchronous: filter, push to a queue, return. Drain the queue from an interval that you started elsewhere.
- **utilityProcess has no Win32 pump.**
  - **[V]** Chromium's utility main thread uses `MessagePumpType::DEFAULT` unless the `--message-loop-type-ui` switch is passed ([utility_main.cc](https://github.com/chromium/chromium/blob/main/content/utility/utility_main.cc)), and Electron's NodeService launch doesn't pass it.
  - **[I]** You would need to drain messages yourself with `setInterval(() => { while (PeekMessageW(msg, null, 0, 0, 1 /*PM_REMOVE*/)); }, 15)`. Callbacks then run inside the koffi call.
  - A `worker_threads` worker with a blocking `GetMessageW` loop also works ([example](https://gitfront.io/r/Elendiar/21SQq6UV13ja/production-taskbar-client/blob/src/main/workers/winEventHook.js)). Stop it by posting WM_QUIT (0x12) with `PostThreadMessageW` to the worker's thread ID; `terminate()` cannot interrupt a native call **[I]**.
- **Flood control [I]:**
  - Don't subscribe to `LOCATIONCHANGE` system-wide. Caret and cursor objects generate it too, with a NULL hwnd for the cursor.
  - Hook it only for the foreground window's process (`idProcess = pid`) and re-target on every `FOREGROUND` event. Or poll the tracked window at 30 Hz between `MOVESIZESTART` and `MOVESIZEEND`.
  - Use separate narrow ranges (one hook per range), because the span 0x3–0x17 also includes the capture, menu and scrolling events.
  - Filter `idObject===0 && idChild===0 && GetAncestor(h, GA_ROOT)===h`. For `DESTROY`, look the hwnd up in your cache, since the window can no longer be queried.
  - Use `UnhookWinEvent` from the same thread that installed the hook, then call `unregister`.

## 4. Filtering real windows and detecting fullscreen
- **Alt-Tab rule [V]** ([Raymond Chen](https://devblogs.microsoft.com/oldnewthing/20071008-00/?p=24863)):
  - A window with `WS_EX_TOOLWINDOW` is excluded.
  - A window that isn't visible is excluded unless it has `WS_EX_APPWINDOW`, which also makes the owner chain ignored.
  - Otherwise walk from the `GA_ROOTOWNER` through `GetLastActivePopup` until you reach a visible popup. The window is listed only if the walk ends on it.
- **Extra checks:**
  - Skip cloaked windows (`DWMWA_CLOAKED != 0`). Electron's manifest sets `disableWindowFiltering` ([V], [manifest](https://github.com/electron/electron/blob/main/shell/browser/resources/win/disable_window_filtering.manifest)), so `EnumWindows` also returns immersive and UWP windows.
  - Require a non-empty extended-frame rect.
  - Skip `WS_EX_NOACTIVATE` windows that lack `WS_EXAPPWINDOW` [I, heuristic].
  - Skip your own PID.
- **Chromium's fullscreen heuristic [V]** ([fullscreen_win.cc](https://github.com/chromium/chromium/blob/main/ui/base/fullscreen_win.cc)): QUNS is `D3D_FULL_SCREEN` or `PRESENTATION_MODE`, or all of the following hold for the foreground window:
  - Its `GetWindowRect` clipped to `rcMonitor` equals `rcMonitor`.
  - Its style has no `WS_DLGFRAME`/`WS_THICKFRAME`.
  - Its extended style has no `WS_EX_WINDOWEDGE`/`WS_EX_TOOLWINDOW`.

  This style check is what rules out maximized windows, whose `GetWindowRect` spills past the monitor. Generalize it from the primary monitor to `MonitorFromWindow`, and exclude the shell classes `Progman`, `WorkerW` and `Shell_TrayWnd`.

## 5. Coordinates
- **[V]** Electron's exe manifest says `<dpiAware>true/pm</dpiAware>`, which means per-monitor v1 ([dpi_aware.manifest](https://github.com/electron/electron/blob/main/shell/browser/resources/win/dpi_aware.manifest)).
- **[V]** Chromium then calls `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` ([win_util.cc](https://github.com/chromium/chromium/blob/main/base/win/win_util.cc)). That API fails with ACCESS_DENIED if a manifest already set the awareness ([doc](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)).
- **[U]** So the process may be PMv1 rather than v2. **It doesn't matter here:** both v1 and v2 see displays in physical pixels ([MS high-DPI doc](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)).
- **[V]** `GetWindowRect` is "virtualized for DPI", so it returns physical pixels in a per-monitor-aware thread. It may include invisible resize borders. `DWMWA_EXTENDED_FRAME_BOUNDS` is the visible frame and is "not adjusted for DPI" ([GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect)).
- **[I]** `GetCursorPos` likewise returns physical pixels.
- Convert with `screen.screenToDipRect(null, rect)` and `screen.dipToScreenPoint` (Windows only, [V]).

## 6. WindowFromPoint and click-through windows
- **[V]** Electron's `setIgnoreMouseEvents(true)` adds `WS_EX_TRANSPARENT|WS_EX_LAYERED` to the window ([native_window_views.cc](https://github.com/electron/electron/blob/main/shell/browser/native_window_views.cc)).
- **[V]** Microsoft documents that a layered window with `WS_EX_TRANSPARENT` passes mouse events to the windows underneath ([window features](https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features)).
- **[V]** The `WindowFromPoint` doc itself only says it skips hidden and disabled windows. Wine's reimplementation of the window manager skips `LAYERED|TRANSPARENT` windows in its point lookup ([server/window.c](https://github.com/wine-mirror/wine/blob/master/server/window.c)).
- **[I, likely]** So `WindowFromPoint` should skip the overlay while it is click-through. It will not skip it while the cat is interactive. Always drop a result whose root window belongs to your own PID.

## Module sketch (koffi 3.3.x, Windows x64)
```ts
import koffi from 'koffi';
const u32 = koffi.load('user32.dll'), k32 = koffi.load('kernel32.dll');
const dwm = koffi.load('dwmapi.dll'), sh32 = koffi.load('shell32.dll');
for (const [n, t] of [['BOOL','int'],['DWORD','uint32_t'],['UINT','uint32_t'],['LONG','int32_t'],
  ['HWND','void *'],['HANDLE','void *'],['HMONITOR','void *'],['HWINEVENTHOOK','void *']] as const) koffi.alias(n, t);
export const RECT = koffi.struct('RECT', { left: 'LONG', top: 'LONG', right: 'LONG', bottom: 'LONG' });
export const POINT = koffi.struct('POINT', { x: 'LONG', y: 'LONG' });
export const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'DWORD', rcMonitor: RECT, rcWork: RECT, dwFlags: 'DWORD' });
export const LASTINPUTINFO = koffi.struct('LASTINPUTINFO', { cbSize: 'UINT', dwTime: 'DWORD' });
export const WINEVENTPROC = koffi.proto('void __stdcall WINEVENTPROC(HWINEVENTHOOK h, DWORD ev, HWND hwnd, LONG idObject, LONG idChild, DWORD tid, DWORD ms)');
export const WNDENUMPROC = koffi.proto('BOOL __stdcall WNDENUMPROC(HWND h, intptr_t lp)');
export const MONITORENUMPROC = koffi.proto('BOOL __stdcall MONITORENUMPROC(HMONITOR m, void *hdc, RECT *rc, intptr_t lp)'); // rc arrives as bigint → koffi.decode(rc, RECT)

const f = (lib: koffi.LibraryHandle, s: string) => lib.func(s);
export const W = {
  SetWinEventHook: f(u32, 'HWINEVENTHOOK __stdcall SetWinEventHook(DWORD min, DWORD max, void *hmod, WINEVENTPROC *fn, DWORD pid, DWORD tid, DWORD flags)'),
  UnhookWinEvent: f(u32, 'BOOL __stdcall UnhookWinEvent(HWINEVENTHOOK h)'),
  GetForegroundWindow: f(u32, 'HWND __stdcall GetForegroundWindow()'),
  GetWindowRect: f(u32, 'BOOL __stdcall GetWindowRect(HWND h, _Out_ RECT *r)'),
  DwmGetRect: dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['HWND', 'DWORD', koffi.out(koffi.pointer(RECT)), 'DWORD']),
  DwmGetU32: dwm.func('__stdcall', 'DwmGetWindowAttribute', 'int32_t', ['HWND', 'DWORD', koffi.out(koffi.pointer('uint32_t')), 'DWORD']),
  IsWindowVisible: f(u32, 'BOOL __stdcall IsWindowVisible(HWND h)'),
  IsIconic: f(u32, 'BOOL __stdcall IsIconic(HWND h)'),
  IsZoomed: f(u32, 'BOOL __stdcall IsZoomed(HWND h)'),
  GetWindowLongPtrW: f(u32, 'intptr_t __stdcall GetWindowLongPtrW(HWND h, int idx)'),
  GetAncestor: f(u32, 'HWND __stdcall GetAncestor(HWND h, UINT flags)'),
  GetWindow: f(u32, 'HWND __stdcall GetWindow(HWND h, UINT cmd)'),
  GetLastActivePopup: f(u32, 'HWND __stdcall GetLastActivePopup(HWND h)'),
  GetWindowThreadProcessId: f(u32, 'DWORD __stdcall GetWindowThreadProcessId(HWND h, _Out_ DWORD *pid)'),
  OpenProcess: f(k32, 'HANDLE __stdcall OpenProcess(DWORD access, BOOL inherit, DWORD pid)'),
  QueryFullProcessImageNameW: f(k32, 'BOOL __stdcall QueryFullProcessImageNameW(HANDLE h, DWORD flags, void *buf, _Inout_ DWORD *size)'),
  CloseHandle: f(k32, 'BOOL __stdcall CloseHandle(HANDLE h)'),
  GetWindowTextLengthW: f(u32, 'int __stdcall GetWindowTextLengthW(HWND h)'),
  GetWindowTextW: f(u32, 'int __stdcall GetWindowTextW(HWND h, void *buf, int max)'),
  GetClassNameW: f(u32, 'int __stdcall GetClassNameW(HWND h, void *buf, int max)'),
  EnumWindows: f(u32, 'BOOL __stdcall EnumWindows(WNDENUMPROC *cb, intptr_t lp)'), // pass a plain JS fn (transient)
  MonitorFromWindow: f(u32, 'HMONITOR __stdcall MonitorFromWindow(HWND h, DWORD flags)'),
  MonitorFromPoint: f(u32, 'HMONITOR __stdcall MonitorFromPoint(POINT pt, DWORD flags)'),
  GetMonitorInfoW: f(u32, 'BOOL __stdcall GetMonitorInfoW(HMONITOR m, _Inout_ MONITORINFO *mi)'),
  EnumDisplayMonitors: f(u32, 'BOOL __stdcall EnumDisplayMonitors(void *hdc, RECT *clip, MONITORENUMPROC *cb, intptr_t lp)'),
  SHQueryUserNotificationState: f(sh32, 'int32_t __stdcall SHQueryUserNotificationState(_Out_ int32_t *state)'),
  GetLastInputInfo: f(u32, 'BOOL __stdcall GetLastInputInfo(_Inout_ LASTINPUTINFO *p)'),
  GetTickCount: f(k32, 'DWORD __stdcall GetTickCount()'),
  GetCursorPos: f(u32, 'BOOL __stdcall GetCursorPos(_Out_ POINT *p)'),
  WindowFromPoint: f(u32, 'HWND __stdcall WindowFromPoint(POINT pt)'),
};
export const hwndOf = (bw: Electron.BrowserWindow) => bw.getNativeWindowHandle().readBigUInt64LE(0);
const w16 = (fn: (b: Buffer) => number, cap: number) => { const b = Buffer.alloc(cap * 2); return b.toString('utf16le', 0, fn(b) * 2); };
export const title = (h: bigint) => w16(b => W.GetWindowTextW(h, b, b.length / 2), W.GetWindowTextLengthW(h) + 1);
export const className = (h: bigint) => w16(b => W.GetClassNameW(h, b, 256), 256);
export function exePath(h: bigint): string | null {
  const pid = [0]; W.GetWindowThreadProcessId(h, pid);
  const ph = W.OpenProcess(0x1000, 0, pid[0]); if (!ph) return null;
  try { const b = Buffer.alloc(32768 * 2), n = [32768]; return W.QueryFullProcessImageNameW(ph, 0, b, n) ? b.toString('utf16le', 0, n[0] * 2) : null; }
  finally { W.CloseHandle(ph); }
}
export const idleMs = () => { const l = { cbSize: 8, dwTime: 0 }; W.GetLastInputInfo(l); return (W.GetTickCount() - l.dwTime) >>> 0; }; // >>>0 handles 49.7-day wrap
export function isAltTabWindow(h: bigint, ownPid: number): boolean {
  const ex = Number(W.GetWindowLongPtrW(h, -20));
  if (ex & 0x80) return false;                                        // TOOLWINDOW
  if (!W.IsWindowVisible(h) && !(ex & 0x40000)) return false;
  if ((ex & 0x08000000) && !(ex & 0x40000)) return false;             // NOACTIVATE heuristic [I]
  if (!(ex & 0x40000)) { let walk = W.GetAncestor(h, 3);
    for (;;) { const p = W.GetLastActivePopup(walk); if (p === walk || W.IsWindowVisible(p)) break; walk = p; }
    if (walk !== h) return false; }
  const c = [0]; if (W.DwmGetU32(h, 14, c, 4) === 0 && c[0]) return false;          // cloaked
  const pid = [0]; W.GetWindowThreadProcessId(h, pid); if (pid[0] === ownPid) return false;
  const r: any = {}; if (W.DwmGetRect(h, 9, r, 16) !== 0) W.GetWindowRect(h, r);
  return r.right > r.left && r.bottom > r.top;
}
export function startWinEvents(onEvent: (ev: number, h: bigint) => void) {   // main process only
  const cb = koffi.register((_k: bigint, ev: number, h: bigint | null, obj: number, child: number) => {
    try { if (h !== null && obj === 0 && child === 0) onEvent(ev, h); } catch { /* never throw into native */ }
  }, koffi.pointer(WINEVENTPROC));                                     // onEvent must only enqueue
  const hooks = [[0x3, 0x3], [0xA, 0xB], [0x16, 0x17], [0x8000, 0x8003], [0x8017, 0x8018]]
    .map(([a, b]) => W.SetWinEventHook(a, b, null, cb, 0, 0, 0 | 2)).filter(Boolean);
  return () => { hooks.forEach(x => W.UnhookWinEvent(x)); koffi.unregister(cb); };
}
```

## Risks and recommendations
1. **Smoke-test hook delivery in the packaged app first [U].** Confirm a `FOREGROUND` event arrives within about 100 ms of an Alt-Tab, in both dev and the NSIS build. Keep a 1–2 Hz `GetForegroundWindow` poll as a fallback, as omi does.
2. **Keep the hook callback tiny.** Filter, enqueue and return; drain from your own interval. Callbacks can re-enter, and promises created inside them may be deferred (`kExplicit`).
3. **Don't hook `LOCATIONCHANGE` globally.** Scope it to the foreground process ID, or poll during move/size.
4. **Use a 4-byte `BOOL` (`int`) everywhere**, never koffi's 1-byte `bool`.
5. **Ship the koffi native package correctly:** keep `koffi` external in esbuild, unpack `@koromix/koffi-*` from the asar, never omit optional dependencies, and add the matching `@koromix` package for cross-arch builds.
6. **Handle the overlay's own windows:**
   - Exclude your own PID from every query; `WINEVENT_SKIPOWNPROCESS` only covers hooks.
   - **[I]** A topmost overlay covering the whole monitor may itself trip the shell's full-screen detection (QUNS_BUSY or Focus Assist). Size the overlay to `workArea`, test it, and treat QUNS_BUSY only as a soft signal.
7. **Check the DPI mode at startup and log it:** call `GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())`. A value of 2 means per-monitor aware.
8. **Prefer Electron's built-in APIs where they exist:** `powerMonitor.getSystemIdleTime()` (in seconds), `screen.getCursorScreenPoint()` (in DIPs) and `screen.screenToDipRect()`. Keep FFI for things Electron doesn't cover: window enumeration, cloaking, process path and QUNS.
9. **Call `GetWindowText` only on other processes' windows.** On a window owned by your own process it sends `WM_GETTEXT` and can hang if that window is unresponsive ([V], [doc](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowtextw)).
