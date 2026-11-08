# Google Play permissions: GizeCat requests none

The manifest declares no permission. That is IMPLEMENTED and pinned by `tests/unit/android/androidProject.test.ts`. No permission declaration form applies, because none of Play's high-risk or sensitive permissions is requested.

| Something GizeCat could have asked for | Requested? | Why not |
|---|---|---|
| Internet (`INTERNET`) | No | The whole app is inside the package. Without this permission, Android gives the app no network access |
| Network state | No | Nothing depends on the network |
| Storage (`READ_*`, `WRITE_*`, `MANAGE_EXTERNAL_STORAGE`) | No | Profile files go through Android's file picker and "save as" screen (the Storage Access Framework), which need no permission and reach only the one file the user chose |
| Display over other apps (`SYSTEM_ALERT_WINDOW`) | No | The cat lives inside its own window. A click-through overlay is ruled out by Android's touch rules (BLOCKED_BY_PLATFORM) |
| Foreground service (`FOREGROUND_SERVICE`) | No | There are no services. Out of sight, the app pauses |
| Wake lock, battery-optimisation exemption | No | No background work. The app never asks to be exempt from battery optimisation |
| Notifications (`POST_NOTIFICATIONS`) | No | The app has no notifications |
| Camera, microphone, location | No | Never used. The WebView denies every web permission request |
| Advertising ID (`AD_ID`) | No | No ads and no advertising library |

## Reading a merged manifest

Two library entries can look like permissions, and neither is requested:

- `androidx.core` declares a `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` for a call the app never makes. The app's manifest removes it (`tools:node="remove"`).
- `androidx.profileinstaller`'s receiver is guarded by `android.permission.DUMP`, which restricts who can call it (the system or `adb shell`). The app does not hold or request that permission.

## Keep it this way

Adding any permission means updating this page, [data-safety.md](data-safety.md), the listing's "asks for no permissions" sentence and the test. `INTERNET` in particular would invalidate the data-safety reasoning, which rests on the app having no network access.
