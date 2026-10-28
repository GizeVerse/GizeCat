# Brief: the Windows taskbar as a moving surface for the cat

**Probe machine:** Windows 11 25H2, build 26200.9711. One 1920x1200 display at 120 dpi (125%), auto-hide taskbar at the bottom. All rects are physical pixels on a per-monitor-v2 thread.

**Scratch files:** `C:\Users\enes1\.claude\jobs\4f08f8fb\tmp\v11research\taskbar\` holds `probe.cjs`, `zorder-electron.cjs`, `rude-electron.cjs`, `koffi-names.cjs` and the logs `run-2s.txt`, `run-20s.txt`, `run-300s.txt`, `zorder-run.txt`, `zorder-nonrude-run.txt`, `rude-run.txt`. No repository files were changed.

## 1. Main finding: our overlay knocks the taskbar out of always-on-top (VERIFIED, affects v1 now)

The test window used the app's exact overlay options: transparent, topmost at the `screen-saver` level, tool window, no-activate, sized to the work area. With auto-hide on, the work area is the whole monitor.

- **Without a fix:** 57–72 ms after `showInactive()`, `Shell_TrayWnd` lost `WS_EX_TOPMOST`. This happened in 3 of 3 runs. The taskbar sank about 509 windows down the z-order. `WindowFromPoint` on the bottom pixel row (the 2 px strip that reveals the taskbar) no longer hit the taskbar. `WS_EX_TOPMOST` came back as soon as the overlay was destroyed.
- **With the fix:** calling `SetPropW(overlay, "NonRudeHWND", 1)` before `showInactive()` prevented it in 2 of 2 runs. The taskbar stayed topmost, our overlay stayed above it, and `WindowFromPoint` on the bottom row returned `Shell_TrayWnd`.
- **Shrinking the overlay doesn't help:** making it 1 DIP shorter changed nothing, because Electron still created a 1920x1200 px window at 125%.
- **Background:** Windows treats a transparent topmost window that covers the whole monitor as a fullscreen ("rude") app. `NonRudeHWND` is an undocumented window property that exempts a window from this. Source: https://github.com/dechamps/RudeWindowFixer
- **Not checked:** what the user actually sees, for example whether the revealed taskbar appears behind maximized windows (UNVERIFIED).

**Fix:**
- Set the property on every overlay right before `showInactive()` (`overlayManager.ts:269`).
- Call `RemovePropW` before `win.destroy()`. The SetProp docs require properties to be removed before a window is destroyed: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setpropw
- Add a probe or E2E check that the taskbar's extended style still has `WS_EX_TOPMOST` (0x8) after the overlays are shown.

## 2. SHAppBarMessage (VERIFIED unless marked)

- **Signature:** `UINT_PTR SHAppBarMessage(DWORD, PAPPBARDATA)` (https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage).
- **`APPBARDATA` on x64:** 48 bytes. Offsets: `hWnd` 8, `uCallbackMessage` 16, `uEdge` 20, `rc` 24, `lParam` 40.
- **`ABM_GETSTATE` (4):** returns 1 (`ABS_AUTOHIDE`). `ABS_ALWAYSONTOP` has not been returned since Windows 7 (https://learn.microsoft.com/en-us/windows/win32/shell/abm-getstate).
- **`ABM_GETTASKBARPOS` (5):** returned 1 with `uEdge`=3 (bottom) and `rc` = [0,1140–1920,1200], 60 px = 48 DIP.
  - That is the **docked (shown) rect, even while the taskbar is hidden**.
  - `hWnd` is not filled in.
  - It covers the primary taskbar only (per the docs).
  - It gave physical pixels even to a DPI-unaware caller, while `GetWindowRect` in the same caller was scaled down ([0,958–1536,1006]). Coordinates only line up on a per-monitor-v2 thread. Electron's main thread is per-monitor-v2 (awareness 2, measured).
- **`ABM_GETAUTOHIDEBAR` (7):** edge 3 returns `Shell_TrayWnd`; edges 0–2 return 0.
- **`ABM_GETAUTOHIDEBAREX` (0xB):** with `uEdge`=3 and `rc` = the monitor rect, returns `Shell_TrayWnd` (https://learn.microsoft.com/en-us/windows/win32/shell/abm-getautohidebarex). Behaviour on a secondary monitor is UNVERIFIED (only one monitor).
- **Cost:** `GETTASKBARPOS` 164 µs and `GETSTATE` 39 µs. Both are cross-process calls to Explorer.
- **Registry (read-only):**
  - `StuckRects3\Settings` is 48 bytes: byte 8 = 0x03 (auto-hide), byte 12 = 3 (bottom edge), bytes 24–39 = the docked rect.
  - `MMStuckRects3` is absent.
  - `TaskbarAl` is absent, so alignment is the default centre (the Start button child sits at x=544).

## 3. The taskbar windows (VERIFIED unless marked)

- **`Shell_TrayWnd`:** style 0x96000000, extended style 0x88 (`TOPMOST|TOOLWINDOW`). It is visible, not cloaked, per-monitor aware at 120 dpi, and `GetWindowBand` reports band 1 (`ZBID_DESKTOP`).
- **Hidden state:** `GetWindowRect` and `DWMWA_EXTENDED_FRAME_BOUNDS` both give [0,1198–1920,1258]. Explorer moves the window down and leaves 2 px on screen. `IsWindowVisible` stays 1. When shown, the rect should match the ABM rect.
- **Windows 11 XAML taskbar:** `Shell_TrayWnd` still owns the geometry. Its children are:
  - `Windows.UI.Composition.DesktopWindowContentBridge` (same rect as the taskbar)
  - `Windows.UI.Input.InputSite.WindowClass` and `Windows.UI.Core.CoreWindow`
  - `Start` and `TrayNotifyWnd`
  - legacy `ReBarWindow32` / `MSTaskSwWClass` / `MSTaskListWClass` (x 544–1045)
- **Secondary taskbars:** none on this machine. `FindWindowExW(NULL, prev, "Shell_SecondaryTrayWnd", NULL)` enumerates top-level windows of a class at 0.63 µs.
- **Slide animation:** not observed. I sampled for 20 s, then passively for another 5 min (100 ms base rate, 4 ms bursts when the cursor is at the edge). The cursor never reached the edge and the rect never changed.
  - Duration and whether in-between positions are visible are UNVERIFIED.
  - INFERRED likely: Explorer hides the taskbar by moving the window itself, and users report a low-FPS slide (https://techcommunity.microsoft.com/discussions/windows11/windows-11-auto-hide-taskbar-animation-is-laggy--low-fps-very-noticeable-on-oled/4475675).
  - To measure it, re-run `node probe.cjs 30000` while the user hovers the bottom edge.
- **Top/left/right positions:** a Settings option arrived in 2026 preview builds, but "Auto-hidden and touch-optimized taskbars are not supported yet" in those positions (https://pureinfotech.com/build-26220-9022-windows-11-25h2/). Whether this machine has it is UNVERIFIED.
- **Tablet-optimized taskbar:** it has collapsed and expanded states (https://www.howtogeek.com/831450/windows-11-is-testing-a-tablet-friendly-taskbar-again/); their heights are UNVERIFIED. Derive everything from live geometry.

## 4. Events versus polling (VERIFIED)

**Cost per call:**

| Call | Cost |
|---|---|
| `GetWindowRect` | 0.58 µs in Node, 0.61 µs in Electron main |
| `DwmGetWindowAttribute` | 1.41 µs |
| `GetCursorPos` | 0.77 µs |
| `IsWindowVisible` | 0.03 µs |
| `FindWindowW` | 0.87 µs |
| `EnumWindows` + class names | 588 µs |

**Hook filtered to Explorer:** `SetWinEventHook(0x8002..0x800B, idProcess=explorer pid, OUTOFCONTEXT)` over 5 min idle produced:
- 4 `LOCATIONCHANGE` events, all on other Explorer windows;
- 0 cursor or caret events;
- **4 `EVENT_OBJECT_SHOW` events on `Shell_TrayWnd` with no geometry change.** So a SHOW event does not mean the taskbar was revealed. The cause is unknown.

**Unfiltered hook:** a system-wide `LOCATIONCHANGE` hook got 566 caret and 24 window events in the same 5 idle minutes. Cursor movement would add more.

**Notes:**
- The docs say `LOCATIONCHANGE` is sent for caret and window objects (https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants). The `idProcess` filter is documented at https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook.
- Explorer's process also hosts File Explorer windows, so the callback must still filter by window handle.
- The hook needs a message pump. Electron main has one; plain Node needs a `PeekMessageW` loop.

## 5. Z-order (VERIFIED unless marked)

- **Same band:** the taskbar and our overlay are both in band 1 (`ZBID_DESKTOP`). On Windows 10, Explorer moves the taskbar into `ZBID_IMMERSIVE_MOGO` only while Start is open (https://blog.adeltax.com/window-z-order-in-windows-10/); on Windows 11 that is UNVERIFIED. While idle, no higher band is involved, so a topmost window can cover the taskbar.
- **Electron levels:** `screen-saver` is a plain topmost window. Only `floating`, `torn-off-menu`, `modal-panel`, `main-menu` and `status` are moved behind `Shell_TrayWnd` (`MoveBehindTaskBarIfNeeded` in https://github.com/electron/electron/blob/main/shell/browser/native_window_views.cc).
- **Order at creation:** a new overlay lands above the taskbar (5 z-order steps above it with `NonRudeHWND` set).
- **Order after a reveal:** among topmost windows, whichever was raised last is on top. Whether Explorer raises the taskbar again when it slides in is UNVERIFIED.
- **No way to win a fight:** the docs only guarantee that topmost windows are above non-topmost ones. Raymond Chen says there is no "super topmost" and two programs fighting both lose (https://devblogs.microsoft.com/oldnewthing/20110310-00/?p=11253). He also notes `WS_EX_TOPMOST` "isn't good enough any more" (https://devblogs.microsoft.com/oldnewthing/20230502-00/?p=108131).
- **What this means for the cat:** put the paws at y = `tray.top − 1` so the cat never overlaps the taskbar; then it looks right whichever window is on top. Never re-assert our z-order. A click-through overlay does not block the 2 px reveal strip, but only once `NonRudeHWND` is set.

## 6. Pitfalls

1. The fullscreen/always-on-top problem in section 1.
2. **koffi 3.3.4 type-name clash (VERIFIED):**
   - **Order that breaks:** declare `RECT`, `POINT`, `APPBARDATA` (which has a `void *` member), `MONITORINFO`, then anonymous `koffi.proto(null, …)`.
   - **What happens:** `MONITORINFO` and `WNDENUMPROC` both get the name `<anonymous_49>`. `koffi.pointer(MONITORINFO)` then resolves to a callback type and throws "Unexpected <anonymous_49> * type, expected pointer or string type".
   - **Current code:** the order in `native.ts` today is safe (checked).
   - **Fix:** declare `APPBARDATA` after the protos or give it a unique name, and add a unit test that `koffi.type(koffi.pointer(T)).primitive === 'Pointer'`.
3. `ABM_GETTASKBARPOS` returns the docked rect even while hidden. Use `GetWindowRect` for the live surface.
4. SHOW events on the taskbar fire without any movement.
5. `SHAppBarMessage` costs 164 µs per call and goes to Explorer; INFERRED: it can stall if Explorer hangs. Never call it per tick.
6. An Explorer restart creates new window handles and a new process id. Rediscover the taskbars when the registered `TaskbarCreated` message arrives (`win.hookWindowMessage`, https://www.electronjs.org/docs/latest/api/browser-window#winhookwindowmessagemessage-callback-windows) and when `IsWindow` fails.
7. The existing `setWinEventHook` binding hard-codes `idProcess` to 0. Add a pid parameter.

## 7. Recommended design

A `TaskbarTracker` in `src/main/win32`, working in physical pixels on Electron's main thread.

**Discovery:**
- When: at startup, on `display-metrics-changed`, on `TaskbarCreated`, when `IsWindow` fails, and on a 10 s reconcile.
- How: `FindWindowW("Shell_TrayWnd")` plus a `FindWindowExW` loop for `Shell_SecondaryTrayWnd`, and `MonitorFromWindow` for each taskbar's monitor.
- Edge: work it out from which monitor side the rect touches; use ABM `uEdge` only as a cross-check on the primary.
- Thickness: from the ABM rect on the primary, otherwise the largest on-screen thickness seen.
- Auto-hide: on when `rcWork == rcMonitor` along that edge, or when `ABM_GETSTATE & 1`.

**State per taskbar:**
- `onScreen` = how far the rect overlaps the monitor along the edge axis.
- Phases: hidden at ≤2 px, shown at full thickness, moving in between.
- `vy` from the last two samples.

**Polling rates:**
- **Idle:** 4 Hz (250 ms).
- **Burst:** 60 Hz (16 ms) while any of these is true:
  - the rect changed in the last 300 ms;
  - the cursor is within 6 px of an auto-hide edge (reuse the existing cursor poll);
  - the cat is on the taskbar or within about 100 DIP above it.
- **Leaving burst:** after 300 ms with no change.
- **Cost:** under 0.1 ms per second in total.

**Optional wake-up hook:** `LOCATIONCHANGE` filtered to Explorer's pid. The callback accepts only `idObject==0 && hwnd ∈ trays` and starts a burst. This matters when the sim is asleep at 5 Hz.

**Surfaces:**
- **Bottom taskbar:** a moving platform at y = `rect.top`, clipped to the monitor's x range. It only exists while `onScreen ≥ 50%` of the thickness, so the cat never jumps onto the 2 px strip. The cat rides `vy` down as the taskbar hides and falls to the floor once it drops below 50%. If the rect jumps with no in-between samples, ease the platform over about 150 ms.
- **Top taskbar:** acts as a ceiling.
- **Left/right taskbar:** a vertical edge the cat can climb.

**Overlays:** set `NonRudeHWND` on every overlay at creation.

## 8. koffi declarations (ready to adapt)

```ts
// Declare after the existing koffi.proto calls in native.ts (pitfall 2), or give it a unique name.
const APPBARDATA = koffi.struct({ cbSize: 'uint32_t', hWnd: 'void *', uCallbackMessage: 'uint32_t',
  uEdge: 'uint32_t', rc: RECT, lParam: 'intptr_t' });               // sizeof == 48 (verified)
const SHAppBarMessage = shell32.func('__stdcall', 'SHAppBarMessage', 'uintptr_t',
  ['uint32_t', koffi.inout(koffi.pointer(APPBARDATA))]);          // HWND results: BigInt(ret)
const FindWindowW = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)');
const SetPropW = user32.func('int __stdcall SetPropW(void *h, const char16_t *name, intptr_t data)');
const RemovePropW = user32.func('intptr_t __stdcall RemovePropW(void *h, const char16_t *name)');
const RegisterWindowMessageW = user32.func('uint32_t __stdcall RegisterWindowMessageW(const char16_t *name)');
const GetWindowBand = user32.func('int __stdcall GetWindowBand(void *h, _Out_ uint32_t *band)'); // undocumented, diagnostics only
// Existing SetWinEventHook binding: pass idProcess through instead of 0
SetWinEventHook(0x800b, 0x800b, null, procPtr, explorerPid, 0, 0 /* WINEVENT_OUTOFCONTEXT */);

const ABM_GETSTATE = 4, ABM_GETTASKBARPOS = 5, ABM_GETAUTOHIDEBAR = 7, ABM_GETAUTOHIDEBAREX = 0x0b;
const ABS_AUTOHIDE = 1, ABE_LEFT = 0, ABE_TOP = 1, ABE_RIGHT = 2, ABE_BOTTOM = 3;
const abd = { cbSize: koffi.sizeof(APPBARDATA), hWnd: null, uCallbackMessage: 0, uEdge: 0,
  rc: { left: 0, top: 0, right: 0, bottom: 0 }, lParam: 0 };
SHAppBarMessage(ABM_GETTASKBARPOS, abd);                          // abd.rc = docked rect, abd.uEdge
// Per monitor: abd.uEdge = edge; abd.rc = rcMonitor; BigInt(SHAppBarMessage(ABM_GETAUTOHIDEBAREX, abd))
SetPropW(overlayHwnd, 'NonRudeHWND', 1);                          // before win.showInactive()
RemovePropW(overlayHwnd, 'NonRudeHWND');                          // right before win.destroy()
```
