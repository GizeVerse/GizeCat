# ADR 0002 — v1.1: launch at sign-in, taskbar physics, window and tab-strip surfaces

- Status: accepted (2026-10-28). Evidence: `docs/research/v1.1/{startup,taskbar,uia-tabs,codemap}.md` (probes on Windows 11 26200, Chrome 155, Edge 156).

## 1. Launch at sign-in

| Decision | Why |
|---|---|
| **HKCU `…\CurrentVersion\Run` value written by the app** through Electron `setLoginItemSettings({openAtLogin, path: process.execPath, args: ['--launched-at-login'], name: LOGIN_ITEM_NAME, enabled: true})`, unquoted inputs (Electron quotes paths with spaces/non-ASCII correctly — probed byte-for-byte). | Standard-user, visible in Task Manager → Startup apps and Settings, user-disableable there (`StartupApproved\Run`), removed by the uninstaller. Startup folder and Task Scheduler rejected (less transparent / no StartupApproved opt-out). |
| **State read with koffi `RegGetValueW`** for our value name only (Run + StartupApproved), not `getLoginItemSettings`. | Electron's getter keys on the AppUserModelID, compares case-sensitively and splits unquoted paths with spaces, so v1's `isActive()` was always false for the default `…\Programs\Desktop Cat\` path. |
| **Main-owned `loginItem` settings section** (`preference` unset/enabled/disabled, `decidedBy`, `disabledBy`, `registeredPath`, `v1Value`, `noticeShown`); renderer patches rejected; changed only via `enableLaunchAtLogin`/`disableLaunchAtLogin` actions. Default for new installs: **on** (`unset` → product default). | Requirement: default-on, explicit opt-outs preserved, never silently re-enabled. |
| **Migration v1 → v2**: v1 `true` → enabled. v1 `false` is ambiguous (v1 always wrote the default) → `unset` + `v1Value:false`, unless evidence of a real opt-out exists (a disabled StartupApproved value, or v1 log lines recording `openAtLogin:false`), then `disabled`. A one-time notice tells the user startup was turned on. | Matches the brief ("no choice yet → new default; explicit opt-out preserved"). |
| **Reconcile at boot** (pure function): Task Manager disable always wins and is never overwritten; register when the preference resolves to on and the entry is missing; repair a stale path (moved install, v1 dev `electron.exe` entry) — except when launched at sign-in (Microsoft: programs started from Run should not write the key); an entry removed outside the app after we registered it counts as an external opt-out unless the uninstaller left its marker (reinstall). | Never fights the user; self-heals after upgrades/moves. |
| **Write gate**: packaged, not test mode, `DESKTOP_CAT_LOGIN_ITEM !== 'off'`, uninstaller next to the exe (excludes `release/win-unpacked`), command line ≤ 260 chars. | Dev, test and smoke runs can never register a dev path. |

## 2. Taskbar as a dynamic surface

| Decision | Why |
|---|---|
| **Fix: set `NonRudeHWND` on every overlay** before `showInactive()` (remove before destroy). | Verified: our full-monitor transparent topmost overlay made Windows treat it as a fullscreen ("rude") app and strip `WS_EX_TOPMOST` from `Shell_TrayWnd` within ~60 ms; the 2 px reveal strip no longer hit-tested as the taskbar. With the property set, the taskbar stays topmost and reveals normally. |
| **`TaskbarTracker`**: discover `Shell_TrayWnd` + `Shell_SecondaryTrayWnd` (FindWindow/FindWindowEx, class names only), `MonitorFromWindow`, `SHAppBarMessage(ABM_GETSTATE/GETTASKBARPOS)` as cross-checks (≤ once per reconcile: it is a cross-process call, 164 µs). Live geometry from `GetWindowRect` (0.6 µs): **4 Hz idle, 60 Hz bursts** while the rect changed in the last 300 ms, the cursor is within 6 px of an auto-hide edge, or the cat is on/near the taskbar. Rediscover on `TaskbarCreated`, display changes, `IsWindow` failure, 10 s reconcile. | Event volume of global LOCATIONCHANGE hooks is high and SHOW events on the tray fire without movement (measured); cheap adaptive sampling is reliable and < 0.1 ms/s. |
| **Surface model**: a taskbar is a `LedgeSurface` (`kind:'taskbar'`, `edge`, `phase` entering/stable/leaving, `vy`) that exists while ≥ 50 % of its thickness is on screen; feet at `rect.top − 1` so the cat never overlaps the taskbar (looks right whichever topmost window wins z-order — we never re-assert z-order). A rising taskbar lifts a cat standing on the floor above it; a retracting one lowers it and then lets it drop to the floor with a **non-startling** "surface retracted" fall. Top taskbars are ceilings; left/right taskbars are walls. | Physical, believable, no z-order fight (Raymond Chen: no "super topmost"). |

## 3. Window and tab-strip surfaces

| Decision | Why |
|---|---|
| One tagged `Surface` union (`src/shared/surfaces.ts`): `LedgeSurface` (window tops, taskbars, tab strips) and `WallSurface` (window sides). One planner, one ride path generalised from window perching (`getSurface(id)` replaces window-only `getWindowRect` for riding), a surface graph in `src/core/movement` for reachability (walk / climb / pull-up at corners / jump / drop). | No parallel animation hacks; one physical cat. |
| Window tops/sides from DWM extended frame bounds (visual edge, not the invisible resize border), inset for Windows 11 rounded corners, z-order occlusion-aware (`listOccluders`), private/excluded windows never climbed. | Cat must not float above the visible edge. |
| **Tab strips via a small C# UI Automation helper** (`System.Windows.Automation`, compiled with the .NET Framework `csc.exe`, JSON lines over stdio, per-monitor DPI aware, InvariantCulture). Only Edge/Chrome top-level `Chrome_WidgetWin_1` windows; class-name path to the horizontal tab container; **never reads `Name`** (tab titles), never touches web-content nodes (a naive descendant search permanently enables the browser's web accessibility: +~60 MB, +1 s CPU — measured), refresh ≈ 0.3 ms, 1 Hz only while relevant. Walkable span excludes the tab-search/actions button, new-tab button, grab handle and caption buttons; disabled when maximized or without head room. | Generic accessibility first; no extensions, injection or remote debugging; helper isolates browser-provider hangs from the main process; geometry-only keeps the window-title privacy invariant. |
| Optional visual fallback: **not used** for geometry. | Native + UIA geometry suffices; screen analysis remains opt-in perception only. |

## Consequences

- A new unsigned helper exe ships in `resources/` (fails closed: tab strips off, window tops still work; restarted with backoff).
- Settings schema v2; tests pinning v1 defaults updated.
- Real reboots/sign-ins, physical taskbar reveals (needs a user's mouse), multi-monitor taskbars and Firefox remain unverified unless observed (see TEST_REPORT).
