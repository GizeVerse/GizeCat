# GizeVerse capability matrix

<!-- Generated from src/shared/platform.ts by `node scripts/capability-matrix.mjs`. Do not edit by hand: a unit test fails when this file is stale. -->

What GizeCat claims about each capability on each platform. A status is a claim about **evidence**, not a promise; see ADR 0004 §2 and CONTRIBUTING.md. No platform other than Windows is supported until the app has run on it and the result is recorded.

## Statuses

| Short | Status | Meaning |
|---|---|---|
| VERIFIED | IMPLEMENTED_AND_LOCALLY_VERIFIED | Code exists and ran on that platform here, with the result recorded in a report |
| IMPL, UNVERIFIED | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Code exists behind platform checks; never executed on that platform |
| ARCH | ARCHITECTURALLY_VALIDATED | The design is shown to fit (code reading, bundling); not implemented as a feature |
| SIMULATED | SIMULATED_OR_MOCK_TESTED | Ran only against fakes or in a virtual environment (container, Xvfb, device emulation) |
| BLOCKED | BLOCKED_BY_PLATFORM_OR_PERMISSION | The platform or a permission prevents it, or it is disabled because it could break an invariant |
| NOT IMPL | NOT_IMPLEMENTED | Nothing exists |

## Overview

| Capability | Windows 10/11 | macOS | Linux (X11 session) | Linux (Wayland session, app under XWayland) | Linux (Wayland session, native) | Web browser (desktop) | Android | iOS / iPadOS |
|---|---|---|---|---|---|---|---|---|
| The character is shown and animated | VERIFIED | IMPL, UNVERIFIED | SIMULATED | BLOCKED | BLOCKED | VERIFIED | SIMULATED | IMPL, UNVERIFIED |
| Drawn over other apps (transparent, always on top) | VERIFIED | IMPL, UNVERIFIED | SIMULATED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Clicks pass through everywhere except the character | VERIFIED | IMPL, UNVERIFIED | SIMULATED | BLOCKED | BLOCKED | VERIFIED | BLOCKED | BLOCKED |
| Sees the pointer outside its own window | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Several displays, mixed scaling | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Climbs and walks on other apps' windows | VERIFIED | NOT IMPL | NOT IMPL | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Rides the taskbar / dock | VERIFIED | NOT IMPL | NOT IMPL | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Walks on browser tab strips | VERIFIED | NOT IMPL | NOT IMPL | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Notices when you are away | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED |
| Gets out of the way of fullscreen apps | VERIFIED | NOT IMPL | NOT IMPL | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Starts when you sign in | VERIFIED | NOT IMPL | NOT IMPL | NOT IMPL | NOT IMPL | BLOCKED | BLOCKED | BLOCKED |
| Tray / menu-bar icon | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | BLOCKED | BLOCKED | BLOCKED |
| Show/hide shortcut | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Encrypted API-key storage | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | BLOCKED | BLOCKED | BLOCKED |
| Optional screen perception (opt-in) | VERIFIED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| Touch gestures (pet, drag, throw) | NOT IMPL | NOT IMPL | NOT IMPL | NOT IMPL | NOT IMPL | IMPL, UNVERIFIED | SIMULATED | IMPL, UNVERIFIED |
| Optional sound | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED |
| Remembers the character between runs | VERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | IMPL, UNVERIFIED | VERIFIED | SIMULATED | IMPL, UNVERIFIED |

## Windows 10/11 (`win32`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | IMPLEMENTED_AND_LOCALLY_VERIFIED | Procedural rig in per-display overlays. | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Drawn over other apps (transparent, always on top) | IMPLEMENTED_AND_LOCALLY_VERIFIED | Transparent, topmost, non-focusable toolbar windows; NonRudeHWND keeps the taskbar topmost. | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Clicks pass through everywhere except the character | IMPLEMENTED_AND_LOCALLY_VERIFIED | Interactive only over the hit region while the renderer is healthy (T8). | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Sees the pointer outside its own window | IMPLEMENTED_AND_LOCALLY_VERIFIED | GetCursorPos poll in main. | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Several displays, mixed scaling | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Per-display overlays with physical-px world; unit-tested with synthetic layouts, no multi-monitor hardware here. | — |
| Climbs and walks on other apps' windows | IMPLEMENTED_AND_LOCALLY_VERIFIED | Window tops and sides via DWM frame bounds and WinEvent hooks. | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Rides the taskbar / dock | IMPLEMENTED_AND_LOCALLY_VERIFIED | Auto-hiding bottom taskbar as a moving ledge (riding a physically revealed taskbar: not observed). | [report](../../docs/TEST_REPORT.md) |
| Walks on browser tab strips | IMPLEMENTED_AND_LOCALLY_VERIFIED | Edge and Chrome tab strips via the bundled UI Automation helper (geometry only). | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Notices when you are away | IMPLEMENTED_AND_LOCALLY_VERIFIED | GetLastInputInfo; typing-like activity inferred without a keyboard hook. | [report](../../docs/TEST_REPORT.md) |
| Gets out of the way of fullscreen apps | IMPLEMENTED_AND_LOCALLY_VERIFIED | SHQueryUserNotificationState. | [report](../../docs/TEST_REPORT.md) |
| Starts when you sign in | IMPLEMENTED_AND_LOCALLY_VERIFIED | Per-user Run entry written by the installed app; opt-outs respected. | [report](../../docs/TEST_REPORT.md) |
| Tray / menu-bar icon | IMPLEMENTED_AND_LOCALLY_VERIFIED | Tray icon and menu. | [report](../../docs/TEST_REPORT.md) |
| Show/hide shortcut | IMPLEMENTED_AND_LOCALLY_VERIFIED | Ctrl+Alt+Shift+C (configurable). | [report](../../docs/TEST_REPORT.md) |
| Encrypted API-key storage | IMPLEMENTED_AND_LOCALLY_VERIFIED | safeStorage (DPAPI). | [report](../../docs/TEST_REPORT.md) |
| Optional screen perception (opt-in) | IMPLEMENTED_AND_LOCALLY_VERIFIED | Opt-in, off by default; privacy gate in main; exclusions by executable name. | [report](../../docs/TEST_REPORT.md) |
| Touch gestures (pet, drag, throw) | NOT_IMPLEMENTED | The desktop overlay is driven by the mouse; no touchscreen was available to test. | — |
| Optional sound | IMPLEMENTED_AND_LOCALLY_VERIFIED | Optional WebAudio cues, off by default. | [report](../../docs/TEST_REPORT.md#v120-2026-11-05-a-lively-cat) |
| Remembers the character between runs | IMPLEMENTED_AND_LOCALLY_VERIFIED | Versioned JSON in %APPDATA%, corrupt-file recovery. | [report](../../docs/TEST_REPORT.md) |

## macOS (`darwin`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same renderer; overlays use logical coordinates (points). On the floor of the work area only. | — |
| Drawn over other apps (transparent, always on top) | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Panel-type, screen-saver level, accepts the first click, hidden from Mission Control. Never run on a Mac. | — |
| Clicks pass through everywhere except the character | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | setIgnoreMouseEvents plus the shared hit-region poll. Never run on a Mac. | — |
| Sees the pointer outside its own window | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | screen.getCursorScreenPoint (documented to need no permission). | — |
| Several displays, mixed scaling | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Logical coordinates (points) avoid mixed-scale overlap; synthetic layouts only. | — |
| Climbs and walks on other apps' windows | NOT_IMPLEMENTED | Needs window geometry of other apps and a consent design (Screen Recording / Accessibility). | — |
| Rides the taskbar / dock | NOT_IMPLEMENTED | The Dock is not modelled as a surface. | — |
| Walks on browser tab strips | NOT_IMPLEMENTED | Windows UI Automation only. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | powerMonitor.getSystemIdleTime. | — |
| Gets out of the way of fullscreen apps | NOT_IMPLEMENTED | No fullscreen detection off Windows yet. | — |
| Starts when you sign in | NOT_IMPLEMENTED | Not implemented on this platform yet (ADR 0004 §7); nothing is registered. | — |
| Tray / menu-bar icon | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Menu-bar icon; the Dock icon stays, and clicking it opens Settings. | — |
| Show/hide shortcut | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Electron globalShortcut (Control+Option+Shift+C). | — |
| Encrypted API-key storage | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | safeStorage (Keychain). | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Fails closed: exclusions are Windows executable names and capture needs a Screen Recording consent design. | — |
| Touch gestures (pet, drag, throw) | NOT_IMPLEMENTED | Desktop overlay is pointer-driven. | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same WebAudio cues. | — |
| Remembers the character between runs | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | JSON in ~/Library/Application Support. | — |

## Linux (X11 session) (`linux-x11`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | SIMULATED_OR_MOCK_TESTED | Ran under Xvfb in a container (Chromium sandbox on): created with a compositing manager, on the floor only. No real desktop session. | [report](../../docs/gizeverse/05-linux.md#the-app-under-xvfb-simulated-desktop) |
| Drawn over other apps (transparent, always on top) | SIMULATED_OR_MOCK_TESTED | Override-redirect window, created only while a compositing manager owns _NET_WM_CM_S<n>, withdrawn when it stops (Xvfb + xcompmgr). | [report](../../docs/gizeverse/05-linux.md#the-app-under-xvfb-simulated-desktop) |
| Clicks pass through everywhere except the character | SIMULATED_OR_MOCK_TESTED | X-server click routing passes through the overlay, except one pixel: Chromium leaves a 1x1 input rectangle at the window origin (a click at the top-left corner is swallowed). | [report](../../docs/gizeverse/05-linux.md#the-app-under-xvfb-simulated-desktop) |
| Sees the pointer outside its own window | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | screen.getCursorScreenPoint (X11 pointer query). | — |
| Several displays, mixed scaling | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Logical coordinates; synthetic layouts only. | — |
| Climbs and walks on other apps' windows | NOT_IMPLEMENTED | _NET_CLIENT_LIST_STACKING could provide geometry; not implemented. | — |
| Rides the taskbar / dock | NOT_IMPLEMENTED | Panels are not modelled as surfaces. | — |
| Walks on browser tab strips | NOT_IMPLEMENTED | Windows UI Automation only. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | powerMonitor.getSystemIdleTime. | — |
| Gets out of the way of fullscreen apps | NOT_IMPLEMENTED | No fullscreen detection off Windows yet. | — |
| Starts when you sign in | NOT_IMPLEMENTED | XDG autostart not implemented yet (ADR 0004 §7); nothing is written. | — |
| Tray / menu-bar icon | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | StatusNotifier tray; GNOME needs the AppIndicator extension. | — |
| Show/hide shortcut | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Electron globalShortcut (X11 key grab). | — |
| Encrypted API-key storage | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | safeStorage via libsecret or KWallet; the plaintext basic_text backend is refused. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Fails closed: no per-OS process identity for privacy exclusions yet. | — |
| Touch gestures (pet, drag, throw) | NOT_IMPLEMENTED | Desktop overlay is pointer-driven. | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same WebAudio cues. | — |
| Remembers the character between runs | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | JSON in ~/.config. | — |

## Linux (Wayland session, app under XWayland) (`linux-xwayland`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | BLOCKED_BY_PLATFORM_OR_PERMISSION | No overlay under XWayland: X11 apps do not see the pointer over Wayland windows, so a stale position could make the overlay take clicks (T8). Use an X11 session. | — |
| Drawn over other apps (transparent, always on top) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Disabled until verified on real hardware (review H2). | — |
| Clicks pass through everywhere except the character | BLOCKED_BY_PLATFORM_OR_PERMISSION | See overlay. | — |
| Sees the pointer outside its own window | BLOCKED_BY_PLATFORM_OR_PERMISSION | XWayland reports the pointer only over X11 windows. | — |
| Several displays, mixed scaling | BLOCKED_BY_PLATFORM_OR_PERMISSION | No overlay. | — |
| Climbs and walks on other apps' windows | BLOCKED_BY_PLATFORM_OR_PERMISSION | Wayland windows are not visible to X11 clients. | — |
| Rides the taskbar / dock | BLOCKED_BY_PLATFORM_OR_PERMISSION | Shell geometry is not exposed. | — |
| Walks on browser tab strips | BLOCKED_BY_PLATFORM_OR_PERMISSION | Windows UI Automation only. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | powerMonitor.getSystemIdleTime. | — |
| Gets out of the way of fullscreen apps | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed to X11 clients for Wayland windows. | — |
| Starts when you sign in | NOT_IMPLEMENTED | XDG autostart not implemented yet. | — |
| Tray / menu-bar icon | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | StatusNotifier tray (desktop dependent). | — |
| Show/hide shortcut | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | X11 key grab; may only work while an X11 window has focus. | — |
| Encrypted API-key storage | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | safeStorage via libsecret or KWallet; basic_text refused. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | No per-OS privacy identity; fails closed. | — |
| Touch gestures (pet, drag, throw) | NOT_IMPLEMENTED | No overlay. | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same WebAudio cues (Settings only). | — |
| Remembers the character between runs | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | JSON in ~/.config. | — |

## Linux (Wayland session, native) (`linux-wayland`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | BLOCKED_BY_PLATFORM_OR_PERMISSION | No overlay on native Wayland (see overlay); sign in to an X11 session. | — |
| Drawn over other apps (transparent, always on top) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Wayland gives clients no always-on-top or positioning; a full-screen overlay could block clicks (T8), so none is created. | — |
| Clicks pass through everywhere except the character | BLOCKED_BY_PLATFORM_OR_PERMISSION | Input regions may apply late on Mutter; the overlay is not created. | — |
| Sees the pointer outside its own window | BLOCKED_BY_PLATFORM_OR_PERMISSION | Wayland does not expose the global pointer to clients. | — |
| Several displays, mixed scaling | BLOCKED_BY_PLATFORM_OR_PERMISSION | Window positioning is not available to clients. | — |
| Climbs and walks on other apps' windows | BLOCKED_BY_PLATFORM_OR_PERMISSION | Other windows are not visible to clients by design. | — |
| Rides the taskbar / dock | BLOCKED_BY_PLATFORM_OR_PERMISSION | Shell geometry is not exposed. | — |
| Walks on browser tab strips | BLOCKED_BY_PLATFORM_OR_PERMISSION | Windows UI Automation only. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | powerMonitor.getSystemIdleTime (may report 0 on some compositors). | — |
| Gets out of the way of fullscreen apps | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed to clients. | — |
| Starts when you sign in | NOT_IMPLEMENTED | XDG autostart not implemented yet. | — |
| Tray / menu-bar icon | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | StatusNotifier tray (desktop dependent). | — |
| Show/hide shortcut | BLOCKED_BY_PLATFORM_OR_PERMISSION | Global key grabs need the GlobalShortcuts portal; not implemented. | — |
| Encrypted API-key storage | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | safeStorage via libsecret or KWallet; basic_text refused. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Needs the ScreenCast portal and a per-OS privacy identity. | — |
| Touch gestures (pet, drag, throw) | NOT_IMPLEMENTED | Desktop overlay is not created. | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same WebAudio cues (Settings only). | — |
| Remembers the character between runs | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | JSON in ~/.config. | — |

## Web browser (desktop) (`web`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | IMPLEMENTED_AND_LOCALLY_VERIFIED | The real sim, host and renderer in a page (Chrome 156 and Edge 156 on Windows 11). | [report](../../docs/gizeverse/07-web-host.md#results) |
| Drawn over other apps (transparent, always on top) | BLOCKED_BY_PLATFORM_OR_PERMISSION | A web page cannot draw over other apps; the character lives inside the page. | — |
| Clicks pass through everywhere except the character | IMPLEMENTED_AND_LOCALLY_VERIFIED | In-page: the page keeps its clicks outside the hit region; a press on the cat stays with the cat. | [report](../../docs/gizeverse/07-web-host.md#results) |
| Sees the pointer outside its own window | BLOCKED_BY_PLATFORM_OR_PERMISSION | Browsers report the pointer only over the page. | — |
| Several displays, mixed scaling | BLOCKED_BY_PLATFORM_OR_PERMISSION | One viewport. | — |
| Climbs and walks on other apps' windows | BLOCKED_BY_PLATFORM_OR_PERMISSION | Browsers do not expose other windows. | — |
| Rides the taskbar / dock | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed to pages. | — |
| Walks on browser tab strips | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed to pages. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Idle from page pointer events; a hidden tab suspends the host (tested with a faked visibilityState only). | — |
| Gets out of the way of fullscreen apps | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed to pages. | — |
| Starts when you sign in | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not available to web pages. | — |
| Tray / menu-bar icon | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not available to web pages. | — |
| Show/hide shortcut | BLOCKED_BY_PLATFORM_OR_PERMISSION | Pages receive keys only while focused; no key listeners by design. | — |
| Encrypted API-key storage | BLOCKED_BY_PLATFORM_OR_PERMISSION | No secrets: the web host has no AI or network features. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not offered on the web host (no screen access, no network). | — |
| Touch gestures (pet, drag, throw) | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Touch routing exists and passed under device emulation (see Android); no touch-screen PC was tested. | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | The same WebAudio cues as the desktop; not tested in the web host. | — |
| Remembers the character between runs | IMPLEMENTED_AND_LOCALLY_VERIFIED | localStorage, validated with the desktop migrations; a reload keeps the cat. | [report](../../docs/gizeverse/07-web-host.md#results) |

## Android (`android`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | SIMULATED_OR_MOCK_TESTED | The web host under desktop Chrome's Pixel 7 emulation; never run on Android or its Chrome. | [report](../../docs/gizeverse/07-web-host.md#results) |
| Drawn over other apps (transparent, always on top) | BLOCKED_BY_PLATFORM_OR_PERMISSION | SYSTEM_ALERT_WINDOW needs a permission, and since Android 12 touches pass through only at ≤ 80 % opacity. | — |
| Clicks pass through everywhere except the character | BLOCKED_BY_PLATFORM_OR_PERMISSION | See overlay. | — |
| Sees the pointer outside its own window | BLOCKED_BY_PLATFORM_OR_PERMISSION | Touch devices have no hovering pointer outside the app. | — |
| Several displays, mixed scaling | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable to the in-page host. | — |
| Climbs and walks on other apps' windows | BLOCKED_BY_PLATFORM_OR_PERMISSION | Other apps are not visible. | — |
| Rides the taskbar / dock | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Walks on browser tab strips | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same web code (page pointer idle); not run on Android. | — |
| Gets out of the way of fullscreen apps | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Starts when you sign in | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Tray / menu-bar icon | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Show/hide shortcut | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Encrypted API-key storage | BLOCKED_BY_PLATFORM_OR_PERMISSION | No secrets on the web host. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | MediaProjection needs per-session consent; not offered. | — |
| Touch gestures (pet, drag, throw) | SIMULATED_OR_MOCK_TESTED | Tap, stroke-to-pet and hold-to-drag passed under Pixel 7 emulation (touch through the DevTools protocol). | [report](../../docs/gizeverse/07-web-host.md#results) |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same web code; not run on Android. | — |
| Remembers the character between runs | SIMULATED_OR_MOCK_TESTED | Reload keeps the cat under Pixel 7 emulation. | [report](../../docs/gizeverse/07-web-host.md#results) |

## iOS / iPadOS (`ios`)

| Capability | Status | Note | Evidence |
|---|---|---|---|
| The character is shown and animated | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | The web host is plain web code, but it has never run in WebKit or Safari. | — |
| Drawn over other apps (transparent, always on top) | BLOCKED_BY_PLATFORM_OR_PERMISSION | iOS has no public API for drawing over other apps. | — |
| Clicks pass through everywhere except the character | BLOCKED_BY_PLATFORM_OR_PERMISSION | See overlay. | — |
| Sees the pointer outside its own window | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Several displays, mixed scaling | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable to the in-page host. | — |
| Climbs and walks on other apps' windows | BLOCKED_BY_PLATFORM_OR_PERMISSION | Other apps are not visible. | — |
| Rides the taskbar / dock | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Walks on browser tab strips | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Notices when you are away | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same web code; never run in Safari. | — |
| Gets out of the way of fullscreen apps | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not exposed. | — |
| Starts when you sign in | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Tray / menu-bar icon | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Show/hide shortcut | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not applicable. | — |
| Encrypted API-key storage | BLOCKED_BY_PLATFORM_OR_PERMISSION | No secrets on the web host. | — |
| Optional screen perception (opt-in) | BLOCKED_BY_PLATFORM_OR_PERMISSION | Not available to apps or pages. | — |
| Touch gestures (pet, drag, throw) | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same touch routing; never run in Safari (WebKit touch and pointer events untested). | — |
| Optional sound | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | Same web code; Safari needs a user gesture to start audio (untested). | — |
| Remembers the character between runs | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED | localStorage; Safari may evict it after 7 days without a visit (untested). | — |
