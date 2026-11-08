# GizeCat for Android (tablet-first)

A native Kotlin app with one Activity and one WebView. The WebView serves the **same production web
bundle as the browser/PWA version** (`out/web`, built by `node scripts/build.mjs --web-only`) from
the APK's assets, so the cat, its simulation, renderer and gesture rules are the web host's, unchanged.
The page recognises the Android host by its origin and skips the service worker there.

Not Capacitor, by design (decision D1 of the 1.4.0 design pass): no npm dependencies, two AndroidX
libraries, zero permissions, no JavaScript interface object.

## Frozen identifiers

| What | Value | Why it never changes |
| --- | --- | --- |
| applicationId and namespace | `io.github.gizeverse.gizecat` | Permanent once published on a store. Different from the desktop appId. |
| WebView origin | `https://appassets.androidplatform.net` | WebViewAssetLoader's reserved domain. The cat's localStorage is keyed by it; a new origin loses every Android cat. |
| Start page | `https://appassets.androidplatform.net/assets/index.html` | Built from the origin above. |

Both are pinned in `src/shared/identity.ts` (`androidApplicationId`, `androidWebOrigin`) and checked
against this project by `tests/unit/android/androidProject.test.ts`.

## What the app does and does not do

- **Permissions: none.** No `INTERNET`, so Android itself forbids network access. That is the third
  layer, after the page's CSP (`connect-src 'none'`) and the native layer, which answers every request
  outside `https://appassets.androidplatform.net/assets/` with an empty 404. There is no storage
  permission either: files go through the Storage Access Framework, which needs none. No overlay
  over other apps, no foreground service. The androidx.core receiver permission is removed from
  the merged manifest.
- **WebView settings:** JavaScript and DOM storage on. File and content URL access, geolocation,
  automatic or multiple windows, zoom and media autoplay off. Mixed content is never allowed.
  WebView usage metrics are opted out. DevTools exist only in debuggable (developer `debug`) builds.
- **Navigation** never leaves the app's own pages and no link opens another app.
- **Backup:** `allowBackup="false"`, so there is no cloud backup. Android 12+ device-to-device
  transfer copies the WebView storage (`app_webview/`), so a new device keeps the cat.
  `hasFragileUserData="true"`, so uninstalling offers to keep the cat's data.
- **Tablet-first:** no forced orientation, `resizeableActivity="true"` (split screen, freeform
  windows), `singleTask` (one cat per device). Resizes, rotation and keyboard changes keep the live
  page. Edge to edge, with the page padded to the safe area. The system bars use the page colours.
- **Lifecycle:** backgrounding pauses the WebView, so the page sees `visibilitychange: hidden`,
  saves the cat and naps. A lost renderer is replaced, at once while the app is in front and
  otherwise when it comes back, so a backgrounded app never starts a renderer the system would
  reclaim again. Only crashes count, not renderers the system killed for memory: after 3 crashes
  within 60 s a static message is shown instead, and reopening the app (the launcher icon,
  Recents, or switching back) clears the count and tries again.
- **Back:** the app first asks the page to close its open dialog (the settings sheet, which also
  holds the profile-import preview; nothing is applied), by running one fixed script with
  `evaluateJavascript` that never carries page or native data. The sheet updates exactly as for
  Escape. With no dialog open, Back moves the app to the background instead of closing it, as
  Android 12+ does for launcher apps. Android 13+ receives Back through an `OnBackInvokedCallback`
  (the manifest opts in to predictive back), so the system's back-to-home preview animation is not
  shown; Android 10-12 through `onBackPressed`.
- **Lowest version:** Android 10 (API 29), with an updated Android System WebView.

## Native file bridge (profile export and import)

This is the only bridge between the page and Android
(`app/src/main/java/io/github/gizeverse/gizecat/FileBridge.kt`). It is deliberately narrow.

1. **Import:** an `<input type="file">` in the page opens the system file picker
   (`ACTION_OPEN_DOCUMENT`, JSON and plain-text documents, one file). The user picks the file; the
   WebView reads it and the page validates the contents. The picker answers "nothing picked" when
   it is cancelled.
2. **Export:** in main frames of the app's own origin, and only there, the page has a
   `gizecatNative` object (`WebViewCompat.addWebMessageListener`). It accepts exactly one message
   shape, as a JSON string:

   ```js
   gizecatNative.postMessage(JSON.stringify({ type: 'saveFile', name: 'gizecat-profile.json', mime: 'application/json', text }));
   gizecatNative.onmessage = (event) => {
     const result = JSON.parse(event.data); // { type: 'saveResult', ok: true } or { type: 'saveResult', ok: false, reason }
   };
   ```

   - Rules: `mime` is `application/json` or `text/plain`, and `text` is at most 256 KB in UTF-8.
     The four keys are required and no others are allowed. `name` is cleaned: path parts, control
     and invisible formatting characters, reserved characters and leading dots are dropped, the name
     is cut to 100 characters, and the extension follows `mime`.
   - The user chooses the location in the system "save as" screen (`ACTION_CREATE_DOCUMENT`).
     The text is then written through the ContentResolver.
   - Possible `reason` values: `cancelled`, `busy` (another save is waiting for the user),
     `invalid`, `too-large`, `unavailable` (no document app) and `write-failed`.
   - Feature detection: `typeof gizecatNative !== 'undefined'`. The object is missing in browsers,
     and on Android System WebView versions without `WEB_MESSAGE_LISTENER`.
3. There is nothing else: no other message types, no `addJavascriptInterface`, no download
   listener, and no storage permission. Camera, microphone and other web permission requests, and
   geolocation, are always denied.

## Build

Prerequisites: a JDK 17 or newer (Android Studio's bundled JBR works) and the Android SDK with
platform `android-36` and build-tools 36.0.0. On first use the Gradle wrapper downloads Gradle 9.1.0
(a sha256-pinned distribution), and Gradle then downloads the Android Gradle Plugin 9.0.1 with its
built-in Kotlin from Google Maven and Maven Central.

`scripts/android-gradle.mjs` sets `JAVA_HOME` and `ANDROID_HOME` for the Gradle process only. It uses
the environment's values when they are valid; otherwise Android Studio's JBR and the default SDK
folder. It runs `scripts/build-web-app.mjs` first, which rebuilds `out/web` and copies it into
`app/src/main/assets/` (generated and gitignored). After the build it copies the outputs to
`release/<version>/android/` and writes `SHA256SUMS-android.txt`.

| Output | Command | Gradle output |
| --- | --- | --- |
| Release APK (unsigned without a keystore) | `npm run android:apk` | `app/build/outputs/apk/release/app-release-unsigned.apk` (`app-release.apk` when signed) |
| Release AAB for Google Play (unsigned without a keystore) | `npm run android:aab` | `app/build/outputs/bundle/release/app-release.aab` |
| Trial APK (sideload trials only) | `npm run android:trial` | `app/build/outputs/apk/trial/app-trial.apk` |
| Web bundle into the app only | `npm run android:web` | `app/src/main/assets/` |

The npm scripts run under `scripts/with-lock.mjs`, so builds on a shared machine take turns. You can
also call it directly: `node scripts/android-gradle.mjs :app:assembleRelease [--no-web] [--no-collect]`.
Plain Gradle works too, once `app/src/main/assets/` is filled. In PowerShell (the `$env:` values
last for that process only):

```powershell
& { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"; android\gradlew.bat -p android --no-daemon :app:assembleRelease }
```

Version: `versionName` comes from `package.json`. `versionCode` = MAJOR×10000 + MINOR×100 + PATCH,
so 1.4.0 gives 10400. The build fails if MINOR or PATCH reaches 100.

### Build types

- `release`: R8 minify and resource shrinking. It is signed only when `android/keystore.properties`
  exists; otherwise the APK and AAB are unsigned. An unsigned APK cannot be installed and an unsigned
  AAB cannot be uploaded.
- `trial`: the release code signed with the Android SDK **debug** keystore (`~/.android/debug.keystore`,
  which Gradle creates if it is missing). It has applicationId `io.github.gizeverse.gizecat.trial`,
  versionName `1.4.0-trial` and the label "GizeCat (trial)". It is not debuggable, and it installs
  next to the release app with its own, separate cat. Use it for sideload trials only and never
  distribute it: anyone with a debug keystore can sign an "update" for it.
- `debug`: developers only (WebView DevTools on).

## Signing (owner only)

Agents never create or handle the release keystore.

1. Create an upload keystore outside the repository with your own name, organisation and password
   (keytool asks for them), e.g.
   `"C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -genkeypair -v -storetype PKCS12 -keystore "%USERPROFILE%\.gizecat-keys\gizecat-upload.jks" -alias gizecat-upload -keyalg RSA -keysize 4096 -validity 10000`.
2. Copy `keystore.properties.example` to `keystore.properties` (gitignored) and fill it in. Write
   `storeFile` with forward slashes. For PKCS12, `keyPassword` = `storePassword`.
3. Back up the keystore and the passwords offline. With Play App Signing a lost upload key can be
   reset through Play support. For APKs distributed outside Play, a lost key means users must
   uninstall, losing their cat, before they can update.

You can also leave `keystore.properties` out and sign the unsigned outputs afterwards:
`apksigner sign --ks <keystore> --out GizeCat.apk app-release-unsigned.apk` (build-tools) for the
APK, and `jarsigner -keystore <keystore> app-release.aab <alias>` (JDK) for the AAB.

## Install (trial APK, sideloading)

On the tablet, allow installing from the source you use (Files app or browser), open
`GizeCat-<version>-android-trial-debugsigned.apk`, and confirm. With a computer:
`adb install GizeCat-<version>-android-trial-debugsigned.apk`. Android developer verification rules
for sideloaded apps apply on certified devices; ADB installs are exempt.

## Status

The project compiles and packages with Gradle on Windows (`:app:assembleTrial`, 1.4.0, with AGP's
lint-vital check reporting no issues). The app has never run on a device or emulator, so every
runtime behaviour described above is THEORETICALLY_COMPATIBLE_NOT_EXECUTED until it runs on a real
tablet.

The merged manifest also contains two components from AndroidX libraries: the
`androidx.startup.InitializationProvider` (not exported) and the
`androidx.profileinstaller.ProfileInstallReceiver`. The receiver is exported but guarded by
`android.permission.DUMP`, so only the system or `adb shell` can call it. Together they install the
app's baseline profile for faster start-up. Neither needs a permission or the network.
