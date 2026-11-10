# ADR 0004 — GizeVerse: one character core, many hosts

- Status: accepted, revision 2 (2026-11-06), after an adversarial design review (see **Review** at the end). Branch `feat/gizeverse-foundation`, cut from `feat/v1.2-lively` at `58b4cd6` (v1.2.0).
- Evidence: [docs/gizeverse/00-baseline-audit.md](../gizeverse/00-baseline-audit.md). "§n" without a file means the audit; "R7" is risk 7 in audit §7; "H1", "M2", "L3" are review findings.
- Builds on ADR 0001–0003. **No invariant in CLAUDE.md changes.** The Windows behaviour validated for v1.2 stays the reference.
- **Labels.** This is design: UNVERIFIED until code implements it and its tests run. The verification statuses are the brief's six (§2.1). The declared status of every capability lives in one data table in code (`src/shared/platform.ts`), and [docs/gizeverse/capability-matrix.md](../gizeverse/capability-matrix.md) is generated from it, so the table is the claim.

## 0. Decisions at a glance

| # | Concern | Decision |
|---|---|---|
| G1 | Shape | Four layers: **character core** (src/core, src/shared), **host runtime** (`createCatHost`, which has no OS or Electron imports), **platform services** (`src/main/platform/`) and **shells** (the Electron desktop overlay and a web page). |
| G2 | Capability model | Pure data in `src/shared/platform.ts`: a declared status per platform and capability (the evidence claim), plus a runtime record in main (is it available on *this* machine, and why not). Settings, diagnostics and the generated docs read the same table. |
| G3 | Factory | `createPlatformServices(probe, screen)` owns every per-OS choice GizeVerse adds. The Windows adapters that already guard themselves (win32/, uia/, the login-item registry) are still constructed in app.ts exactly as before. |
| G4 | Coordinates | Two strategies: `win32-physical` (Electron's `dipToScreenRect` / `dipToScreenPoint`, unchanged) and `logical` everywhere else (world px = DIP, world scale 1). |
| G5 | Fail-safe overlay | An overlay exists only where click-through and staying on top can be honoured. **No overlay on native Wayland or under XWayland**, and on X11 only while a compositing manager runs. Without an overlay the app still runs its tray and Settings and says why. |
| G6 | Linux | The app never switches the display backend itself (H1). A plaintext safeStorage backend (`basic_text`, `unknown`) is refused (R6). A packaged build started with `--no-sandbox` refuses to start (R5). Idle time comes from `powerMonitor` at 1 s resolution. |
| G7 | macOS | A `panel` overlay at the `screen-saver` level that accepts the first click and is hidden from Mission Control. A minimal application menu (roles only). The Dock icon stays, and `activate` opens Settings. |
| G8 | Experience | A **web host** (`src/web`) runs the real `createCatHost`, the real sim and the real overlay renderer in one page: one logical display (the viewport), pointer input from the page, touch gestures, localStorage persistence. No perception, no network, no key listeners, no test hooks in the production build. |
| G9 | Mobile | Native Android and iOS overlays are not built. The web host is the mobile experience (Chrome on Android, Safari on iOS, in-page only). The capability table records the native options with honest statuses. |
| G10 | Character | Type-level seams only: a `CharacterDescriptor` that the cat fills. Persisted formats do not change (downgrade safety, R13). |
| G11 | Branding | Display strings say **GizeCat** ("a GizeVerse character"), drawn from one constant. Every persistent identifier is frozen and pinned by tests (§9). Installer-visible names change only after an upgrade test on a disposable machine. |
| G12 | Electron | Stays at 44.9.3 on this branch. A 44.10.x bump is the next milestone, behind a Windows regression run. Electron 45 deprecates the synchronous safeStorage API that secretStore uses (L4). |

## 1. Context

The audit found:
- the core is already platform-agnostic, and the Windows integrations load lazily and fail soft;
- the Electron display API is the one hard blocker: `dipToScreenRect` exists only on Windows, so off Windows the world stays empty and no cat appears;
- `createCatHost` bundles for the browser with no Electron or Node imports (esbuild `--platform=browser`, 114 inputs, no `electron`, no `node:*`; REAL, re-run for this ADR).

So GizeVerse does not need a rewrite. It needs one seam where platforms differ, an honest record of what each platform can do, and a second host that this machine can actually verify.

## 2. The capability model

### 2.1 Vocabulary

- `PlatformId`: `win32`, `darwin`, `linux-x11`, `linux-xwayland`, `linux-wayland`, `web`, `android`, `ios`.
- `CapabilityId`:
  - characterView, overlay, clickThrough, globalCursor
  - multiDisplay, windowSurfaces, taskbarSurfaces, tabStrips
  - activityIdle, fullscreenAware
  - loginItem, tray, globalShortcut, secretStorage, perception
  - touchInput, sound, persistence
- `VerificationStatus`, the brief's six:

| Status | Meaning here |
|---|---|
| IMPLEMENTED_AND_LOCALLY_VERIFIED | Code exists and ran on that platform here, with the result recorded in a report |
| IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Code exists behind platform checks; never executed on that platform |
| ARCHITECTURALLY_VALIDATED | The design is shown to fit (code reading, bundling); not implemented as a feature |
| SIMULATED_OR_MOCK_TESTED | Ran only against fakes or in a virtual environment (container, Xvfb, Weston, device emulation) |
| BLOCKED_BY_PLATFORM_OR_PERMISSION | The platform or a permission prevents it, or it is disabled because it could break an invariant |
| NOT_IMPLEMENTED | Nothing exists |

### 2.2 Two questions, two answers

- **Declared status** (static, `src/shared/platform.ts`): what the project claims. Unit tests enforce:
  - no IMPLEMENTED_AND_LOCALLY_VERIFIED on a platform this machine cannot run: darwin, every Linux id (containers are not a desktop session; L2), android, ios;
  - every LOCALLY_VERIFIED or SIMULATED claim names its evidence (a report anchor);
  - the overlay is BLOCKED on native Wayland, XWayland and every in-page host;
  - perception and login items are not implemented off Windows.
- **Runtime availability** (main, per launch; `src/main/platform/runtime.ts`): `{ available, reason }` per capability, starting from the declared table and only ever narrowed by observation (no displays, no compositor, keyring refused, tray failed, shortcut taken, sandbox off). It travels in `AppStatus.platform` to Settings and the diagnostics export.
- **Build and test results** ("the unit tests pass on Linux") are not capabilities. They live in the verification matrix of the GizeVerse report.

### 2.3 One table, generated docs

`node scripts/capability-matrix.mjs` renders the table (`src/shared/capabilityMatrixDoc.ts`) to `docs/gizeverse/capability-matrix.md`; `--check`, and a unit test, fail when the file is stale. The README links to it and never restates a status by hand.

## 3. Platform services

```
createPlatformServices(probe, screen) → {
  id, label,
  coordinates: DisplayCoordinates,      // §4
  overlayProfile: OverlayProfile,       // §5
  sessionEndWindow, saveOnPowerShutdown, x11CompositorRequired, trayBalloons,
  applicationMenu, activateOpensSettings, loginItemSupported, appUserModelId,
  secretBackendAllowed(backend),
}
```

- **win32** gets today's behaviour in every field (a unit test pins each one).
- **The probe** (`probeFromProcess`) reads names and presence only: whether `WAYLAND_DISPLAY`, `WAYLAND_SOCKET` or `XDG_SESSION_TYPE=wayland` indicate a Wayland session, whether `DISPLAY` is set, and an explicit `--ozone-platform` or a concrete `--ozone-platform-hint`. The diagnostics log records these booleans, never the values.
- **Platform resolution** (`resolvePlatformId`):
  - an explicit x11 inside a Wayland session is **linux-xwayland**;
  - without an explicit choice, any Wayland session is **linux-wayland**, because Electron 38+ runs native Wayland there;
  - otherwise **linux-x11**;
  - unknown operating systems fail closed to a platform without an overlay.
- **Off Windows** the existing "unavailable" stubs report window surfaces, taskbar ledges, tab strips and fullscreen detection as unavailable, with reasons.
- **Idle off Windows** comes from `powerMonitor.getSystemIdleTime()` in whole seconds. The activity monitor's coarse mode counts new input only when idle drops, and does not infer typing; a 1 s reading would otherwise look like constant input at the host's 50 ms poll, which a test shows.
- **Off Windows the cat lives on the floor only** (L1). The screen-edge walls of v1.2 need the Win32 input extensions and the fail-closed T8 obstacle guard, so they stay Windows-only.

## 4. Display coordinates

The world is in "world px". `DisplayGeometry.scaleFactor` is world px per DIP, and the cat's size is DIP × scaleFactor. So any strategy that is consistent across the display rects, the cursor and overlay-local DIP is correct.

| Strategy | Where | boundsPx / workAreaPx | Cursor | scaleFactor |
|---|---|---|---|---|
| `win32-physical` | win32 | `screen.dipToScreenRect(null, r)` (unchanged since v1.0) | `GetCursorPos`, falling back to `dipToScreenPoint` (unchanged) | the OS scale |
| `logical` | every other platform | = DIP | `getCursorScreenPoint()` | 1 |

- The renderer sizes its canvas from `window.devicePixelRatio` and only falls back to the configured scale, so a logical world stays sharp on Retina screens.
- A scale-only change on a logical platform changes nothing in the world, which is correct, because windows are DIP-sized.
- An X11-pixel strategy was dropped (L3): nothing consumes X11 pixels yet, and DIP × scale differs from them by rounding at fractional scales.
- Code: `src/core/display/coordinates.ts` (pure) and `src/main/display/coordinates.ts` (Electron). The display service, the overlay manager's `info()`, perception's capture displays and the cursor fallback all use it.
- A world without displays is logged as an error and reported in Settings. The sim falls back to its built-in display, so there is no crash loop (review, REAL from code).

## 5. Overlay profiles

| | win32 (unchanged) | darwin | linux-x11 | linux-xwayland, linux-wayland, others |
|---|---|---|---|---|
| Created | yes | yes | only while a compositing manager runs (H3) | **no** (G5, H2) |
| `type` | `toolbar` | `panel` | none (Electron documents `focusable:false` on Linux as outside window-manager control, on top on all workspaces) | n/a |
| Topmost | `screen-saver` | `screen-saver` | `setAlwaysOnTop(true)` | n/a |
| Extras | NonRudeHWND, TaskbarCreated, session-end events | `acceptFirstMouse` (M2), `hiddenInMissionControl`; no `setVisibleOnAllWorkspaces`, which would show the Dock icon and briefly hide the window (M1) | none | n/a |

- **X11 compositor gate.** `src/main/linux/x11Compositor.ts` asks libX11 (through koffi, lazily) who owns `_NET_WM_CM_S<screen>`. Any failure counts as "no compositor".
- The overlay manager's `allowOverlays` gate is read at start and with the 10 s topmost check. Closing it destroys every overlay; opening it re-creates them.
- The renderer, the hit-region poll and the hung-renderer fallback (T8) are shared on every platform.

## 6. Linux and macOS policies

**Linux.**
- **Display backend (H1).** `app.commandLine.appendSwitch('ozone-platform')` has no effect: the backend is chosen before the main script runs. The app neither relaunches nor injects flags. On a Wayland session it shows no overlay, and the message suggests an X11 session.
- **Sandbox.** A packaged build with `--no-sandbox` shows a dialog and exits. Development runs log a warning (container smoke runs may need `--no-sandbox`, and are labelled as such).
- **Secrets.** `basic_text` and `unknown` mean "no keyring", so API keys cannot be stored, and the reason is shown.
- **Tray.** The tray fires only `click`; GNOME needs the AppIndicator extension.

**macOS.**
- **Menu.** `appMenu`, `editMenu` and `windowMenu` roles, so copy and paste work in Settings.
- **Reachability (M3).** The Dock icon stays. `activate` (a Dock click, or a Finder launch while running) opens Settings like a second launch, after a 3 s grace that ignores the launch's own activation.
- **Coordinates.** Logical (points).
- **Login item.** NOT_IMPLEMENTED (§7).

**Both.**
- Perception stays fail-closed (R2: exclusions are .exe names; macOS capture needs a Screen Recording consent design).
- Window surfaces, taskbar ledges and tab strips are NOT_IMPLEMENTED.
- Before ready, `powerMonitor` `shutdown` saves the state, in place of Windows' session-end window.

## 7. Startup at sign-in off Windows

Default-on startup was verified and disclosed for the Windows installer only. Off Windows the login-item write gate has an explicit `unsupported-platform` block (L4), and the status reason says "not supported on this platform yet; nothing is registered". No autostart file or SMAppService entry is ever written, so there is no hidden persistence. XDG autostart and SMAppService are next-milestone items.

## 8. The web host (experience layer)

- **Composition.** `src/web/main.ts` composes:
  - `createCatSim` and `createCatHost`;
  - a web display service (one display, the viewport, `logical`, refreshed on resize);
  - web overlays implementing `HostOverlays`, plus an in-page `OverlayApi` installed **before** the renderer module runs (the renderer reads `window.desktopCat` at evaluation, M4);
  - unavailable stubs for the window tracker and activity monitor, imported from `win32Api.ts` directly (never `win32/index.ts`, which reaches koffi);
  - `localStorage` stores for the cat state and a settings subset, with the same zod schemas and corrupt-data recovery.
- **Routing (M4).** Pointer routing (press, drag, lost press, hit-region freshness, gestures) currently lives in overlayManager.ts, which imports Electron. The web host gets its own small router over the same gesture recognizer and hit-region rules. No Electron code is shared.
- **Touch (as built).** The router listens at the document in the capture phase, so the IPC pointer schema did not change. It translates touch into the recognizer's existing mouse vocabulary, which means `gestures.ts` is unchanged and the desktop rules carry no risk:
  - a stroke along the body pets;
  - a hold of at least 350 ms followed by movement drags;
  - a tap clicks;
  - a fling throws;
  - a long-press `contextmenu` is ignored for touch (Android raises one; M4).

  A cat-owned press suppresses the click that follows; keyboard clicks (`detail === 0`) always reach the page.
- **Security (M5).** CSP `default-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`. Zod runs `jitless` there, because its JIT probe would violate the CSP (the E2E test caught it).
  - No network requests after load, no key listeners. ESLint bans the key-event literals in `src/web`.
  - The production build (`out/web`) has no test hooks. The test build goes to `out/web-test`, and both the build and a test scan `out/web`.
  - Results: [07-web-host.md](../gizeverse/07-web-host.md).
- **Verification.** A Playwright project serves `out/web` locally and drives the installed Chrome and Edge through `channel`: REAL on Windows Chrome and Edge. Mobile viewport and touch emulation are SIMULATED_OR_MOCK_TESTED. An emulator run on a new, own AVD would be REAL for an emulator, not a device.

## 9. Branding and frozen identifiers

**Display.** `src/shared/brand.ts` holds `{ platform: 'GizeVerse', product: 'GizeCat', installedName: 'Desktop Cat', formerName: 'Desktop Cat' }`. `installedName` is what Windows shows for the installed app (shortcuts, Apps list, Task Manager › Startup apps); text that tells the user what to click there uses it. The frozen identifiers live in `src/shared/identity.ts`. `product` feeds:
- UI strings, window titles, the tray tooltip and menus;
- dialogs and notices.

About reads "GizeCat, a GizeVerse character (formerly Desktop Cat)".

**Frozen.** Each of these is pinned by a test against package.json, electron-builder.yml, installer.nsh or the code:

| Identifier | Value | Why |
|---|---|---|
| appId / AppUserModelID | `io.github.enesiltas.desktopcat` | NSIS GUID, taskbar grouping, Run value name |
| package.json `productName` = `app.getName()` | `Desktop Cat` | userData `%APPDATA%\Desktop Cat`; the single-instance lock; the macOS Keychain item (`Desktop Cat Safe Storage`) and Linux os_crypt name (M6) |
| userData folder | `Desktop Cat` | Pinned explicitly in index.ts as well, so a later productName change cannot move it |
| Windows executable | `DesktopCat` | Install folder, Run entry, pins |
| Linux executable / .desktop name | `desktop-cat` (the npm name) | Launchers and autostart entries made later |
| macOS bundle name | `Desktop Cat.app` | Login items and permissions are bundle-keyed |
| Uninstall marker | `login-item-removed-by-uninstall` | Installer contract |
| Sidecar tag, diagnostics kind, lock key | `desktop-cat-opt-outs`, `desktop-cat-diagnostics`, `desktop-cat:second-instance` | Downgrade safety, tools, lock handover |
| Environment variables | `DESKTOP_CAT_*` | Users' opt-outs and portable paths |
| Scheme and preload globals | `desktop-cat://`, `window.desktopCat`, `window.desktopCatSettings` | Security code and renderers |

**Deferred.** The builder `productName`, shortcutName, uninstallDisplayName and artifactName keep "Desktop Cat" until `upgrade-test.ps1` passes from 1.2.0 on a disposable Windows user or VM. That test must never run on this machine, because the owner's install is here. **Assets.** No new logos or assets.

## 10. Character seams (G10)

`src/shared/character.ts`: `CharacterDescriptor { kind: 'cat'; displayName; body; clips; reactions }`, filled from `shared/cat.ts`. Hosts keep importing the cat constants. The descriptor is the documented contract for a second character, so there is no generic sim and no persisted `kind` yet.

## 11. Packaging

- **Windows.** Builder configuration equivalent (review H1 corrected the wording): the same `out/` packaged with the v1.2 and the new config gives byte-identical payloads; the app code itself changed. `out/web*` is excluded from the desktop package.
  - The Windows-only entries (the UIA helper extraResources, the koffi-win32 asarUnpack) move under `win:`; a `--dir` payload diff before and after proves it.
  - **elevate.exe is not dropped** (`packElevateHelper` unchanged): that would change the installer, which cannot be install-tested here. It is listed as a notice item instead.
- **Linux.** A `linux:` section with AppImage and tar.gz, category Utility, and koffi's linux-x64 binary unpacked (the compositor probe needs it).
  - deb and rpm need a homepage and a maintainer email, which must not be invented, so they wait for the owner.
  - An AppImage on Ubuntu 24.04+ may need `--no-sandbox`, which the packaged build refuses (R5), so the AppImage is BLOCKED there until a sandbox-capable package exists.
  - Built in an own `node:24-bookworm-slim` container: REAL for "it builds".
- **macOS.** A `mac:` section (dmg and zip, x64 and arm64, category utilities). Unsigned and not notarized. It cannot be built here.
- **Scripts.** `package` (Windows, unchanged), `package:linux`, `package:mac`.

## 12. Verification plan

| Claim | How | Best status |
|---|---|---|
| Windows unchanged | `verify.mjs full`; the lively E2E subset; packaged smoke; payload diff | IMPLEMENTED_AND_LOCALLY_VERIFIED |
| Coordinates, table, policies, gates | Unit tests with fake screens, fake X11 and fake environments | SIMULATED_OR_MOCK_TESTED |
| Linux builds and unit tests | Own container: `npm ci`, typecheck, lint, vitest, build | REAL ("builds and tests on Linux"), in the verification matrix |
| Linux app under X11 | Same container, Xvfb, with and without a compositor; logs and window checks | SIMULATED_OR_MOCK_TESTED (virtual X server; may need `--no-sandbox`, labelled) |
| Linux packaging | electron-builder in the container | REAL for the artifact build only |
| macOS | Code reading and unit tests | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED |
| Web host | Playwright on Chrome and Edge; unit tests | IMPLEMENTED_AND_LOCALLY_VERIFIED (Windows Chrome/Edge) |
| Mobile web | Device emulation; optional own AVD | SIMULATED_OR_MOCK_TESTED / emulator REAL |
| Native mobile | none | NOT_IMPLEMENTED or BLOCKED_BY_PLATFORM_OR_PERMISSION |

## 13. Rejected alternatives

- **A new framework** (Tauri, Flutter, React Native). It would discard a validated Windows product to reach platforms that still need native overlay work.
- **One generic `Character` sim now.** The sim was validated as a cat; generalising it before a second character exists only risks regressions (R13).
- **Renaming persistent identifiers now.** That loses users' data and startup entries, and it cannot be tested here.
- **Switching Linux to X11 ourselves.** `appendSwitch` cannot do it (H1). A relaunch with `--ozone-platform=x11` would land in XWayland, which gets no overlay (H2), so it would only add a process restart.
- **Native Wayland overlays through layer-shell.** Electron does not expose layer-shell.
- **An Android SYSTEM_ALERT_WINDOW overlay.** Touches pass through only at ≤ 80 % opacity, and the overlay needs a reviewed foreground service; a research item only.

## 14. Risks carried forward

- **R2:** a per-OS process identity is needed before any non-Windows window adapter or perception.
- **R5:** the Linux sandbox. A packaged build refuses `--no-sandbox`, so the AppImage may be BLOCKED on Ubuntu 24.04+ until a deb with an AppArmor profile, or a Flatpak, exists.
- **R7:** macOS cannot be verified here.
- **R8 / L4:** the Electron runway. 44 is end-of-life on 2027-03-02, and 45 deprecates synchronous safeStorage.
- **H2 follow-up:** XWayland and Wayland users see no cat. A windowed or in-page companion for them is a candidate for the next milestone.
- **Branding:** half-done by design (display only). Installer names wait for an upgrade test.

## Review (revision 2)

An independent reviewer read revision 1 against the code and the Electron 44.9.3 documentation and sources.

| # | Finding | Disposition |
|---|---|---|
| H1 | `appendSwitch('ozone-platform')` cannot work; a Wayland session with both displays set would be read as X11 and get an overlay on native Wayland | **Fixed.** No switch, no relaunch; any Wayland session without an explicit choice is linux-wayland; unknown OS fails closed. Tests. |
| H2 | XWayland clients see no pointer over Wayland windows: a stale cursor could make the overlay take clicks (T8) | **Fixed.** `linux-xwayland` with no overlay. Tests. |
| H3 | An X11 overlay without a compositor may render opaque over the desktop | **Fixed.** libX11 compositor probe and the overlay gate; fail closed. Tests with fake X11; a container run with and without a compositor. |
| M1 | `setVisibleOnAllWorkspaces` shows the Dock icon and briefly hides the window | **Fixed.** Not called. |
| M2 | macOS: `acceptFirstMouse` defaults to false | **Fixed.** Set on the darwin profile. |
| M3 | macOS: a relaunch emits `activate`; the notch can hide the tray | **Fixed.** `activate` opens Settings; the Dock icon stays. |
| M4 | The web host needs `pointerType` in the schema, its own router, the bridge before the renderer, stubs without koffi, and handling of the Android long-press | **Accepted** into §8. |
| M5 | `default-src 'self'` still allows same-origin fetch; test hooks in a web build | **Accepted** into §8. |
| M6 | `app.getName()` keys the macOS Keychain and Linux os_crypt; more identifiers were missing | **Fixed** in §9. |
| L1 | Screen edges off Windows | **Fixed:** floor only. |
| L2 | Generous statuses; Linux in a container is not a desktop; the `--no-sandbox` smoke; elevate.exe changes the payload | **Fixed.** Linux ids are unreachable for LOCALLY_VERIFIED; build results go to the verification matrix; container runs are labelled; elevate.exe stays. |
| L3 | `logical` drops the OS scale; `scaled-uniform` has no consumer | **Fixed.** Logical only off Windows; scale-only changes need no world change. |
| L4 | Electron 45 safeStorage; the login-item gate closed only by accident | **Fixed** (explicit `unsupported-platform` block); runway noted. |

Confirmed sound by the reviewer (REAL):
- `setAppUserModelId` is a no-op off Windows;
- `app.dock` exists on macOS only;
- `getSelectedStorageBackend` is Linux-only and returns `unknown` before ready;
- the empty world does not crash-loop;
- the logical world is consistent across renderMapping, hit rects, Mover, simWorld and catHost;
- catHost has no Electron or Node imports;
- the ADR covers every `dipToScreen*` call site.

## Addendum: 1.4.0 (release candidate)

- Date: 2026-11-08. Branch `release/1.4.0-universal-devices`. Not released; the owner approves a release later.
- **No invariant in CLAUDE.md changes.** The Windows behaviour validated for 1.3.0 stays the reference.
- **Labels.** 1.4.0 reports use the owner's release vocabulary: IMPLEMENTED, COMPILED_OR_PACKAGED, THEORETICALLY_COMPATIBLE_NOT_EXECUTED, REQUIRES_OWNER_CREDENTIALS, BLOCKED_BY_PLATFORM, NOT_IMPLEMENTED ([docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140)). The capability table (§2) keeps its own vocabulary, and nothing in 1.4.0 has run on any device.

| # | Concern | Decision |
|---|---|---|
| W1 | Windows installers | One NSIS installer per architecture: `Desktop-Cat-Setup-<version>-x64.exe` and `-arm64.exe`. Same appId, so either installs over 1.3.0 or over the other as an upgrade. Each carries only its own koffi binary (`scripts/stage-koffi-arch.mjs` stages the ARM64 one at the lockfile's version and integrity). The ARM64-only installer refuses to run on non-Arm PCs (`customInit` in `build/installer.nsh`); the x64 installer is unchanged by construction. `scripts/check-win-payload.mjs` checks both unpacked builds statically. The ARM64 build is cross-built on x64 and has never run. |
| M-D1 | macOS surfaces | Floor only. Window surfaces, the Dock as a surface and fullscreen awareness stay NOT_IMPLEMENTED: the only permission-free window-bounds source needs native code that has never run. |
| M-D3 | macOS overlay level | **Amends G7 and §5:** the darwin panel uses the `floating` level, not `screen-saver`, so menus, the menu bar, the Dock and system alerts draw over the cat. Electron's panel joins every Space and shows over fullscreen apps, so review M1 is moot. |
| M-D4 | Dock | The Dock icon stays on by default (§6), with a darwin-only switch (`general.showDockIcon`) that sets the activation policy. Never `LSUIElement`. |
| M-D6 | Login item | **Amends §2.2 and §7:** macOS gets an opt-in login item through SMAppService (`setLoginItemSettings`), off by default, with no writes at startup and a write gate that requires a packaged build in /Applications. Linux autostart stays NOT_IMPLEMENTED. The capability test now allows an implemented login item on win32 and darwin only, and darwin's may claim code, never a platform run. |
| M-D10 | Entitlements | Hardened runtime with `com.apple.security.cs.allow-jit` only. |
| M-D11 | macOS artifacts | **Amends §11:** a macOS runner builds DMG and zip for x64, arm64 and universal through the manual `macos-packages.yml`: job `developer-id` with the owner's credentials, job `adhoc` without secrets. A Linux environment (a disposable WSL 2 distro on Windows, or a container) builds ad-hoc zips for x64 and arm64 only. Every ad-hoc file is named `-adhoc`. The bundle stays `Desktop Cat.app` (§9). |
| P1 | Tablets, web | **Amends G8 and G9:** the web host becomes an installable PWA (manifest, icons, a versioned offline service worker, a settings sheet, safe areas). The CSP adds `manifest-src` and `worker-src 'self'` and drops `data:` images. It is the iPad experience; a native iPad app was evaluated and is not justified now. |
| A1 | Tablets, Android | **Amends G9:** a native Kotlin WebView app (`android/`) serves the same `out/web` bundle from `https://appassets.androidplatform.net` with zero permissions (as decided; 1.4.1 later added four opt-in ones for an optional floating cat, [android-overlay.md](../platforms/android-overlay.md)), no cloud backup and a hardened WebView. One narrow, Android-only file bridge (`gizecatNative`, one message type) saves profile files. Capacitor was rejected ([14-android-app.md](../gizeverse/14-android-app.md)). A desktop-style overlay stays BLOCKED (§13). |
| F1 | Profile format | **Amends §10:** `src/shared/profileTransfer.ts` defines a versioned, platform-agnostic profile file (`IDENTITY.profileKind` = `gizeverse-character-profile`, format 1.0, `character: 'cat'`, at most 64 KiB). It is the first persisted character kind. An exhaustive field policy classifies every setting, so a new setting fails typecheck until it is classified. It never carries secrets, AI or perception settings, paths or device-only settings; a newer major format is refused; an import never re-enables an opt-out. Hosts: "Take your cat to another device" on the desktop (main parses and applies; the renderer never sees a path or file content), in the web app and in the Android app. |
| I1 | New frozen identifiers | `androidApplicationId` `io.github.gizeverse.gizecat`, `androidWebOrigin` `https://appassets.androidplatform.net` and `profileKind` `gizeverse-character-profile`, added to §9's list and pinned by tests. |
| R1 | Release automation | Four manual workflows (`macos-packages.yml`, `android-release.yml`, `release.yml`, `pages.yml`), with `workflow_dispatch` as their only trigger. Signing secrets live in one protected GitHub Environment per path (`macos-signing`, `android-signing`, `windows-signing`), and only the signing job names it. None has ever been started ([release automation](../platforms/release-automation.md), T22). |

Statuses per target and artifact: [docs/platforms/README.md](../platforms/README.md). Reports: [04-macos.md](../gizeverse/04-macos.md#140-update), [07-web-host.md](../gizeverse/07-web-host.md#140-the-installable-tablet-web-app), [08-mobile-boundaries.md](../gizeverse/08-mobile-boundaries.md#140-update), [14-android-app.md](../gizeverse/14-android-app.md).
