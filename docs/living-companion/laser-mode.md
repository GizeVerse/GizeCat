# Laser Mode

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: Laser Mode has not been started on a desktop, an emulator or a phone, and nothing here is OWNER-VERIFIED. The claims below come from reading `src/core/behavior/laser.ts`, `simLaser.ts`, `src/main/catHost.ts`, `src/main/overlay/`, `src/renderer/overlay/props.ts`, `src/web/main.ts` and `src/web/overlaySurface.ts`.

Back to the [overview](README.md).

Laser Mode is a game you start on purpose. A small red dot follows a pointer, and the cat chases the dot. The cat never catches it. It is off every time the app starts, and it is never saved.

## Windows and Android at a glance

| | Windows | Android |
|---|---|---|
| What the dot follows | The real pointer position, on whichever display it is on. The system cursor is not changed, hidden or moved. | In the app and in the browser page: your finger or mouse anywhere on that page. Over other apps: only what Android delivers to GizeCat, see below. |
| How the pointer is read | The same cursor sample the cat already uses, handed to the overlay only while the mode is on, never stored or logged. | The page's own pointer; in the floating window only the cat's small touch window (a press or a mouse hover on the cat itself) and fresh position hints from GizeCat's own app window (they expire after 1.8 s). |
| Global pointer tracking | Reads the cursor position through the platform call the cat already used. | None. Android does not let an app see touches elsewhere, and GizeCat does not ask for a way around that. No new permission: the manifest still declares exactly four. |
| Start | Tray menu "Laser mode", cat right-click menu "Laser mode", or the "Start laser mode" button on the Companion page. | The "Laser mode" switch in the Interactions section of the home panel. |
| Stop | Tray menu "Stop laser mode" (always offered while it is on), the cat menu, the Companion page button, or restarting GizeCat. | The same switch, or closing and reopening the app (it starts clean). |
| Off by default | Yes, at every start. | Yes. The app screen discards any record left by an earlier session. |
| Needs | The cat visible and not paused. The Windows pages state no other requirement; whether turning off "Hunt and pounce" also stops the cat following the dot on Windows was not checked in the code (UNVERIFIED). Reaching with a paw needs "paw at the pointer" on; hopping needs jumps on. | The panel disables the switch while "Hunt and pounce" is off, because following the light is a chase. |

## What you see

- A red dot, 5 DIP in radius with a soft 15 DIP glow, drawn over the cat. It pulses gently, and does not pulse under reduced motion (`drawLaser` in `props.ts`).
- The cat walks toward it, runs when it is far and the cat is keen, sits and watches when the dot rests, reaches a paw toward a resting dot (the `pawAt` clip, never a swat), and now and then hops at a dot above it.
- If the dot disappears after the cat had been following it for a while, the cat may look confused for a moment (the `confused` clip).

## The guarantees

### The cat never catches it

The dot is light, not prey. While Laser Mode is on there is no hunt, no pounce, no "caught" outcome, no catch emote, and no hunt or pounce counters or memories (`simHunt.ts` refuses to start a hunt while the mode is on; `simLaser.ts` makes the cat hold off). The cat stops at least `LASER_STANDOFF_BODY_LENGTHS` (0.9) body widths short of the dot, horizontally, and never closes that gap. The goal is dropped if the walkable floor would put it closer. If you move the dot onto the cat, the cat holds still rather than backing off, so a click or a pet is never dodged.

### Click-through (T8)

The overlay must never block the desktop. It is click-through by default and becomes interactive only over the cat's own hit region while the renderer is healthy. Laser Mode adds three safeguards on top (`laser.ts`, `props.ts`, `renderMapping.ts`):

1. **The dot takes no clicks.** It is a drawing on a canvas with pointer events off and is not part of the hit region; a click on the dot goes through to the app underneath.
2. **The cat keeps the hit region away from the hotspot.** The stand-off is never less than the paw's whole reach plus the 8 DIP click-through clearance, the hysteresis and a quarter of a body width (`laserStandoffPx`), whatever the size and display scale. This is what keeps the cat's hit region from covering the point you are about to click.
3. **The user's clicks take priority.** A pressed button (or one pressed in the last 4 seconds), typing, a drag, pausing the cat, hiding it, a fullscreen app on its display, and every physical state make the cat let go of the light. A command or a touch you gave the cat holds its activity for 8 seconds, and the light waits.

### It is never an endless loop

Following costs stamina. The chase budget is 45 seconds, scaled by the personality's `chaseDuration` and the cat's energy, spent only while following. When it runs out the cat takes a break of roughly 9 to 18 seconds (longer for a cat that likes its rest) and grooms or stretches. Then it may go back to the light.

### Everything else yields to it, and it yields to you

- No world event starts or continues beside it. Starting Laser Mode ends a running event at once.
- A sleeping cat is woken by the light only after the dot has been around for 2.5 seconds, never at once, and never when you put it to sleep yourself.
- The cat does not follow the dot across a gap onto another display or onto a fullscreen display; on Windows no dot is drawn over a display with a fullscreen app in front unless the cat is set to ignore fullscreen apps.
- If the dot has been missing for 0.7 seconds, the cat gives it up and sits.

## Windows details

- The dot is sent to the overlays only while Laser Mode is on and the cat is not paused. A single clearing message follows when it ends, so nothing remains drawn.
- The host polls the cursor faster while the mode is on and returns to its adaptive rate afterwards.
- The dot is drawn over the cat; it is the cat that keeps its distance.
- Multiple displays: the dot goes only to the display that holds it. Mixed DPI and multi-monitor setups are untested on hardware, as for the rest of the app.

## Android details

- The stage window: the cat's visual window is normally just the cat and its margins. While the dot (or event props) exist it widens into one wide, short strip holding the cat and the dot, and it shrinks back 1.5 seconds after they are gone. It never takes touches, and it is capped at 4096 x 900 dp (`stageWindow.ts`, `floatingProtocol.ts`).
- In the app screen and the browser the dot follows the page's own pointer anywhere on the page.
- With the floating cat, Android delivers to GizeCat only a press or a mouse hover on the cat's small touch window, and a touch inside GizeCat's own app window. The dot follows just those and goes away when they stop. A finger that lifted is not treated as a pointer left standing there.
- The session switch is held by the app page and handed to the floating page through a small record and native's "settings changed" message. It is not part of the settings or the profile.

## What it does not do

- It does not capture the screen, read other windows or send anything anywhere. Windows reads the same cursor position the cat already reads; Android reads nothing outside GizeCat.
- It does not change, hide or replace the system cursor.
- It does not follow your finger over other apps on Android. That is a limit of the platform, stated in the panel.
- It does not make the cat chase for ever or pounce on the dot.
- It is not saved: not in the settings, not in a profile, not in the cat's memory.
- It does not work while the cat is hidden or paused, or on a fullscreen display.
- It is not a screen-reading feature and is separate from the opt-in screen perception, which stays off by default.

## Where it is pinned

Written and NOT RUN: `tests/unit/core/behavior/laser.test.ts` (the pure stand-off and decision rules), `tests/unit/core/behavior/sim-laser.test.ts` (the sim layer), `tests/unit/main/catHost.test.ts` and `renderMapping.test.ts` (the host and the mapping), `tests/unit/main/companionMenus.test.ts` and `companionIpc.test.ts` (menus and actions), `tests/unit/renderer/props.test.ts` (the dot), `tests/unit/web/sessionFlags.test.ts`, `stageWindow.test.ts` and `overlaySurface.test.ts` (Android).
