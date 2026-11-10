# Google Play permissions: the floating cat's four

The manifest declares **four permissions, all for the optional floating cat** (1.4.0 preview 2; [design](../../platforms/android-overlay.md)). That is IMPLEMENTED and pinned by `tests/unit/android/androidProject.test.ts`. The app is fully usable without any of them being granted. **Nothing here has been filed with Google Play, and Play's acceptance is not assumed**: its policies and forms change, so read the current ones before submitting (UNVERIFIED against the current Play Console).

| Permission | Requested? | Why | Declaration to prepare |
|---|---|---|---|
| Display over other apps (`SYSTEM_ALERT_WINDOW`) | **Yes, opt-in** | The floating cat, a desktop pet drawn above other apps, is the product's core feature on Android tablets. Not granted by installing: the user turns it on in Android's settings, which the app opens only on request | Play's permission policy for draw-over-other-apps: explain that the floating cat is core functionality, that it only draws the cat, and that the app stays useful without it |
| Foreground service (`FOREGROUND_SERVICE`) and special use (`FOREGROUND_SERVICE_SPECIAL_USE`) | **Yes** | Keeps the cat's window displayed while other apps are in front; Android 14+ requires a declared type, and none of the predefined types describes a pet window | The Play Console's foreground-service declaration for `specialUse`: what it does, why no standard type fits, the subtype from the manifest (*"Keeps the user's floating desktop-pet cat window displayed over other apps while it is running. Started and stopped only by the user."*), and possibly a short video of starting and stopping it |
| Notifications (`POST_NOTIFICATIONS`, Android 13+) | **Yes**, asked once | Shows the service's notification with Pause, Hide and Stop | None beyond the listing's permission text. Declining changes nothing else |
| Internet (`INTERNET`) | No | The whole app is inside the package. Without this permission, Android gives the app no network access | |
| Network state | No | Nothing depends on the network | |
| Storage (`READ_*`, `WRITE_*`, `MANAGE_EXTERNAL_STORAGE`) | No | Profile files go through Android's file picker and "save as" screen (the Storage Access Framework), which need no permission and reach only the one file the user chose | |
| Boot completion (`RECEIVE_BOOT_COMPLETED`) | No | The cat never starts by itself | |
| Accessibility (`BIND_ACCESSIBILITY_SERVICE`) | No | Not used, and not used as a workaround for the overlay | |
| Wake lock, battery-optimisation exemption | No | No background work beyond the user-started service | |
| Camera, microphone, location | No | Never used. The WebView denies every web permission request | |
| Advertising ID (`AD_ID`) | No | No ads and no advertising library | |

## What the user is told

First use of **Float over apps** shows, in the app, before Android's page opens:

> Let your cat walk over other apps. GizeCat needs Android's "Display over other apps" permission to draw the cat on top of your launcher and other apps. Without it the cat can only live inside this app, which keeps working normally. GizeCat uses it only to draw the cat. It does not read what is on your screen, does not record anything and never touches the network. The cat takes touches only where it is drawn, and a small area around it. Android will open its own settings page. Turn on GizeCat there, then come back. You can turn it off again at any time.

- **Declined:** the floating cat stays off; the app works as before. Nothing asks again until the user taps Float over apps again.
- **Revoked later:** the floating cat stops with a plain message and never restarts by itself.

## Reading a merged manifest

Two library entries can look like permissions, and neither is requested:

- `androidx.core` declares a `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` for a call the app never makes. The app's manifest removes it (`tools:node="remove"`).
- `androidx.profileinstaller`'s receiver is guarded by `android.permission.DUMP`, which restricts who can call it (the system or `adb shell`). The app does not hold or request that permission.

## Keep it this way

Adding any permission means updating this page, [data-safety.md](data-safety.md), the listing's permission sentence and the test. `INTERNET` in particular would invalidate the data-safety reasoning, which rests on the app having no network access. The listing must no longer say the app "asks for no permissions": it asks for these four, only for the floating cat.

**Developer verification.** Google is rolling out developer verification on certified Android devices. Google says protections begin on 30 September 2026 for installs from participating stores in Brazil, Indonesia, Singapore and Thailand, and expand globally in 2027. Where it applies, an app from an unregistered developer may not install. Registering is an owner action (REQUIRES_OWNER_CREDENTIALS). Check Google's current rules; this page does not track them.
