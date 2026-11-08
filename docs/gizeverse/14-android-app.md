# GizeCat for Android tablets: decision record (1.4.0)

Status: accepted for the 1.4.0 release candidate, 2026-11-08. Code: `android/` ([android/README.md](../../android/README.md)). Statuses use the 1.4.0 vocabulary ([docs/platforms/README.md](../platforms/README.md#status-vocabulary-for-140)).

**Evidence.** The project compiles and packages with Gradle on Windows (`:app:assembleTrial`, with AGP's lint-vital check reporting no issues): COMPILED_OR_PACKAGED. The app has **never run on a device or emulator**, so every runtime statement here is THEORETICALLY_COMPATIBLE_NOT_EXECUTED. A build is not a test.

## Context

- [08-mobile-boundaries.md](08-mobile-boundaries.md) ruled out a desktop-style overlay on Android, and recommended the web host, optionally wrapped with Capacitor for a store.
- 1.4.0 made the web host an installable PWA ([07-web-host.md](07-web-host.md#140-the-installable-tablet-web-app)). The Android app is a second way to deliver the **same** production bundle (`out/web`), with an app icon, offline start without a browser, and no permissions.

## Decisions

### A1. A native Kotlin WebView app, not Capacitor

| Criterion | Native WebView + WebViewAssetLoader | Capacitor |
|---|---|---|
| Reuse of the cat | The same unchanged bundle | The same unchanged bundle (the page uses no Capacitor API) |
| Fit with the invariants | Zero permissions, no JavaScript interface object, every WebView setting set explicitly | Defaults to override and re-check on every upgrade: the INTERNET permission, a FileProvider, `allowBackup=true`, the `androidBridge` JS interface, built-in plugins (Http, Cookies, WebView, SystemBars), geolocation-enabled settings, an inline-script fallback that the CSP blocks |
| Dependencies | 0 npm packages; 2 Maven artifacts (`androidx.webkit:webkit:1.14.0`, `androidx.core:core:1.17.0`) | 3 npm packages (the CLI brings 18 direct dependencies) plus appcompat, fragment, coordinatorlayout, activity, core-splashscreen and the Cordova framework through Gradle |
| Maintenance | One Activity on a standard Android Gradle Plugin setup | Yearly major versions; files that `cap sync` regenerates; an Android build that depends on `node_modules` paths |

Capacitor would win only with many native plugins, or with one CLI for iOS as well. Neither applies: the iPad version is the PWA ([08-mobile-boundaries.md](08-mobile-boundaries.md#140-update)).

### A2. Frozen identifiers

| Identifier | Value | Why it never changes |
|---|---|---|
| applicationId and namespace | `io.github.gizeverse.gizecat` | Permanent once published on Google Play. It differs from the desktop appId `io.github.enesiltas.desktopcat`. |
| WebView origin | `https://appassets.androidplatform.net` | WebViewAssetLoader's reserved domain. The cat's localStorage is keyed by it; a new origin, or a later switch to Capacitor (`https://localhost`), would lose every Android cat. |
| Trial applicationId | `io.github.gizeverse.gizecat.trial` | Keeps the debug-signed trial apart from the release app. |

Both main values live in `src/shared/identity.ts` (`androidApplicationId`, `androidWebOrigin`) and are pinned by `tests/unit/shared/identity.test.ts` and `tests/unit/android/androidProject.test.ts` (written, not run in 1.4.0).

### A3. Permissions: none

- No `INTERNET`, so Android itself forbids network access. This is the third layer after the page's CSP (`connect-src 'none'`) and the native layer, which answers every request outside `https://appassets.androidplatform.net/assets/` with an empty 404.
- No storage permission: files go through the Storage Access Framework.
- No `SYSTEM_ALERT_WINDOW` and no foreground service. A desktop-style click-through overlay is BLOCKED_BY_PLATFORM (since Android 12, touches pass through another app's overlay only at ≤ 80 % opacity). An optional overlay that needs the "Display over other apps" permission is NOT_IMPLEMENTED.
- androidx.core's `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` is removed from the merged manifest. Two AndroidX library components remain for baseline-profile installation: `InitializationProvider` (not exported) and `ProfileInstallReceiver` (exported, guarded by `android.permission.DUMP`).
- WebView usage metrics are opted out; cleartext traffic is off.

### A4. Backup and data

- `allowBackup="false"`: no cloud backup at any API level. GizeCat has no cloud features. Cloud backup stays an owner decision (NOT_IMPLEMENTED).
- `dataExtractionRules` keeps only a device-transfer rule for `root/app_webview/`, so an Android 12+ phone-to-tablet transfer can carry the cat. This relies on WebView's internal storage layout, which is not a public contract.
- `hasFragileUserData="true"`: uninstalling offers to keep the cat's data.
- The cat lives in the WebView's localStorage on that device only. Nothing syncs.

### A5. WebView hardening

- On: JavaScript and DOM storage (both needed).
- Off: file and content URL access, geolocation, automatic or multiple windows, zoom. Mixed content is never allowed. Media needs a user gesture (sound starts from the page's button).
- DevTools only in debuggable builds (`FLAG_DEBUGGABLE`): never in release or trial builds, which keeps the "no DevTools in packaged builds" invariant.
- Requests: the asset loader serves the app's own files; everything else gets an empty 404. Navigation outside the app's own origin is blocked, and no other app is ever launched.
- A lost renderer is replaced: at once while the Activity is resumed, otherwise on the next `onResume`, so a backgrounded app never starts a renderer the system would reclaim again. Only crashes (`RenderProcessGoneDetail.didCrash()`) count, never system memory kills: after 3 crashes within 60 s a static message is shown, so the app never crash-loops. Reopening the app (`onStart`, or `onNewIntent` from the launcher icon) clears the count and tries again, so the message is never permanent. A missing WebView provider shows a static message, retried the same way.
- Back first runs one fixed script (`evaluateJavascript`, a constant with no page or native data in it) that closes the page's open `<dialog>`, the settings sheet that also holds the profile-import preview; the sheet's `close` handler updates its state as it does for Escape. Only when no dialog was open does the app move to the background (`moveTaskToBack`, as Android 12+ does for launcher roots). Android 13+ delivers Back through an `OnBackInvokedCallback` registered for the Activity's lifetime (targetSdk 36, predictive back opted in), which gives up the system's back-to-home preview animation; Android 10-12 through `onBackPressed`. A second Back while the page has not answered leaves at once.
- The `WebChromeClient` denies every web permission request and every geolocation prompt.

### A6. The file bridge: an Android-only IPC surface

The design first said "no WebChromeClient, no addWebMessageListener". The lead replaced that with one narrow bridge, so that profile files can be saved and opened on Android, where `<a download>` and blob downloads do nothing (there is deliberately no DownloadListener).

- **Open:** `<input type="file">` opens the system picker (`ACTION_OPEN_DOCUMENT`, JSON and plain-text documents, one file). The page reads and validates the contents itself.
- **Save:** a `gizecatNative` object (`WebViewCompat.addWebMessageListener`) exists only in main frames of the exact origin `https://appassets.androidplatform.net`, and only where the WebView supports `WEB_MESSAGE_LISTENER`. It accepts exactly one message type, `saveFile`, as a JSON string with exactly the keys `type`, `name`, `mime` and `text`; `mime` must be `application/json` or `text/plain`; `text` is at most 256 KB in UTF-8. The name is sanitised (path parts, control and bidi characters, reserved characters and leading dots removed; at most 100 characters; extension forced to match `mime`). The user chooses the destination in the system "save as" screen (`ACTION_CREATE_DOCUMENT`). One save at a time. The reply is `{type:'saveResult', ok, reason?}`.
- There is no `addJavascriptInterface`, no other message type, no download listener and no storage permission.
- Threat analysis: [THREAT_MODEL.md](../THREAT_MODEL.md), T20.
- Status: the native side is IMPLEMENTED and compiled; the page uses it for "Take your cat to another device" (IMPLEMENTED). Neither has run on a device.

### A7. Build types

| Type | What it is | Signing |
|---|---|---|
| `release` | R8 minify and resource shrinking | Only from `android/keystore.properties`; otherwise the APK and AAB are unsigned. An incomplete file is a build error. |
| `trial` | The release code with id suffix `.trial`, versionName `-trial` and the label "GizeCat (trial)"; not debuggable | The Android SDK debug keystore. For sideload trials only; never a release. |
| `debug` | Developers only; WebView DevTools on | Debug keystore |

`versionName` comes from `package.json`; `versionCode` = MAJOR×10000 + MINOR×100 + PATCH (1.4.0 → 10400). Commands: [building-and-packaging.md](../platforms/building-and-packaging.md#android-app).

### A8. Signing and distribution

- No agent creates or handles the release keystore. The owner creates an upload keystore outside the repository, fills `android/keystore.properties` (gitignored) and backs both up offline (REQUIRES_OWNER_CREDENTIALS).
- Google Play needs the owner's developer account, Play App Signing, a signed AAB, the data-safety form (no data collected or shared; no internet permission), a privacy policy address of the owner's choice, a content rating and target audience, and store graphics (REQUIRES_OWNER_CREDENTIALS).
- Sideloading outside Play: Google's developer verification applies on certified devices. The design research recorded enforcement from 2026-09-30 in Brazil, Indonesia, Singapore and Thailand and worldwide in 2027, with ADB installs exempt. Registering is an owner action.
- An unsigned APK cannot be installed and an unsigned AAB cannot be uploaded. Only the trial APK installs without owner credentials, as a separate app with its own cat.

### A9. Tablet-first configuration

No forced orientation, `resizeableActivity="true"` (split screen, free-form windows), `singleTask` (one cat per device), edge to edge with the page padded to the safe area, and configuration changes that keep the live page. Lowest version: Android 10 (API 29) with an updated Android System WebView; compileSdk and targetSdk 36.

## Known limits

- Never run: offline asset serving without the INTERNET permission (the standard WebViewAssetLoader pattern), the lifecycle (`onPause` making the page hidden before timers pause; the 30 s autosave bounds any loss), long-press and haptics against hold-to-drag, and device transfer.
- An outdated Android System WebView (without ES2022 or `WEB_MESSAGE_LISTENER`) shows no cat, or no save bridge. There is no minimum-version guard.
- `.json` files that a document provider labels `application/octet-stream` are not offered by the picker.
- External links in the page do not open.
- The Apache-2.0 notices of the two AndroidX libraries and their dependencies are in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), not inside the APK. An in-app licences page is needed before a store release (NOT_IMPLEMENTED).

## Rejected alternatives

- **Capacitor** (A1).
- **A SYSTEM_ALERT_WINDOW overlay** as the main experience: it needs a reviewed permission and a foreground service, and the 80 % opacity rule rules out a click-through cat.
- **A separate app-shell page** for Android: the app serves the PWA's own bundle, which detects the Android host by its origin and skips the service worker there.
