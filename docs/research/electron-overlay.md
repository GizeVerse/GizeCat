# Electron overlay engineering on Windows 11: technical brief

Labels: **[V]** means I read it in the current docs or source on 2026-10-28. **[I]** means inference that hasn't been tested on a real machine. Nothing was run or installed.

## 0. Versions: the stack plan is out of date
- **[V]** The current stable release is **45.1.0** (2026-10-27). The latest 44 is **44.10.0**, so pinning "44.9.x" is already behind. Electron supports only the latest three majors.
  - 44: Chromium M152, end of life about 2027-03-02.
  - 45: M156, end of life about 2027-04-27.
  - Source: `gh api repos/electron/electron/releases`, https://releases.electronjs.org/schedule
- **[V]** Breaking changes that affect us:
  - 44 dropped Windows ia32 builds and removed `openAsHidden` from login items.
  - 45 removed `Buffer`, `setImmediate` and the `events`/`timers`/`url` shims from sandboxed preloads.
  - 45 reports screen capture to the permission handler as `display-capture`.
  - Source: https://www.electronjs.org/docs/latest/breaking-changes
- **[V]** electron-builder is at **26.18.1** and has a native `electronFuses` config block (`packages/app-builder-lib/scheme.json`).
- **Recommendation:** use Electron 45.1.x. If you stay on 44, use 44.10.x.

## 1. Transparent frameless window: how it renders
- **[V]** Translucent windows don't use `WS_EX_LAYERED` on the GPU path.
  - Chromium uses DirectComposition with a premultiplied-alpha swapchain plus `DwmExtendFrameIntoClientArea(-1)`. The style is `WS_POPUP` with no `WS_THICKFRAME`/`WS_CAPTION`, and `WS_EX_NOREDIRECTIONBITMAP` is set when the feature is on.
  - "Software composited windows can continue to use WS_EX_LAYERED."
  - Chromium's own comment: "WS_EX_LAYERED automatically makes clicks on transparent pixels fall through, but that isn't the case when using Direct3D." So transparent pixels **do not** pass clicks through. Click-through needs `setIgnoreMouseEvents` (issue #1335 is still open).
  - Source: chromium `ui/views/widget/widget_hwnd_utils.cc`, `ui/views/win/hwnd_message_handler.cc`
- **[V]** Electron overrides several options when `transparent: true`:
  - It forces `thickFrame = false`, which also turns off rounded corners. The `thickFrame` option has no effect.
  - It sets shadow type to none.
  - `type: 'toolbar'` adds `WS_EX_TOOLWINDOW`.
  - `focusable: false` adds `WS_EX_NOACTIVATE` and implies `skipTaskbar`.
  - Source: `shell/browser/native_window_views.cc`, https://www.electronjs.org/docs/latest/api/structures/base-window-options
- **[V]** Documented limits: transparency on Windows needs `frame: false`, `resizable: true` can break transparency, and the window isn't transparent while DevTools is open. `backgroundColor` defaults to `#FFF`, and `#00000000` only works when `transparent: true`. Source: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
- **[V] Known bugs:**
  - #40515 (open, updated 2026-10-27): some machines show a black or grey background with hardware acceleration on. `disableHardwareAcceleration` fixes it for some users.
  - #27286: a transparent window exactly the size of the display turns opaque. The workaround is to make it 1px smaller. Sizing to `workArea` avoids this.
  - #41063 (open): a frameless transparent window shrinks after `minimize()`/`hide()`.
  - #51679: the window grows by 16×8 DIP since 41.3/42. It only hits `thickFrame: true`, so transparent windows are **[I]** unaffected.
- **[V] Moving windows across mixed DPI:**
  - #54627: content painted at an offset after moving between monitors with different DPI (43.5, Win11 26200). Closed as *not_planned* on 2026-10-23.
  - #27054 and #27651 (open): `setBounds` makes the window grow.
  - #55245: 1–2px drift at fractional scale factors.
  - #10862 (open): per-monitor DPI positioning problems.
- **Per-display window or one small moving window:**
  - **[I]** Use **one window per display, sized to `display.workArea` and never moved.** The cat moves inside it using CSS transforms driven by `requestAnimationFrame`, which stays in sync with vsync. The window never changes DPI, and there are no per-frame `SetWindowPos` calls, which jitter because window moves and content paints aren't synchronised.
  - When the cat crosses to another display, hand it to that display's window.
  - Cost: GPU memory of about width×height×4 per buffer (around 14 MB at 2560×1400). Damage tracking keeps per-frame work small.
  - On the software fallback, which uses layered windows, full-surface updates get expensive. Keep a small-window mode as a fallback for that case.

## 2. setIgnoreMouseEvents
- **[V] How it works:**
  - `ignore: true` adds `WS_EX_TRANSPARENT | WS_EX_LAYERED`. `ignore: false` removes them unless the window is already layered.
  - `forward: true` installs **one process-wide `SetWindowsHookEx(WH_MOUSE_LL)`** on the main UI thread. It forwards **only `WM_MOUSEMOVE`**, sent as synthetic move/leave messages through a posted task. Clicks and wheel events are never forwarded.
  - The hook is removed when no window is forwarding any more.
  - Source: `shell/browser/native_window_views_win.cc`
- **[V] Caveats:**
  - Forwarding pauses while the foreground window runs at a higher integrity level, such as an elevated app (BrowserWindow docs).
  - Microsoft's docs say a low-level hook that exceeds `LowLevelHooksTimeout` (at most 1000 ms) is **silently removed on Windows 7 and later**, and its thread must pump messages. Source: https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc
  - **[I]** So any synchronous koffi call or long task on the main thread can lag the mouse system-wide and kill forwarding.
- **Polling alternative:** **[V]** `screen.getCursorScreenPoint()` returns DIP. **[I]** Polling it at about 30 Hz costs very little, needs no hook and works over elevated windows. The open feature request #54635 shows apps already use this pattern.
- **Recommendation:** polling decides when the window becomes interactive. Add `forward: true` only for hover effects. Call `setIgnoreMouseEvents` only when the state changes, because each call rewrites the window style.
- **Watch out:** while `ignore = false`, the **whole** overlay eats clicks, transparent areas included. When the renderer sees the cursor leave the cat, it should flip back to ignore immediately.
- **[V]** `setShape(rects)` (experimental) clips both painting and hit-testing. **[I]** Updating it every frame forces a repaint, so don't use it for animation.

## 3. Always on top and z-order
- **[V] Levels do matter on Windows:**
  - `floating` (the default), `torn-off-menu`, `modal-panel`, `main-menu` and `status` place the window **just below `Shell_TrayWnd`**. Electron does this with `SetWindowPos(hwnd, taskbar)` when the level is set and again whenever the window is activated.
  - `pop-up-menu`, `screen-saver` and `dock` stay above the taskbar.
  - `moveTop()` is `SetWindowPos(HWND_TOP, SWP_NOACTIVATE|SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW)`.
  - `always-on-top-changed` fires only when the API changes the level. It does **not** tell you when other topmost windows push yours down.
- **[I]** Start menu, search and notification flyouts sit in shell z-bands that no app level can beat. Re-assert with `moveTop()` on foreground-change events or a slow timer.

## 4. screen and mixed DPI
- **[V]** `bounds` and `workArea` are DIP. `getCursorScreenPoint` returns DIP.
- **[V]** Conversion helpers, which scale using the display that contains the point or window:
  - `screenToDipPoint` / `dipToScreenPoint` (Windows and Linux)
  - `screenToDipRect(win|null, rect)` / `dipToScreenRect(win|null, rect)` (Windows only)
- **[V]** Events: `display-added`, `display-removed`, `display-metrics-changed` (with `changedMetrics` ⊂ `bounds`, `workArea`, `scaleFactor`, `rotation`).
- **[I]** Win32 rects from koffi (`GetWindowRect`, `DWMWA_EXTENDED_FRAME_BOUNDS`) are physical pixels because Chromium is per-monitor-v2 aware. Convert them with `screenToDipRect(null, r)`. Resize overlays on `workArea` changes, for example when the taskbar auto-hides.

## 5. Power and lifecycle
- **[V] powerMonitor on Windows:**
  - Events: `suspend`, `resume`, `lock-screen`, `unlock-screen`, `on-ac`/`on-battery`, `speed-limit-change`.
  - `shutdown` is Linux/macOS only. `user-did-become-active` is macOS only.
  - `getSystemIdleTime()` returns seconds. `getSystemIdleState(s)` returns active/idle/locked/unknown, with "locked on supported systems only". **[I]** Test that on Windows.
- **[V] Session end on Windows:**
  - BrowserWindow emits `query-session-end` (where `preventDefault` only delays) and then `session-end`. `reasons` can be `shutdown`, `close-app`, `critical`, `logoff`.
  - **`before-quit`, `will-quit` and `quit` are not emitted on Windows shutdown or logoff.** Save state synchronously in `session-end` and also periodically.
  - Normal order: `before-quit` → `will-quit` → `quit`.
  - `app.exit()` skips `before-quit`/`will-quit`.

## 6. Single instance and login item
- **[V]** The single-instance lock is a `ProcessSingleton` keyed on **`DIR_USER_DATA`** (`electron_api_app.cc`).
  - Call `setPath('userData')` before `requestSingleInstanceLock()`.
  - **[I]** Playwright runs with a separate user-data directory won't collide with an installed copy.
  - `second-instance(event, argv, cwd, additionalData)` only fires after `ready`. Prefer `additionalData` over parsing `argv`.
- **[V]** `setLoginItemSettings` (`shell/browser/browser_win.cc`):
  - It writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. The value name is `name`, or the AppUserModelID if `name` is unset. The value is `"path" args`.
  - `enabled: false` writes `03 00…` under `HKCU\…\Explorer\StartupApproved\Run`.
  - **`enabled: true` deletes that value, which overrides a user's "Disabled" choice in Task Manager.** Call `getLoginItemSettings().launchItems` first and only call `set` when the user changes the setting.
  - `openAtLogin: false` deletes both values.
- **[I]** With NSIS, a per-user install keeps `process.execPath` stable across updates. Set `name: 'DesktopCat'` explicitly (so it doesn't depend on the AppUserModelID) and pass `args: ['--autostart']`. The uninstaller won't remove the Run value by itself, so add `DeleteRegValue` lines in a `customUnInstall` NSIS macro.

## 7. Content protection and desktopCapturer
- **[V]** `setContentProtection(true)` maps to `widget()->SetExcludeFromScreenCapture`.
  - On Windows 10 2004 and later the window is "removed from capture entirely". **[I]** That is `WDA_EXCLUDEFROMCAPTURE`.
  - It takes effect on the next composition.
  - It keeps the cat out of its own captures, and also out of the user's screenshots and screen shares. Make it a setting.
- **[V]** `desktopCapturer` runs in the **main process only**.
  - `getSources({types: ['screen'], thumbnailSize, fetchWindowIcons})` uses a 150×150 thumbnail by default. A size of 0 skips thumbnails. Returned thumbnail sizes aren't guaranteed.
  - On Windows there's **no permission prompt**; the consent call only exists for macOS.
  - When the DXGI capturer is in use, Electron maps device names to `Display.id`. Otherwise the ids already match, so `source.display_id === String(display.id)`. Source: `electron_api_desktop_capturer.cc`
  - **[I]** Each call builds new capturers and takes a full-screen grab, so call it no more than once every 5–10 s with a small thumbnail (for example 320×180). Pause it when locked, idle or on battery.

## 8. Security
- **[V]** Defaults: `contextIsolation: true`, `sandbox: true` (since 20), `nodeIntegration: false`, `webSecurity: true`. Source: https://www.electronjs.org/docs/latest/api/structures/web-preferences
- **[V]** Checklist from https://www.electronjs.org/docs/latest/tutorial/security:
  - Use a custom protocol instead of `file://`.
  - Set a CSP.
  - Deny permissions with `setPermissionRequestHandler`.
  - Use `will-navigate` with `preventDefault` and `setWindowOpenHandler` returning `{action: 'deny'}`.
  - Validate `event.senderFrame` and its URL on every IPC message (parse payloads with zod).
  - Expose narrow wrappers through `contextBridge`.
- **[V] Fuses** (https://www.electronjs.org/docs/latest/tutorial/fuses). Turn these **off**: `runAsNode`, `nodeOptions`, `nodeCliInspect`, `grantFileProtocolExtraPrivileges`. Turn these **on**: `embeddedAsarIntegrityValidation` (Windows needs Electron 30+), `onlyLoadAppFromAsar`.
  - **[V] Pitfall:** Playwright `_electron` launches with `--inspect=0` (`playwright-core/src/server/electron/electron.ts`). Packaged builds with `nodeCliInspect` off can't be driven by Playwright. Run E2E tests against the unpackaged app or a separate test build.
- **[V] utilityProcess:**
  - `utilityProcess.fork(modulePath, args, {env, execArgv, cwd, stdio, serviceName})` after `ready`. Talks over `process.parentPort` and `MessagePortMain`.
  - It runs **unsandboxed** (`[ServiceSandbox=kNoSandbox]` in `node_service.mojom`).
  - Chromium's utility main uses an **IO message pump** unless `--message-loop-type-ui` is passed, so there's no Win32 message loop.
  - Microsoft's docs: "The client thread that calls SetWinEventHook must have a message loop."
  - **[I]** So koffi polling (`GetForegroundWindow`, `GetWindowTextW`, `EnumWindows`) can run in a utility process. Win-event hooks need their own `GetMessageW` loop in a worker thread, or the main thread, which does pump messages.

## 9. Tray and global shortcuts
- **[V] Tray:**
  - ICO is recommended. **[I]** Use a multi-size ICO with 16, 20, 24, 32 and 48px images.
  - Events: `click(e, bounds, position)`, plus `right-click`, `double-click`, `middle-click`, `balloon-*` (Windows).
  - `displayBalloon({iconType, title, content, largeIcon, noSound, respectQuietTime})`.
  - A tray GUID is tied to the code signature, or to the exe path if unsigned, so only pass one with a signed build.
  - **[I]** Keep a module-level reference to the `Tray` object.
- **[V] globalShortcut:** only after `ready`. `register()` returns `false` and **fails silently** if another app holds the accelerator. Show that failure in Settings and call `unregisterAll()` in `will-quit`.

## Recommended overlay window (per display)
```ts
function createOverlay(d: Electron.Display) {
  const win = new BrowserWindow({
    ...d.workArea, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', hasShadow: false, roundedCorners: false,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, focusable: false, skipTaskbar: true, type: 'toolbar',
    alwaysOnTop: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true,
      nodeIntegration: false, spellcheck: false, devTools: !app.isPackaged },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // 'floating' = just under the taskbar
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setBounds(d.workArea);                 // re-apply on the target display's DPI
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.showInactive());
  win.on('session-end', () => persistSync());
  void win.loadURL(`app://cat/overlay.html?display=${d.id}`);
  return win;
}
// hit-testing: renderer reports sprite rect in screen-DIP (zod-validated IPC)
setInterval(() => {
  const p = screen.getCursorScreenPoint();
  const over = !!catRect && inside(catRect, p);
  if (over !== interactive) { interactive = over; overlay.setIgnoreMouseEvents(!over, { forward: true }); }
}, 33);
```

## Risks & recommendations
1. **Black background bug #40515:** add a compatibility setting that calls `app.disableHardwareAcceleration()` on the next launch and switches to the small-window mode.
2. **Never move or hide the overlay windows:** hide the sprite instead (bugs #41063, #54627, #27651).
3. **Keep the main thread free:** use koffi's async calls or a utility process, so the low-level mouse hook isn't silently removed.
4. **Login items:** never call `setLoginItemSettings` with `enabled: true` on every boot, or you override the user's Task Manager choice. Clean up the Run value in the NSIS uninstaller.
5. **Fuses vs Playwright:** fuses break packaged-build E2E. Test unpackaged and keep a fused smoke build.
6. **Content protection:** treat excluding the cat from captures as a user choice. Rate-limit `desktopCapturer` and keep it opt-in.
7. **Polling cost:** CI can't measure it because Actions is blocked. Check that cursor polling and rAF CPU and GPU use stay low on real hardware (still unverified).
