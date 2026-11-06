# GizeVerse Phase Zero: baseline audit

Date: 2026-11-06. Branch: `feat/gizeverse-foundation` at `58b4cd6`, worktree `.claude/worktrees/v1.1`. This phase was read-only, and this file is its only output. Product: GizeCat (today "Desktop Cat"). Brand: GizeVerse, a future platform for digital characters.

**Claim labels.**
- **REAL**: read or executed in this phase, by an auditor or by the synthesizer.
- **REAL (doc)**: read in the cited official source.
- **REAL\***: an official page seen only as a search-tool excerpt, not read in full.
- **UNVERIFIED**: an inference, a search-level source, or something not executed.

Nothing ran on macOS, Linux, Android or iOS. No app, installer, Docker container or emulator was started.

**Platform statuses** (used in sections 1, 2, 5, 6 and 8):

| Status | Meaning |
|---|---|
| IMPLEMENTED_AND_LOCALLY_VERIFIED | Built and exercised on this machine |
| IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | The code exists but has not run on the target |
| ARCHITECTURALLY_VALIDATED | The design or seam is shown by code reading, a build probe or docs, but is not implemented |
| SIMULATED_OR_MOCK_TESTED | Exercised only against fakes, emulation or a virtual display |
| BLOCKED_BY_PLATFORM_OR_PERMISSION | The OS or store does not allow it, a user permission gates it, or this machine cannot reach the platform |
| NOT_IMPLEMENTED | No code exists |

Inputs were five auditor reports (portability map; build, packaging, tests and CI; branding identifiers; desktop platform research; mobile and web research), plus the synthesizer checks in section 0.

## 0. Synthesizer checks and resolved disagreements

| Point | Finding | Label |
|---|---|---|
| Electron 44 end of life | 2027-03-02, tentative. 45 has been stable since 2026-10-20, with end of life 2027-04-27 (tentative). 46 is planned for 2027-01-05 (tentative) [E1]. This settles the desktop report's "end-of-life date not found". | REAL (doc) |
| Pinned Electron patch | The repo pins 44.9.3 (package.json:38, electron-builder.yml:4). The latest 44.x is **44.10.2**, released 2026-11-03 [E2]. | REAL (doc) |
| Screen API platform tags | dipToScreenRect and screenToDipRect are Windows-only. dipToScreenPoint and screenToDipPoint are Windows and Linux, not Wayland. getCursorScreenPoint is "not supported on Wayland" [S5]. The repo uses them at displayService.ts:30-31, overlayManager.ts:830, capture.ts:114 and app.ts:206. The auditors agree. | REAL (doc and grep) |
| "registry.ts:52 throws" (desktop report) | The throw sits inside bindRegGetValue, and createLoginItemRegistry catches it (registry.ts:105-109) and returns `available: false` (:119). It fails soft, as the portability report says. | REAL |
| Owner's installed version | Memory says 1.1.0; `.claude/handoff.md:3` says 1.1.1. Not inspected, because the install is off-limits. Treated here as "1.1.x, installed and running". | UNVERIFIED |
| release/ contents | The worktree's release/ has 1.1.0, 1.1.1 and 1.2.0, plus blockmaps, builder-debug.yml and win-unpacked. The main checkout's release/ has 1.0.0 through 1.2.0. | REAL (listing) |
| Citation fixes | The Playwright config is `playwright.config.mts`, not `.ts`. asarUnpack is electron-builder.yml:24-26 and `win:` is :29-35. Electron 44 went stable on 2026-08-24 per the schedule. | REAL |

## 1. Repository baseline

| Item | State | Label |
|---|---|---|
| Branches | `main` and `feat/desktop-cat-v1`: 459264f (v1.0.0 plus claude-standard 1.1).<br>`feat/v1.1-surfaces`: e9133bd (1.1.1, 23 commits ahead of main).<br>`feat/v1.2-lively` and `feat/gizeverse-foundation`: 58b4cd6 (1.2.0, 50 ahead of 1.1.1 and 73 ahead of main).<br>Nothing has been merged since v1.0. There are no tags and no remote.<br>Worktrees: the main checkout, `.claude/worktrees/v1` and `.claude/worktrees/v1.1`. | REAL (git) |
| Version | 1.2.0 (package.json:4); main is at 1.0.0. | REAL |
| Stack | Electron 44.9.3, electron-builder 26.18.1, TypeScript 6.0.3, esbuild 0.28.2, vitest 5.0.5, Playwright 1.64.1, zod 4.6.7 (bundled), koffi 3.3.4 (the only runtime dependency) (package.json:31-45). | REAL |
| Release artifact | `release/Desktop-Cat-Setup-1.2.0.exe`: 121,515,413 B, SHA-256 `02C05826…57B3` (TEST_REPORT.md:7), unsigned. The payload has app.asar (115 entries), app.asar.unpacked (koffi, 2.1 MB), native/DesktopCatUia.exe (42 KB) and elevate.exe. | REAL |
| Code size | 215 `.ts` files in src/, 180 test files under tests/, 8 Playwright specs. | REAL (count) |
| Last recorded verification | From docs/TEST_REPORT.md for v1.2.0:<br>- `verify.mjs full` passed at d96c4ab.<br>- Vitest: 3645 passed, 26 skipped, 1 todo.<br>- Playwright: 30 passed, 15 skipped.<br>- Packaged smoke, install and upgrade checks, as listed there.<br>None of this was re-run in this phase. | REAL as recorded |
| Verification tiers | Defined in `.claude/standard.json`:<br>- fast: typecheck, lint, vitest.<br>- full: fast plus build and Playwright E2E. The E2E step requires `node_modules/electron/path.txt`.<br>- Four pinned invariants: consent-guard, privacy-defaults-off, sandboxed-renderers, no-test-surface-when-packaged. | REAL |
| Lint of core and shared | The portability auditor ran `npx eslint --no-cache --max-warnings 0 src/core src/shared`; it exited 0. | REAL |
| CI | One workflow, on windows-latest only. Its header says it has never run (ci.yml:3-5). There is no Linux or macOS job, and actions are pinned by tag, not SHA. Private-repo Actions have been blocked by billing since 2026-10-02, so CI counts as absent. Whether public repos would run is UNVERIFIED. | REAL (file); no runs |
| Dependency audit | The last real `npm audit` was at v1.0: 0 vulnerabilities (TEST_REPORT.md:212). None was run for 1.1 or 1.2, and none here (it needs the network). | REAL; current state UNVERIFIED |
| Licences | MIT, plus THIRD_PARTY_NOTICES.md. Two gaps:<br>- zod's MIT notice is not shipped anywhere (esbuild `legalComments: 'none'`, build.mjs:28).<br>- elevate.exe ships but is not listed in the notices. | REAL |

**Windows status:** IMPLEMENTED_AND_LOCALLY_VERIFIED for the v1.2 feature set on this machine (Windows 11 26200, one 1920×1200 display at 125 %). Multi-monitor, mixed DPI and Windows 10: IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED (CLAUDE.md, Project notes).

## 2. Architecture and portability map

### 2.1 Module classification

Classes: a = platform-agnostic, b = Electron-generic, c = Windows-specific, d = mixed.

| Area | Class | Notes (file:line) |
|---|---|---|
| src/core/** (56 files) | a | Enforced by ESLint (eslint.config.mjs:25-39), plus a determinism rule (:41-52). The only coupling is vocabulary: the 'taskbar' and 'tabStrip' surface kinds. |
| src/shared/** (16 files) | a | Coupling in the data only:<br>- .exe privacy exclusions (settings.ts:108-126)<br>- Windows-reserved shortcuts (shortcut.ts:58-68)<br>- HWND and exe wording in the docs (world.ts:45-49) |
| renderer/overlay/**, including the cat/ rig | a/b | Uses only the DOM and Canvas 2D. It reaches Electron only through `OverlayApi` (shared/ipc.ts:204-213; overlay/main.ts:12-17). |
| renderer/settings/** | b | Windows wording (strings.ts:165-173). Appends ".exe" to exclusions (validate.ts:143). Uses the Segoe UI Variable and Segoe Fluent Icons system fonts (styles.css:5-8). |
| preload/* | b | contextBridge only. |
| main: catHost, ipc/*, store/*, diagnostics/* (except dpiAwareness), protocol, security, settingsWindow, tray, most of lifecycle/* | b | The tray balloon is Windows-only (tray.ts:102). secretStore promises DPAPI (secretStore.ts:1, :32). |
| main: app.ts, contracts.ts, display/displayService.ts, overlay/overlayWindow.ts, overlay/overlayManager.ts, perception/capture.ts, surfaces/provider.ts, win32/windowTracker.ts, win32/activityMonitor.ts | d | - app.ts imports the Windows adapters directly (app.ts:49-52).<br>- The contract is shaped after Win32 (contracts.ts:21-48).<br>- **displayService.ts:30-31 calls dipToScreenRect, which blocks any port.**<br>- Overlays use `type: 'toolbar'` (overlayWindow.ts:45).<br>- provider.ts imports win32 and uia directly (provider.ts:61-67). |
| main: win32/native, registry, win32Api, taskbar*, clickObstacles, mouseButtons, processNames; uia/*; lifecycle/loginItem*; diagnostics/dpiAwareness; native/uia-helper (C#); build/installer.nsh | c | - koffi FFI to user32, kernel32, dwmapi, shell32 and advapi32 (native.ts:147-227; registry.ts:13-17)<br>- The UIA helper is spawned as a separate exe (uia/client.ts:22-23)<br>- Login at sign-in through HKCU Run and StartupApproved |

### 2.2 Windows dependencies

**Loading.** koffi is required lazily, after a `process.platform === 'win32'` check (native.ts:141-145; registry.ts:52). Each service has an "unavailable" stub:
- win32: win32/index.ts:27-34, win32Api.ts:593-620
- taskbar: taskbar.ts:176-208
- UIA: uia/index.ts:36, uia/service.ts:411
- login registry: registry.ts:105-119
- overlay shell: overlayWindow.ts:96-106

REAL (code).

**Win32 APIs used:**
- GetCursorPos and GetLastInputInfo
- GetAsyncKeyState, for mouse buttons only
- EnumWindows and GetWindow (z-order)
- DwmGetWindowAttribute (frame bounds, cloaked state)
- SetWinEventHook
- SHQueryUserNotificationState and SHAppBarMessage
- SetPropW (NonRudeHWND) and RegisterWindowMessageW (TaskbarCreated)
- RegGetValueW

**Electron APIs that are Windows-only or differ by platform:**
- `screen.dipToScreenRect`, at three call sites.
- `screen.dipToScreenPoint` (app.ts:206); it does not exist on macOS.
- `hookWindowMessage` (overlayWindow.ts:146).
- `tray.displayBalloon` (tray.ts:102).
- The `query-session-end` and `session-end` events (overlayManager.ts:324-325).
- `setAppUserModelId` (index.ts:68). Per Electron's main-branch source it is a no-op elsewhere; UNVERIFIED for the v44 tag.
- The `args` option of `setLoginItemSettings` (loginItem.ts:172).

### 2.3 Seams usable as adapters

| Seam | Today on Windows | Off Windows today | Port direction |
|---|---|---|---|
| `Win32Api` (contracts.ts:21-48), plus the duck-typed `Win32ApiExtensions` and `Win32InputExtensions` (win32Api.ts:72-125) | koffi facade (win32Api.ts:183) | `createUnavailableWin32Api`: every method returns null, false or [] | Split into DesktopWindows, PointerInput and FullscreenState. Keep HWND and WinEvent types inside win32/. |
| `WindowTracker`, `ActivityMonitor` (contracts.ts:51-97) | Neutral logic over Win32Api | Mode 'unavailable'. Privacy fails closed (windowTracker.ts:553-596). No idle events. | Reuse as they are. Feed idle from `powerMonitor.getSystemIdleTime` through the existing idleProvider hook (activityMonitor.ts:22, :53). |
| `DisplayService` (contracts.ts:99-110) | Electron screen plus dipToScreenRect | The call throws, the world stays empty (topology.ts:100, :104-108), and no overlays are created (overlayManager.ts:681) | One platform pixel-mapping helper |
| `TaskbarTracker`, `TabStripService` | taskbar.ts; uia plus the C# helper | Inert, or permanently unavailable | Keep them unavailable. Dock or panel adapters come later. |
| `SurfaceProvider` (contracts.ts:214-226) | surfaces/provider.ts | windowSurfaces 'unavailable': the cat stays on the floor | Remove the direct win32 and uia imports (provider.ts:61-67) |
| `PerceptionHost` | perception/capture.ts | Fails closed: the foreground counts as excluded and everything is masked | A per-OS process identity must come first (privacy) |
| `SecretStore` | safeStorage (DPAPI) | 'unavailable' when no encryption is available | On Linux, refuse the `basic_text` backend |
| Login item (registry.ts:39-41; writer at loginItem.ts:57-60) | HKCU Run and StartupApproved | The write gate is closed (no uninstaller next to the exe) | macOS: SMAppService via setLoginItemSettings, without args, using wasOpenedAtLogin. Linux: XDG autostart. |
| `OverlayApi` (shared/ipc.ts:204-213) | The preload bridge | n/a | An in-page host for a browser build |
| Composition | app.ts:126-231 | n/a | `createPlatformServices(process.platform)` |

### 2.4 What happens on macOS or Linux today

This trace comes from reading the code. It has never been executed (UNVERIFIED).

1. index.ts: the setPath-then-lock order works.
2. The win32 layer logs that it is unavailable.
3. `DisplayService` throws on `dipToScreenRect`. The topology tracker swallows the error, so `world.displays = []`, and `overlayManager.start()` creates no windows.
4. The window tracker is 'unavailable'. There are no idle events, no taskbars and no tab strips.
5. Perception fails closed, and the login item cannot be written.
6. A tray is created. On Linux it needs StatusNotifier support; GNOME needs the AppIndicator extension.

**Result: a running process with a tray icon and a working Settings window, but no cat.**

Also:
- Whether the sim tolerates an empty world, or crash-loops under crashGuard, is UNVERIFIED.
- On macOS the cursor fallback also throws (dipToScreenPoint is missing). catHost.ts:572-578 catches this, so the cursor position is never known.
- On Linux X11 the outcome is the same, because dipToScreenRect is Windows-only there too.

**Status:**
- macOS and Linux X11: NOT_IMPLEMENTED.
- Native Wayland: NOT_IMPLEMENTED. Its core window controls are also BLOCKED_BY_PLATFORM_OR_PERMISSION (section 5).

### 2.5 Coupling that matters for GizeVerse

**Character** (REAL):
- The vocabularies in shared/cat.ts (clips, skins, sounds, reactions; cat.ts:5-177).
- Body constants, used directly by mover.ts:6 and catHost.ts:23.
- A 9-level sim class chain of about 6,000 lines (sim.ts:29).
- The concrete `CatScene` in runtime.ts:12.
- An AI prompt and allow-list worded for a cat (aiOutput.ts:12-24).
- `PersistedCat` has no character-kind field (catState.ts:145-156).
- One sim and one host (app.ts:166).

**Privacy:**
- Exclusions are .exe basenames (settings.ts:108-126; validate.ts:143; processNames.ts:18-47). This is safe today only because everything fails closed off Windows.
- The CLAUDE.md invariant "window titles never leave `src/main/win32`" names a Windows directory. Any non-Windows window adapter therefore needs the owner to reword that invariant first.

**ESLint gap:** the core/shared rule bans `node:*`, fs, path, os, child_process, koffi and electron (eslint.config.mjs:33). It does not ban bare built-ins (crypto, util, events and others) or globals (process, Buffer, window, document). shared/ is also bundled into the sandboxed renderers, so such a use would break them at run time, not at lint time.

## 3. Build, packaging and test portability

| Step | Windows | Linux | macOS | Evidence |
|---|---|---|---|---|
| `npm ci --ignore-scripts` | REAL (TEST_REPORT) | Likely works: the v3 lockfile records linux prebuilds for koffi, esbuild, rolldown and lightningcss (UNVERIFIED) | Likely works (UNVERIFIED) | package-lock.json:1248-1263; koffi package.json:35-56 |
| typecheck, lint | REAL | Expected to work (UNVERIFIED) | Same | n/a |
| vitest, fast tier | REAL: 3645 passed | **Expected to FAIL**: the login-item tests pass Windows paths through host `node:path` (loginItem.ts:129, :143; loginItemFakes.ts:177-182). `path.posix.dirname` of such a path returns '.' (REAL, evaluated). settingsStore.ts:56 is a similar suspect. | Same | Auditor |
| Explicit win32 gates | n/a | Six files skip: win32Api.real, registry.real, helper.real, taskbarNative, 2 protocol cases, 1 install-script case | Same | Auditor (file:line in that report) |
| `npm run build` | REAL | Expected to work; the UIA helper skips itself with a log (build-uia-helper.mjs:26, :90-93) (UNVERIFIED) | Same | n/a |
| Playwright E2E | REAL: 30 passed, 15 skipped | overlay, surfaces and lively specs call user32/dwmapi through koffi, so they are Windows-only. ipc, stress, persistence, diagnostics and lifecycle may be portable under Xvfb (UNVERIFIED). | Same; no macOS host here | playwright.config.mts; tests/e2e/* |
| Packaged checks | REAL (smoke, install, upgrade) | None. Every script is Windows-only (DesktopCat.exe, taskkill, PowerShell, NSIS). | None | scripts/* |
| electron-builder | NSIS only (yml:29-51); the scripts hardcode `--win` (package.json:25-26) | Needs a `linux:` section. deb and rpm throw without a `homepage` and an author email (FpmTarget.js:81-96). The top-level extraResources (DesktopCatUia.exe) and the koffi-win32 asarUnpack entry would also apply (yml:21-26). | Needs a `mac:` section, a macOS host, a Developer ID and notarization. hardenedRuntime defaults to true. | Auditor (installed source); [B2], [B3], [B4] |
| Fuses | Set globally (yml:52-60) | ASAR integrity is not documented for Linux | Documented | [B5] |
| Notices | zod's notice is missing. elevate.exe is unlisted; `nsis.packElevateHelper: false` would drop it, since perMachine and allowElevation are already false (NsisTarget.js:122). | n/a | n/a | Auditor |

**Packaging direction** (no change to the Windows payload):
- Move extraResources and executableName under `win:`.
- Exclude koffi from mac and linux packages.
- Add per-OS package scripts.
- Tag the Windows-only E2E specs.
- Write separate per-OS packaged smoke checks.

## 4. Branding identifiers

### 4.1 Inventory

| Class | Identifier | Value | Where | If renamed, for a 1.x user |
|---|---|---|---|---|
| PERSISTENT | appId | `io.github.enesiltas.desktopcat` | electron-builder.yml:1 | The NSIS GUID changes. Today it is `e1021757-1dcb-56be-999c-26e3a22d4339` = UUIDv5(appId), computed by the auditor. The upgrade no longer finds the old install, a second Apps entry appears, and uninstalling the stale entry can wipe the shared folder and the Run value [B1]. |
| PERSISTENT | AppUserModelID | the same string | index.ts:16, :68; stamped on shortcuts | Taskbar pin grouping and notification settings reset (UNVERIFIED) [W1] |
| PERSISTENT | Run / StartupApproved value name | the same string | loginItem.ts:37; installer.nsh:27, :41, :63-64 | The app turns launch-at-login off on its own while the old entry keeps launching it. A Task Manager "Disabled" choice is lost. |
| PERSISTENT | package.json productName, which names userData | "Desktop Cat" → `%APPDATA%\Desktop Cat` | package.json:3; index.ts:1-3 (the lock is keyed on userData) | Settings, memories, the API key, logs and the uninstall marker are left behind. The single-instance lock differs, so two cats can run. |
| PERSISTENT | win.executableName | `DesktopCat` | yml:34 | Upgraded and fresh installs end up in differently named folders. The Run entry points at a deleted exe until a user start repairs it. Pins break and tray settings reset (UNVERIFIED). |
| PERSISTENT | Uninstall marker | `%APPDATA%\Desktop Cat\login-item-removed-by-uninstall` | installer.nsh:73-75 | A reinstall reads the missing marker as an opt-out |
| PERSISTENT | Sidecar kind | `desktop-cat-opt-outs` | optOutSidecar.ts:12, :31 | The v1.2 downgrade protection for opt-outs is lost |
| PERSISTENT (user-facing) | Environment variables `DESKTOP_CAT_LOGIN_ITEM`, `DESKTOP_CAT_USER_DATA` | `off` / a path | loginItem.ts:40; launchArgs.ts:6-8 | A user's opt-out or portable data path is ignored |
| DISPLAY | Builder productName, shortcutName, uninstallDisplayName, artifactName | "Desktop Cat" | yml:2, :43, :48, :49 | Safe: exe FileDescription, Apps-list name, link names, installer file name. Confirm with an upgrade test on a disposable VM. |
| DISPLAY | UI strings, window titles, tray tooltip, menus, dialogs, login-item messages, diagnostics file name | "Desktop Cat" | strings.ts; tray.ts:49; menuModel.ts:89, :107, :116; overlayWindow.ts:47; settingsWindow.ts:90; index.ts:29, :37; exportDiagnostics.ts:17 | Only test assertions change (menus.test.ts, tray.test.ts, lifecycle.spec.ts) |
| INTERNAL | Scheme | `desktop-cat://` | ipc.ts:15 | Security-sensitive (security.ts:11-16, :73; protocol.ts:56-62). No web storage is used, so no data is lost. |
| INTERNAL | Other internal names | Preload globals `window.desktopCat` and `window.desktopCatSettings`, `__desktopCatTest`, `DesktopCatUia.exe`, npm name `desktop-cat`, diagnostics kind, test prefixes | various | Churn only. Renaming the npm name orphans `%LOCALAPPDATA%\desktop-cat-updater`. The test prefixes drive crash-leftover cleanup. |
| Neutral | Icons | gen-icons.cjs (a cat head, no text) | scripts/gen-icons.cjs | No change needed |

### 4.2 Transition plan

| Step | Change | Keep stable | Verification |
|---|---|---|---|
| 0 | The owner confirms the spelling (GizeCat) and where GizeVerse appears | n/a | Owner decision |
| 1 | One product display-name constant in src/shared. Every DISPLAY string. The builder productName, shortcutName, uninstallDisplayName and artifactName. The docs. | Every PERSISTENT and INTERNAL identifier | Update the string tests. Add a test that yml appId equals `APP_USER_MODEL_ID`; none exists today. |
| 1b | Pin userData: when there is no override, call `app.setPath('userData', join(appData, 'Desktop Cat'))` before the lock | userData, the marker, the lock | A unit test, and a lifecycle.test.ts check that the constant equals the installer.nsh marker folder |
| 2 | package.json productName may then change | n/a | `upgrade-test.ps1` from 1.2.0 to the new build, only on a disposable Windows user or VM, never on this machine |
| Later, optional | Identity rename | n/a | Needs: nsis.guid pinned to the old GUID, a Run/StartupApproved carry-over, a whole-folder userData move (it holds Local State), environment variable aliases and both sidecar tags. Requires an ADR and the owner's approval. |

Ask the owner before changing any PERSISTENT identifier.

## 5. Platform capability tables

Legend: Yes = supported per the docs; Part = partial or conditional; No = not possible through the API; Perm = needs a user or OS permission. Every cell is REAL (doc) unless marked [U]. Nothing was executed on these platforms.

### 5.1 Desktop

| Capability | macOS | Linux X11 | Wayland GNOME (Mutter) | Wayland KDE (KWin) / wlroots | Src |
|---|---|---|---|---|---|
| Transparent frameless window | Yes | Yes (needs a compositing WM [U]) | Yes, with hasShadow:false and roundedCorners:false (the repo sets both, overlayWindow.ts:34-35) | Yes | S1, S3 |
| Always-on-top | Yes; levels map to NSWindowLevel | Yes (EWMH hint; the level argument is ignored) | No through the API; only the user's window menu [U] | No through the API. KDE: a KWin rule or script. layer-shell exists, but Electron does not use it [U]. | S1, S2, S43 |
| Over fullscreen apps, all workspaces | Part: visibleOnFullScreen hides the Dock icon; NSPanel route [U] | Part (depends on the WM) | No [U] | No; KWin rule [U] | S1, S20 |
| Click-through (setIgnoreMouseEvents) | Yes | Yes from 44.5.0 (broken in 43.x) | Part from 44.5.0; Mutter applies it late (#51808) | KDE: Yes (KWin 5.27 passed 3/3). wlroots: [U] | S14, S17, S18 |
| `forward: true` (mouse moves while ignoring) | Yes | No | No | No | S1, S4 |
| Global cursor (needed for the T8 poll) | Yes, no permission | Yes | No | No | S5, S25 |
| Position windows, cover the work area | Yes, within visibleFrame | Yes | No: setPosition is unsupported and getBounds returns 0,0 | No | S1, S32 |
| The repo's DIP↔px helpers | Rect: No. Point: No | Rect: No. Point: Yes | No | No | S5 |
| showInactive | Yes | Yes | No | No | S1 |
| Other apps' windows and their bounds | Part: bounds without permission are undocumented. Titles need Screen Recording (Perm) [U]. AX needs Accessibility (Perm). | Yes: `_NET_CLIENT_LIST_STACKING`, no permission | No, by design; only a Shell extension can do it | KDE: only through a KWin script. wlroots: ext-foreign-toplevel-list gives titles but no geometry. | S26-S30, S39, S44, S46, S47 |
| Dock or panel geometry | Yes (workArea = visibleFrame) | Yes (`_NET_WORKAREA`, struts) | No or Part: workArea was reported equal to bounds (#43493) | Same as GNOME | S6, S24, S39 |
| Start at login | Yes, through SMAppService. It may need approval and may fail silently if the app is unsigned. args is Windows-only. | No Electron support; write an XDG autostart file | XDG autostart (honoured [U]), or the Flatpak Background portal (Perm) | KDE: XDG [U]. wlroots: compositor config [U]. | S7, S31, S40, S48, S54 |
| Tray | Yes (template image) | Part (SNI; only 'click' fires) | Part (needs the AppIndicator extension) | KDE: Yes [U]. wlroots: depends on the bar [U]. | S8, S41, S42 |
| Hide from taskbar or Dock | Yes | No: skipTaskbar is macOS/Windows only; workarounds [U] | No [U] | No [U] | S1, S2 |
| Screen capture (perception) | Perm (Screen Recording) | Yes [U] | Perm (PipeWire portal) | Perm | S9, S10 |
| Electron 44 specifics | macOS 13+ only; openAsHidden removed; x64 and arm64 only | Native Wayland is the default since 38.2; `--ozone-platform=x11` is the escape hatch [U for this app] | n/a | n/a | S11, S12, S13 |

**Status now and realistic target:**
- **macOS**: NOT_IMPLEMENTED. Target: IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED, since there is no Mac here. Window surfaces need a consent design; until one exists they are BLOCKED_BY_PLATFORM_OR_PERMISSION.
- **Linux X11, including forced XWayland**: NOT_IMPLEMENTED. Target: implemented, with container verification (section 6).
- **Native Wayland**: always-on-top, the global cursor, positioning and window discovery are BLOCKED_BY_PLATFORM_OR_PERMISSION. At most, a degraded mode is possible.

### 5.2 Web and mobile

| Option | Over other apps | Continuous animation | Background | Policy / permission | Status now | Src |
|---|---|---|---|---|---|---|
| Browser page or PWA (Chrome, Edge) | No (in-page only) | Yes (rAF; paused when hidden) | Throttled or frozen when hidden | None | **ARCHITECTURALLY_VALIDATED**. The core and renderer bundled for `platform=browser` (esbuild; sim 178 KB gzip, renderer 32 KB gzip, REAL executed). The renderer depends only on `OverlayApi`. | M1-M3 |
| Document Picture-in-Picture (Chrome, Edge 116+) | An always-on-top window. It needs a user gesture and closes with its opener. Transparency [U]. | Yes | Closes with its opener | None | NOT_IMPLEMENTED | M4 |
| Android browser, or a Capacitor WebView | No | Yes | Suspended | None (Capacitor: Android 7+, iOS 15+) | NOT_IMPLEMENTED | M5 |
| Android SYSTEM_ALERT_WINDOW overlay | Yes | Needs a specialUse foreground service, which Play reviews | Android 15 exempts background starts only while the overlay is visible | Perm. Impossible on Go devices. Since Android 12, touches pass through only if the overlay's opacity is 0.8 or less. | **BLOCKED_BY_PLATFORM_OR_PERMISSION** for the full-screen click-through design. A small touchable-window variant: NOT_IMPLEMENTED. | M6-M9 |
| Android live wallpaper | Home screen only | Only while visible | n/a | Low [U] | NOT_IMPLEMENTED (research candidate) | M10 |
| Android widget, bubbles, picture-in-picture | Home screen / conversations only / video only | No / misuse / misuse | n/a | Policy risk | Not recommended | M11-M13 |
| iOS overlay over other apps | No public API (the absence is [U]) | n/a | n/a | n/a | BLOCKED_BY_PLATFORM_OR_PERMISSION | n/a |
| iOS WidgetKit, Live Activities | Home and Lock Screen | No: archived views, about 40-70 reloads a day. Live Activities: 8 h active plus 4 h, attributes up to 4 KB. | Budgeted | Low | NOT_IMPLEMENTED | M14-M16 (REAL\*) |
| iOS in-app character (WKWebView or native) | No | Yes | Suspended | App Store guideline 4.2 applies to web wrappers | NOT_IMPLEMENTED | M17 |

**Touch gap** (REAL, code): petting requires hover with no button pressed (gestures.ts:247). A finger that moves more than 6 px becomes a drag (gestures.ts:43). input.ts:66-67 does not forward `pointerType`.

## 6. What this machine can verify

| Target | How (own resources only) | Best status it can earn | Limits |
|---|---|---|---|
| Windows 11 native | `verify.mjs fast` and `full`; packaged smoke under with-lock | IMPLEMENTED_AND_LOCALLY_VERIFIED | One display at 125 %; no Windows 10 and no mixed DPI. Never run installers, install-test or upgrade-test here (the owner's install). |
| Linux headless: typecheck, lint, vitest, build | Own container from the local `node:24-bookworm-slim` image | IMPLEMENTED_AND_LOCALLY_VERIFIED for "builds and unit tests pass on Linux" | Extra packages need the network (apt) [U]. Never touch, inspect or prune other containers or images. |
| Linux X11 app behaviour | The same container, plus Xvfb and a compositing WM for alpha [U], running Electron | REAL for "starts, creates overlays, X11 APIs answer". SIMULATED_OR_MOCK_TESTED for desktop integration (a virtual X server, no real desktop). | Chromium's sandbox in Docker may need extra privileges. A `--no-sandbox` run must be labelled as such and cannot verify the sandbox invariant [U]. |
| Linux Wayland | The same container, plus Weston with the headless backend | SIMULATED_OR_MOCK_TESTED. It shows the Wayland API gaps, not how Mutter or KWin behave. | No GNOME or KDE session available |
| Browser experience | Playwright with `channel: 'chrome'` or `'msedge'`, using the installed version 156 browsers. Playwright's bundled Chromium (revision 1248) is not installed. | IMPLEMENTED_AND_LOCALLY_VERIFIED on Windows Chrome and Edge. Mobile emulation: SIMULATED_OR_MOCK_TESTED. | Whether channel launch works is UNVERIFIED |
| Android | A new, dedicated AVD from android-35 google_apis x86_64; adb reverse to a local server; Playwright `_android` or chrome://inspect | REAL on an emulator, not a device. For physical devices: IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED. | Whether Chrome is preinstalled is UNVERIFIED. avdmanager needs the JDK inside Android Studio's jbr [U]. Never use other projects' AVDs. Heavy: take the machine lock. |
| Out of reach | macOS, iOS/iPadOS, physical phones, code signing and notarization, Play and App Store review, real GNOME/KDE/wlroots sessions, multi-monitor hardware | BLOCKED_BY_PLATFORM_OR_PERMISSION, for this machine | WSL2 Ubuntu belongs to the user and is off-limits |

## 7. Portability risks, ranked

| # | Risk | Impact | Evidence | Mitigation |
|---|---|---|---|---|
| 1 | The brand rename touches persistent identifiers (productName/userData, appId/GUID, the Run value, the exe name) | The owner and users lose their cat, settings and API key; duplicate installs; launch-at-login is silently undone | Section 4 | Rename display strings only. Pin userData first. Write an ADR and get the owner's approval for any identifier change. |
| 2 | Privacy exclusions are keyed on .exe names, and the invariant names `src/main/win32` | A future macOS or X11 window adapter matches none of them, breaking the privacy invariant while tests stay green | settings.ts:108-126; windowTracker.ts:553-596 | Before any non-Windows window adapter: a per-OS process identity, a test that every default exclusion has an entry per OS, and the owner rewording the invariant |
| 3 | Electron defaults to native Wayland (since 38.2) | No always-on-top, global cursor or positioning. On Mutter a full-screen overlay may block clicks, which violates T8. | S1, S5, S13, S18 | Force X11/XWayland, or refuse the overlay on native Wayland. Fail safe: create no overlay when click-through cannot be guaranteed. |
| 4 | The display-mapping blocker; empty-world behaviour unknown | No cat off Windows; possibly a crash loop | displayService.ts:30-31; topology.ts:104-108 | A platform pixel-mapping helper. Surface "no displays" as a startup error. Unit tests with a fake screen per platform. |
| 5 | Linux packaging versus the sandbox invariant: on Ubuntu 24.04+ AppImage launchers fall back to `--no-sandbox` | The renderer sandbox is lost | S51-S53 | deb with an AppArmor profile, or Flatpak. A smoke check that fails if `--no-sandbox` is in effect. |
| 6 | Linux safeStorage `basic_text` backend | API keys are effectively plaintext | secretStore.ts:55 | Refuse `basic_text` |
| 7 | macOS cannot be verified here; distribution needs a Developer ID and notarization | Claims could outrun evidence | Section 6 | Label it IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED. Get a macOS runner and an Apple account before any release. |
| 8 | Electron runway | 44 ends on 2027-03-02 (tentative). The pinned 44.9.3 is behind 44.10.2. 45 changes how capture permissions work. | Section 0; S11 | Bump within 44.x after a Windows regression run. Review capture.ts before moving to 45. |
| 9 | Hidden Windows assumptions in tests (login-item paths) | The first Linux run goes red for unrelated reasons | loginItem.ts:129, :143 | Use `path.win32` in the login-item logic |
| 10 | Top-level Windows packaging entries; deb/rpm metadata missing | Broken mac and linux packages | yml:21-26; FpmTarget.js:81-96 | Move them under `win:`. Add homepage, author email and desktopName. |
| 11 | Gaps in the ESLint core/shared rule | Node globals in shared/ would break the sandboxed renderers at run time | eslint.config.mjs:33 | Ban builtinModules in both forms, and add restricted globals |
| 12 | Open-source licence gaps | A non-compliant release | Section 1 | Ship a full notices file next to the exe. Drop elevate.exe. |
| 13 | Generalising the character too early | Regressions in behaviour validated for v1.2 | The sim chain of about 6,000 lines | Only type-level seams for now |
| 14 | Mobile store policy | Android overlay permission and specialUse service review; Go devices; iOS guideline 4.2 | Section 5.2 | Web first. Native mobile stays research-only. |
| 15 | No CI | No independent verification | ci.yml:3-5 | Rely on the local tiers. Prepare a CI matrix and label it unexecuted. |

## 8. Recommended direction and work plan

**Direction** (ARCHITECTURALLY_VALIDATED by code reading):
- Keep one TypeScript core, src/core plus src/shared, as the source of truth.
- Formalise a **platform layer** in src/main, chosen by a single factory.
- Express each platform's reality as a **capability model**: pure data in src/shared, reported to Settings and diagnostics with the statuses defined above.
- Treat a **browser host** as a second, fully verifiable host for the same core and renderer.
- Keep Windows as the reference implementation, with its behaviour unchanged.

**Proposed shape** (ADR 0004 decides):
- `src/shared/platform.ts` (pure data):
  - `PlatformId`.
  - Capability ids: overlay, topmost, clickThrough, globalCursor, windowSurfaces, taskbar, tabStrips, loginItem, tray, secretStorage, perceptionCapture, idle.
  - `CapabilityStatus`: one of the six statuses, plus runtime availability.
- `src/main/platform/createPlatformServices(platform)`:
  - Returns displayCoords, desktopWindows, pointer, fullscreen, taskbars, tabStrips, loginItem, overlayShell, secrets and capabilities.
  - win32 uses today's adapters unchanged; darwin and linux get start-and-degrade stubs.
- A `DisplayCoordinates` helper replaces the four Windows-only call sites. The win32 code path stays identical.
- A web host in `src/web`:
  - An in-page OverlayApi, a tick loop, gestures and localStorage persistence.
  - `renderMapping` moves into shared, and the gesture recogniser gets a touch mode.
  - No perception, no network, no key listeners and no test hooks in production.
- Character seams, type-level only:
  - An optional `kind` field (default 'cat') in PersistedCat and settings.
  - A `CharacterSpec` type for the body constants.
  - A `CharacterScene` interface between runtime.ts and CatScene.

**Waves**, ordered by the brief's priorities. Every wave ends with `verify.mjs fast`; waves that touch main or the renderer also run `full` on Windows. W5 does not depend on the platform work and can follow W1.

| Wave | Priority | Work | Exit evidence / target status |
|---|---|---|---|
| W0 | Preserve the Windows baseline | - Run `verify.mjs full` at the branch start as the baseline.<br>- No persistent-identifier changes.<br>- A test that yml appId equals the AUMID.<br>- ESLint hardening. | Windows stays IMPLEMENTED_AND_LOCALLY_VERIFIED, behaviour unchanged |
| W1 | Shared core, platform adapters, capability model | - ADR 0004 and its critique.<br>- Capability types and createPlatformServices.<br>- DisplayCoordinates.<br>- Split Win32Api (a rename only on Windows).<br>- `path.win32` in the login-item logic.<br>- Report "no displays" as a startup error. | Unit tests with a fake screen per platform (SIMULATED_OR_MOCK_TESTED for darwin and linux). Windows `full` passes. |
| W2 | macOS and Linux foundations | - Linux start-and-degrade: an X11/XWayland policy, refusing `basic_text`, an XDG autostart adapter and a tray fallback.<br>- A macOS overlay profile behind platform checks: panel window type, an app menu, a hidden Dock icon, setLoginItemSettings without args.<br>- Hide Windows-only UI through capabilities.<br>- Restructure the packaging config and add a `linux:` target (AppImage or deb). | Linux in an own container: the headless tiers are REAL; Xvfb and Weston runs are SIMULATED_OR_MOCK_TESTED. macOS: IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED. |
| W3 | Portable experience | - The web host and the touch mode.<br>- A Playwright web project (channel chrome or msedge).<br>- Mobile emulation. | Windows Chrome and Edge: IMPLEMENTED_AND_LOCALLY_VERIFIED. Mobile: SIMULATED_OR_MOCK_TESTED. An own-AVD emulator run comes later. |
| W4 | Android and iOS boundaries | - Capability rows for Android and iOS in the docs.<br>- An emulator Chrome run, in an explicitly approved phase.<br>- Native overlay, live wallpaper, widgets and everything on iOS stay research-only. | Statuses recorded honestly as BLOCKED_BY_PLATFORM_OR_PERMISSION or NOT_IMPLEMENTED |
| W5 | Branding transition | - The display-name constant.<br>- The userData pin.<br>- The builder display names.<br>- Owner decisions on the spelling and the persistent identifiers. | Unit tests. The upgrade test runs only on a disposable VM; UNVERIFIED until it has run. |
| W6 | Open-source readiness | - Notices: add zod, drop elevate.exe.<br>- SECURITY and CONTRIBUTING files; homepage and author metadata.<br>- `npm audit` (needs the network).<br>- An Electron 44.10.x bump with a Windows regression run.<br>- A prepared CI matrix, not executed. | The audit is recorded as REAL. CI is labelled absent until a run is observed. |

**Owner decisions needed before code:**
1. The GizeCat spelling, and where GizeVerse appears.
2. Freeze the persistent identifiers (recommended), or plan a migration.
3. A rewording of the invariant "window titles never leave `src/main/win32`", for future non-Windows adapters.
4. Linux scope: X11/XWayland only, with native Wayland degraded.
5. Whether an Electron patch bump belongs on this branch.

## Sources

**Electron and builder:**
- E1 https://releases.electronjs.org/schedule
- E2 https://releases.electronjs.org/releases/stable?version=44
- B1 https://www.electron.build/docs/nsis
- B2 https://www.electron.build/docs/linux
- B3 https://www.electron.build/docs/features/multi-platform-build/
- B4 https://www.electron.build/docs/features/code-signing/notarization/ (these docs are labelled v27/next; the repo pins 26.18.1)
- B5 https://www.electronjs.org/docs/latest/tutorial/asar-integrity
- W1 https://learn.microsoft.com/en-us/windows/win32/shell/appids
- G1 https://docs.github.com/en/actions/concepts/billing-and-usage

**Desktop** (numbering follows the desktop research report; [s] = seen as a search result only):
- S1 https://www.electronjs.org/docs/latest/api/browser-window
- S2 https://www.electronjs.org/docs/latest/api/structures/base-window-options
- S3 https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
- S4 https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions
- S5 https://www.electronjs.org/docs/latest/api/screen
- S6 https://www.electronjs.org/docs/latest/api/structures/display
- S7 https://www.electronjs.org/docs/latest/api/app
- S8 https://www.electronjs.org/docs/latest/api/tray
- S9 https://www.electronjs.org/docs/latest/api/system-preferences
- S10 https://www.electronjs.org/docs/latest/api/desktop-capturer
- S11 https://www.electronjs.org/docs/latest/breaking-changes
- S12 https://www.electronjs.org/blog/electron-44-0
- S13 https://www.electronjs.org/blog/tech-talk-wayland
- S14 https://releases.electronjs.org/pr/54393
- S15 https://releases.electronjs.org/release/v44.9.3
- S16 https://github.com/electron/electron/pull/54375
- S17 https://github.com/electron/electron/issues/52456
- S18 https://github.com/electron/electron/issues/51808
- S20 https://raw.githubusercontent.com/electron/electron/main/shell/browser/native_window_mac.mm
- S21 https://github.com/electron/electron/issues/42104
- S22 https://github.com/electron/electron/issues/26350 [s]
- S23 https://github.com/electron/electron/pull/21706 [s]
- S24 https://github.com/electron/electron/issues/43493
- S25 https://chromium.googlesource.com/chromium/src/+/main/ui/ozone/platform/wayland/host/wayland_screen.cc
- S26 https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)
- S27 https://developer.apple.com/documentation/coregraphics/kcgwindowname
- S28 https://developer.apple.com/forums/thread/839069
- S29 https://chromium.googlesource.com/chromium/src/+/main/ui/base/cocoa/permissions_utils.mm
- S30 https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions
- S31 https://developer.apple.com/documentation/servicemanagement/smappservice
- S32 https://developer.apple.com/documentation/appkit/nsscreen/visibleframe
- S33 https://developer.apple.com/documentation/appkit/nsscreen/screenshaveseparatespaces
- S34 https://developer.apple.com/news/?id=saqachfa
- S35 https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac
- S37 https://www.electronjs.org/docs/latest/tutorial/code-signing
- S38 https://github.com/electron/universal
- S39 https://specifications.freedesktop.org/wm/latest/ar01s03.html
- S40 https://specifications.freedesktop.org/autostart/latest/
- S41 https://specifications.freedesktop.org/status-notifier-item/latest/
- S42 https://extensions.gnome.org/extension/615/appindicator-support/
- S43 https://wayland.app/protocols/wlr-layer-shell-unstable-v1
- S44 https://wayland.app/protocols/ext-foreign-toplevel-list-v1
- S45 https://wayland.app/protocols/fractional-scale-v1
- S46 https://discourse.gnome.org/t/unable-to-call-the-remote-getwindows-gnome-method-via-dbus/21201
- S47 https://develop.kde.org/docs/plasma/kwin/api/
- S48 https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Background.html
- S50 https://docs.flatpak.org/en/latest/electron.html
- S51 https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
- S52 https://github.com/electron/electron/issues/41066
- S53 https://www.electron.build/docs/linux
- S54 https://github.com/electron/electron/issues/15198
- S55 https://github.com/electron/electron/pull/42727
- S56 https://koffi.dev/

**Web and mobile** ([\*] = REAL\*, search excerpt):
- M1 https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame [\*]
- M2 https://developer.chrome.com/blog/timer-throttling-in-chrome-88 [\*]
- M3 https://developer.chrome.com/docs/web-platform/page-lifecycle-api [\*]
- M4 https://developer.chrome.com/docs/web-platform/document-picture-in-picture [\*]
- M5 https://capacitorjs.com/docs/main/reference/support-policy [\*]
- M6 https://developer.android.com/about/versions/12/behavior-changes-all#untrusted-touch-events
- M7 https://developer.android.com/about/versions/15/behavior-changes-15#fgs-sysalert
- M8 https://developer.android.com/develop/background-work/services/fgs/service-types
- M9 https://developer.android.com/reference/android/Manifest.permission#SYSTEM_ALERT_WINDOW [\*]
- M9 also: https://support.google.com/googleplay/android-developer/answer/16558241 [\*]
- M10 https://developer.android.com/reference/android/service/wallpaper/WallpaperService.Engine [\*]
- M11 https://developer.android.com/reference/android/appwidget/AppWidgetProviderInfo [\*]
- M12 https://developer.android.com/guide/topics/ui/bubbles [\*]
- M13 https://developer.android.com/develop/ui/views/picture-in-picture [\*]
- M14 https://developer.apple.com/videos/play/wwdc2026/277/ and https://developer.apple.com/videos/play/wwdc2021/10048/ [\*]
- M15 https://developer.apple.com/videos/play/wwdc2023/10028/ [\*]
- M16 https://developer.apple.com/documentation/activitykit/activityauthorizationerror/attributestoolarge [\*]
- M17 https://developer.apple.com/app-store/review/guidelines/ (fetched)
