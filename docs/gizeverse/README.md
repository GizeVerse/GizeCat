# GizeVerse foundation: reports

Branch `feat/gizeverse-foundation` (no remote; nothing pushed or published). It was cut from `feat/v1.2-lively` at `58b4cd6` (v1.2.0). Mission: turn Desktop Cat into GizeCat, the first character of the GizeVerse platform, on a cross-platform foundation without breaking the validated Windows app.

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

## Risks and next milestone

1. **Owner decisions before any publication.** Security and conduct contacts; the organization and repository; the deb/rpm homepage and maintainer; whether the persistent identifiers ever change. See [11-open-source-readiness.md](11-open-source-readiness.md).
2. **The installer-name rename to GizeCat.** It needs `scripts/upgrade-test.ps1` from 1.2.0 on a disposable Windows user or VM ([12-branding.md](12-branding.md)).
3. **Electron runway.** Bump 44.9.3 → 44.10.x behind a Windows regression run. 44 is end-of-life on 2027-03-02; Electron 45 deprecates synchronous safeStorage.
4. **Real-hardware runs.**
   - The macOS checklist ([04-macos.md](04-macos.md)).
   - Linux X11 desktops, including fixing the one-pixel origin gap ([05-linux.md](05-linux.md)).
   - Windows 10 and multi-monitor.
5. **Linux packaging that keeps the sandbox** (a deb with an AppArmor profile, or a Flatpak). Without it, the AppImage is refused where it cannot sandbox.
6. **Wayland and XWayland users see no cat.** A windowed or in-page companion is the candidate.
7. **Web host size** (about 870 KB, half of it zod locales), and a PWA. Optionally a Capacitor wrapper for the mobile stores.
8. **R2: a per-OS process identity for the privacy exclusions** before any window adapter or perception off Windows.

## Branch and status

- **Branch:** `feat/gizeverse-foundation`, in the worktree `.claude/worktrees/v1.1`.
  - No remote: nothing was pushed, merged or published.
  - `main` is untouched (v1.0); `feat/v1.2-lively` (v1.2.0) is the base.
- **Commits:** about 20 on top of `58b4cd6`. The branch log from `58b4cd6` lists them; each has a conventional message saying what it proves. The diff spans about 160 files, roughly +9.5k/-0.3k lines; much of it is tests, docs and evidence.
- **Main code areas:**
  - `src/shared/{platform,capabilityMatrixDoc,brand,identity,character}.ts`;
  - `src/core/display/coordinates.ts`;
  - `src/main/platform/*`, `src/main/linux/x11Compositor.ts`, `src/main/display/coordinates.ts`, `src/main/overlay/overlayProfile.ts`;
  - the wiring in `src/main/{app,index,tray}.ts`, `overlay/`, `perception/`, `lifecycle/`, `win32/activityMonitor.ts`;
  - `src/web/**` (new);
  - the Settings platform view, `electron-builder.yml`, the ESLint and tsconfig files, `scripts/{capability-matrix,serve-web}.mjs`.
- **Untouched:** the installers in `release/`, and the owner's installed app.
