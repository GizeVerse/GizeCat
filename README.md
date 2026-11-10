# GizeCat

**A small cat that lives on your screen, and never gets in the way of your clicks.**

GizeCat (formerly Desktop Cat) is the first character of **GizeVerse**, a small, open-source home for playful digital characters that share your screen. It is free, MIT-licensed, and honest about where it has actually been tested.

GizeCat is one animated, persistent cat, the same on every device. It wanders along the bottom of your screen, naps when you're away, and can be petted, picked up and thrown. On Windows it also climbs the sides of windows, walks along their tops and browser tab strips, rides an auto-hiding taskbar and hunts your cursor.

On a desktop, everything except the cat's own body stays clickable. On a tablet, the cat lives inside its own window.

![The cat's coats and poses, rendered by the app's own renderer](docs/images/skins.png)

## Get it on your device

**Current release: 1.3.0, for Windows x64** ([Releases](https://github.com/GizeVerse/GizeCat/releases), [how to install](#download-and-install-windows-1011)). It stays the current release until the owner publishes 1.4.0.

**1.4.0 is a release candidate. It is not published, and nothing in 1.4.0 has run on any device.** The table shows where each device stands. A build is not a test.

| Device | 1.4.0 candidate | Status | Signing | Guide |
|---|---|---|---|---|
| Windows x64 | `Desktop-Cat-Setup-1.4.0-x64.exe` | COMPILED_OR_PACKAGED; not run for 1.4.0 (1.3.0 ran on Windows 11 x64) | Unsigned: SmartScreen warns, Smart App Control may block it. Signed builds: REQUIRES_OWNER_CREDENTIALS | [Windows](docs/platforms/windows.md) |
| Windows ARM64 | `Desktop-Cat-Setup-1.4.0-arm64.exe` | COMPILED_OR_PACKAGED on an x64 PC; statically inspected; never run | Unsigned, as above | [Windows](docs/platforms/windows.md) |
| macOS Intel | `GizeCat-1.4.0-mac-x64-adhoc.zip` | COMPILED_OR_PACKAGED; statically inspected; never run on a Mac | Ad-hoc signed, **not notarized**: macOS blocks it until you allow it. Developer ID and notarization: REQUIRES_OWNER_CREDENTIALS | [macOS](docs/platforms/macos.md) |
| macOS Apple Silicon | `GizeCat-1.4.0-mac-arm64-adhoc.zip` | COMPILED_OR_PACKAGED; statically inspected; never run on a Mac | Ad-hoc signed, **not notarized**, as above | [macOS](docs/platforms/macos.md) |
| iPad | The web app, added to the Home Screen from Safari. Expected address `https://gizeverse.github.io/GizeCat/`, **not deployed**. | Web bundle COMPILED_OR_PACKAGED; never run on an iPad; hosting REQUIRES_OWNER_CREDENTIALS | A web app is not signed. No App Store app (NOT_IMPLEMENTED) | [iPad](docs/platforms/ipados.md) |
| Android tablets | The Android app (APK), or the same web app from Chrome once it is hosted | COMPILED_OR_PACKAGED; never run on a device or emulator | Release APK and AAB **unsigned until the owner's key exists, and an unsigned APK cannot be installed** (REQUIRES_OWNER_CREDENTIALS). A debug-signed trial APK is for sideload trials only | [Android](docs/platforms/android.md) |

What the status words mean, and the status of every file: [docs/platforms/](docs/platforms/README.md). If something does not work: [troubleshooting](docs/platforms/troubleshooting.md). GizeCat has no listing in any app store.

## Features

- **A living cat.** A 24-state behaviour simulation with needs, moods, a personality and a small memory. It explores on its own, stays on windows for minutes, hunts the pointer and reacts to throws in varied ways.
- **Original procedural art.** A vector rig drawn in code: 36 animation clips, 7 coats, an optional pixel style, and no third-party assets.
- **Click-through by design.** Only the cat's body catches the pointer. There are no global mouse or keyboard hooks.
- **Works offline; no AI required.** Screen perception is optional and **off by default**; see [Privacy and AI vision](#privacy-and-ai-vision).
- **Lightweight.** About 1–1.5 % of one CPU core while awake and under 1 % asleep on the Windows 11 test machine ([benchmark](docs/gizeverse/10-performance-dependencies.md)).
- **Settings** for appearance, behaviour, personality, privacy, AI and diagnostics, in light and dark themes, keyboard accessible.
- **Take your cat with you (1.4.0 candidate, never run on a device).** Save the cat to a file and load it on another computer, an iPad or an Android tablet. Nothing is uploaded and there is no account; it is a copy, not a sync ([how it works](docs/platforms/profile-transfer.md)).

## Download and install (Windows 10/11)

**Current release: 1.3.0**, for Windows x64. **1.4.0 is a release candidate and is not published yet.** It adds a Windows on Arm installer, macOS support (ad-hoc signed, not notarized test zips), an installable web app for iPads and Android tablets, and a native Android tablet app. None of the 1.4.0 builds has run on a device. Install guides and the status of every target: [docs/platforms/](docs/platforms/README.md).

Download the latest `Desktop-Cat-Setup-<version>.exe` from **[Releases](https://github.com/GizeVerse/GizeCat/releases)** (from 1.4.0: `Desktop-Cat-Setup-<version>-x64.exe`, or `-arm64.exe` for Windows on Arm PCs), check its SHA-256 against the release notes, and run it.
- **No admin needed.** It is a per-user install into `%LOCALAPPDATA%\Programs\DesktopCat`.
- **SmartScreen.** The installer is **not code-signed**, so Windows may warn: choose **More info → Run anyway**.
- **First start.** The cat appears at the bottom of your screen, and a Welcome page explains the controls.
- **Startup.** GizeCat starts when you sign in to Windows (a one-time notification tells you). Turn it off in Settings → General, or in Task Manager → Startup apps; an opt-out is never overridden.
- **Upgrading.** Your cat and settings are built to carry over: they live in `%APPDATA%\Desktop Cat`, which every version uses. A real upgrade from 1.0 to 1.1 kept them. For 1.2 to 1.3, the `installer-check` workflow runs the upgrade on a disposable machine; its results are in the repository's Actions tab. Quit the running cat from its tray menu first.
- **Uninstall** from Windows Settings → Apps. This removes the startup entry too.

The installer, shortcuts and Apps entry are still named **Desktop Cat**. They are renamed only after an upgrade test on a disposable machine shows that existing installs carry over ([why](docs/gizeverse/12-branding.md)).

You can also build it yourself; see [Build, run, test](#build-run-test).

## Platforms

**Windows 10/11 is the only supported platform.** Other platforms have code for them, but nothing outside Windows is a supported release until it has run on real hardware. Each capability's status is in the **[capability matrix](docs/gizeverse/capability-matrix.md)** (generated from code). The 1.4.0 candidate's status per target and per artifact is in **[docs/platforms/](docs/platforms/README.md)**.

| Platform | What exists | What has actually run |
|---|---|---|
| Windows 10/11 (x64) | The full app | Validated on Windows 11 hardware through 1.3.0 ([tested environments](#tested-environments)); the 1.4.0 installer has not been run |
| Windows on Arm (ARM64) | 1.4.0 candidate: the full app as an ARM64 installer | Built on an x64 PC and checked statically; **never run on Arm hardware** ([guide](docs/platforms/windows.md)) |
| Web browser | The real cat in a page, with mouse and touch; 1.4.0 makes it an installable web app | 1.3.0: automated tests in Chrome 156 and Edge 156 on Windows; phone layouts only under desktop-browser emulation ([report](docs/gizeverse/07-web-host.md)). The 1.4.0 web app has not run in a browser. |
| Linux, X11 session with a compositing window manager | The overlay on the screen floor (no window climbing) | Builds and passes its tests on Linux; the app has run only in a container under a virtual X server, never on a real Linux desktop. One known one-pixel click-through gap ([report](docs/gizeverse/05-linux.md)). |
| Linux, Wayland session | No overlay, on purpose: Wayland gives apps no way to stay on top and pass clicks through safely. Tray and Settings only. | Blocked by the platform |
| macOS (Intel, Apple Silicon) | 1.4.0 candidate: the desktop app on the screen floor (no window climbing), a menu-bar icon, a Dock switch, an opt-in "Open at login", no permission prompts. Ad-hoc signed, not notarized zips exist for both architectures, built in a disposable WSL 2 distro on the Windows build PC. DMG and universal builds need a Mac: the manual workflow's `adhoc` job makes them without secrets, and its `developer-id` job makes signed and notarized builds with the owner's Apple credentials. It has never been started. | Implemented and packaged; **never run on a Mac** ([guide](docs/platforms/macos.md), [report](docs/gizeverse/04-macos.md)) |
| iPad | 1.4.0 candidate: the installable web app (Safari → Share → Add to Home Screen), prepared for a GitHub project site that is not deployed. No App Store app; the cat lives inside its own window, because iPadOS lets no app draw over other apps. | **Never run on an iPad** or in Safari ([guide](docs/platforms/ipados.md)) |
| Android tablets | 1.4.0 candidate: a native app with no internet permission, and the web app installed from Chrome. The cat lives inside its own window; the native app can also float it over other apps (1.4.1, opt-in: four permissions, only for that; [guide](docs/platforms/android-overlay.md)). Release builds are unsigned until the owner's key exists; the signing pipeline is ready and has never run. | Compiled and packaged; **never run on a device or emulator** ([guide](docs/platforms/android.md), [why no click-through overlay](docs/gizeverse/08-mobile-boundaries.md)) |

## Privacy and AI vision

- **Off by default.** GizeCat works without looking at your screen. It knows where windows are, so it can climb them, and when you are idle, so it can nap. It never reads keystrokes, typed text or the clipboard. There is no telemetry.
- **Opt-in screen perception.** Two levels:
  - **Local statistics.** A short burst of tiny, masked, in-memory frames gives brightness, motion and similar coarse labels. Nothing is stored or sent.
  - **AI vision.** You configure it. It can use a local model (Ollama, OpenAI-compatible servers) or, behind a separate cloud switch, Anthropic. The cat can only pick from a fixed list of reactions.
- **Safeguards.**
  - Password managers, banking, sign-in and private-browsing windows are excluded.
  - A privacy pause and "preview what the cat sees" are in Settings › Privacy & Vision.
  - API keys are stored encrypted.

Details: [docs/PRIVACY.md](docs/PRIVACY.md), [docs/AI_SETUP.md](docs/AI_SETUP.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Contributing, roadmap, security

- **Contributing.** Issues, platform reports (especially from macOS and Linux desktops we cannot test) and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).
- **Roadmap:** [ROADMAP.md](ROADMAP.md).
- **Security issues:** please follow [SECURITY.md](SECURITY.md). Do not open a public issue.

## Controls

| Action | Result |
|---|---|
| Move the cursor back and forth over the cat | Petting (purrs, leans in) |
| Click / double-click | Ear flick or meow / happy hop (too many clicks annoy it) |
| Drag | Carry it; drop it on the floor, a window, another monitor; fling to throw |
| Right-click the cat | Pet, Call, Play, Sleep/Wake, Pause, Hide, Settings, Quit |
| Tray icon | Left-click show/hide; right-click menu (pause, interactions on/off, vision privacy pause, call, settings, quit) |
| `Ctrl+Alt+Shift+C` | Show/hide (configurable) |

In the web host: tap the cat, stroke it with a finger to pet it, or hold it and drag. On macOS (1.4.0 candidate) a click on the menu-bar icon opens its menu instead of hiding the cat, and the shortcut is `Control+Option+Shift+C`. Full guide: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## What is implemented

**Overlay & Windows integration.** Rendering adapts its frame rate (display rate while moving, ~30 fps when calm, ~20 fps asleep). One transparent, frameless, non-focusable, topmost overlay per display (sized to the work area), never moved or hidden (works around Electron's transparent-window bugs); main-process cursor polling decides click-through against the cat's reported hit region; hung/crashed renderers are forced click-through and recreated. Multi-monitor and mixed-DPI coordinates (physical px world, per-display DIP rendering), display add/remove/re-layout, auto-hide taskbars. Tray, global shortcut, single-instance lock (second launch surfaces the running cat), launch at sign-in (v1.1: on by default through the standard per-user Run entry; opt-outs in the app or in Task Manager are kept; registered only by the installed app; removed by the uninstaller), graceful quit (the cat falls asleep, state saved), session-end/suspend saves, crash guard.

**The cat.** A 24-state behaviour machine (sleeping, waking, idle, walking, running, chasing/watching the cursor, curious, inspecting/perching on windows, watching you work, playing, petted, startled, annoyed, seeking attention, resting, grooming, hiding, falling asleep, held, jumping, falling, landing, away) with an explicit transition table, priorities, dwell times, cooldowns and anti-thrash rules; utility-scored autonomous choices with bounded seeded randomness; physics (gravity, ballistic jumps onto window tops, riding moving windows, drag and throw). Persistent personality (traits), needs (energy, boredom, bond, annoyance, fear), favourite spots, learned preferences and a small memory, in a versioned schema with migration and corrupt-file recovery.

**Awareness (Tier A, always on, local).** WinEvent hooks (foreground, show/hide/destroy, minimise, move/size, cloak) with a reconcile poll; app categories from executable names; fullscreen detection (the cat gets out of the way); typing-like activity inferred from input without cursor motion (no keyboard hook); idle/return.

**Perception (optional, OFF by default).** Tier B: a ~0.3 s burst of three tiny masked in-memory frames → brightness/contrast/colourfulness/edge density/change/motion and the coarse labels dark/bright, busy/quiet, motion/still, video-like, new element (no semantic claims). Tier C: Ollama, OpenAI-compatible local servers, or Anthropic (`claude-haiku-5-5`), strict schema + 8-reaction allow-list, rate limits, circuit breaker; cloud requires a separate switch, and server-forwarded cloud models are detected and fail closed. Consent flow, exclusions (password managers, auth, banking, private browsing — including their dialogs), privacy pause, "preview what the cat sees". See [docs/PRIVACY.md](docs/PRIVACY.md) and [docs/AI_SETUP.md](docs/AI_SETUP.md).

**Settings UI.** Welcome, General, Appearance, Behavior, Interaction, Privacy & Vision, AI, Personality, Diagnostics (live resource charts, log export), About. Light/dark, keyboard accessible.

| Appearance | Privacy & Vision | Personality (dark) |
|---|---|---|
| ![Appearance page](docs/images/settings-appearance.png) | ![Privacy page](docs/images/settings-privacy.png) | ![Personality page](docs/images/settings-personality-dark.png) |

Screenshots are of the real settings window driven by the real main process (`scripts/qa-settings.mjs`); the cat sheets above are rendered by the app's own overlay renderer (`scripts/render-preview.cjs`). No screenshot of a desktop is included because that would capture other people's screen content; `scripts/qa-desktop.mjs` reproduces the on-desktop check locally.

**Security.** Sandboxed renderers, context isolation, custom scheme + strict CSP, validated IPC with sender checks, DPAPI-encrypted keys never exposed to renderers, Electron fuses on packaged builds. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

**Environment surfaces (v1.1, reachable from the floor since 1.1.1).** One physics model for every surface: the floor, window tops (DWM visual frame, Windows 11 rounded corners inset, z-order occlusion aware), window sides the cat leaps up to, catches and climbs (with corner pull-up and climbing down), browser tab strips (measured for visible floating Edge/Chrome windows, reached by climbing), and the auto-hiding taskbar as a **moving** ledge (the cat may hop on, rides it up and down, and is set down calmly when it hides; never stuck on a vanished surface). Riding follows dragged windows; covered or closed surfaces end in a calm drop or a short start. Taskbars are tracked with cheap adaptive geometry sampling (no screenshots); overlays carry `NonRudeHWND` so Windows no longer strips the taskbar's always-on-top flag, and a click guard keeps taskbar clicks and auto-hide reveals working under the cat. Tab strips of Edge and Chrome come from a small bundled UI Automation helper (`DesktopCatUia.exe`): geometry only, never tab names or page content, never clicks, scoped so the browser's web accessibility is not switched on. Each behaviour has its own switch (*Play with the taskbar*, *Climb windows*, *Walk on browser tabs*). Maximized windows offer nothing to climb (they cover the screen and their top is the screen's edge). *Settings → Diagnostics → Surfaces* explains what the cat can see and reach (counts, reasons, no titles), with optional click-through outlines on the desktop.

## GizeVerse architecture

- **Character core** (`src/core`, `src/shared`): behaviour, movement, gestures, contracts. It is platform-agnostic (ESLint-enforced) and deterministic for a seed.
- **Host runtime** (`createCatHost`): the simulation loop, with no Electron or Node imports. The desktop app and the web host run the same loop.
- **Platform services** (`src/main/platform`): every per-OS decision (coordinates, overlay profile, menus, session end, secret-storage policy, sandbox rule) and runtime capability detection, which Settings › Diagnostics › Platform shows.
- **Shells:** the Electron desktop overlay (`src/main`, `src/renderer`, `src/preload`) and the web host (`src/web`).

Design and review: [ADR 0004](docs/adr/0004-gizeverse-platform.md). Reports: [docs/gizeverse/](docs/gizeverse/README.md). Roadmap: [ROADMAP.md](ROADMAP.md).

## Not implemented / future possibilities

- Top, left and right taskbars as surfaces (they are tracked, but only bottom auto-hide taskbars are ledges); Firefox and vertical-tab layouts for tab strips.
- Sounds (meows/purrs) — not implemented.
- Multiple skins per cat at once, localisation beyond English.
- Auto-update: not implemented.
- Code signing: no build is signed with a publisher's key yet. For 1.4.0, the signing paths for Windows, macOS (Developer ID and notarization) and Android exist in manual workflows that have never been started, and they need the owner's credentials ([release automation](docs/platforms/release-automation.md)). Google Play and public web hosting also need the owner.
- The cat over other apps on iPad or Android: not possible on iPadOS, and ruled out on Android by its touch rules ([why](docs/gizeverse/08-mobile-boundaries.md)).

## Build, run, test

The desktop app requires Windows 10/11 x64. All platforms need Node 22.13+, 24 or 26 (built with Node 26.4; enforced by `engines`) and npm.

```powershell
npm ci --ignore-scripts                 # no dependency needs install scripts
node node_modules/electron/install.js   # Electron 44 downloads its binary lazily
npm run dev                             # development build + run (separate userData via --user-data-dir if desired)
npm run typecheck; npm run lint; npm test
npm run build; npx playwright test      # E2E: launches the real app (a cat appears briefly)
npm run package                         # -> release/Desktop-Cat-Setup-<version>-x64.exe (+ release/win-unpacked)
npm run package:win                     # x64 + ARM64 installers (stages the ARM64 koffi binary first)
npm run package:linux                   # Linux AppImage + tar.gz (run on Linux; see docs/gizeverse/05-linux.md)
npm run package:mac                     # macOS dmg + zip, x64 + arm64 (needs a Mac; not notarized without the owner's identity)
npm run package:mac:adhoc-wsl           # macOS ad-hoc test zips from a disposable WSL 2 distro on Windows (commit first)
npm run package:mac:adhoc-docker        # the same zips from a Linux container (commit first; Docker Desktop)
npm run build:web; npm run test:web     # web host -> out/web, and its Playwright tests (installed Chrome and Edge)
npm run package:web                     # installable web app -> release/<version>/web/ (folder, zip, SHA256SUMS)
npm run android:apk; npm run android:aab; npm run android:trial   # Android app (JDK 17+, Android SDK 36) -> release/<version>/android/
npm run android:release                 # APK + AAB; signed if a key is configured, otherwise unsigned
node scripts/capability-matrix.mjs      # regenerate docs/gizeverse/capability-matrix.md from src/shared/platform.ts
node scripts/smoke-packaged.mjs         # smoke-test the packaged exe
powershell -File scripts/install-test.ps1   # silent install -> smoke -> silent uninstall
node scripts/bench.mjs                  # resource benchmark -> out/bench/*.json
node scripts/qa-desktop.mjs             # real-desktop compositing check
npx electron scripts/render-preview.cjs # art contact sheets -> out/preview/
```

On shared machines wrap heavy commands: `node scripts/with-lock.mjs <label> -- <command>`. Every platform's setup and packaging steps: [docs/platforms/building-and-packaging.md](docs/platforms/building-and-packaging.md). The manual GitHub workflows: [docs/platforms/release-automation.md](docs/platforms/release-automation.md).

## Tested environments

| Environment | What ran | Result |
|---|---|---|
| 1.4.0 release candidate: Windows x64 and ARM64, macOS, iPad, Android tablets, the installable web app | Builds and static checks only (type checks, lint, the web bundle, both Windows installers, the ad-hoc macOS zips, the Android APK and AAB, and static inspection of what was built). No test was executed for 1.4.0. | **not run on any device**, see [docs/platforms/](docs/platforms/README.md) |
| GizeVerse foundation (2026-11-06): Windows 11, same machine | verify full (3790 unit/integration tests, 30 Playwright tests against the real app), REAL lively scenarios (window, throws, covered support, hunt, screen edge), builder-config equivalence, packaged smoke | pass, see [docs/gizeverse/03-windows-regression.md](docs/gizeverse/03-windows-regression.md) |
| Web host: Windows 11, Chrome 156, Edge 156 | 25 Playwright tests (drawing, click routing, petting, drag, persistence, no network, no key listeners), plus the same under desktop Chrome Pixel 7 emulation | pass (REAL in the browsers; phone layout SIMULATED), see [docs/gizeverse/07-web-host.md](docs/gizeverse/07-web-host.md) |
| Linux: Debian 12 container (Docker), Node 24.21, Electron 44.9.3 under Xvfb | typecheck, lint, 3755 unit tests, build, AppImage + tar.gz, overlay policy (no compositor / compositor / compositor dies), X-server click routing, packaged start with the sandbox, `--no-sandbox` refusal | pass; a 1x1 px non-click-through spot at the overlay origin (SIMULATED desktop), see [docs/gizeverse/05-linux.md](docs/gizeverse/05-linux.md) |
| macOS, iOS, Android devices, real Linux desktops | not run | **not tested**, see [docs/gizeverse/02-verification.md](docs/gizeverse/02-verification.md#needs-hardware-or-accounts) |
| Windows 11 Home 10.0.26200, x64, one 1920×1200 display at 125 %, auto-hide bottom taskbar, Edge 156, Chrome 155 | v1.1: typecheck, lint, 2834 unit/integration tests, 30 Playwright E2E tests against the real app (28 passed + 2 environment skips in the final run, all 30 passed earlier), silent install with startup registration/repair/Task-Manager-disable/upgrade/uninstall checks, a real 1.0 → 1.1 upgrade with settings migration, taskbar/z-order probe with control, UI Automation probe with own Edge/Chrome instances, packaged smoke, resource benchmark | all pass — see [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Same machine, v1.2.0 | typecheck, lint, 3645 unit/integration tests, 30 default Playwright tests against the real app, REAL scenarios with own windows (window, Edge 156 and Chrome 155 tab-strip stays through ordinary geometry updates, hunting, throws, screen edge beside a maximized window, covered support, sound), the **packaged** build going up by itself, packaged smoke, fuses, resource benchmark, behaviour band matrix (SIMULATED) | pass, with the narrow misses and open items in [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Installing 1.2.0 over a running 1.1.1, the cat on a real Windows Terminal strip, File Explorer tab strips (ship off) | not run | **not observed** |
| Same machine, v1.1.1 | typecheck, lint, 3078 unit/integration tests, 33 Playwright E2E tests (30 passed + 3 skips: the opt-in browser test, run separately, and 2 environment preconditions), REAL traversal: a fresh cat leaps onto and climbs a typical-size window and walks its top (dev build and the **packaged** build), and reaches the tab strip of an own floating Edge 156 and Chrome 155 window; packaged smoke, fuses, resource benchmark | all pass — see [docs/TEST_REPORT.md](docs/TEST_REPORT.md) |
| Installing 1.1.1 over a running 1.1.0, the user's own browser profiles | not run (the machine's real install was in use) | **not observed** |
| Reboot / sign-in start, a physically revealed taskbar with the cat riding it | registration verified on a real install; riding SIMULATED through the real app | **not observed** |
| Windows 10 | — | **not tested** (Win32 APIs used exist since 1903; expected to work) |
| Multi-monitor / mixed DPI hardware | unit-tested with synthetic layouts only | **not tested on hardware** |
| Real Ollama / LM Studio / Anthropic endpoints | adapters tested against local mock servers | **not tested against real providers** |

## Documentation

[Platforms and install guides (1.4.0 candidate)](docs/platforms/README.md) · [Troubleshooting by device](docs/platforms/troubleshooting.md) · [Take your cat to another device](docs/platforms/profile-transfer.md) · [Release automation](docs/platforms/release-automation.md) · [GizeVerse platform (ADR 0004)](docs/adr/0004-gizeverse-platform.md) · [Capability matrix](docs/gizeverse/capability-matrix.md) · [GizeVerse reports](docs/gizeverse/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Roadmap](ROADMAP.md) · [Architecture decision record](docs/adr/0001-architecture.md) · [User guide](docs/USER_GUIDE.md) · [Privacy](docs/PRIVACY.md) · [Threat model](docs/THREAT_MODEL.md) · [AI setup](docs/AI_SETUP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Test report](docs/TEST_REPORT.md) · [Release checklist](docs/RELEASE_CHECKLIST.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) · [Example settings](docs/settings.example.json) · [Research notes](docs/research/)

## License

MIT — see [LICENSE](LICENSE). Artwork is original and part of this project. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
