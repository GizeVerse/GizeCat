# The floating cat on Android (1.4.1, interaction update 1.4.2)

GizeCat on an Android tablet can float over the launcher and other apps, like the desktop cat. This page is the design, the permissions, the limits and the install steps. Status words: [README.md](README.md#status-vocabulary-for-140).

**What has and has not run.** The owner installed GizeCat 1.4.2 (the [stable release](https://github.com/GizeVerse/GizeCat/releases/tag/v1.4.2)) on **one physical Android phone** and reports that the floating cat worked: overlay above other apps, dragging and throwing, screen-edge movement and climbing, touch interaction, using apps underneath, rotation and landscape, the control panel, and switching apps with the cat staying as it was. That is an owner report about one phone; the maintainers ran no test, emulator or simulator, and **tablets and other manufacturers' phones are not individually verified** (vendor battery managers and overlay rules may differ). The status rows below that say "never run" or THEORETICALLY_COMPATIBLE_NOT_EXECUTED describe what was executed by the build tooling; read them together with this report. The slight opacity reduction on Android 12+ was accepted by the owner as a minor platform limit.

| Item | Status |
|---|---|
| A foreground service with a transparent overlay window that follows the cat | IMPLEMENTED; COMPILED_OR_PACKAGED; runtime THEORETICALLY_COMPATIBLE_NOT_EXECUTED |
| The shared cat engine, renderer and gestures inside that window | IMPLEMENTED (the same bundle as the app); never run in an overlay window |
| Permission onboarding ("Display over other apps"), notification controls | IMPLEMENTED; never run |
| Touches only where the cat is (1.4.2: a tight touch window, not a 172 × 196 dp one) | IMPLEMENTED; COMPILED_OR_PACKAGED; never run. A small area (the cat + 12 dp) still takes touches: BLOCKED_BY_PLATFORM to make it zero, see [Touch](#touch-and-pass-through) |
| Dragging and throwing with a finger (1.4.2 fix) | IMPLEMENTED; never run |
| Walking along the screen's left and right edges and corners (1.4.2) | IMPLEMENTED; never run. The top edge is reached by the climb; no ceiling pose |
| Interaction hunting from legitimate sources only (1.4.2) | IMPLEMENTED; never run. See [Interaction hunting](#interaction-hunting-142) |
| The cat walking on other apps' windows | BLOCKED_BY_PLATFORM (other apps are not visible to an app) |
| A production-signed build, Google Play listing | REQUIRES_OWNER_CREDENTIALS |

## What it does

- **Start Floating Cat** (the app's toolbar button, **Float over apps**) puts the cat in a small transparent window above everything else. The cat walks along the bottom of the screen, above the navigation bar, and (1.4.2) climbs the left and right edges now and then, plays, sleeps and reacts exactly as in the app. It does not reserve any screen area or split the screen.
- You can **touch, pet, pick up, drag and throw** it. Drop it anywhere on the screen; it falls to the floor. The same gestures as the app and the desktop: tap, then (1.4.2) **touch and drag at once** to pick it up, and flick to throw; a still press-and-hold still picks it up too.
- **Pause** freezes the cat where it stands. **Hide** removes it from the screen until you show it. **Stop** ends the floating cat and puts it back in the app. **Settings** (the notification's body, or the app) opens the usual settings sheet; changes apply to the floating cat at once.
- The controls are on the app screen and in the service's notification (Pause or Resume, Hide or Show, Stop; tapping the notification opens the settings).
- The app remains fully usable without the permission: the cat lives inside the app exactly as before.

## How it works

One cat, one engine, two surfaces:

1. `FloatingCatService` (a foreground service, declared `specialUse`) owns one `OverlayWindow`. It checks `Settings.canDrawOverlays()` before it creates anything, shows a minimal notification and stops itself when the permission goes away.
2. `OverlayWindow` adds `TYPE_APPLICATION_OVERLAY` windows through `WindowManager` (1.4.2: a **visual** window and a **touch** window, below). Inside it is a WebView that loads **the same web bundle as the app** (`index.html?surface=overlay`), so the cat's simulation, renderer, animation, physics and gesture recognizer are the shared ones, unchanged. The page's background is transparent; the window is `PixelFormat.TRANSLUCENT`, not focusable, not touch-modal, laid out in physical screen coordinates.
3. **The visual window is only as big as the cat and the room it draws into**: the footprint plus 44 dp at each side, 60 dp above (84 dp with emotes on) and 48 dp below, times the cat's size setting. About 172 × 196 dp at the default settings (size 100 %, emotes on; 172 × 172 dp with emotes off); no screen area is reserved and nothing is opaque. **1.4.2:** that window is `FLAG_NOT_TOUCHABLE` and never takes a touch. A second, invisible **touch window** covers only the cat's footprint plus 12 dp and is the only thing that takes touches; it exists only while the cat takes touches (not paused, interactions on, visible).
4. The cat's world is the **whole physical screen** in dp, minus the system bars and the display cutout (native sends the screen size and insets). Each frame the page works out where the cat is and tells native the window rectangle it needs (snapped to whole device pixels); native moves the window with `updateViewLayout`, at most once per frame. Inside the window the cat is drawn at the same place every frame, so a window that lags a frame behind never makes it jitter against its own pixels. The window is removed from the WindowManager whenever the cat is hidden or not drawn.
5. Touches inside the touch window are read **natively in raw screen coordinates**, with the event's own time (`MotionEvent.eventTime`) and, for a mouse or trackpad pointer over it, hover and leave, and sent to the page, which feeds them to the same pointer router and gesture recognizer. Raw coordinates matter: a window that moves under the finger would shift window-relative coordinates mid-drag.
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

- **Outside the cat's touch window, touches go to the app underneath, untouched.** Since 1.4.2 the visual window (the 172 × 196 dp one) is `FLAG_NOT_TOUCHABLE`, so the owner-reported dead zone around the cat is gone. Only the invisible touch window, the cat's footprint plus 12 dp on each side (re-placed every frame, removed while the cat takes no touches), consumes touches.
- **Exact remaining limit:** inside that touch window every touch belongs to the cat. Android offers an app window **no input region** (no way to say "touchable only where pixels are opaque"), so a button of another app under those few dp cannot be pressed. This is a platform limit, not a bug to be fixed with a workaround; no AccessibilityService and no unsafe bypass of Android's untrusted-touch protections is used.
- **Android 12 and later obscured-touch rule:** touches that pass **through** another app's overlay window to a third app are blocked unless the overlay is at most 80 % opaque (`InputManager.getMaximumObscuringOpacityForTouch()`). The cat's window is only about 172 × 196 dp, never a full-screen touch-passing window, and **while the cat takes touches nobody relies on pass-through**. It also sets `filterTouchesWhenObscured`, so when another app's overlay is on top of the cat, the cat is not touched through it.
- **Android 12+ and the visual window:** touches pass through a non-touchable overlay window only at opacity 0.8 or less, so the visual window is drawn at 0.8 on Android 12 and later, always (not only while paused). The cat looks about 20 % dimmer than in the app. That is the price of not having a dead zone. While paused or with interactions off, the touch window is removed and nothing takes a touch. This pass-through is written to Android's documented rule and **has never been tried on a device**. **Hidden,** the window is removed entirely and obstructs nothing.
- **Apps that block overlays:** some screens (Android's permission dialogs, some banking and security apps, any window with `FLAG_SECURE` or `setHideOverlayWindows`) hide or refuse overlays or block touches while an overlay is above them. The cat then disappears or the screen asks you to close it. Hide the cat from the notification when that happens.
- **System bars, keyboard, lock screen:** the overlay is below the status bar and navigation bar, can sit under the on-screen keyboard's layer and never shows on the secure lock screen. The cat's floor is the top of the navigation bar.

## Interaction hunting (1.4.2)

On Windows the cat can follow the global cursor. Android's event model does not allow that: a touch belongs to the window it lands on, and no app can observe touches or pointer movement in other apps. Nothing here claims otherwise. The cat's "interaction target" is fed from **only these legitimate sources**:

1. **Touches received by the cat's own touch window** (the finger on or next to the cat).
2. **A mouse or trackpad pointer over the cat's touch window** (hover and leave, which Android delivers to the window under the pointer).
3. **Touches inside GizeCat's own app window** while it is open (the app forwards a position-only hint; it contains no view or content data).

A hint is used only while fresh (about 1.8 s) and is never kept as a standing pointer. No AccessibilityService, screen capture, hidden input hook, notification listener, root or privileged API is used, and no permission was added. The cat's play-with-cursor setting (`cursorPlay`) governs how it reacts, exactly as on the desktop.

## The app's home panel (1.4.2)

The Android app opens on a control panel (`src/web/androidPanel.ts`): a GizeVerse/GizeCat header with a status chip, a large **Start/Stop floating cat** with **Pause/Resume** and **Hide/Show**, the permission checklist with the one-tap steps (Display over apps, notifications, each marked needed, optional or ok), the cat's name, coat and size, personality presets, movement speed, autonomy, sleep timing, and the edge-walking and interaction-hunting switches, interaction (petting, dragging, throwing, play with touch) and edge-walking switches. It is one column on a phone and two from 720 px. The floating cat runs in the service, independent of this screen: opening or closing the panel never resets the cat. Setting changes apply to the floating cat at once.

### Living Companion additions (UNVERIFIED on a device: written without running anything)

The panel is now in sections: Companion (the controls above plus live chips for mood, activity, personality and the world event), Appearance, Personality (seven profiles and Auto), Behavior (activity, speed, rest and sleep, edges, hunting and the world events with a switch for each), Interactions (including Laser mode), Audio (sound is off by default), Accessibility (reduced motion; Android's "Remove animations" is honoured too) and Journal (newest first, a switch and a confirmed Clear). While the floating cat runs its WebView owns the cat: the panel then shows the journal as last saved, offers no live mood or activity and cannot clear the journal, and never writes the cat.

**Stage window.** World-event props sit on the floor away from the cat, so while props (or the laser dot) exist the VISUAL window widens into one wide, short strip holding the cat, the props and the dot (`src/web/stageWindow.ts`), and shrinks back about 1.5 s after the last one is gone. It is still `FLAG_NOT_TOUCHABLE` at 0.8 alpha on Android 12+; the touch window is exactly the 1.4.2 rectangle (cat footprint plus 12 dp) and does not grow. The `win` message keeps its keys; native accepts a visual window up to 4096 x 900 dp (`MAX_STAGE_W_DP`, `MAX_STAGE_H_DP`) and a touch window up to 600 dp. Nothing is drawn or held while the cat is hidden, paused with no props, or the screen is off.

**Laser mode, honestly.** It is a session switch (off at every app start, never stored in the settings). In the app's own cat page the red dot follows your finger or mouse anywhere on that page. Over other apps Android shows GizeCat only a touch or mouse pointer on the cat's own touch window and a touch inside GizeCat's own app window, so the dot follows just those, for about 1.8 s after the last one, and goes away. It cannot follow your finger over other apps, nothing tracks it globally, and no permission or accessibility service was added.

## Why 1.4.1's drag and throw failed (static diagnosis, 1.4.2)

Traced through the code, **not reproduced on a device**:

- A touch that moved before a 350 ms still hold was classified as a *stroke* (petting), and only a still hold could start a drag, so "touch and drag" never picked the cat up. On a phone the finger rarely stays still for a third of a second. 1.4.2 starts the drag at the first move past the slop in the Android overlay (`touchDragOnMove`); the desktop and browser routers are unchanged.
- The touch target was the cat's exact footprint, so a slightly-off touch missed it. 1.4.2 pads the hit area.
- Pointer events reached the page late (native to page), so release velocity was computed from arrival times, not the gesture's times, and a throw looked like a click. 1.4.2 sends `MotionEvent.eventTime` and the page uses it, mapped to its own clock.
- Pointer IDs, raw coordinates, density and window repositioning (which moves the window but not the world) checked out: the drag position stays in world coordinates, so moving the window mid-drag does not move the cat.

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

- One small visual window with one WebView, plus (1.4.2) a tiny touch window while the cat takes touches; no full-screen layer. Both move at most once per display frame.
- While **paused**, **hidden** or with the **screen off**, the engine runs its slow tick (a hidden cat ticks about four times a second, a suspended one slower), and the renderer is not drawing.
- The notification is low-importance and silent. There is no wake lock, no alarm, no job and no boot receiver.
- Not measured: battery drain was never measured on a device (UNVERIFIED).

## Version, and what 1.4.1 updates

**GizeCat 1.4.1 is an Android-focused update. Windows and macOS are not updated:** the Windows installers stay the 1.4.0 Preview files (`Desktop-Cat-Setup-1.4.0-x64.exe` and `-arm64.exe`), macOS and iPadOS are not part of this release, and `package.json`, the desktop version, the hosted web app and the browser build stay 1.4.0. The Android app has its own version in `android/version.properties`: versionName `1.4.1`, versionCode `10402`. (The earlier trial APKs were 10400 for 1.4.0 and 10401 for the unpublished 1.4.0-overlay.1 build.) The bundled web app's About line shows 1.4.1 inside the Android app only.

The one published file is `GizeCat-1.4.1-android-trial-debugsigned.apk`, a **sideload preview signed with the Android debug key**:
- application id `io.github.gizeverse.gizecat.trial` (unchanged), label "GizeCat (trial)", versionName `1.4.1-trial`, versionCode 10402, not debuggable;
- signing certificate SHA-256 `162fffa6298efb7c668a7b4f41ae87720c90caa383b460449737e53dadcd53a1`, the same as the published 1.4.0 trial APK, so it installs **over** it and keeps the cat and the settings;
- **never a production release, and not a Google Play build.** The unsigned release APK and AAB are not published and cannot be installed (Android refuses an unsigned APK, Google Play an unsigned AAB) until the owner signs them with the upload key ([android-signing.md](android-signing.md)).

The release page lists the APK's size and SHA-256 in `SHA256SUMS.txt`; check it before installing.

## Install

1. On the tablet, download `GizeCat-1.4.1-android-trial-debugsigned.apk` from the release page, in Chrome or the Files app.
2. Optional, on a computer: `Get-FileHash .\GizeCat-1.4.1-android-trial-debugsigned.apk -Algorithm SHA256` and compare it with `SHA256SUMS.txt`.
3. Open the APK. Android asks you to allow installs from that app (Chrome or Files): turn on **Allow from this source**, go back, tap **Install**. Google Play Protect may warn about an app from outside Play; that is expected.
4. Open **GizeCat (trial)**.

With a computer and USB debugging: `adb install -r GizeCat-1.4.1-android-trial-debugsigned.apk`.

## Upgrade from an earlier debug-signed preview

- **From the 1.4.0 trial APK** (versionCode 10400) **or the 1.4.0-overlay.1 build** (10401): just install the new APK the same way. It has the same application id and the same debug signing certificate, and a higher versionCode, so Android treats it as an update and keeps your cat and settings. You do not uninstall first.
- If Android refuses with a signature conflict, the older app was signed with a different debug key (another computer's). Then the update cannot work: save the cat to a file first (Settings, **Take your cat to another device**), uninstall the old app, install this one and load the file.
- From a **production-signed** build later: not guaranteed. A debug-signed preview can never be updated in place by an app signed with another key, so save the cat to a file first, uninstall, install, load.
- A downgrade is refused by Android: never install an APK with a lower versionCode over a higher one.

## Grant and revoke the overlay permission

- **Grant:** in the app tap **Float over apps**, read the explanation, tap **Open Android settings**, switch **Allow display over other apps** on for GizeCat, then go back. The cat starts by itself when you return with the permission on. Android's page can also be reached by hand: Settings, Apps, GizeCat (trial), **Display over other apps** (or Settings, Apps, Special app access, **Display over other apps**; the names vary by maker).
- **Android 13 and later** also asks once whether GizeCat may show notifications. Allow it to get Pause, Hide and Stop in the notification; declining changes nothing else, the same buttons are in the app.
- **Revoke:** switch the same setting off. The floating cat stops at once with a plain message, and the app keeps working with the cat inside it. Nothing asks again until you tap **Float over apps** again.
- **Stop the cat without revoking:** **Stop floating cat** in the app or **Stop** in the notification.

## The foreground service notification

While the cat floats, Android requires a notification (it is the foreground service's, low-importance, silent and hidden on the lock screen). It has **Pause** or **Resume**, **Hide** or **Show**, and **Stop**; tapping it opens GizeCat's settings. With notifications turned off for the app, the service still runs and the controls are in the app, and Android's list of running apps can stop it.

## Limits and unverified behaviour

- **Never run.** Not on a device, an emulator or a simulator. Whether the overlay window appears, the WebView renders transparently in it, the touch forwarding feels right, the window follows the cat smoothly and the controls work is unknown (UNVERIFIED). Likely first problems: a WebView that does not stay transparent on some devices, a window position that lags the cat, vendor battery managers ending the service, and screens that block overlays.
- **Latency:** the window follows the cat once per frame through two process hops (page, native); on slow devices the cat may visibly lag its own movement. Not measured.
- **Some secondary animation is reduced.** The renderer derives the tail's inertia and the held cat's swing from how far the cat moved inside its canvas since the last frame. In the floating window the cat stays at the same place inside the window (the window moves instead), so those two effects are absent there: the tail does not trail behind a walking cat, and a cat being carried does not swing. The behaviour, poses, walk cycle and every state are the shared ones. Restoring the two effects would mean passing the real motion to the renderer through the shared render snapshot (the desktop code path); that was left out of this preview on purpose, to leave Windows untouched.
- **The floor is the screen bottom, with the side edges (1.4.2).** Other apps' windows are invisible to an app, so the cat cannot walk on them. It climbs the left and right edges every 30–60 s or so and comes back down; the corners are where floor and wall meet. There is no ceiling pose: the top edge is reached by the climb only. It can be dragged and thrown anywhere on the screen and falls back.
- **One display:** the cat lives on the default display. Secondary displays are not supported.
- **Sound** (off by default) needs the page to be allowed to start audio without a tap; not verified.
- **Accessibility:** the floating window is hidden from screen readers on purpose (a picture with nothing to read); the controls are in the notification and the app, which TalkBack can use.
- **Insets** come from `WindowMetrics` on Android 11+ and from system resources on Android 10; a device that reports them wrongly puts the cat's floor in the wrong place.
- **Multiple users, work profiles, Samsung DeX and desktop modes** are untested.
- The desktop and web builds are unchanged: the overlay code runs only when the page is loaded with `?surface=overlay` inside the app's own origin with the native bridge present.
