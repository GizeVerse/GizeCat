# GizeVerse on Android and iOS/iPadOS: experience boundaries

Status: 2026-11-06, branch `feat/gizeverse-foundation`. Research and design only: **no native mobile code exists**, and no physical phone or tablet was used. Source ids (M1–M17) refer to [00-baseline-audit.md](00-baseline-audit.md), "Sources"; those marked [\*] there were not opened by the auditor and are UNVERIFIED as quoted.

## 1.4.0 update

2026-11-08, branch `release/1.4.0-universal-devices` (release candidate). This section updates the recommendation below; the 1.3.0 research tables after it are kept as they were. Statuses use the 1.4.0 vocabulary ([docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140)). **Nothing here has run on a phone, a tablet or an emulator.**

| Option | 1.4.0 decision | Status |
|---|---|---|
| The web host as an installable PWA (iPad Safari, Android Chrome) | Built: manifest, icons, offline service worker, settings sheet, safe areas, first screen, a static licences page ([07-web-host.md](07-web-host.md#140-the-installable-tablet-web-app)) | Code IMPLEMENTED; bundle COMPILED_OR_PACKAGED; on devices THEORETICALLY_COMPATIBLE_NOT_EXECUTED; public hosting REQUIRES_OWNER_CREDENTIALS (expected address `https://gizeverse.github.io/GizeCat/`, not deployed) |
| A store app wrapping the web host on Android | A **native Kotlin WebView app replaces the earlier Capacitor recommendation**: zero permissions when decided (1.4.1 adds four opt-in ones for the floating cat, below), no JavaScript interface object, two AndroidX libraries ([14-android-app.md](14-android-app.md)) | Code IMPLEMENTED; trial APK, unsigned release APK and AAB COMPILED_OR_PACKAGED; on devices THEORETICALLY_COMPATIBLE_NOT_EXECUTED; signing pipeline IMPLEMENTED and never run; signed release and Google Play REQUIRES_OWNER_CREDENTIALS |
| A native iPad app (SwiftUI or WKWebView) | Evaluated and **not justified now**: it would add no capability beyond the PWA (the cat still lives only inside its own window), and the App Store needs the owner's Apple Developer Program enrollment | NOT_IMPLEMENTED |
| A desktop-style overlay over other apps | Unchanged: impossible on iPadOS; ruled out on Android by the 80 % opacity rule | BLOCKED_BY_PLATFORM |
| An optional Android overlay behind "Display over other apps" | **Built in 1.4.1** at the owner's request, as the different shape this row predicted: not a click-through screen but a small transparent window that follows the cat, in a user-started foreground service ([android-overlay.md](../platforms/android-overlay.md)). It adds four permissions (`SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`) and needs Play declarations the owner has not filed | Code IMPLEMENTED; COMPILED_OR_PACKAGED; on devices THEORETICALLY_COMPATIBLE_NOT_EXECUTED; exact click-through still BLOCKED_BY_PLATFORM |

**Moving a cat between devices.** Persistence formats still differ per host (desktop JSON files, web localStorage, the Android app's WebView storage). 1.4.0 adds a portable, versioned profile file in shared code (`src/shared/profileTransfer.ts`, kind `gizeverse-character-profile`, format 1.0). It carries the cat's identity, traits, look and preferences, and its memory only on request. "Take your cat to another device" saves and loads it on the desktop, in the web app and in the Android app (IMPLEMENTED; never run on a device; [guide](../platforms/profile-transfer.md)). A sync of the cat's memory would still need a server, which stays outside the privacy design.

## The short answer

- A desktop-style GizeCat **over other apps is not possible on iOS**. On Android a full-screen click-through overlay is not possible either; the owner asked for the nearest thing, a small floating window behind the "Display over other apps" permission, and 1.4.1 implements it (never run on a device; [android-overlay.md](../platforms/android-overlay.md)).
- The mobile GizeCat is the **web host**: the same character, simulation and renderer, inside a page, driven by touch (ADR 0004 §8). Status: see the web, Android and iOS columns of the [capability matrix](capability-matrix.md).

## Android

| Option | What it gives | Blocker or cost | Status |
|---|---|---|---|
| Web host in Chrome for Android | The full character in a tab; touch gestures; persistence | In-page only; throttled or frozen in the background (M2, M3) | Built as the web host. On Android: SIMULATED_OR_MOCK_TESTED via desktop Chrome's device emulation at best; real Android Chrome not run unless an own-AVD emulator run is recorded in the web-host report |
| Capacitor/WebView app wrapping the web host | Store distribution, home-screen icon | A second build and store review; same in-app limits (M5) | NOT_IMPLEMENTED |
| `SYSTEM_ALERT_WINDOW` overlay over other apps | Something close to the desktop cat | Needs the "Display over other apps" permission, which Play reviews (M9). Since Android 12, touches pass through an overlay only if it is at most 80 % opaque (M6), so a full-screen click-through overlay is ruled out. A visible overlay also needs a foreground service whose type Play accepts (M7, M8). Impossible on Go devices. | BLOCKED_BY_PLATFORM_OR_PERMISSION for the desktop design; a small touchable bubble window is a different product: NOT_IMPLEMENTED |
| Live wallpaper | A cat living on the home screen | Home screen only; animates only while visible (M10) | NOT_IMPLEMENTED; research candidate |
| Widgets, bubbles, picture-in-picture | — | Widgets are not continuously animated (M11); bubbles are for conversations (M12); picture-in-picture is for video (M13). Using them for a pet risks policy rejection. | Not recommended |

## iOS and iPadOS

| Option | What it gives | Blocker or cost | Status |
|---|---|---|---|
| Web host in Safari | The character in a tab | In-page only; suspended in the background; WebKit differences not tested (no Safari or iOS device here) | IMPLEMENTED_BUT_NOT_PLATFORM_VERIFIED once the web host exists (the code is plain web, but it has never run in WebKit) |
| Overlay over other apps | — | iOS has no public API for drawing over other apps | BLOCKED_BY_PLATFORM_OR_PERMISSION |
| WidgetKit, Live Activities | A glanceable cat on the Home or Lock Screen | Archived snapshots with a reload budget, not continuous animation; Live Activities are time-limited and carry at most 4 KB of attributes (M14–M16) | NOT_IMPLEMENTED; research candidate for a "status" companion |
| Native or WKWebView app | An in-app character | App Store guideline 4.2 (minimum functionality) applies to thin web wrappers (M17) | NOT_IMPLEMENTED |

## What the shared core already gives a future mobile app

- **Behaviour.** The simulation (`src/core`) is platform-agnostic and deterministic for a seed (ESLint-enforced). It runs unchanged in a browser bundle (REAL, esbuild `--platform=browser`).
- **Art.** The renderer draws with Canvas 2D only, and depends on the host only through `OverlayApi`.
- **Touch.** The web host translates touch into the gesture recognizer's vocabulary (tap, stroke to pet, hold to drag, fling to throw) without changing the desktop's gesture rules.
- **Not shared yet:**
  - Persistence formats stay per host (desktop JSON files, web localStorage). A cross-device sync of the cat's memory would need a server, and that is outside the privacy design: no network by default.
  - Perception is desktop-only and off by default. Mobile screen capture needs per-session OS consent (Android MediaProjection) or does not exist for third-party apps (iOS), so GizeCat does not offer it on mobile.

## Recommendation

1.3.0 recommendation, kept as written; [1.4.0 update](#140-update) replaces item 2 with a native WebView app on Android and the PWA on iPad.

1. Ship and verify the web host first; it is the only mobile experience this project can test.
2. If a store app is wanted, wrap the web host with Capacitor. Run the store review question (guideline 4.2) first.
3. Keep Android overlays and live wallpapers as research items. Do not build an overlay that relies on the 80 % opacity rule; it would not match the product.
