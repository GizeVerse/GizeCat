# The floating cat on Android (1.4.0 preview 2)

GizeCat on an Android tablet can float over the launcher and other apps, like the desktop cat. This page is the design, the permissions, the limits and the install steps. Status words: [README.md](README.md#status-vocabulary-for-140).

**Nothing on this page has run.** The code compiles and is packaged; it has never run on a device, an emulator or a simulator, and no test was executed for it. Every behaviour below is what the code is written to do (THEORETICALLY_COMPATIBLE_NOT_EXECUTED), not what was seen.

| Item | Status |
|---|---|
| A foreground service with a transparent overlay window that follows the cat | IMPLEMENTED; COMPILED_OR_PACKAGED; runtime THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| The shared cat engine, renderer and gestures inside that window | IMPLEMENTED (the same bundle as the app); never run in an overlay window |
| Permission onboarding ("Display over other apps"), notification controls | IMPLEMENTED; never run |
| Click-through everywhere except the cat | BLOCKED_BY_PLATFORM (Android has no input region for an app window): see [Touch](#touch-and-pass-through) |
| The cat walking on other apps' windows | BLOCKED_BY_PLATFORM (other apps are not visible to an app) |
| A production-signed build, Google Play listing | REQUIRES_OWNER_CREDENTIALS |

## What it does

- **Start Floating Cat** (the app's toolbar button, **Float over apps**) puts the cat in a small transparent window above everything else. The cat walks along the bottom of the screen, above the navigation bar, plays, sleeps and reacts exactly as in the app. It does not reserve any screen area or split the screen.
- You can **touch, pet, pick up, drag and throw** it. Drop it anywhere on the screen; it falls to the floor. The same gestures as the app and the desktop: tap, stroke, press-and-hold then drag, flick to throw.
- **Pause** freezes the cat where it stands. **Hide** removes it from the screen until you show it. **Stop** ends the floating cat and puts it back in the app. **Settings** (the notification's body, or the app) opens the usual settings sheet; changes apply to the floating cat at once.
- The controls are on the app screen and in the service's notification (Pause or Resume, Hide or Show, Stop; tapping the notification opens the settings).
- The app remains fully usable without the permission: the cat lives inside the app exactly as before.

## How it works

One cat, one engine, two surfaces:

1. `FloatingCatService` (a foreground service, declared `specialUse`) owns one `OverlayWindow`. It checks `Settings.canDrawOverlays()` before it creates anything, shows a minimal notification and stops itself when the permission goes away.
2. `OverlayWindow` adds one `TYPE_APPLICATION_OVERLAY` window through `WindowManager`. Inside it is a WebView that loads **the same web bundle as the app** (`index.html?surface=overlay`), so the cat's simulation, renderer, animation, physics and gesture recognizer are the shared ones, unchanged. The page's background is transparent; the window is `PixelFormat.TRANSLUCENT`, not focusable, not touch-modal, laid out in physical screen coordinates.
3. **The window is only as big as the cat and the room it draws into**: the footprint plus 44 dp at each side, 60 dp above (84 dp with emotes on) and 48 dp below, times the cat's size setting. About 172 × 196 dp at the default settings (size 100 %, emotes on; 172 × 172 dp with emotes off); no screen area is reserved and nothing is opaque.
4. The cat's world is the **whole physical screen** in dp, minus the system bars and the display cutout (native sends the screen size and insets). Each frame the page works out where the cat is and tells native the window rectangle it needs (snapped to whole device pixels); native moves the window with `updateViewLayout`, at most once per frame. Inside the window the cat is drawn at the same place every frame, so a window that lags a frame behind never makes it jitter against its own pixels. The window is removed from the WindowManager whenever the cat is hidden or not drawn.
5. Touches inside the window are read **natively in raw screen coordinates** and sent to the page, which feeds them to the same pointer router and gesture recognizer. Raw coordinates matter: a window that moves under the finger would shift window-relative coordinates mid-drag.
6. Two small native bridges (JSON strings, `addWebMessageListener`, the app's own origin only): `gizecatOverlay` in the floating window (screen metrics, touches and commands to the page; the window rectangle and acknowledgements back) and `gizecatFloating` in the app (start, stop, pause, hide and permission steps). No message carries a cat, a setting or a file. The cat and its settings stay in the page's storage; native only says "save now" and "settings changed". The page also tells native when the cat takes no touches (paused, interactions off), and the window then lets touches through.
7. While the cat floats, **the app's own page parks its cat** (hidden, no more saving) so there is one cat. When the floating cat stops, the service first has the page save the cat (a bounded 0.8 s wait), and the app page reloads from that stored cat.

Source: `android/app/src/main/java/io/github/gizeverse/gizecat/` (`FloatingCatService.kt`, `OverlayWindow.kt`, `FloatingBridge.kt`, `FloatingState.kt`), `src/web/overlaySurface.ts`, `overlayDisplay.ts`, `floatingProtocol.ts`, `floatingBridges.ts`, `floatingUi.ts`.

## First use and the permission

Nothing asks for anything when the app opens. Tapping **Float over apps** without the permission opens an explanation (the app screen, not a system dialog):

> **Let your cat walk over other apps.** GizeCat needs Android's "Display over other apps" permission to draw the cat on top of your launcher and other apps. Without it the cat can only live inside this app, which keeps working normally.
> GizeCat uses it only to draw the cat. It does not read what is on your screen, does not record anything and never touches the network. The cat takes touches only where it is drawn, and a small area around it.
> Android will open its own settings page. Turn on GizeCat there, then come back. You can turn it off again at any time.

with **Open Android settings** and **Not now**.

- **Open Android settings** opens Android's own page for this app (`Settings.ACTION_MANAGE_OVERLAY_PERMISSION` with the package URI). The app never grants itself the permission and never opens that page except from this button. Coming back with the permission on starts the cat (your tap on Start stands); coming back without it shows one calm line and nothing else.
- **Not now** closes the explanation. Nothing asks again until you tap **Float over apps** again, so there is no nagging.
- **Declined or never granted:** the floating cat stays off; the app works as before.
- **Revoked while it floats:** an AppOps watch (and a failed window update) stops the service with the reason "Android took away the permission". It never tries to float again by itself.
- On **Android 13+** the first start also asks once for the notification permission, so the notification's controls show. Declining changes nothing else: the same buttons are on the app screen, and the app says so.

## Permissions (declared in the manifest)

| Permission | Why it is essential | If missing |
|---|---|---|
| `SYSTEM_ALERT_WINDOW` ("Display over other apps") | The only way to draw the cat above other apps. Never granted by installing; the user turns it on in Android's settings. | The floating cat does not start; the app works |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE` | Android ends background apps' overlays; a foreground service keeps the window alive while other apps are in front. Android 14+ needs a declared type | The floating cat cannot run |
| `POST_NOTIFICATIONS` (Android 13+) | Shows the service's notification with Pause, Hide and Stop. Asked once. | The cat floats; the controls are on the app screen |

Still **not** requested: internet (the OS forbids the app any network access), storage, boot completion (the cat never starts by itself), accessibility (no `AccessibilityService`, and no workaround for it), screen capture or reading, camera, microphone, location, usage stats, package queries.

## Google Play

Do not assume Google Play accepts the overlay. Policy and forms change; read them before submitting. What is known when this was written (not verified against the current Play Console, so UNVERIFIED):

- `SYSTEM_ALERT_WINDOW` is allowed only where it is essential to the app's core functionality, and the draw-over-apps use must be justified. The justification for GizeCat: **the floating cat is the product** (a desktop pet that lives over other apps); the app remains useful without it.
- A foreground service of type `specialUse` needs a declaration in the Play Console: what the service does, why no standard type fits, and a subtype. The manifest carries the subtype text: *"Keeps the user's floating desktop-pet cat window displayed over other apps while it is running. Started and stopped only by the user."* Play may ask for a short video of the feature.
- Both items need a human in the Play Console; none was filed. The draft store texts are in [docs/store/google-play/](../store/google-play/permissions.md).
- The owner decides whether to publish a build with the overlay on Google Play, or only as a sideloaded preview and on GitHub.

## Privacy

- The floating window reads nothing from other apps: no screen capture, no accessibility, no usage access, no window titles. It cannot see what is under it.
- It uses no network, and the app has no internet permission.
- Raw touch coordinates are read only for touches that land **inside the cat's own window**; they go to the cat's gesture recognizer and are not stored or sent anywhere.
- Notifications are private (hidden on the lock screen) and silent.
- Ordinary cat data (the cat, settings) stays in the app's private storage, as before.

## Touch and pass-through

What is and is not possible, stated plainly:

- **Outside the window, touches go to the app underneath, untouched.** The window is `FLAG_NOT_TOUCH_MODAL`, and it is only about 172 × 196 dp at the default settings around the cat. Everything outside it behaves as if the cat were not there.
- **Inside the window, every touch belongs to the cat's window**, including the transparent margin around the cat (about 44 dp at the sides, 48–84 dp above and below). Android offers an app window **no input region**, so a button of another app under that margin cannot be pressed. This is a platform limit, not a bug to be fixed with a workaround.
- **Android 12 and later obscured-touch rule:** touches that pass **through** another app's overlay window to a third app are blocked unless the overlay is at most 80 % opaque (`InputManager.getMaximumObscuringOpacityForTouch()`). The cat's window is only about 172 × 196 dp, never a full-screen touch-passing window, and **while the cat takes touches nobody relies on pass-through**. It also sets `filterTouchesWhenObscured`, so when another app's overlay is on top of the cat, the cat is not touched through it.
- **While paused, or with interactions turned off in Settings** (the cat takes no touches), the page tells native, which makes the window `FLAG_NOT_TOUCHABLE` so touches reach the app underneath, and draws it at 0.8 opacity because Android 12+ passes touches on only at that opacity or less. The cat then looks about 20 % dimmer. This pass-through is written to Android's documented rule and **has never been tried on a device**. **Hidden,** the window is removed entirely and obstructs nothing.
- **Apps that block overlays:** some screens (Android's permission dialogs, some banking and security apps, any window with `FLAG_SECURE` or `setHideOverlayWindows`) hide or refuse overlays or block touches while an overlay is above them. The cat then disappears or the screen asks you to close it. Hide the cat from the notification when that happens.
- **System bars, keyboard, lock screen:** the overlay is below the status bar and navigation bar, can sit under the on-screen keyboard's layer and never shows on the secure lock screen. The cat's floor is the top of the navigation bar.

## Lifecycle

| Event | What happens |
|---|---|
| Start | Foreground first; permission checked; one window (a second start while it runs does nothing) |
| Pause / resume | The page pauses the cat's simulation; the window stays |
| Hide / show | The cat is hidden in the page and the window leaves the WindowManager; shown again on the next frame |
| Stop | The page saves the cat (bounded wait), the window and WebView are freed, the service leaves the foreground and ends |
| Screen off / on | The cat is put to sleep (a suspended page) and woken; a paused cat stays paused |
| Rotation, split screen, foldable, display size change | A display listener pushes the new screen size and insets; the page re-fits the cat's world and keeps the cat |
| Renderer (WebView process) lost | A fresh page is created, reloading the cat from storage (it autosaves every 30 s and on every stop). Three crashes in a minute stop the service ("its drawing kept failing") |
| Permission revoked | The service stops with that reason |
| Process killed by the system | The service does not restart (`START_NOT_STICKY`). The cat is simply not floating until the user starts it again. The app shows no message for this case: the state lives in memory, so a new process starts from "not running" (a message appears only for stops the running service itself reports, such as a revoked permission or a failing renderer). The cat is as last saved (autosave every 30 s) |
| App swiped from Recents | The floating cat keeps running (it is a foreground service). Stop is in the notification when notifications are on; with them off, or if the notification was dismissed, open the app and tap Stop floating cat (or stop the app in Android's list of running apps) |
| Start over or loading a profile while it floats | Refused: stop the floating cat first (it owns the stored cat and would write the old one back) |
| Reboot | The cat does not start by itself: there is no boot receiver |

## Battery and CPU

- One small window and one WebView; no full-screen layer. The window moves at most once per display frame.
- While **paused**, **hidden** or with the **screen off**, the engine runs its slow tick (a hidden cat ticks about four times a second, a suspended one slower), and the renderer is not drawing.
- The notification is low-importance and silent. There is no wake lock, no alarm, no job and no boot receiver.
- Not measured: battery drain was never measured on a device (UNVERIFIED).

## Install and distribute the preview

The preview 2 files are in `release/1.4.0-overlay.1/android/` on the build machine (not published; see below). They are named by what they are:

| File | What it is |
|---|---|
| `GizeCat-1.4.0-overlay.1-android-trial-debugsigned.apk` | Sideload trial. Signed with the **Android debug key**; its own application id `io.github.gizeverse.gizecat.trial`, labelled "GizeCat (trial)". **Never a production release.** |
| `GizeCat-1.4.0-overlay.1-android-unsigned.apk`, `…-unsigned.aab` | Unsigned release builds. Android will not install the APK and Google Play will not take the AAB until the owner signs them with the upload key ([android-signing.md](android-signing.md)) |

Built on 2026-11-10 from this branch (static checks: the APK's manifest, permissions, signature and bundled files were read; nothing was run):

| File | Bytes | SHA-256 |
|---|---|---|
| `GizeCat-1.4.0-overlay.1-android-trial-debugsigned.apk` | 690,909 | `a00262a2b15cfae9b263850c01ec899db864e1f9fa3928fd92b26c007954897b` |
| `GizeCat-1.4.0-overlay.1-android-unsigned.apk` | 686,797 | `f23862541822fd17f70ed6807741516a495fa8cabec97c295a367c15336bf2e2` |
| `GizeCat-1.4.0-overlay.1-android-unsigned.aab` | 679,534 | `b8f22aba41a0eaef099c4015282b638bf3a9b403c2722f6f8ca546534f51f232` |

The trial APK reads version `1.4.0-overlay.1-trial`, code 10401, id `io.github.gizeverse.gizecat.trial`, not debuggable, debug certificate SHA-256 `162fffa6298efb7c668a7b4f41ae87720c90caa383b460449737e53dadcd53a1`, and exactly the four permissions above. The unsigned APK and AAB carry no signature (`apksigner` and `jarsigner` refuse them), version `1.4.0-overlay.1`, code 10400. The published 1.4.0 Android files in `release/1.4.0/android/` were not touched.

To try the trial APK on a tablet you own: copy it to the tablet, open it from the file manager or browser (allow "Install unknown apps" for that app when asked), then open GizeCat (trial) and tap **Float over apps**. It installs as an update over the earlier 1.4.0 trial APK of the same key (the cat is kept). It is not guaranteed to upgrade in place to a production-signed build: uninstall first, after saving the cat to a file (Settings, **Take your cat to another device**).

## Limits and unverified behaviour

- **Never run.** Not on a device, an emulator or a simulator. Whether the overlay window appears, the WebView renders transparently in it, the touch forwarding feels right, the window follows the cat smoothly and the controls work is unknown (UNVERIFIED). Likely first problems: a WebView that does not stay transparent on some devices, a window position that lags the cat, vendor battery managers ending the service, and screens that block overlays.
- **Latency:** the window follows the cat once per frame through two process hops (page, native); on slow devices the cat may visibly lag its own movement. Not measured.
- **Some secondary animation is reduced.** The renderer derives the tail's inertia and the held cat's swing from how far the cat moved inside its canvas since the last frame. In the floating window the cat stays at the same place inside the window (the window moves instead), so those two effects are absent there: the tail does not trail behind a walking cat, and a cat being carried does not swing. The behaviour, poses, walk cycle and every state are the shared ones. Restoring the two effects would mean passing the real motion to the renderer through the shared render snapshot (the desktop code path); that was left out of this preview on purpose, to leave Windows untouched.
- **The floor is the screen bottom.** Other apps' windows are invisible to an app, so the cat cannot walk on them. It can be dragged and thrown anywhere on the screen and falls back.
- **One display:** the cat lives on the default display. Secondary displays are not supported.
- **Sound** (off by default) needs the page to be allowed to start audio without a tap; not verified.
- **Accessibility:** the floating window is hidden from screen readers on purpose (a picture with nothing to read); the controls are in the notification and the app, which TalkBack can use.
- **Insets** come from `WindowMetrics` on Android 11+ and from system resources on Android 10; a device that reports them wrongly puts the cat's floor in the wrong place.
- **Multiple users, work profiles, Samsung DeX and desktop modes** are untested.
- The desktop and web builds are unchanged: the overlay code runs only when the page is loaded with `?surface=overlay` inside the app's own origin with the native bridge present.
