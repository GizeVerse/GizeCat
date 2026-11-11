# Living Companion (GizeCat 1.5.0)

The Living Companion is the 1.5.0 layer that gives the one GizeCat cat a small world to live in. It adds seven selectable personalities, a derived mood, deeper sleep, small harmless world events, an opt-in Laser Mode, calmer motion, soft sounds and a quiet diary called the Cat Journal. It runs on Windows and on Android (the floating cat and the in-app cat).

This page is the overview. The details are in the other pages of this folder:

- [Personalities](personalities.md): the seven profiles plus Auto, and the numbers behind them.
- [World events](events.md): the scheduler rules, the pace setting and a table of all 26 events.
- [Laser Mode](laser-mode.md): what it does on Windows and on Android, and its honest limits.
- [Journal and memory](journal-and-memory.md): what is stored, how it is bounded, how to clear it.
- [Animation system](animation-system.md): the clip metadata contract, the posture model and the behaviour catalogue.
- [Architecture](architecture.md): the developer view, and how to add an event, a personality, a prop or a clip.
- [Living Companion in the sim](../gizeverse/living-companion-sim.md): the sim layers in more detail.

## Status of 1.5.0 (read this first)

1.5.0 is a release candidate. Nothing is published or tagged; the owner reviews and publishes it.

| Word | Meaning | Applies to |
|---|---|---|
| IMPLEMENTED | The code exists in the repository. | Every piece of the Living Companion listed below. |
| COMPILED_OR_PACKAGED | It type-checks, builds or packages. | Reported by the build tooling for the release candidate, not asserted by this documentation. |
| statically verified | Type-check, lint and read-only review. | Every piece below. |
| OWNER-VERIFIED | The owner ran it on real hardware. | Nothing in 1.5.0. |
| NOT RUN | Never executed. | Every piece below: no test, emulator, simulator or application launch was performed for any 1.5.0 code. |

What has been run, by whom, and on what:

- Android: the 1.4.2 floating cat (overlay, drag and throw, screen-edge climbing, touch, rotation, panel, app switching) was OWNER-VERIFIED on one physical Android phone. Tablets and other phones are not individually verified. The Living Companion on Android is new in 1.5.0 and has not been run.
- Windows: the 1.3.0 baseline ran on Windows 11 hardware. The 1.4.0 Preview and 1.5.0 were never run by the build tooling.
- Release artifacts: the Windows installers are unsigned. The Android APK is signed with the Android debug certificate (the trial build) or is unsigned (the release APK and AAB). Nothing here claims a verified publisher, SmartScreen trust, Play approval or a malware-free app.

Scope: Windows and Android only. macOS and iPad are not part of this release; the 1.4.0 Preview documents about them stay as they are.

## What it is

| Piece | What it does | Where it lives |
|---|---|---|
| Personalities | Seven profiles plus Auto. Your choice shapes how the cat reacts; the cat never changes it. | `src/core/behavior/personalityProfiles.ts` |
| Mood | One of eight moods, derived from the cat's state plus short pushes from events. It colours the animation; it never decides behaviour and is never saved. | `src/core/behavior/mood.ts` |
| Sleep depth | Grows the longer the cat sleeps. Breathing slows and the frame rate drops further. | `mood.ts` (`sleepDepthFor`), the animator |
| World events | 20 normal and 6 rare small events (a mouse, a wave, a butterfly). One every 5 to 30 minutes at the default pace. | `src/core/events/` |
| Props | The things events put on screen, drawn procedurally behind the cat. | `src/renderer/overlay/props.ts` |
| Laser Mode | The pointer becomes a red dot the cat chases and never catches. Session only. | `src/core/behavior/laser.ts`, `simLaser.ts` |
| Reduced motion | Calmer movement, shorter and gentler events. | `src/core/behavior/reducedMotion.ts` |
| Sound cues | Cat sounds and world sounds, each with its own switch. Audio stays OFF by default. | `src/shared/cat.ts` (`SOUND_CUES`) |
| Cat Journal | A bounded local diary of meaningful moments. | `src/core/behavior/worldMemory.ts`, `src/shared/catState.ts` |
| New clips | `scratch`, `shake`, `confused`. | `src/shared/animationCatalog.ts` |
| Settings pages | Companion, Personality, Interaction, Audio, Accessibility and Journal pages on Windows. | `src/renderer/settings/pages/` |
| Android panel | The sectioned home panel of the Android app. | `src/web/androidPanel.ts` |
| Android stage window | A wider, short window that exists only while event props or the laser dot are on screen. | `src/web/stageWindow.ts` |

The sim stays the source of truth for the cat's body. The event engine only describes what the cat is invited to do; the sim decides whether to do it. The user's drag, throw, tap, petting and pause always win, and a sleeping or frightened cat can refuse an invitation.

## Windows versus Android

| | Windows 10/11 | Android (floating cat and in-app cat) |
|---|---|---|
| Personalities and mood | Same code. | Same code (the web host runs the same sim). |
| World events and props | Props are drawn on the transparent overlay behind the cat, on whichever display they reach. | Props are drawn in a stage window: the cat's visual window widens into one wide, short strip while props or the dot exist, up to 4096 x 900 dp, and shrinks back 1.5 s after they are gone. |
| Wave "climbed" outcome | Climbs a screen edge only where the host offers edge bands with the click guard behind them; otherwise the cat moves away or hops. | Climbs a screen edge through the guardless screen-edge machinery; otherwise moves away or hops. |
| Laser Mode source | A dot drawn on the overlay at the real pointer position. The system cursor is untouched. | Only the touches and mouse hover Android delivers to the cat's small touch window, and short position hints from GizeCat's own app window. No global tracking, no new permission. |
| Laser Mode start and stop | Tray menu, cat context menu, or the Companion settings page. | The Laser mode switch in the Interactions section of the home panel. |
| Reduced motion | The Accessibility switch, and the system "reduce animations" setting (`systemPreferences.getAnimationSettings`). | The panel switch, and Android's "Remove animations" (it reaches the WebView as `prefers-reduced-motion`). |
| Journal | Journal page: read, switch off, clear. | Journal section of the panel. While the floating cat runs, the panel shows the last saved journal and cannot clear it. |
| Cat memory file | `cat-state.json` in the app's user data folder. | The app's private WebView storage on the device (key `gizecat.web.cat.v1`). |
| Settings pages | `src/renderer/settings` | `src/web/androidPanel.ts` and the settings sheet |

Android permissions did not change in 1.5.0: the manifest declares exactly four (`SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`). That is a static reading of `android/app/src/main/AndroidManifest.xml`, not a run.

## Controls

All of these default to the value in the last column.

| Control | Where on Windows | Where on Android | Default |
|---|---|---|---|
| Personality (seven profiles or Auto) | Personality page | Personality section | Auto |
| World events on or off | Behaviour page, and the Accessibility page ("Disable all world events") | Behavior section | On |
| Rare events | Behaviour page | Behavior section | On |
| How often (pace 0.5x to 2x) | Behaviour page | Behavior section | 1x (Normal) |
| Switch off one event | Behaviour page | Behavior section, one switch per event | None switched off |
| Pause world events | Tray menu, cat menu, Companion page | Behavior section | Not paused; session only, never stored |
| Laser Mode | Tray menu, cat menu, Companion page | Interactions section | Off at every start; session only |
| Reduced motion | Accessibility page | Accessibility section | Off (the system setting also counts) |
| Sound on | Audio page | Audio section | Off |
| Cat sounds / World sounds | Audio page | Audio section | On (they matter only while Sound is on) |
| Keep a journal | Journal page | Journal section | On |
| Clear journal | Journal page | Journal section | Not applicable |

All of these are stored in the `companion` and `sound` settings sections (`src/shared/settings.ts`), except Pause world events and Laser Mode, which are held by the running app only.

## Principles the code enforces

- Nothing here sends anything anywhere. The world events, the mood and the journal are local. No screen capture, no network and no new permission is involved.
- The mouse is never caught; no prop is prey. No event covers the screen, and none flashes. See [World events](events.md#what-never-happens).
- The overlay never blocks the desktop. Props and the laser dot are drawn with `pointer-events` off and are never part of the hit region. See [Laser Mode](laser-mode.md).
- No notifications, no streaks, no scores and no reminders. See [Journal and memory](journal-and-memory.md).
- Existing cats are not changed: with Auto, the personality knobs are neutral and the cat keeps the traits it was born with.
