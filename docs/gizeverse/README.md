# GizeVerse foundation: reports

Branch `feat/gizeverse-foundation`, cut from `feat/v1.2-lively` at `58b4cd6` (v1.2.0). Mission: turn Desktop Cat into GizeCat, the first character of the GizeVerse platform, on a cross-platform foundation without breaking the validated Windows app. The first public release, 1.3.0, is cut from this branch; it adds the long-run interaction fix ([13-interaction-reliability.md](13-interaction-reliability.md)).

**Labels.**
- REAL = executed here and observed.
- SIMULATED = fakes, emulation or a virtual display.
- UNVERIFIED = not executed.
- Platform statuses use the brief's six values; the [capability matrix](capability-matrix.md) is generated from code and is the single place they are stated.

## Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Baseline and architecture audit | [00-baseline-audit.md](00-baseline-audit.md) |
| 2 | Before/after architecture | [01-architecture.md](01-architecture.md) |
| 3 | Shared core and platform adapters | [01-architecture.md](01-architecture.md#shared-core-and-adapters), [ADR 0004](../adr/0004-gizeverse-platform.md) |
| 4 | Capability matrix | [capability-matrix.md](capability-matrix.md) (generated from `src/shared/platform.ts`) |
| 5 | Verification matrix | [02-verification.md](02-verification.md) |
| 6 | Windows regression | [03-windows-regression.md](03-windows-regression.md) |
| 7 | macOS | [04-macos.md](04-macos.md) |
| 8 | Linux X11 / XWayland / Wayland | [05-linux.md](05-linux.md) |
| 9 | Android | [08-mobile-boundaries.md](08-mobile-boundaries.md), [07-web-host.md](07-web-host.md) |
| 10 | iOS / iPadOS | [08-mobile-boundaries.md](08-mobile-boundaries.md) |
| 11 | Security and privacy review | [09-security-privacy.md](09-security-privacy.md) |
| 12 | Performance and dependencies | [10-performance-dependencies.md](10-performance-dependencies.md) |
| 13 | Open-source readiness | [11-open-source-readiness.md](11-open-source-readiness.md) |
| 14 | Branding | [12-branding.md](12-branding.md) |
| 15 | Build and test results with exact commands | [02-verification.md](02-verification.md#commands-and-results) |
| 16 | Unverified items needing hardware | [02-verification.md](02-verification.md#needs-hardware-or-accounts) |
| 17 | Risks and next milestone | [below](#risks-and-next-milestone), [ROADMAP.md](../../ROADMAP.md) |
| 18 | Changed files, commits, branch, status | [below](#branch-and-status) |
| 19 | Long-run interaction reliability (1.3.0): diagnosis, fix, long-run suites, soak | [13-interaction-reliability.md](13-interaction-reliability.md) |
| 20 | 1.4.0 candidate: every device, install guides and statuses per target and artifact | [docs/platforms/](../platforms/README.md) |
| 21 | 1.4.0: the Android tablet app (native WebView vs Capacitor, identifiers, permissions, backup, hardening, file bridge, signing) | [14-android-app.md](14-android-app.md) |
| 22 | 1.4.0: the installable tablet web app (PWA) | [07-web-host.md](07-web-host.md#140-the-installable-tablet-web-app) |
| 23 | 1.4.0: macOS as a desktop target (floor only, floating panel, Dock, opt-in login item, packaging) | [04-macos.md](04-macos.md#140-update) |
| 24 | 1.4.0: mobile boundaries revisited (native Android app, no native iPad app, profile format) | [08-mobile-boundaries.md](08-mobile-boundaries.md#140-update) |
| 25 | 1.4.0 decisions in the platform ADR | [ADR 0004, 1.4.0 addendum](../adr/0004-gizeverse-platform.md#addendum-140-release-candidate) |
| 26 | Building and packaging every artifact | [building-and-packaging.md](../platforms/building-and-packaging.md) |
| 27 | 1.4.0: the manual release workflows, their secrets and the owner's steps | [release-automation.md](../platforms/release-automation.md) |
| 28 | 1.4.0: signing the Android app, and Google Play readiness | [android-signing.md](../platforms/android-signing.md), [docs/store/google-play/](../store/google-play/release-readiness.md) |
| 29 | 1.4.0: troubleshooting by device | [troubleshooting.md](../platforms/troubleshooting.md) |
| 30 | 1.4.0: moving a cat to another device | [profile-transfer.md](../platforms/profile-transfer.md) |

## Status in one table

| Platform | What exists | Best evidence | Status (main capabilities) |
|---|---|---|---|
| Windows 10/11 | The full app (v1.2 behaviour, GizeCat names) | verify full, REAL lively scenarios, packaged smoke, benchmark on Windows 11 | IMPLEMENTED_AND_LOCALLY_VERIFIED |
| Web (desktop browsers) | The real character in a page; mouse and touch | Playwright on Chrome 156 and Edge 156 | IMPLEMENTED_AND_LOCALLY_VERIFIED (Windows Chrome/Edge); Firefox and Safari not run |
| Linux X11 | Overlay with a compositing manager; floor only | Debian 12 container: builds, 3755 tests, packages (REAL); the app under Xvfb with the sandbox on (SIMULATED) | SIMULATED_OR_MOCK_TESTED; one-pixel click-through gap at the overlay origin |
| Linux XWayland / Wayland | No overlay (it could block clicks); tray and Settings | unit tests | BLOCKED_BY_PLATFORM_OR_PERMISSION |
| macOS | Platform profile (panel overlay, menus, logical coordinates) | unit tests with a fake platform | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED |
| Android | The web host in a browser | desktop Chrome Pixel 7 emulation | SIMULATED_OR_MOCK_TESTED; native overlay BLOCKED |
| iOS / iPadOS | The web host in a browser | none | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED (web code); overlay BLOCKED |

## 1.4.0 release candidate

Branch `release/1.4.0-universal-devices`. **Not released**; 1.3.0 stays the current release until the owner approves 1.4.0. Nothing in 1.4.0 has run on any device. It uses its own status vocabulary (IMPLEMENTED, COMPILED_OR_PACKAGED, THEORETICALLY_COMPATIBLE_NOT_EXECUTED, REQUIRES_OWNER_CREDENTIALS, BLOCKED_BY_PLATFORM, NOT_IMPLEMENTED), defined in [docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140) with the status of every target and artifact. The table above is the 1.3.0 status and is kept as it was.

| Target | What 1.4.0 adds | Runs on the device |
|---|---|---|
| Windows x64 and ARM64 | One installer per architecture; an ARM64-only guard; a static payload check | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| macOS Intel and Apple Silicon | Floating panel, template menu-bar icon, Dock switch, opt-in login item, packaging routes, ad-hoc zips (COMPILED_OR_PACKAGED, not notarized) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| iPad | The installable web app (expected project-site address not deployed) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Android tablets | A native WebView app with a ready signing pipeline (no key exists), an optional floating cat over other apps (1.4.1: four permissions, only for it), and the installable web app | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| Every host | A portable profile file and "Take your cat to another device" to save and load it | THEORETICALLY_COMPATIBLE_NOT_EXECUTED |

## Risks and next milestone

1. **Owner decisions still open.** Security and conduct reports now go through GitHub private vulnerability reporting ([SECURITY.md](../../SECURITY.md)); no maintainer contact or legal identity is named. Still open: the deb/rpm homepage and maintainer, and whether the persistent identifiers ever change. See [11-open-source-readiness.md](11-open-source-readiness.md).
2. **The installer-name rename to GizeCat.** It needs `scripts/upgrade-test.ps1` from 1.2.0 on a disposable Windows user or VM ([12-branding.md](12-branding.md)).
3. **Electron runway.** Bump 44.9.3 → 44.10.x behind a Windows regression run. 44 is end-of-life on 2027-03-02; Electron 45 deprecates synchronous safeStorage.
4. **Real-hardware runs.**
   - The macOS checklist ([04-macos.md](04-macos.md)).
   - Linux X11 desktops, including fixing the one-pixel origin gap ([05-linux.md](05-linux.md)).
   - Windows 10 and multi-monitor.
5. **Linux packaging that keeps the sandbox** (a deb with an AppArmor profile, or a Flatpak). Without it, the AppImage is refused where it cannot sandbox.
6. **Wayland and XWayland users see no cat.** A windowed or in-page companion is the candidate.
7. **Web host size** (about 870 KB in 1.3.0, half of it zod locales). The 1.4.0 candidate adds the PWA and a native Android WebView app; Capacitor was rejected ([14-android-app.md](14-android-app.md)).
8. **R2: a per-OS process identity for the privacy exclusions** before any window adapter or perception off Windows.

## Branch and status

- **Branch:** `feat/gizeverse-foundation`; `feat/v1.2-lively` (v1.2.0) is the base. Nothing was merged into the local `main` (v1.0).
- **Commits:** 35 on top of `58b4cd6` before the 1.3.0 documentation commit (20 for the foundation, the rest for publication and the 1.3.0 interaction work). The branch log from `58b4cd6` lists them; each has a conventional message saying what it proves. The diff spans about 200 files, roughly +18k/-0.4k lines; much of it is tests, docs and evidence.
- **Main code areas:**
  - `src/shared/{platform,capabilityMatrixDoc,brand,identity,character}.ts`;
  - `src/core/display/coordinates.ts`;
  - `src/main/platform/*`, `src/main/linux/x11Compositor.ts`, `src/main/display/coordinates.ts`, `src/main/overlay/overlayProfile.ts`;
  - the wiring in `src/main/{app,index,tray}.ts`, `overlay/`, `perception/`, `lifecycle/`, `win32/activityMonitor.ts`;
  - `src/web/**` (new);
  - the Settings platform view, `electron-builder.yml`, the ESLint and tsconfig files, `scripts/{capability-matrix,serve-web}.mjs`.
- **Untouched:** the installers in `release/`, and the owner's installed app.
