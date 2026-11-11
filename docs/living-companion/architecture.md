# Living Companion: developer architecture

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: no test, emulator, simulator or application launch was performed for any 1.5.0 code, so every statement about behaviour on this page is a reading of the code, not an observation. The tests named below were written and have not been run.

Back to the [overview](README.md). The sim layers are described in more detail in [Living Companion in the sim](../gizeverse/living-companion-sim.md). Project-wide rules (what must never change) are in `CLAUDE.md` and `docs/THREAT_MODEL.md`.

## Layers and seams

```
src/shared/      contracts and zod schemas: vocabulary (companion.ts), settings, persisted cat (catState.ts),
                 render state (cat.ts), sim contract (sim.ts), animation metadata (animationCatalog.ts),
                 UI text tables (worldText.ts, personalityText.ts), profile transfer
src/core/        pure logic, no Electron, no DOM, no Node
   events/       the world-event engine: catalog, schedule, mechanics, tracks, engine
   behavior/     the sim (state machine and layers), personalities, mood, world memory, laser, reduced motion
src/main/        Windows host: catHost, overlay manager, win32, store, ipc, tray and menus
src/renderer/    overlay (rig, animator, props, runtime) and settings pages (sandboxed)
src/web/         web and Android host: the same sim and host in a page, Android floating window protocol,
                 stage window, home panel
android/         the native Android shell (Kotlin): the floating windows, the service
```

The seams, from the inside out:

1. **`src/shared` is platform-agnostic** (ESLint-enforced: no Node built-ins, no Electron, no `Math.random`, no `new Date()` in core). Vocabulary and schemas live here so that every layer and both hosts read the same definition.
2. **The event engine and the sim meet at one narrow interface** (`src/core/events/types.ts`). In: `EventTickInput` (the clock, the wall clock, the local hour, the random source, the stage rectangle, the cat's view, the temperament, the user's choices, whether an event is allowed, whether the user is busy). Out: `EventTickOutput` (the props, an `EventIntent`, the active event, and on the tick one finishes, a history entry and an optional journal entry). The engine never touches the cat. It never sees the personality table either, only the nine-number `EventTemperament`.
3. **The sim is the source of truth for the body.** `simCompanion.ts` turns an intent into an ordinary activity (idle, walking, playing, resting or hiding) with the variant `event`. The existing mover, clips and transition table do the work. Nothing was added to `BehaviorState`. The user, the physics and sleep or fear can all refuse an invitation.
4. **The sim and the host meet at `SimEnv` (in) and `SimOutput` (out)** (`src/shared/sim.ts`). The Living Companion fields are all optional, so an ordinary tick is unchanged: `laserMode`, `reducedMotion`, `eventStage` in; `props`, `mood`, `sleepDepth`, `worldEvent`, `journalEntry` out.
5. **The host maps the output to each overlay** (`src/main/overlay/renderMapping.ts`, `overlayManager.ts`), then the renderer draws (`src/renderer/overlay`).

## Data flow

```
host tick (catHost.step)
   SimEnv: cursor, window info, hidden/paused, localHour, laserMode?, reducedMotion?
      |
      v
CatSim.tick -> ... SimCompanion.stepCompanion -> WorldEventEngine.tick(EventTickInput)
      |                  |                            |  props + intent + finished
      |                  |<---------------------------+
      |                  +-- mood (moodFor), sleepDepth, history + journal -> cat.world
      v
SimOutput (world px): cat pose, clip, props?, mood?, sleepDepth?, worldEvent?
      |
      v
renderMapping.mapProps / mapLaser / render state (overlay-local DIP, one per display)
      |
      v
OverlayRuntime (renderer): sanitise (validate.ts) -> CatAnimator (clip + mood layers + deep sleep)
                           -> drawProps (behind the cat) -> cat -> drawLaser (over the cat)
```

Notes on the steps:

- `catHost.step` (shared by Windows and the web host) samples the cursor, fullscreen displays and the clock, builds `SimEnv`, runs the sim in bounded sub-steps and passes `extras` (the laser dot and the reduced-motion flag) to the overlays only when set.
- The engine runs inside the sim tick. Its output is held for one tick: props are replaced every tick, the journal entry is cleared at the start of the next.
- `renderMapping` converts props from world px to overlay-local DIP, sends only the props that reach a display, and sends the laser only to the display that holds it. After the mode ends, one clearing message follows so nothing stays drawn.
- The renderer sanitises every field (`validate.ts`: an unknown prop kind, a non-finite number or a bad mood is dropped, never trusted), draws props behind the cat and the dot over it, both with pointer events off, and reports the hit region from the cat's scene only. Nothing in this feature can make the overlay interactive.
- The renderer keeps a calm 30 fps while props or the dot are on screen, even while the cat sleeps (`runtime.ts`).

## Platform adapters

| Concern | Windows host | Web and Android host |
|---|---|---|
| Composition | `src/main/app.ts` builds `createCatHost` with the Win32 pieces. | `src/web/main.ts` builds the same `createCatHost` (imported from `src/main/catHost.ts`) with an unavailable Win32 API, web overlays and a pointer router. |
| Overlays | Transparent, click-through Electron windows per display (`overlayManager.ts`). | `createWebOverlays` (`webOverlays.ts`) draws into the page; on the Android floating cat `overlaySurface.ts` sizes and places the native window and its small touch window. |
| Props placement | On the display overlays they reach. | The stage window (`stageWindow.ts`): the union of the cat's window and the padded props and dot bounds, sticky, clipped to the screen, never above the protocol caps (`floatingProtocol.ts`, kept in lockstep with the native side). |
| Pointer for Laser Mode | The cursor sample, handed on only while the mode is on. | `cursorFallback` in `web/main.ts`: the router's cursor while pressed or hovering, else a fresh hint from the app window (`overlaySurface.cursorHint`, 1.8 s). |
| Reduced motion | `systemPreferences.getAnimationSettings().prefersReducedMotion` (`app.ts`). | `prefers-reduced-motion` in the WebView. |
| Persistence | `cat-state.json` through `catStore.ts` and `jsonStore.ts` (atomic write, backup, quarantine). | `localStorage` through `src/web/storage.ts` (`gizecat.web.cat.v1`, `gizecat.web.settings.v1`), same schemas and recovery. |
| Session-only flags | Held by the host (`setLaserMode`, events pause). | `sessionFlags.ts`, written by the app page and read by the floating page, cleared at app start. |
| UI | `src/renderer/settings/pages` (Companion, Personality, Interaction, Audio, Accessibility, Journal), tray and cat menus (`menuModel.ts`), IPC actions (`ipc/actions.ts`). | `androidPanel.ts` and the settings sheet, through the web allow-list (`settingsModel.ts`). |

Every IPC payload on Windows stays zod-validated and sender-checked, and the renderers stay sandboxed (see `docs/THREAT_MODEL.md`); the Living Companion adds actions (`startLaserMode`, `stopLaserMode`, `pauseEvents`, `resumeEvents`, `clearJournal`) to the existing action channel and a `companion` view to the view state, not a new channel.

## Determinism and the injected clock and random

Everything in `src/core` is deterministic for a given seed:

- **No ambient time or randomness.** The clock (`now`, `wallNow`, `localHour`) and the random source arrive through `EventTickInput` and `SimEnv`; ESLint forbids `Math.random` and `new Date()` in core.
- **The engine has its own stream.** `SimCompanion` seeds one stream from the cat id, the session counter and the wall-clock second, and never draws from the main stream. Laser Mode and the body-care variety each have their own streams too (`simLaser.ts`). So a seeded run that never uses an event, the laser or a care variant draws exactly what it drew before 1.5.0.
- **Randomness is sanitised.** `safeRandom` clamps any out-of-range or non-finite draw before the engine uses it.
- **Time cannot burst.** One countdown tick never advances more than 5 s, one event step never integrates more than 1 s, and a suspend, lock or display change ends the event and redraws the delay.
- **Pure helpers.** `schedule.ts`, `laser.ts`, `mood.ts`, `personalityProfiles.ts`, `worldMemory.ts` and `animationCatalog.ts` are pure functions over plain data, tested without a sim.

## Persistence

- The persisted cat gets one additive section, `world` (history, counters, last-ended time, journal), with no schema bump. Entries are validated one by one and bounded on load. Details in [Journal and memory](journal-and-memory.md).
- The user's choices live in the `companion` section (`personality`, `events`, `reducedMotion`, `journal`) and the `sound` section (`cat` and `world` switches) of the settings (`src/shared/settings.ts`). A patch may send one leaf of `events` or `journal` and it is merged.
- Mood, sleep depth, the running event, Laser Mode and the events pause are never persisted.
- The profile file carries the `companion` and `sound` choices and never the `world` section (`PROFILE_FIELD_POLICY` and `PROFILE_CAT_POLICY` are exhaustive at compile time).

## How to add things

Each step names the file; the compiler or a test catches most omissions. Run the checks yourself (this documentation did not).

### Add a world event

1. Add the id to `WORLD_EVENT_IDS` (or `RARE_EVENT_IDS`) in `src/shared/companion.ts`. The id list feeds the settings schema, the settings lists and the Android panel automatically.
2. Add an `EventDef` to `NORMAL` or `RARE` in `src/core/events/catalog.ts`: weight, duration, one of the eight mechanics (`floorRunner`, `flutter`, `hopper`, `wave`, `weather`, `drifter`, `settler`, `visitor`), props, floor and height needs, time preference, outcomes (each with a lower-case token of 1 to 24 characters of `a-z0-9_`, a base weight, a bias, a journal flag and the beats the cat is invited through), the mood, the interrupt style and the minimum stand-off for prey-like props.
3. If no mechanic fits, add an init branch in `src/core/events/mechanics.ts` (a family reads its event's entry; most events are a few lines of tracks via `tracks.ts`). Keep every prop inside the stage, under `MAX_PROPS`, and handle `ctx.reduced`.
4. Add an `EVENT_TEXT` entry in `src/shared/worldText.ts`: a name, a description, a fallback sentence and one sentence per outcome. Keep the tone (no exclamation marks, no guilt, no streaks).
5. If it needs a new prop, see the next section.
6. Update the pins: `tests/unit/core/events/catalog.test.ts` asserts "exactly one entry per event id, 20 normal and 6 rare", every outcome token, journal-worthiness and the world text coverage, so it fails until you update the counts and the table. Add engine cases to `engine.test.ts`.
7. Update [World events](events.md) (the table, the counts) and `docs/USER_GUIDE.md` if the user-facing list changes.

### Add a personality

1. Add the id to `PERSONALITY_IDS` in `src/shared/companion.ts`. The order matters: a tie in `nearestPersonality` goes to the earlier id.
2. Add the profile to `PERSONALITY_PROFILES` in `src/core/behavior/personalityProfiles.ts` (a `Record<PersonalityId, ...>`: the compiler requires it): seven target traits inside the generator band and the knobs. Keep it far from the others in trait space, or the drift guard (halving until the cat still reads as its own personality) has nothing to hold on to.
3. Add its words to `PERSONALITY_TEXT` in `src/shared/personalityText.ts`.
4. Check the settings enum (it is built from `PERSONALITY_IDS`), the Android panel and the pages; update `tests/unit/core/behavior/personalityProfiles.test.ts` and `tests/unit/renderer/settings/companionPages.test.ts`.
5. Update [Personalities](personalities.md).

### Add a prop kind

1. Add the kind to `PROP_KINDS` in `src/shared/companion.ts` (the renderer's validator uses the same list).
2. Add a drawer to `DRAWERS` in `src/renderer/overlay/props.ts`: a `Record<PropKind, ...>`, so it fails to compile until you do. Draw procedurally (no image), respect `reducedMotion` (halved amplitude, no flicker) and keep it inside its reach in `src/renderer/overlay/propBounds.ts` (the presence and dirty-rect logic read it).
3. Use it from an event's `props` and a mechanic. Props are never part of the hit region.
4. Cover it in `tests/unit/renderer/props.test.ts`.

### Add a clip

1. Add the name to `ANIM_CLIPS` in `src/shared/cat.ts` (and to `ONE_SHOT_CLIPS` if it is a one-shot).
2. Add its entry to `CLIP_META` in `src/shared/animationCatalog.ts` (a `Record<AnimClip, ClipMeta>`: it fails to compile otherwise) and, if a platform may lack it, a stand-in in `CLIP_FALLBACK`.
3. Draw it in `src/renderer/overlay/cat/clips.ts` (and `rig.ts` or `animator.ts` if it needs a new pose field; list it in `TAIL_AUTHORED` if its tail is authored).
4. Reach it from the sim through a phase in `src/core/behavior/clips.ts` or an event beat's `clip`.
5. If it fits a product behaviour, add or update the row in `BEHAVIOR_CATALOG`.
6. Tests: `tests/unit/renderer/clips.test.ts` and `presence.test.ts` (the drawn extent of every clip against the margins), `livingCompanion.test.ts`. Update [Animation system](animation-system.md).

## Which files and tests pin what

All of these were written and have NOT been run.

| Area | Source | Tests |
|---|---|---|
| Scheduler, catalogue, outcomes, interruption | `src/core/events/*` | `tests/unit/core/events/catalog.test.ts`, `engine.test.ts`, `tracks.test.ts` |
| Personalities, temperament, drift | `personalityProfiles.ts` | `tests/unit/core/behavior/personalityProfiles.test.ts` |
| Mood and sleep depth | `mood.ts` | `tests/unit/core/behavior/mood.test.ts` |
| World memory, journal bounds | `worldMemory.ts`, `catState.ts` | `tests/unit/core/behavior/worldMemory.test.ts`, `tests/unit/main/catStore.test.ts` |
| The sim integration | `simCompanion.ts` | `tests/unit/core/behavior/companion-sim.test.ts` |
| Laser Mode | `laser.ts`, `simLaser.ts` | `tests/unit/core/behavior/laser.test.ts`, `sim-laser.test.ts` |
| Settings and profile policy | `settings.ts`, `profileTransfer.ts` | `tests/unit/shared/companionSettings.test.ts`, `profileTransfer.test.ts`, `settings.test.ts` |
| Render mapping, host | `renderMapping.ts`, `catHost.ts` | `tests/unit/main/renderMapping.test.ts`, `catHost.test.ts`, `overlayManager.test.ts` |
| Props, dot, animator, clips | `src/renderer/overlay/*` | `tests/unit/renderer/props.test.ts`, `livingCompanion.test.ts`, `animator.test.ts`, `clips.test.ts`, `presence.test.ts`, `sound.test.ts` |
| Menus, IPC actions, pages | `menuModel.ts`, `ipc/actions.ts`, `settings/pages` | `tests/unit/main/companionMenus.test.ts`, `companionIpc.test.ts`, `tests/unit/renderer/settings/companionPages.test.ts` |
| Android stage window, panel, flags | `src/web/*` | `tests/unit/web/stageWindow.test.ts`, `overlaySurface.test.ts`, `floatingProtocol.test.ts`, `sessionFlags.test.ts`, `settingsModel.test.ts`, `strings.test.ts`, `tests/unit/android/androidProject.test.ts` |

The definition of done for a change here is the project's own: `node .claude/scripts/verify.mjs fast` passes on the final tree and every claim carries a label (see `CLAUDE.md`). For 1.5.0 that has not been done by this documentation pass.
