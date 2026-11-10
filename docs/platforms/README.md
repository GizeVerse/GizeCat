# GizeCat on every device (1.4.0 release candidate)

GizeCat 1.4.0 is a **release candidate. It is not released.** The current release is 1.3.0 for Windows x64. The project owner decides later whether 1.4.0 is published. **Android is released separately:** GizeCat 1.4.2 (Android-only, stable, [release page](https://github.com/GizeVerse/GizeCat/releases/tag/v1.4.2)) floats the cat over other apps; the owner used it on one physical Android phone and other devices are not individually verified. Windows and macOS are not updated by it.

**Nothing in 1.4.0 has run on any device.** The code exists, some of it was compiled or packaged, and that is all. A build is not a test. Every statement on these pages about how GizeCat behaves on a device comes from reading the code and the platform documentation.

Pages:
- [windows.md](windows.md): Windows 10/11 PCs, x64 and ARM64 (Windows on Arm).
- [macos.md](macos.md): Macs with Intel or Apple Silicon.
- [ipados.md](ipados.md): iPads, through the installable web app.
- [android.md](android.md): Android tablets, through the native app or the web app in Chrome.
- [troubleshooting.md](troubleshooting.md): the likely problems on each device, with steps.
- [profile-transfer.md](profile-transfer.md): moving a cat to another device.
- [privacy-and-permissions.md](privacy-and-permissions.md): what each version may access, stores and sends.
- [building-and-packaging.md](building-and-packaging.md): how to build each artifact.
- [release-automation.md](release-automation.md): the manual GitHub workflows, their secrets and the owner's steps.
- [signing-overview.md](signing-overview.md): where signing stands on every platform, and each artifact's exact signing status.
- [windows-signing.md](windows-signing.md): Authenticode for the Windows installers (SignPath, or your own certificate).
- [macos-signing.md](macos-signing.md): Developer ID signing, notarization and stapling.
- [android-overlay.md](android-overlay.md): the floating cat over other apps on Android (1.4.1; stable in 1.4.2): design, permissions, touch limits, install.
- [android-signing.md](android-signing.md): the owner's procedure for the Android release key.
- [release-owner-actions.md](release-owner-actions.md): everything only the owner can do, in order.

## One character, four device families

It is the same cat everywhere. Every version runs the same behaviour simulation (`src/core`), the same procedural renderer, the same gesture rules, the same coats and the same personality presets. None of them has an account, ads, analytics or telemetry. The cat and its memory stay on the device.

| Family | What you install | What it is |
|---|---|---|
| Windows PCs | `Desktop-Cat-Setup-1.4.0-x64.exe` or `Desktop-Cat-Setup-1.4.0-arm64.exe` | The desktop app: a transparent, click-through overlay over your desktop |
| Macs | `Desktop Cat.app` from `GizeCat-1.4.0-mac-x64-adhoc.zip` or `GizeCat-1.4.0-mac-arm64-adhoc.zip` (ad-hoc signed, not notarized), or from a notarized DMG or zip once the owner has built one | The same desktop app, following macOS conventions (menu bar, Dock) |
| iPads | The GizeCat web app, added to the Home Screen from Safari, once it is hosted | The cat inside its own app window |
| Android tablets | The GizeCat Android app once it is signed, the debug-signed trial APK for sideload trials, or the web app from Chrome once it is hosted | The cat inside its own app window; in the native app, optionally floating over other apps |

## What differs, and why

| Topic | Windows | macOS | iPad | Android tablet |
|---|---|---|---|---|
| Over other apps | Yes: a transparent overlay; only the cat takes clicks | Yes: the same overlay as a floating panel | No. iPadOS has no API for it (BLOCKED_BY_PLATFORM) | Opt-in, from 1.4.1 (stable in 1.4.2): a transparent window that follows the cat, behind "Display over other apps" (IMPLEMENTED; the owner used 1.4.2 on one physical phone and reports it works, other devices not verified; [guide](android-overlay.md)). Exact click-through is BLOCKED_BY_PLATFORM: touches in a small area around the cat are consumed |
| Where the cat walks | Floor, window tops and sides, the auto-hiding taskbar, Edge and Chrome tab strips | The floor of each screen only | The floor of the app window | The floor of the app window, or of the whole screen with the floating cat |
| Input | Mouse | Mouse or trackpad | Touch | Touch |
| Starts at sign-in | On by default (a one-time notice says so; you can turn it off) | Off by default; you can turn on "Open at login" | Not applicable | Not applicable |
| Screen analysis and AI vision | Optional, off by default | Not available (fails closed; no permission is requested) | Not available | Not available |
| Permissions it asks for | None (per-user install, no administrator rights) | None | None | None, unless you start the floating cat: then "Display over other apps", a foreground-service notification (Android 13+: notification permission) |
| Where the cat is stored | `%APPDATA%\Desktop Cat` | `~/Library/Application Support/Desktop Cat` | The web app's storage on the iPad | The app's private storage, or Chrome's storage |
| Updates | Install the new version over the old one | Replace the app | The host updates the files. The new version downloads in the background; close the app and open it again to start it | Install the new APK, or the web app updates as on the iPad |

**Why the cat climbs windows only on Windows.** On Windows, window positions, the taskbar and browser tab strips come from Win32 and UI Automation, and that code ran on hardware for 1.1 to 1.3. On macOS the only permission-free source of other windows' positions needs native code that has never run on a Mac, so 1.4.0 keeps the cat on the floor. Tablets show the cat inside its own window, so there are no other windows to climb; even the Android floating cat cannot see other apps' windows, so it walks only on the screen floor.

**Why tablets get the web app.** The web app is the same character code as the desktop app, it needs no permissions, and it is the only route that this project can build without store accounts. The Android app wraps that same web bundle with a hardened WebView and no permissions ([decision record](../gizeverse/14-android-app.md)). A native iPad app was evaluated and is not justified now: it would add nothing the web app cannot do, and an App Store release needs the owner's Apple Developer Program enrollment ([ipados.md](ipados.md)).

**Moving a cat between devices.** 1.4.0 adds a portable profile file. **Take your cat to another device** saves the cat to a file and loads one. Before anything changes you see what the file would change and choose what to load. Nothing is uploaded: it is a copy, not a sync. The full guide is [profile-transfer.md](profile-transfer.md). IMPLEMENTED; like everything in 1.4.0, it has never run on a device. Without it, each device and each app has its own cat.

## Status vocabulary for 1.4.0

| Status | Meaning |
|---|---|
| IMPLEMENTED | The code exists in this repository. It says nothing about running it. |
| COMPILED_OR_PACKAGED | A build or package was produced. A build is not a test. |
| THEORETICALLY_COMPATIBLE_NOT_EXECUTED | Written for that target from its documentation and source, but never run there. |
| REQUIRES_OWNER_CREDENTIALS | Needs the project owner's accounts, certificates or keys (code signing, Apple Developer Program, Google Play, a release keystore, GitHub Pages). |
| BLOCKED_BY_PLATFORM | The operating system does not allow it. |
| NOT_IMPLEMENTED | Nothing exists. |

The per-feature [capability matrix](../gizeverse/capability-matrix.md) uses an older vocabulary from ADR 0004. Its entries backed by a local run record earlier releases (1.3.0 and before) on Windows 11 and in desktop Chrome and Edge. None of the 1.4.0 changes has been run.

## Status per target

| Target | Code | Package | Runs on the device | Signing and store | Over other apps |
|---|---|---|---|---|---|
| Windows x64 (Windows 10/11) | IMPLEMENTED | COMPILED_OR_PACKAGED | THEORETICALLY_COMPATIBLE_NOT_EXECUTED for 1.4.0 (1.3.0 ran on Windows 11 x64) | REQUIRES_OWNER_CREDENTIALS (unsigned; no Microsoft Store listing) | IMPLEMENTED |
| Windows ARM64 (Windows 11 on Arm) | IMPLEMENTED | COMPILED_OR_PACKAGED (built on an x64 PC; statically inspected only) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | REQUIRES_OWNER_CREDENTIALS (unsigned) | IMPLEMENTED |
| macOS Intel (x64) | IMPLEMENTED | COMPILED_OR_PACKAGED: ad-hoc zip, statically inspected only | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | Ad-hoc signed, not notarized. Developer ID and notarization: REQUIRES_OWNER_CREDENTIALS. No Mac App Store listing | IMPLEMENTED |
| macOS Apple Silicon (arm64) | IMPLEMENTED | COMPILED_OR_PACKAGED: ad-hoc zip, statically inspected only | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | Ad-hoc signed, not notarized. Developer ID and notarization: REQUIRES_OWNER_CREDENTIALS | IMPLEMENTED |
| macOS universal | IMPLEMENTED (configuration) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED (it can only be built on a Mac) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | REQUIRES_OWNER_CREDENTIALS | IMPLEMENTED |
| iPadOS web app (Safari, Home Screen) | IMPLEMENTED | COMPILED_OR_PACKAGED (static web bundle) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | Public HTTPS hosting: REQUIRES_OWNER_CREDENTIALS (expected address `https://gizeverse.github.io/GizeCat/`, not deployed). App Store app: NOT_IMPLEMENTED | BLOCKED_BY_PLATFORM |
| Android tablet app | IMPLEMENTED | COMPILED_OR_PACKAGED (trial APK; release APK and AAB unsigned) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | REQUIRES_OWNER_CREDENTIALS (release key, Google Play, developer verification). The signing pipeline is IMPLEMENTED and has never run | Floating cat over other apps (native app, opt-in, 1.4.1): IMPLEMENTED, COMPILED_OR_PACKAGED, runtime: owner-reported working on one physical phone with 1.4.2 (stable), otherwise THEORETICALLY_COMPATIBLE_NOT_EXECUTED ([guide](android-overlay.md)). Exact click-through: BLOCKED_BY_PLATFORM |
| Android tablet web app (Chrome) | IMPLEMENTED | COMPILED_OR_PACKAGED (same web bundle) | THEORETICALLY_COMPATIBLE_NOT_EXECUTED | Public HTTPS hosting: REQUIRES_OWNER_CREDENTIALS (same expected address, not deployed) | BLOCKED_BY_PLATFORM |

Two Windows details: the x64 build on Windows 11 on Arm runs under emulation (THEORETICALLY_COMPATIBLE_NOT_EXECUTED), and the x64 build cannot run on Windows 10 on Arm, which has no x64 emulation (BLOCKED_BY_PLATFORM).

**macOS packages for this candidate.** Ad-hoc signed, not notarized zips exist for Intel and Apple Silicon. They were built with `electron-builder --mac dir` in a disposable WSL 2 distro on the Windows build PC (`npm run package:mac:adhoc-wsl`), statically inspected by `scripts/check-mac-payload.mjs`, and never run. DMG and universal builds need a Mac: electron-builder needs `hdiutil`, and `@electron/universal` refuses other hosts. The manual `macos-packages.yml` workflow makes them on a Mac runner: ad-hoc signed without secrets, Developer ID signed and notarized with the owner's secrets. It has never been started.

**The release workflows are manual and have never been started.** The default branch `main` has `ci.yml`, `installer-check.yml` and an older `release.yml`. `macos-packages.yml`, `pages.yml` and `android-release.yml` are not on `main`, so they cannot be started until the owner brings them there ([release automation](release-automation.md)).

## Status per artifact

These statuses describe the candidate build. **1.4.0 is not published**, so a file can be downloaded only once the owner attaches it to a release, with its SHA-256 in `SHA256SUMS.txt`. The candidate build's files, sizes and checksums, and the owner's steps before publishing, are in [the 1.4.0 candidate notes](../releases/1.4.0-release-candidate.md).

| Artifact | For | Built by | Status |
|---|---|---|---|
| `Desktop-Cat-Setup-1.4.0-x64.exe` | Windows 10/11 on x64 PCs | The Windows release run into `release/1.4.0/windows` on an x64 Windows PC ([steps](building-and-packaging.md#windows-x64-and-arm64)) | COMPILED_OR_PACKAGED. Unsigned. Not installed or run for 1.4.0. |
| `Desktop-Cat-Setup-1.4.0-arm64.exe` | Windows 11 on Arm PCs | The same run (cross-built), then a static payload check | COMPILED_OR_PACKAGED. Unsigned. Runtime THEORETICALLY_COMPATIBLE_NOT_EXECUTED. |
| The same two installers, Authenticode signed | Windows PCs | The manual `release.yml` workflow with `windows_signing: signpath` (SignPath, `windows-signing` environment), or `scripts/sign-windows.ps1` with your own token or cloud-HSM certificate ([Windows signing](windows-signing.md)) | REQUIRES_OWNER_CREDENTIALS. Never started. |
| `GizeCat-1.4.0-mac-x64-adhoc.zip` | Intel Macs, testing | A disposable WSL 2 distro on the Windows build PC (`npm run package:mac:adhoc-wsl`), ad-hoc signed, then a static payload check | COMPILED_OR_PACKAGED. Not notarized. Never run. |
| `GizeCat-1.4.0-mac-arm64-adhoc.zip` | Apple Silicon Macs, testing | The same run | COMPILED_OR_PACKAGED. Not notarized. Never run. |
| `GizeCat-1.4.0-mac-<x64, arm64, universal>-adhoc-macrunner.dmg` and `.zip` | Macs, testing | The manual `macos-packages.yml` workflow on a Mac runner, job `adhoc`, no secrets | THEORETICALLY_COMPATIBLE_NOT_EXECUTED. Never started. Not notarized. |
| `GizeCat-1.4.0-mac-<x64, arm64, universal>.dmg` and `.zip` | Macs | The same workflow, job `developer-id`, with the owner's Apple credentials | REQUIRES_OWNER_CREDENTIALS. Never started. |
| `GizeCat-web-1.4.0.zip` | Self-hosting the web app for iPads, Android tablets and desktop browsers | `npm run package:web` | COMPILED_OR_PACKAGED |
| The web app at a public HTTPS address | iPads, Android tablets | The manual `pages.yml` workflow (GitHub Pages) or any static host | REQUIRES_OWNER_CREDENTIALS. Expected address `https://gizeverse.github.io/GizeCat/`, **not deployed**. |
| `GizeCat-1.4.0-android-unsigned.apk` | Android tablets | `npm run android:apk` | COMPILED_OR_PACKAGED. It cannot be installed until it is signed. |
| `GizeCat-1.4.0-android-unsigned.aab` | Google Play | `npm run android:aab` | COMPILED_OR_PACKAGED. Uploading needs a signed AAB: REQUIRES_OWNER_CREDENTIALS. |
| `GizeCat-1.4.0-android.apk` and `.aab` (signed) | Android tablets, Google Play | `npm run android:release` with the owner's key, or the manual `android-release.yml` workflow ([signing](android-signing.md)) | REQUIRES_OWNER_CREDENTIALS. No key exists yet. |
| `GizeCat-1.4.0-android-trial-debugsigned.apk` | Sideload trials only | `npm run android:trial` | COMPILED_OR_PACKAGED. Signed with a debug key; never a production release. |
| `SHA256SUMS.txt` | Checking downloads | `npm run release:sums` (`scripts/release-sums.mjs`), run by the owner after the last package and attached to the release ([how](building-and-packaging.md#release-checksums)) | One line per installer, zip, DMG, APK and AAB in `release/1.4.0/{windows,mac,web,android}`. The per-folder checksum files the packaging scripts write are build by-products and are not attached. |

## Feedback

Real-world reports are how any of these statuses can move. Please use the repository's issue forms at <https://github.com/GizeVerse/GizeCat/issues>:
- **Platform report** for what happened on a Mac, an iPad, an Android tablet, a Windows on Arm PC, Windows 10 or several monitors. The form's operating-system list does not name iPadOS, Android or Windows on Arm yet; choose "Other (say below)" and name your device, its OS version and which artifact you installed.
- **Bug report** for something that went wrong.
- **Feature request** for ideas.

Do not include API keys, screenshots of other people's content or personal data. Security problems go through [SECURITY.md](../../SECURITY.md), never a public issue.
