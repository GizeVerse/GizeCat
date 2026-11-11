# Android: Google Play Protect review (1.4.2 candidate)

Status: **static review only**. Nothing here was run on a device. No appeal has been filed, no
store account was touched, and none of this is a promise that an install is warning-free.

## 1.5.0 note (release candidate)

Nothing about the permission set changed in 1.5.0 (the Living Companion): the manifest still declares exactly the four permissions in the table below, there is still no `INTERNET` permission, and the new world-event props, stage window and Laser Mode use no new permission, accessibility service or other sensitive API. The static findings below were written for 1.4.1 and 1.4.2 and still describe the manifest; they were not re-run as a scan or on a device for 1.5.0, and no one has installed a 1.5.0 build. Whether Play Protect warns about a 1.5.0 APK is unknown. The trial APK is still signed with the Android debug certificate and the release APK and AAB are unsigned. No appeal has been filed, no store account was touched, and nothing here claims a warning-free or malware-free install.

## What the owner saw

Installing the 1.4.1 sideload APK on a real phone showed Google Play Protect's **"Harmful app
blocked"** message. That is a different message from the ordinary "unknown developer / app not
from Play" prompt, and it is a different one from Play Protect's "sensitive permission" block for
sideloaded apps. Google's own page separates the cases:
[Developer Guidance for Google Play Protect Warnings](https://developers.google.com/android/play-protect/warning-dev-guidance).
Per that page, "harmful app blocked" is the case an appeal can address once the app is confirmed to
follow Google's guidelines; the sensitive-permission case is not appealable.

What we do **not** know: why this APK was classified. Play Protect gives no reason, and the
debug signature alone is **not** established as the cause (see "Signing" below).

## Static findings (source and 1.4.1 packaging rules)

| Area | Finding | Status |
|---|---|---|
| Permissions | Exactly four: `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`. Each is still needed by the floating cat (overlay window, the service that keeps it alive, the notification that service must show). None was added in 1.4.2. | IMPLEMENTED |
| Network | No `INTERNET` permission, `usesCleartextTraffic="false"`, no `java.net`, `HttpURLConnection` or `okhttp` in the Kotlin sources. | IMPLEMENTED |
| Dynamic code | No `DexClassLoader`, `PathClassLoader`, `Class.forName`, `loadLibrary`, `Runtime.exec`, `ProcessBuilder` or reflection (`getMethod`, `setAccessible`) in the sources. | IMPLEMENTED |
| Native code | No native libraries of its own; dependencies are `androidx.webkit` and `androidx.core` only (`android/app/build.gradle.kts`). | IMPLEMENTED |
| Sensitive APIs | No AccessibilityService, MediaProjection, NotificationListener, DevicePolicy, `REQUEST_INSTALL_PACKAGES` or `Settings.Secure` use. | IMPLEMENTED |
| WebView | Serves bundled assets only; `allowFileAccess = false`; no `addJavascriptInterface`; `evaluateJavascript` runs fixed constant scripts; messages use `addWebMessageListener` with an origin allow-list. | IMPLEMENTED |
| Service | `FloatingCatService` is not exported, type `specialUse` with the required subtype property. Started and stopped only by the user. | IMPLEMENTED |
| Boot / background | No `RECEIVE_BOOT_COMPLETED`; the cat never starts by itself. | IMPLEMENTED |
| Backup | `allowBackup="false"`. | IMPLEMENTED |

Patterns a scanner may weigh that are **inherent to the feature**: an overlay permission plus a
foreground service that draws over other apps is the profile of a legitimate pet app and also of
some adware and phishing overlays. 1.4.2 reduces the overlay's footprint (a tight touch window; the
rest of the overlay does not take touches) but cannot remove the permission without removing the
product.

## Signing

The sideload "trial" build is signed with the Android SDK **debug** key. Debug-signed APKs are
common in malware-adjacent samples and carry no publisher reputation, so they may weigh in a
classifier. But Play Protect also flags correctly signed apps, and a release key does not
guarantee a clean install. We do not claim the signature caused the block, and we do not claim a
new signature would clear it. The release key (owner procedure: `android-signing.md`) is needed for
Google Play regardless.

## What was deliberately not done

- Nothing was removed from the product to quiet the warning, and no permission was added or hidden.
- The owner was not asked to disable Play Protect, and this document does not suggest it.
- No evasion (obfuscation tricks, packers, split loading) was added; the release build only uses
  the normal R8 shrinker.

## Appeal: recommendation and exact evidence

Google's guidance: confirm the app follows its policies, then file a Play Protect appeal if it is
still blocked in error (see the link above). **Recommendation: file one, but only after the owner
approves it and from the owner's own account**, and preferably with the release-signed APK that
will actually ship, so the evidence matches the artifact. Nothing has been submitted.

Evidence to attach:

1. Package id `io.github.gizeverse.gizecat` (trial: `.trial`), versionName and versionCode of the
   APK being appealed, and its SHA-256 (record it in the release notes at build time).
2. The signing certificate SHA-256 of that APK.
3. The permission table above with the reason for each, and the statement that there is no
   network permission.
4. A statement that the app contains no code downloaded or loaded at runtime, no accessibility,
   screen capture or notification-listener use, and no telemetry (`docs/PRIVACY.md`).
5. Source repository: `https://github.com/GizeVerse/GizeCat`, tag of the build.
6. A contact address of the owner's choosing.

## Recommended distribution path

1. **Google Play** (internal testing first): Play-signed release builds get Play's review and
   reputation, which is the path that actually removes the "unknown app" friction. Needs the
   owner's developer account, the release key / Play App Signing enrolment, the foreground-service
   declaration (text prepared in `android-overlay.md`) and the data-safety form.
2. Until then, the sideload APK will keep showing Android's unknown-app prompt, and may show
   Play Protect prompts. Users can also use Play Protect's own "scan app" option; that is the
   user's choice and we do not ask for it to be turned off.

## Text for users

> GizeCat asks for **Display over other apps** so the cat can walk over other apps, and shows one
> notification while it runs. It has no internet access, does not read your screen, your
> touches in other apps, or your notifications, and has no ads or tracking. You start and stop the
> floating cat yourself.
