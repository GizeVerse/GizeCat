# GizeCat on Android tablets (1.4.0 release candidate)

There are two ways to run GizeCat on an Android tablet: the **native app**, new in 1.4.0, and the **web app** installed from Chrome. Both show the same cat from the same web bundle. **Neither has run on an Android device or emulator.** The app was compiled and packaged with Gradle; that is all. Statuses use the 1.4.0 vocabulary in [README.md](README.md#status-vocabulary-for-140).

By default the cat lives **inside its own window**. The native app can also **float over other apps** (1.4.1, opt-in): a foreground service draws the cat in a small transparent window that follows it, behind Android's "Display over other apps" permission. That is IMPLEMENTED and compiled; 1.4.2 was used by the owner on **one physical Android phone** (owner-reported working), and other devices are not individually verified: the design, the permissions, the touch limits and the install steps are in [android-overlay.md](android-overlay.md). The web app (Chrome) cannot draw over other apps (BLOCKED_BY_PLATFORM). A desktop-style overlay that lets touches through everywhere except the cat is ruled out by Android's touch rules: Android gives an app window no input region, and since Android 12 touches pass through another app's overlay only when it is at most 80 % opaque (BLOCKED_BY_PLATFORM); the floating cat's window is therefore only the cat and a small margin, and touches in that margin are consumed.

## The native app

| | |
|---|---|
| Name | GizeCat |
| Application id | `io.github.gizeverse.gizecat` (permanent) |
| Requires | Android 10 (API 29) or later, and an up-to-date Android System WebView |
| Made for | Tablets. It does not force an orientation and supports split screen and free-form windows. Nothing stops it from installing on a phone. |

### How to get it

- **Release APK and AAB:** `GizeCat-1.4.0-android-unsigned.apk` and `GizeCat-1.4.0-android-unsigned.aab` are **unsigned** until the owner's release key exists (REQUIRES_OWNER_CREDENTIALS). Android does not install an unsigned APK, and Google Play does not accept an unsigned AAB.
- **Signing pipeline:** ready, and it has never run, because no key exists. The build takes the key from the `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` environment variables, or else from `android/keystore.properties`. With neither, the outputs are unsigned. `npm run android:release` builds both, and the manual `android-release.yml` workflow does the same with its secrets in the `android-signing` environment. Signed files are named `GizeCat-1.4.0-android.apk` and `.aab`. The owner's procedure is in [android-signing.md](android-signing.md).
- **Google Play:** not listed. A listing needs the owner's Google Play developer account (REQUIRES_OWNER_CREDENTIALS). Draft texts and a readiness list for the owner are in [docs/store/google-play/](../store/google-play/release-readiness.md).
- **Newest APK, 1.4.2 (stable release):** `GizeCat-1.4.2-android-trial-debugsigned.apk` ([v1.4.2 release](https://github.com/GizeVerse/GizeCat/releases/tag/v1.4.2); Android-only; Windows and macOS are not updated). Signed with the Android Debug certificate, so not a Google Play package, and Play Protect may warn. It installs over the 1.4.1 and 1.4.0 trial APKs: same application id, same debug key, higher versionCode. Install, upgrade, permission and notification steps: [android-overlay.md](android-overlay.md#install).
- **Trial APK:** `GizeCat-1.4.0-android-trial-debugsigned.apk` (1.4.0) and 1.4.1 and the 1.4.2 one above are Android-Debug signed, never Google Play production packages:
  - It is labelled **GizeCat (trial)** and has its own application id, `io.github.gizeverse.gizecat.trial`. It installs next to a later signed app, with its own, separate cat.
  - It is signed with the build machine's Android **debug** key. A debug key is a development key with a well-known password; it is not managed like a release key. The trial is not a release and will not be updated in place by a signed release.

### Install the trial APK, step by step

1. On the tablet, download the APK from the release page (<https://github.com/GizeVerse/GizeCat/releases>) in Chrome or the Files app.
2. Optional: on a computer, check it against `SHA256SUMS.txt` (PowerShell: `Get-FileHash .\GizeCat-1.4.0-android-trial-debugsigned.apk -Algorithm SHA256`).
3. Open the APK. Android asks you to allow installs from that app (Chrome or Files): turn on **Allow from this source**, then go back.
4. Tap **Install**. Google Play Protect may warn about an app from an unknown developer or offer to scan it; that is expected for an app from outside Play.
5. Open **GizeCat (trial)**.

With a computer and USB debugging: `adb install GizeCat-1.4.0-android-trial-debugsigned.apk`.

If something goes wrong: [troubleshooting](troubleshooting.md#android-tablets).

**Developer verification.** Google is rolling out developer verification on certified Android devices. Google says protections begin on 30 September 2026 for installs from participating stores in Brazil, Indonesia, Singapore and Thailand, and expand globally in 2027. Where it applies, an app from an unregistered developer may not install. Registering is an owner action (REQUIRES_OWNER_CREDENTIALS). Earlier design notes said ADB installs are exempt; that was not confirmed on the page read for this release. Check Google's current rules; this page does not track them.

### Permissions

**Four, all for the optional floating cat** ([why and what if missing](android-overlay.md#permissions-declared-in-the-manifest)). The app is fully usable without any of them being granted, and nothing asks for them until you tap **Float over apps**.
- `SYSTEM_ALERT_WINDOW` ("Display over other apps"): never granted by the install. The app explains it, then opens Android's own settings page only when you ask; you turn it on there.
- `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_SPECIAL_USE`: the service that keeps the cat on screen while other apps are in front.
- `POST_NOTIFICATIONS` (Android 13+): shows the service's notification with Pause, Hide and Stop. Asked once, on the first start.
- No internet permission, so Android itself forbids network access.
- No storage permission. Profile files go through the system's own file picker and "save as" screen, at the place you choose.
- No location, camera, microphone, accessibility, screen capture or boot receiver. The WebView denies every web permission request.
- No background work except the floating cat's own foreground service, which only you start and which never restarts by itself: no alarm, job, wake lock or battery-optimisation request.

### What works and what does not

What exists in code (THEORETICALLY_COMPATIBLE_NOT_EXECUTED for every item; built, never run on a device or emulator):
- The cat full-screen, edge to edge, with the floor above the gesture bar; touch gestures as on the iPad.
- Works offline: the web bundle is inside the APK.
- Rotation, split screen, resizing and a change of display density keep the live cat. A change of dark mode, language, layout direction or text size reloads the page on purpose, so the theme, system bars and text are applied again; the cat is saved first and comes back.
- Back moves the app to the background instead of closing it. In the background the cat saves and naps.
- If the WebView's renderer crashes, the page is rebuilt; after 3 crashes within 60 seconds a message is shown instead.
- **Take your cat to another device** in Settings ([guide](profile-transfer.md)): saving goes through the system "save as" screen (a narrow, Android-only bridge), and loading through the system file picker.
- A third-party notices page, under Settings → About. From that page, Android's Back sends the app to the background; use its **Back to GizeCat** link.

What it does not do:
- Draw over other apps, unless you start the floating cat in the native app (see the top of this page); the web app never does.
- Back up the cat to the cloud. Cloud backup is off by design (NOT_IMPLEMENTED).
- Open links to other apps or websites. Navigation never leaves the app's own pages.
- Show a cat on an outdated Android System WebView: the page says "GizeCat has not started" instead. Update Android System WebView from Google Play ([steps](troubleshooting.md#the-android-system-webview-is-too-old)).

### Data

- The cat and its settings live in the app's private storage on the tablet. Nothing syncs.
- No cloud backup. On Android 12 and later, a device-to-device transfer (for example to a new tablet) is set up to copy the cat. This relies on WebView's internal storage layout and has not been checked.
- Uninstalling offers to keep the app's data.

### Uninstall

Touch and hold the GizeCat icon → **Uninstall**, or **Settings → Apps → GizeCat → Uninstall**. If Android offers to keep the app's data, keeping it lets a reinstall of the same app bring the cat back. Leave it unticked to delete the cat.

## The web app in Chrome

The same web app as on the iPad ([ipados.md](ipados.md)), installed from Chrome. It needs an HTTPS address. The expected address, `https://gizeverse.github.io/GizeCat/`, is **not deployed** (REQUIRES_OWNER_CREDENTIALS), and `GizeCat-web-1.4.0.zip` can be self-hosted on any static HTTPS host.

1. Open the address in **Chrome** on the tablet.
2. Chrome menu (⋮) → **Install app** (or **Add to Home screen**). When Chrome offers it, GizeCat's Settings also shows an **Install GizeCat** button.
3. Open GizeCat from the home screen or app list.

- **Permissions:** none. The installed web app asks Chrome to keep its storage; Chrome decides without a prompt.
- **What works:** as for the iPad web app (THEORETICALLY_COMPATIBLE_NOT_EXECUTED). An Android web app cannot draw over other apps (BLOCKED_BY_PLATFORM).
- **Uninstall:** touch and hold the icon → **Uninstall**, or remove the site's data in Chrome's site settings. Settings → Start again → **Start over with a new cat** deletes the cat.
- The web app in Chrome and the native app do not share a cat.

## Signing and store status

| Item | Status |
|---|---|
| Release APK and AAB | COMPILED_OR_PACKAGED, unsigned |
| Signing from the environment or `android/keystore.properties`; `android-release.yml` in the `android-signing` environment | IMPLEMENTED; never run, because no key exists |
| Signed release APK and AAB | REQUIRES_OWNER_CREDENTIALS (the owner's release key) |
| Google Play listing | REQUIRES_OWNER_CREDENTIALS (developer account, data-safety form, privacy policy address, content rating). No listing exists |
| Developer verification for sideloading | REQUIRES_OWNER_CREDENTIALS |
| Trial APK | COMPILED_OR_PACKAGED; debug-signed; sideload trials only |
| Floating cat over other apps (native app, 1.4.1) | IMPLEMENTED; COMPILED_OR_PACKAGED; runtime THEORETICALLY_COMPATIBLE_NOT_EXECUTED ([android-overlay.md](android-overlay.md)). Exact click-through: BLOCKED_BY_PLATFORM |
| Licences page inside the app | IMPLEMENTED (Settings → About; a static page generated from [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)); never run on a device |
| Full privacy policy text inside the app | NOT_IMPLEMENTED (Settings has a short Privacy section) |

## Feedback

Android reports are the only way these statuses can move. Open a **Platform report** at <https://github.com/GizeVerse/GizeCat/issues>, choose "Other (say below)", and give your tablet model, Android version, Android System WebView version (Settings → Apps → Android System WebView), and whether you used the trial APK or the web app in Chrome.
