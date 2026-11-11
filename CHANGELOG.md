# Changelog

GizeCat (formerly Desktop Cat). Versions follow semantic versioning. 1.3.0 is the first public release; earlier versions were built and tested locally but not published.

## 1.5.0 (Living Companion; RELEASE CANDIDATE, unpublished)

**Not published and not tagged.** The current published releases are Windows v1.3.0 and Android v1.4.2; the owner reviews and publishes 1.5.0. It covers **Windows and Android only** (macOS and iPad are not part of this release; the 1.4.0 Preview notes about them stay as they were). Desktop and web version 1.5.0 (`package.json`), Android 1.5.0, versionCode 10500 (`android/version.properties`). **Nothing in 1.5.0 has been run: no test, emulator, simulator or application launch was performed for any 1.5.0 code.** Every item below is IMPLEMENTED and statically verified (type-check, lint, read-only review) only. Overview: [docs/living-companion/README.md](docs/living-companion/README.md); draft notes: [docs/releases/1.5.0-release-candidate.md](docs/releases/1.5.0-release-candidate.md).

### Added
- **Seven selectable personalities plus Auto** (Curious, Playful, Energetic, Lazy, Shy, Mischievous, Calm; `src/core/behavior/personalityProfiles.ts`). Auto keeps the traits the cat was born with; the cat never changes the choice.
- **Mood and sleep depth** (`mood.ts`): eight moods derived from the cat's state, shown in its expression, and a sleep that deepens over time.
- **Bounded local world memory and the Cat Journal** in the persisted cat (`catState.ts`, `worldMemory.ts`): the last 16 events and the newest 60 journal entries, on this device only, clearable.
- **World events** (`src/core/events`, props in `src/renderer/overlay/props.ts`): a pure, deterministic engine with 20 everyday and 6 rare events, a random wait of 5 to 30 minutes counted from the end of the previous event, repetition control, interruption and recovery. Props are pictures: never clickable, never part of the click-through region. Wired into the simulation by `simCompanion.ts`.
- **Laser Mode** (`simLaser.ts`): a red dot the cat chases and never catches; session-only and off at every start.
- **Reduced motion**, also following the system setting (Windows and Android "remove animations").
- **New clips:** scratch, shake and confused; deep sleep; mood expression layers.
- **Sound cues** with separate Cat sounds and World sounds switches. Audio stays off by default.
- **Desktop settings:** new Companion, Audio, Accessibility & Focus and Journal pages; Personality gains the seven-profile chooser; Behaviour gains world-event settings; Interaction explains Laser mode; the tray menu and the cat's menu gain **Laser mode** / **Stop laser mode**.
- **Windows host wiring** (`src/main`): the laser dot at the real pointer position (the system cursor is untouched; not drawn over a full-screen display), the events pause, and the new actions.
- **Web and Android host** (`src/web`): the Android home panel's Companion, Personality, Behavior (world events), Interactions (Laser mode), Audio, Accessibility and Journal sections (`androidPanel.ts`), and the "stage" window that widens the floating cat's visual window while event props or the laser dot exist (`stageWindow.ts`).
- Release files named by the build: `release/1.5.0/windows/Desktop-Cat-Setup-1.5.0-x64.exe` and `-arm64.exe` (NSIS, unsigned); `release/1.5.0/android/GizeCat-1.5.0-android-trial-debugsigned.apk`, `GizeCat-1.5.0-android-unsigned.apk`, `GizeCat-1.5.0-android-unsigned.aab`; `release/1.5.0/SHA256SUMS.txt`.

### Changed
- **Companion choices travel with a saved profile** (personality, which events, pace, reduced motion, whether a journal is kept); the journal and event history themselves do not (`src/shared/profileTransfer.ts`).
- **Android panel rebuilt** around the Companion sections. The Android app version is again released together with the desktop and web version.
- Settings pages and the Android panel show live mood, activity, personality and the current or next event.
- Documentation updated: README, user guide, platform pages, release checklist.

### Privacy and permission changes
- **None new.** Screen analysis and cloud egress are still off by default; no telemetry, no keyboard hook, no clipboard capture. The laser pointer position is used only to draw the dot and is never stored, logged or sent. The journal never leaves the device. **Android still declares exactly four permissions** (`SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`) and no network permission.

### Platform limitations
- **Android Laser Mode** follows only touches and mouse or trackpad hover that Android delivers to the cat's small touch window, plus position hints from GizeCat's own app window. No global tracking; over other apps it cannot follow a finger. It needs Hunt and pounce on.
- The Android touch-window limit from 1.4.2 remains (a small area around the cat consumes touches).
- Windows: the 1.4.0 limits remain (exclusive-fullscreen games, the lock screen and administrator windows).
- Signing: the Windows installers are unsigned (SmartScreen warns, Smart App Control may block). The Android trial APK is signed with the Android **Debug** certificate and is not a Google Play package; the release APK and AAB are unsigned. No verified publisher, Play approval or malware-free claim is made.

### Known issues
- Everything is untested at runtime, so unknown defects are likely, in drawing the props and the dot, in the Android stage window, in event timing and in the new settings pages.
- Tablets and phones other than the one the owner used for 1.4.2 are not individually verified; vendor battery and overlay rules may differ.

### Not done
- No test, emulator, simulator or application launch for 1.5.0; no install of the Windows installers; no run of the Android APK. Windows on Arm has never run.
- Not published, not tagged, no hashes recorded in the repository documents (the maintainer fills them in later).
- No macOS or iPad work in this release.

## 1.4.2 (Android Floating Desktop Pet; stable Android release, 2026-11-10)

**An Android-only stable release** ([v1.4.2](https://github.com/GizeVerse/GizeCat/releases/tag/v1.4.2), tag at commit `fb0c920`; first published as a pre-release and promoted to stable and latest the same day with the same APK). Windows, macOS and the desktop/web version (`package.json`, 1.4.0) are not touched. Android 1.4.2, versionCode 10403 (`android/version.properties`), same application id and the same debug-signing identity as 1.4.1, so it installs over it. **The owner used this exact APK on one physical Android phone and reports that overlay visibility, dragging and throwing, screen-edge movement and climbing, touch interaction, interacting with apps underneath, rotation and landscape, the control panel, and app switching with persistence all worked.** That is one phone, owner-reported: other phones and tablets are not individually verified, and no automated test, emulator or simulator was used. The APK is still signed with the Android Debug certificate (not a Google Play package) and Play Protect may warn; static review is not proof of safety.

Prompted by the owner's real-phone report on 1.4.1 (overlay, landscape, rotation and taps worked; drag and throw did not, a small area around the cat ate touches, the cat never walked the screen edges, the panel was poor, and Play Protect blocked the install).

### Fixed
- **Dragging and throwing** (static diagnosis, [details](docs/platforms/android-overlay.md#why-141s-drag-and-throw-failed-static-diagnosis-142)): a touch that moved before a 350 ms still hold was read as petting, so a finger could not pick the cat up; the target was the exact footprint; and throw speed was measured from event arrival times. In the Android overlay a touch that moves now drags at once, the hit area is padded, and the gesture's own `MotionEvent` times travel to the page. The desktop and browser input paths are unchanged.
- **The touch dead zone**: the 172 × 196 dp window no longer takes touches. The cat is drawn in a non-touchable window (0.8 opacity on Android 12+, Android's pass-through rule) and a tight invisible touch window (cat + 12 dp) takes touches, and exists only while the cat takes any. Android has no input region, so that small area still consumes touches (BLOCKED_BY_PLATFORM to remove).

### Added
- **Screen-edge walking**: the cat climbs the left and right edges and meets the corners, using the shared v1.2 screen-edge engine through a new surface provider (`src/web/screenEdgeSurfaces.ts`); new optional host fields are inert on Windows. No ceiling pose; other apps' windows are not surfaces.
- **Interaction hunting from legitimate sources only**: touches on the cat, mouse/trackpad hover over it, and position hints from GizeCat's own app window. Android does not allow observing other apps' touches or pointer; no AccessibilityService, capture or listener was added.
- **A new Android home panel** (`src/web/androidPanel.ts`): status, start/stop, pause, hide, permission checklist, cat name and size, movement and behavior settings, interaction and edge switches; two columns from 720 px; the floating cat is independent of it.
- **Play Protect review** ([report](docs/platforms/android-play-protect.md)): static findings, appeal evidence and a distribution recommendation. No appeal was filed.

### Not done
- No test, emulator, simulator or device run; no publish, no tag, no appeal. No permission was added.
- The cause of the Play Protect block is unknown; nothing says the debug signature alone caused it, and no signature or store release is promised to be warning-free.

## 1.4.1 (Android-focused Preview)

**An Android-only update.** Windows and macOS are **not** updated: the Windows installers stay the 1.4.0 Preview files, macOS and iPadOS are not part of it, and `package.json` (the desktop and web version) stays 1.4.0. The Android app has its own version, 1.4.1 (`android/version.properties`, versionCode 10402). The APK is a **debug-signed preview**, not a production release and not a Google Play build. **Nothing in 1.4.1 has run on a device, an emulator or a simulator.** A build is not a test.

### Added
- **The floating cat on Android (owner-requested)** ([guide](docs/platforms/android-overlay.md)): an optional, user-started foreground service draws the cat in a small transparent overlay window that follows it over the launcher and other apps, running the same web bundle and shared cat engine. Touch, pet, drag and throw work through raw touches read natively; Pause, Hide, Stop and Settings are on the app screen and in a minimal notification; the app asks for "Display over other apps" only after an in-app explanation, only when you tap Float over apps, and works fully without it. It adds four permissions (`SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`), pinned by tests, and it never starts by itself. The 1.4.1 APK is collected into `release/1.4.1/android/`, never into `release/1.4.0/`. Exact click-through is BLOCKED_BY_PLATFORM (touches in the window's margin around the cat are consumed). **Compiled and packaged, never run on a device, emulator or simulator.** Windows, macOS and the browser web host are unchanged.

### Changed
- **The Android app's manifest** declares four permissions for the floating cat (it declared none); the privacy page, the privacy policy, the threat model (T23), the Play permission drafts and the capability matrix say so. The web privacy page's Permissions section now separates the browser (asks for nothing) from the Android app.
- **The Android version** is its own: `android/version.properties` (1.4.1, versionCode 10402) feeds Gradle, the Android build script and the bundled web app's About line. The desktop installers, the hosted web app and `package.json` keep 1.4.0.
- **Start over and loading a profile** are refused while the floating cat runs (stop it first): it owns the stored cat.

### Not done
- No test, emulator, simulator or device run. The floating cat is IMPLEMENTED and COMPILED_OR_PACKAGED only.
- Touch pass-through is limited by Android: the window is only the cat and a margin, and touches in the margin are consumed.
- Floor-only movement: other apps' windows are invisible to an app.
- Some secure or system screens hide overlays or block touches while one is above them.
- No Google Play approval is assumed or claimed; the permission and foreground-service declarations are drafted, not filed.
- The tail's inertia and the held cat's swing are reduced in the floating window.

## 1.4.0 (published 2026-11-10 as a Preview: Windows x64 and ARM64 installers and an Android trial APK)

**Not released.** 1.3.0 stays the current release until the owner publishes 1.4.0. **Nothing in 1.4.0 has run on any device.** A build is not a test. Statuses use the release vocabulary: IMPLEMENTED, COMPILED_OR_PACKAGED, THEORETICALLY_COMPATIBLE_NOT_EXECUTED, REQUIRES_OWNER_CREDENTIALS, BLOCKED_BY_PLATFORM, NOT_IMPLEMENTED. Every target and artifact: [docs/platforms/](docs/platforms/README.md).

### Added
- **Windows on Arm.** One installer per architecture: `Desktop-Cat-Setup-1.4.0-x64.exe` and `Desktop-Cat-Setup-1.4.0-arm64.exe`. Each carries only its own native library. The ARM64 installer stops with a clear message on a PC that is not Windows on Arm. A static payload check (`scripts/check-win-payload.mjs`) reads both builds without running them, and fails on any file outside the app's allow-list. Both installers are unsigned. The ARM64 build is cross-built on x64 and has never run (THEORETICALLY_COMPATIBLE_NOT_EXECUTED).
- **macOS as a desktop target** for Intel and Apple Silicon ([guide](docs/platforms/macos.md)):
  - a template menu-bar icon whose click opens the menu;
  - a Dock icon, on by default, with a "Show GizeCat in the Dock" switch;
  - an opt-in "Open at login" through macOS's login-item service, off by default;
  - an application menu without Hide, and a quick save at logout or shutdown;
  - no permission prompts: Electron's camera, microphone and Bluetooth reasons now say GizeCat never uses them;
  - Settings in macOS terms: "this Mac", "menu bar", "Open at login", Option and Command, the macOS Keychain in the API-key messages, and a note that the fullscreen setting has no effect;
  - the shortcut field accepts Command and Cmd;
  - plain Unicode icons in Settings, because the Windows icon font does not exist on a Mac;
  - rows for taskbar, tab-strip and window-hop behaviour left out where those capabilities are unavailable;
  - status checks that do not touch the Keychain while no API key is stored.

  It is floor-only (no window climbing), and it has never run on a Mac.
- **macOS packages:**
  - ad-hoc signed, **not notarized** zips for Intel and Apple Silicon: `GizeCat-1.4.0-mac-x64-adhoc.zip` and `GizeCat-1.4.0-mac-arm64-adhoc.zip`. They are built with `electron-builder --mac dir` in a disposable WSL 2 distro on Windows (`npm run package:mac:adhoc-wsl`) or in a Linux container (`npm run package:mac:adhoc-docker`). `scripts/check-mac-payload.mjs` inspects them statically. COMPILED_OR_PACKAGED, never run;
  - DMG and zip for x64, arm64 and universal, from the manual `macos-packages.yml` workflow on a Mac runner: ad-hoc signed without secrets, with `-adhoc` names, or Developer ID signed and notarized with the owner's secrets (REQUIRES_OWNER_CREDENTIALS). DMG and universal builds need a Mac. The workflow has never been started.
- **An installable web app (PWA) for tablets** ([iPad](docs/platforms/ipados.md), [Android](docs/platforms/android.md#the-web-app-in-chrome)):
  - a manifest with a stable `id`, and icons;
  - an offline service worker with a versioned cache, and one line in Settings that says where the offline copy stands;
  - a CSS-only loading screen, and a failure message after 15 seconds if the app cannot start;
  - a tablet layout with a toolbar and safe areas, a compact toolbar in narrow windows, and a Home Screen look that runs under the status bar;
  - a settings sheet (name, coat, style, size, shadow, emotes, personality, sound, storage status, Reset settings, Start over);
  - a static third-party notices page, `licenses.html`, under Settings → About. It opens offline;
  - sound that starts from a tap;
  - `npm run package:web`, which writes a self-hostable zip.

  It is prepared for the GitHub project site `https://gizeverse.github.io/GizeCat/`. That address is the expected one and **it is not deployed** (REQUIRES_OWNER_CREDENTIALS). It has never run on an iPad, an Android tablet or in a browser.
- **A native Android tablet app** ([guide](docs/platforms/android.md), [decision record](docs/gizeverse/14-android-app.md)):
  - a Kotlin WebView app around the same web bundle;
  - no internet permission, so there is no network access; no alarm, job or wake lock (as published in the 1.4.0 trial APK it had no permissions at all; preview 2 adds four for the optional floating cat, below);
  - no cloud backup, and a hardened WebView;
  - one narrow file bridge for saving profile files;
  - Back closes an open sheet first, then moves the app to the background;
  - the same third-party notices page, in the app's own files;
  - a signing pipeline: the key comes from the `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` environment variables, or else from `android/keystore.properties`. `npm run android:release` builds both outputs. A partial set stops the build and names what is missing, never a value. IMPLEMENTED; never run, because no key exists;
  - draft Google Play texts and a readiness list for the owner ([docs/store/google-play/](docs/store/google-play/release-readiness.md)). No listing exists.

  The release APK and AAB are unsigned until the owner's key exists (REQUIRES_OWNER_CREDENTIALS), and an unsigned APK cannot be installed. A debug-signed trial APK exists for sideload trials only and is never a production release. It has been compiled and packaged, never run on a device or emulator.
- **A portable profile format** (`src/shared/profileTransfer.ts`, `gizeverse-character-profile` format 1.0): the cat's identity, traits, look and preferences, and its memory only on request; never secrets, AI or perception settings, paths or device-only settings. A newer major version is refused, and an import never re-enables an opt-out. **Take your cat to another device** saves and loads it: Settings → Personality on Windows and macOS (the system's own save and open dialogs), and the settings sheet in the web app and the Android app. A preview shows what a file would change, and nothing changes until you confirm. It is a copy, not a sync ([guide](docs/platforms/profile-transfer.md)). Never run on a device.
- **Release automation** ([guide](docs/platforms/release-automation.md)). Four workflows, each manual only: `macos-packages.yml`, `android-release.yml`, `release.yml` (now with a `signpath` path that signs through SignPath, verifies every signature and compares each signed file with its unsigned input, and draft attachment) and `pages.yml`. Signing secrets live in the protected GitHub Environments `macos-signing`, `android-signing` and `windows-signing`. **None has ever been started.** `macos-packages.yml`, `pages.yml` and `android-release.yml` are not on `main`, so they cannot be started until the owner brings them there.
- **Documentation:** [troubleshooting by device](docs/platforms/troubleshooting.md), [moving a cat to another device](docs/platforms/profile-transfer.md), [Android signing](docs/platforms/android-signing.md).
- **Diagnostics:** `os.arm64Translation` (true when an x64 build runs under Rosetta or Windows on Arm emulation).
- **Signing readiness** ([overview](docs/platforms/signing-overview.md)), all never run because no credential exists:
  - Windows: SignPath CI signing in `release.yml` and a local token or cloud-HSM script (`scripts/sign-windows.ps1`), with SHA-256 and RFC 3161 timestamps. Two check tools read files without running them: `scripts/verify-windows-signature.ps1` and `scripts/compare-signed-pe.mjs`.
  - macOS: the Developer ID job checks the identity, hardened runtime, timestamp, notarization and stapling, also inside the shipped zips. It signs, notarizes (blocking) and staples each DMG. `scripts/check-mac-payload.mjs --expect-signature adhoc|cms` tells ad-hoc from real signatures.
  - Android: the signed CI path refuses debug keys and APK/AAB certificate mismatches. An owner script creates the upload key outside the repository (`scripts/android-create-upload-key.ps1`).
  - Owner steps: [release-owner-actions.md](docs/platforms/release-owner-actions.md).

### Changed
- **Windows installer file names** gain the architecture: `-x64` / `-arm64`. Shortcuts, the Apps entry and the install folder still say "Desktop Cat". The same appId means installing over 1.3.0 is an upgrade that keeps your cat (the upgrade to 1.4.0 has not been run).
- **macOS overlay level** is `floating` instead of `screen-saver`, so menus, the menu bar, the Dock and system alerts draw over the cat.
- **Web host CSP:** no `data:` images; `manifest-src` and `worker-src 'self'` added. The 1.3.0 wording "no network after load" is replaced by a precise one: the page itself can make no requests, and the only traffic is the browser loading the app's own files.
- The untrusted-text helpers moved to `src/shared/text.ts` (the old path re-exports them).
- The [capability matrix](docs/gizeverse/capability-matrix.md) marks the macOS login item as implemented and never run on a Mac, and notes which web and Android evidence is from 1.3.0.
- **Android configuration:** the Activity also handles `touchscreen` and `colorMode`, so a move to another display keeps the live page. Changes of dark mode, language, layout direction and text size still rebuild the page on purpose. The release build no longer writes version-control info into the APK.
- `THIRD_PARTY_NOTICES.md` names the product GizeCat, adds rcodesign as a build tool, and no longer says the Android app does not show the notices.

### Security
- New threat-model entries for the profile file as untrusted input, the service worker, static hosting with a meta-tag CSP and the shared `github.io` origin, the Android WebView file bridge, the static licences page, and the signing secrets of the release automation ([THREAT_MODEL.md](docs/THREAT_MODEL.md), T17–T22).
- New frozen identifiers, pinned by tests: `io.github.gizeverse.gizecat` (Android application id), `https://appassets.androidplatform.net` (Android web origin) and `gizeverse-character-profile` (profile tag).

### Not done
- No test was executed for 1.4.0. The new unit, Playwright and static tests are written and wait for the owner's run.
- No workflow in the release automation has been started.
- Authenticode signing, Developer ID signing, notarization, Android release signing, store listings, public web hosting and Android developer verification all need the owner's credentials. No store listing exists.
- Some Settings texts are still written for Windows when shown on a Mac ([limits](docs/platforms/macos.md#limitations)).

## 1.3.0 — first public release

### Fixed
- **Clicking, dragging and throwing the cat could stop working after it had run for a while.** A safety check ended any press 400 ms after Windows reported the mouse button up, even while the cat's window was still receiving the held button. That button state can read "up" by mistake, and a busy PC delays the check, so taps were lost, drags were cut short and throws fell flat, silently. The cat's own window input is now authoritative while it is alive. Also: the click guard no longer gets stuck after a bail-out or a momentarily stale window list; lock and sleep states always recover (also when Windows misses the unlock or resume event); a right-click, a hung or reloaded renderer, or a resume no longer leave a half-finished gesture behind; overlays recover after repeated renderer failures. More than 80 new tests: long-run, fuzz and 24-hour simulated suites, plus an opt-in soak of the real app, which passed a two-hour run with simulated input ([details](docs/gizeverse/13-interaction-reliability.md)).
- **Profile counters** for edge climbs, excursions, surface hops, slips and hard landings were shown in Settings but never counted.

### Added
- **GizeVerse foundation.**
  - A platform layer (`src/main/platform`) with a capability model: every capability's status on every platform is declared in code and published as [docs/gizeverse/capability-matrix.md](docs/gizeverse/capability-matrix.md).
  - **Web host:** the real cat (same simulation, host loop and renderer) in a browser page, with mouse and touch gestures, no network access after load and no key listeners ([report](docs/gizeverse/07-web-host.md)).
  - **macOS and Linux X11 foundations:**
    - overlay profiles and logical coordinates on both;
    - on X11, an overlay only while a compositing window manager runs;
    - on Wayland and XWayland, no overlay, because clicks could be blocked there.

  None of these platforms is a supported release yet ([reports](docs/gizeverse/README.md)).
- **Settings → Diagnostics → Platform** lists what this platform can and cannot do, and why.
- **Open-source files:** contributing guide, code of conduct, security policy, issue and pull-request templates, CI and release workflows, roadmap.

### Changed
- **The product is now called GizeCat**, "a GizeVerse character". Persistent identifiers are unchanged, so that existing installs keep their cat, settings, API keys and startup entry: the app ID, the `%APPDATA%\Desktop Cat` data folder, the executable name and the `DESKTOP_CAT_*` environment variables. The installer, shortcuts and Apps entry keep the name "Desktop Cat" for now.
- **Your data folder is pinned explicitly** to `%APPDATA%\Desktop Cat`, so a future product rename can never move it.

### Security
- **The packaged app refuses to start with `--no-sandbox`.** Renderers always run in Chromium's sandbox.
- **On Linux, plaintext keyring backends are refused** for API keys.
- **No new runtime dependency.** `npm audit --omit=dev`: 0 vulnerabilities.

## 1.2.0 — a lively cat (not published)

- **Livelier behaviour.** The cat explores on its own, stays on windows and browser tab strips for minutes, hunts the cursor (stalk, crouch, pounce, bat) and reacts to throws in varied ways. Utility-scored choices with needs, moods and rhythm ([ADR 0003](docs/adr/0003-lively-cat.md)).
- **Screen edges.** The cat clings to and peeks over screen edges, with a fail-closed click guard. A covered or vanished support ends in a controlled bail-out.
- **Small additions.** Personality presets, optional sound (off by default) and a behaviour profile in Diagnostics.

## 1.1.1 — reaching windows from the floor (not published)

- Leap-and-cling, top re-resolution, landing spans, and tab-strip interest for floating windows. The cat could get stuck on the floor.
- **Settings → Diagnostics → Surfaces** explains what the cat can reach.

## 1.1.0 — surfaces and startup (not published)

- **Surfaces.** Window tops and sides, browser tab strips (Edge, Chrome) and an auto-hiding taskbar as moving ledges.
- **Startup.** Starts at sign-in by default, through the per-user Run entry. Opt-outs are respected.

## 1.0.0 — first version (not published)

- One animated cat in transparent, click-through overlays on Windows 10/11, with a 24-state behaviour machine, petting, dragging and throwing.
- A Settings UI, and optional opt-in screen perception (local statistics or an AI vision model).
