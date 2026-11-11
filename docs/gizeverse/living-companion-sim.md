# Living Companion in the sim: events, Laser Mode, reduced motion, body care

Status: implemented and type-checked; **UNVERIFIED at runtime** (the unit tests below were written and not run
in this session; nothing here has been seen on a desktop or a phone).

The sim (`src/core/behavior`) stays the source of truth for behaviour. These layers sit at the top of the
class chain (`simCore -> simDrives -> simStay -> simHunt -> simReactions -> simSalience -> simUtility ->
simActivities -> simCompanion -> simLaser -> sim`). Everything is pure TypeScript with an injected clock and
random source; there is no DOM, Node or Electron in `src/core`.

## 1. How world events drive the body (`simCompanion.ts`)

The world-event engine (`src/core/events`) is ticked every sim tick with the cat's situation
(`eventInput`). It returns props (world px, passed through to the renderer unchanged) and, after the cat has
had time to notice, an *intent* (watch, approach, sneak, chase, flee, play, inspect, hop, settle, shake...).

- The body of an event is an ordinary activity (idle, walking, playing, resting or hiding) with the variant
  `event`; the existing Mover, clips and transition table do the work. Nothing was added to `BehaviorState`.
- The user and the physics always win: drag, throw, tap, petting and every physical state interrupt the
  event (`events.interrupt('user' | 'drag')`); a sleeping cat only wakes for an urgent intent (>= 0.5); a
  busy cat ignores gentle invitations.
- Props are never prey: no pounce at a prop, no 'caught', no hunt counters. The hold-still zone and the cursor
  clearance of `goTo()` apply to every event walk.
- `intent.sound` and `intent.emote` are one-shots (present only on the tick a beat begins); everything else is
  re-emitted every tick, so the body is released when no intent arrives for `BODY_STALE_MS`.
- Personality reaches the engine as an event temperament (`temperamentFor`), including two flags: a shy cat
  (`watchFirst`) only watches a calm beat for 6 to 12 s before performing it and then keeps a 1.5 times wider
  stand-off; a lazy cat (`ignoreMinor`) lets a minor event (leaf, paper plane, sparkles, bubbles, falling star)
  pass 60 % of the time: props play, no intent is sent, the outcome is 'unnoticed' (never journalled). Urgent
  beats are never delayed and forced events are never ignored.
- Novelty: `SimCompanion` hands `cat.world.counts` to the engine at construction, on `onCatReplaced` and in
  `forgetWorld` (so Clear journal and Clear history reset it). Rarely met events are chosen up to 1/0.6 times
  more often than very familiar ones and noticed about 0.85x to 1.2x as fast (never for urgent events).
- While Laser Mode is on, `eventsAllowed()` is false: a running event winds down, none starts.

## 2. Laser Mode (`laser.ts`, `simLaser.ts`)

Laser Mode is the user's own game: while `env.laserMode` is on and the cursor is on the cat's display, the
**real cursor is a light**. The overlay draws the dot; the sim decides what the cat does about it.

The body is one `walking` activity with the variant `laser` (no new `BehaviorState`: `states.ts`,
`CLIP_MAP` and the exhaustive tests are unchanged in shape). Its phases are `approach` (moving; the clip
follows the speed: walk or run), `sit` (watching), `pawAt` (a paw out) and `loaf` (the dot rested for 12 s).
A hop at a dot overhead goes through the existing `jumping` physical state and the activity resumes after
the landing.

### The stand-off (never closed)

`laserStandoffPx(bodyWidth, scale, size)` is the larger of `LASER_STANDOFF_BODY_LENGTHS` body widths and
`HIT_FRONT_EXTENT_DIP.pawAt + HIT_CLEARANCE_DIP + the click-through hysteresis + 0.25 body widths`, so the hit
region never comes near the hotspot at any size or display scale (T8). `laserDecision` (pure) makes the
choice for one tick:

- the goal is on the cat's own side of the dot, `standoff + margin` away, and is **dropped** when the walkable
  span would put it closer than the stand-off;
- a dot already inside the stand-off (the user moved it onto the cat) makes the cat **hold still**, not back
  off: a click or a pet is never dodged, and the cat still does not close the gap;
- the paw reaches (`pawAt`, never `swat`, never a pounce) only for a resting dot in reach, only with
  `strikeClearancePx('pawAt', ...) >= requiredClearancePx` and only if "Paw at the pointer" is not switched off;
- a hop needs a dot at 1.4 to 4 body heights above the feet, room for the hop itself (a cat that may hop stops
  0.75 body widths beyond the stand-off, a hop carries 0.35 toward the dot) and jumps not switched off by the
  user (`pounce` or `surfaceHops`; reduced motion does not count, a hop is allowed there);
- the cat's own goal setter (`laserGo`) does not use the hold-still pause of `goTo` (it would freeze the cat
  at the stand-off, which lies inside that zone); the stand-off, not a pause, keeps the hit region off the hotspot.

No hunt starts (`huntStartable`, mischief swat and playful retreat are off while Laser Mode is on), so there
are no `hunts`, `pounces`, `chasesStarted` counters, no memories and no catch emote.

### Priorities

The laser body does not take the cat from: any physical state, being held or petted, a reaction playing out
(startled, annoyed, hiding), a command or interaction of the last 8 s, a pending request, an edge visit, a
wall climb. It ends (to a calm idle, no teleport) when: Laser Mode ends, the mode is not `normal` (paused,
hidden, away, quiet, locked), a fullscreen display holds the cat, a button is down or was pressed in the last 4 s
(also the host's press counter), raw typing, a drag, or the dot is gone for 0.7 s. Losing a dot after a chase of
at least 2.5 s may show the `confused` flourish.

Sleep: Laser Mode wakes a sleeping cat only after the dot has been around for 2.5 s, through the existing
`wakingUp` path (never the launch intro nap).

### Stamina

Following spends a chase budget (`laserChaseBudgetMs`: 45 s scaled by `knobs.chaseDuration` and the energy) and a
little energy; holding still recovers half as fast. At the end of the budget the cat takes a break
(`laserBreakMs`: 9-18 s scaled by `restBias`): a groom if grooming is allowed, else a stretch, then goes back to
the light. Keen profiles (energetic, mischievous) chase longer and run; calm and lazy ones follow later (a
dead zone grows with `restBias`), tire sooner and watch more. Reduced motion never runs.

### Screen edges

With `env.edgeBands` and the existing gates (`scanEdge`: cooldown, typing, cursor clearance) the cat may use a
full screen-edge climb toward a dot within 2.5 body widths of a side edge and above it. Otherwise it looks up.

## 3. Reduced motion (`reducedMotion.ts`)

`settings.companion.reducedMotion` or `env.reducedMotion` selects one pure policy (`motionPolicy`):

| Rule | How |
| --- | --- |
| no sprint, no running by choice | `goTo` maps run/chase/sprint to walk (`calmPace`); the laser decision never picks run |
| only hops for voluntary jumps | the opt-outs `pounce`, `surfaceHops`, `slips`, `zoomies`, `tailChase` are added on top of the user's own (`withMotionOptOuts`; the very same set object when off); the Mover's `surfaceHops` and `wallJumps` follow |
| calmer reactions | decorative overlays (ear/tail flick, head tilt) are dropped; event intents are already softened by the engine |
| slower cadence | `dwellFor` x 1.35 |
| user physics unchanged | drag, throw, fall and landing are not touched |

Switching the preference on or off recomputes the opt-outs from the settings, so a user's own opt-outs are never lost.

## 4. Body-care variety

- **Grooming** gets phases (`main` face wash, `paw`, `scratch`): 16 % of bouts open with a scratch, a face wash
  continues into a paw wash (45 %) or a scratch (12 %), at most three steps; the grooming dwell still ends the
  bout. `paw` is drawn with the same `groom` clip as the face wash (the renderer has one groom clip).
- **Settling** before sleep: a quarter of the falling-asleep sequences start with a short `sit`, 17 % with a
  `stretch`, taken out of the yawn so the whole sequence keeps its length (seeded timings are unchanged).
- **Flourishes** are one-shots over a calm body, chosen through `resolveClip` and `canSwitch` (a clip that is
  not interruptible finishes first): `shake` after an annoyed reaction (25 %) or a hard landing (35 %),
  `confused` when a laser dot vanishes after a chase, after a refused hop, and when a hunt's prey cursor is gone
  (50 %). The wet-cat `shake` after the tsunami is the event engine's intent (see section 1).
- The animation catalogue's `CLIP_META` priorities are honoured by `careClip`; phases map to clips in `CLIP_MAP`.

## 5. Determinism

- The event engine and this layer draw only from streams derived from the cat id, the session counter (and, for
  events, the wall clock): `companionRandom`, `laserRandom`, `careRandom`. The main stream is never drawn from by
  them, so a seeded run with no event, no Laser Mode and no body-care variant reached keeps the sequence it had.
- Body-care picks do draw from `careRandom` at every grooming or falling-asleep entry, but never from the main
  stream; phase timings of the existing sequences are unchanged (the settle lead is cut out of the yawn).
- The main-stream draws made during Laser Mode are those of the machinery it starts (an idle pose, an edge
  visit's hold, the follow-up activity).
- Reduced motion off returns the identical opt-out set and dwell, so default runs are bit-identical.

## 6. Tests (written, not run)

- `tests/unit/core/behavior/laser.test.ts`: stand-off geometry at every size and scale, the decision (never a goal
  inside the stand-off, hold when inside, runs vs walks, reach and hop gates, stamina) and the reduced-motion policy.
- `tests/unit/core/behavior/sim-laser.test.ts`: the stand-off never violated in the sim, no hunt state, pounce
  clip or hunt counters, reach and hop and their opt-outs, a press stops the chase, gentle wake from sleep, clean
  hand-back, pause / hidden / fullscreen / held / typing, confused on a vanished dot, reduced motion in the sim,
  scratch and settle variants reachable.
- `tests/unit/core/behavior/states.test.ts`: the new phases map to the documented clips.
