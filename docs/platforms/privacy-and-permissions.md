# Privacy and permissions on every device (1.4.0 release candidate; 1.5.0 section below)

GizeCat has no account, ads, analytics, telemetry, crash upload or update check on any device. The full privacy policy is [docs/PRIVACY.md](../PRIVACY.md); this page compares the versions. Nothing in 1.4.0 has run on a device, so every line below describes what the code and its configuration do (IMPLEMENTED), not an observation.

## Permissions

| | Windows | macOS | iPad web app | Android app | Android web app (Chrome) |
|---|---|---|---|---|---|
| Permission prompts | None | None in 1.4.0 | None | Only for the optional floating cat, and only when you start it: "Display over other apps" (Android's own settings page) and, on Android 13+, notifications ([details](android-overlay.md#permissions-declared-in-the-manifest)). The app works with neither | None |
| Administrator rights | Not needed (per-user install) | Not needed | Not applicable | Not applicable | Not applicable |
| Network permission | Not applicable | Not applicable | Not applicable | **None**: no internet permission, so Android blocks all network access | Not applicable |
| Storage permission | Not applicable | Not applicable | Not applicable | None: files go through the system's file picker | Not applicable |
| Draw over other apps | Not a permission on Windows | Not a permission on macOS | Impossible (BLOCKED_BY_PLATFORM) | `SYSTEM_ALERT_WINDOW`, opt-in, never granted by the install (1.4.1; never run) | Impossible for web apps |
| Starts at sign-in | On by default, disclosed once, easy to turn off | Off by default; opt-in "Open at login" | No | No | No |
| Asks the browser to keep storage | — | — | Yes, in the installed app only; no prompt | — | Yes, in the installed app only; no prompt |

On macOS, 1.4.0 never asks for Accessibility, Screen Recording, Input Monitoring, camera, microphone or Bluetooth. Electron's built-in reasons for camera, microphone, audio capture and Bluetooth are replaced with "GizeCat never uses …; choose Don't Allow".

## Network

| Version | Network traffic |
|---|---|
| Windows | None with default settings. Optional AI vision talks only to the provider you configure ([PRIVACY.md](../PRIVACY.md#network-access)). |
| macOS | None with default settings. Screen analysis and AI vision cannot run on macOS. The AI page's "List models" and "Test connection" buttons contact only the endpoint you configured, and only when you click them. |
| Web app (iPad, Android Chrome, desktop browsers) | The page itself cannot make requests (its Content Security Policy has `connect-src 'none'`). The only traffic is the browser loading the app's own files from the site that hosts it: on first load, once per version for the offline copy, and the browser's own update checks of `sw.js` and the manifest. No page data is ever sent. The licences page is one more of those files; it is static and has no script. |
| Android app | None, including the floating cat. Three layers: no internet permission, a native layer that answers every request outside the app's own files with an empty "not found" (in the floating window too), and the same `connect-src 'none'` policy. |

## What is stored, and where

| Version | Where | What |
|---|---|---|
| Windows | `%APPDATA%\Desktop Cat` | Settings, the cat's state, logs; an encrypted API key only if you enter one ([details](../PRIVACY.md#what-is-stored-on-disk)) |
| macOS | `~/Library/Application Support/Desktop Cat`; Keychain item "Desktop Cat Safe Storage" | The same files as on Windows; API keys, if any, are protected by the macOS Keychain. With no key saved, GizeCat does not ask the Keychain for its status |
| Web app | The browser's storage for the hosting site: `gizecat.web.cat.v1` and `gizecat.web.settings.v1` (localStorage); a service-worker cache `gizecat-shell-<scope hash>-<version>-<hash>` | The cat and its settings; the cache holds only the app's own files |
| Android app | The app's private WebView storage on the tablet | The same two localStorage keys. No cloud backup; Android 12+ device-to-device transfer may copy them; uninstalling offers to keep them |

Nothing syncs between devices. There is no server.

**Shared web origin.** If the web app is hosted as a GitHub project site (`<owner>.github.io/<repository>/`), it shares its browser storage and caches with every other GitHub Pages site of the same owner. That is how the expected address, `https://gizeverse.github.io/GizeCat/`, would work; it is not deployed. GizeCat only deletes older caches of its own copy (`gizecat-shell-<scope hash>-*`). A custom domain avoids the sharing; that is an owner decision.

## The Android floating cat (1.4.1)

A foreground service draws the cat in a small transparent window above other apps ([design and limits](android-overlay.md)). It reads nothing from other apps: no screen capture, no accessibility service, no usage access, no window titles. Raw touch coordinates are read only for touches that land inside the cat's own window; they feed the cat's gesture recognizer and are not stored or sent. Its notification is silent and hidden on the lock screen. It never starts by itself (no boot receiver). IMPLEMENTED; never run on a device.

## 1.5.0 Living Companion: permissions unchanged (release candidate)

1.5.0 (Windows and Android only; macOS and iPad are not part of it) adds world events with props, Laser Mode, the Cat Journal, personality profiles and sound categories. Nothing in 1.5.0 has been run; this describes what the code and its manifest do (IMPLEMENTED, statically verified). The full list of what is stored is in [PRIVACY.md](../PRIVACY.md#living-companion-150-release-candidate).

- **Windows:** no new permission, prompt, registry entry, native call or network request. Laser Mode draws a dot at the pointer position the app already reads (`GetCursorPos`) and leaves the system cursor alone.
- **Android:** exactly the same four permissions as 1.4.2, checked in `android/app/src/main/AndroidManifest.xml`:

  | Permission | Why it is still needed in 1.5.0 |
  |---|---|
  | `SYSTEM_ALERT_WINDOW` | The floating cat's window. Props and the laser dot are drawn inside that same window; they need nothing more |
  | `FOREGROUND_SERVICE` | The service that keeps that window alive |
  | `FOREGROUND_SERVICE_SPECIAL_USE` | The declared type Android 14+ requires for that service |
  | `POST_NOTIFICATIONS` (Android 13+) | The service's notification (Pause, Hide, Stop) |

- **What the stage window and the laser do not need:** the stage (the wider, not-touchable strip the floating window becomes while props or the dot exist) takes no touches and no permission; it is the same overlay window, resized. The laser needs no accessibility service, screen capture, usage access, notification listener or global pointer hook: on Android the dot follows only touches and mouse hover that Android delivers to the cat's own small touch window and position hints from GizeCat's own app window. It cannot follow your finger over other apps.
- **Network:** none added; there is still no internet permission on Android.
- **Storage:** the world memory (bounded event history, counters, journal; at most 60 journal entries) lives in the cat's own file or storage key and is never exported in a profile. Mood is not stored. Laser Mode and "pause events" are session switches; on Android a record of two booleans in the app's private storage hands them to the floating page and is cleared at every app start.
- **Sound:** still off by default; the cat's sounds and the world's sounds have separate switches that matter only once sound is on.

## What every version never does

- Listen to the keyboard, read keystrokes, typed text or the clipboard. The web build fails if its files contain key-listener code.
- Send telemetry or analytics. The Android app also opts out of WebView usage metrics.
- Turn on screen analysis by itself. On Windows only the consent dialog can turn it on; macOS, the web app and the Android app have no screen analysis at all.
- Include DevTools or test hooks in a packaged build, the production web bundle, or the Android release and trial builds.

## The profile file

1.4.0 adds a portable file to carry a cat to another device (format: `src/shared/profileTransfer.ts`). **Take your cat to another device** saves and loads it: Settings → Personality on Windows and macOS, and the settings sheet in the web app and the Android app. IMPLEMENTED; never run on a device. How to use it, device by device: [profile-transfer.md](profile-transfer.md).

- **It contains:** the cat's name, its identity (`catId`) and birth time, its 7 personality traits, its look (coat, style, size, opacity, animation speed, shadow, emotes), and the carried behaviour, handling and sound preferences. Since 1.5.0 also the Living Companion choices (personality profile, which world events it meets and how often, reduced motion, whether a journal is kept, the cat and world sound switches). Its counters, learned habits and bond only if you choose to include what it has learned. The event history, event counters and the journal are never in the file.
- **It never contains:** API keys, screen-analysis or AI settings, exclusion lists, window titles, display ids or positions, folder paths, startup or shortcut settings, or diagnostics.
- It is plain, unencrypted JSON, at most 64 KiB, saved only where you choose. No network and no account are involved. It is a copy, not a sync.
- **An import never weakens privacy.** It never turns on screen analysis, AI or consent; it never touches startup, shortcuts or diagnostics; and it never switches tab-strip reading back on when it is off on the device. Device-only settings stay as they are.
- A file from a newer major format version is refused. A file is read as untrusted input ([threat model](../THREAT_MODEL.md), T17).

## Where to report a privacy concern

Open an issue at <https://github.com/GizeVerse/GizeCat/issues>. A security vulnerability goes through [SECURITY.md](../../SECURITY.md), never a public issue.
