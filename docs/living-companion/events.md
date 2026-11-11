# World events

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: no 1.5.0 code has been executed, so no event has been seen on a desktop, an emulator or a phone. Every rule below is read from `src/core/events/` (`schedule.ts`, `engine.ts`, `catalog.ts`, `mechanics.ts`) and from the sim layer that carries it out (`src/core/behavior/simCompanion.ts`).

Back to the [overview](README.md).

A world event is a small, harmless thing that happens around the cat: a mouse runs across the floor, a butterfly flutters by, a little wave rolls in. The event engine is pure and deterministic. It draws the props and describes what the cat is invited to do; the sim decides whether to do it.

## The scheduler, exactly as implemented

All numbers are constants in `src/shared/companion.ts` and `src/core/events/schedule.ts`.

1. **The delay.** After the app starts, and after every event ends, the engine draws a raw delay uniformly between 5 and 30 minutes. The delay is counted from the end of the previous event, not from its start, so two events are always at least one event length plus the delay apart.
2. **The pace.** The delay actually waited is the raw draw divided by the pace, and never less than 2 minutes (`EVENT_DELAY_FLOOR_MS`). The pace is checked while counting, so changing it affects the countdown already running. At the default pace of 1 the range is 5 to 30 minutes; at 2 it is 2.5 to 15; at 0.5 it is 10 to 60.
3. **The countdown only runs while the cat is free.** Time counts only while events are enabled, the cat is allowed to start one, and the user is not busy with it. When any of those is false the countdown pauses; it does not reset. One tick never adds more than 5 seconds (`MAX_COUNTDOWN_STEP_MS`), so a suspend or a clock jump cannot cause an instant event or a burst.
4. **"The cat is allowed" means all of these** (`eventsAllowed` in `simCompanion.ts`): events not paused for this session; the sim in its normal mode (not paused, hidden or away); the cat not hidden; Laser Mode off; the cat not held, airborne (other than an event's own hop) or in a physical state; no fullscreen app on the cat's display; and typing intensity under 0.5. "The user is busy" means the pointer is over the cat, it is being dragged, or it was touched in the last 4 seconds.
5. **When the time is up** the engine checks again whether the cat is busy (held, falling, being petted, away). If so the event simply stays due until the cat is free. Otherwise it chooses an event.
6. **Choosing.** With probability 0.06 (`RARE_EVENT_PROBABILITY`), and only when rare events are on, the draw is from the rare pool. If the rare pool has nothing offerable, the draw falls back to the normal pool. Within a pool the pick is weighted: the event's base weight, times a time-of-day factor, times a recency factor.
   - Time of day: an event that prefers day (07:00 up to 19:00) or night (20:00 up to 06:00) gets 1.8 in its preferred time and 0.5 in the opposite one; the twilight hours count as 1. Events with no preference always count 1.
   - Recency: an event that ended recently keeps 0.25 of its weight, recovering linearly to full weight three hours after it ended (wall time).
7. **Repetition control.** Normal events exclude the previous 3 events; rare events exclude the previous 6. If you have switched off so much that nothing is left, the exclusion is relaxed step by step (all three, then only the last one, then none). The history is bounded to the last 16 events and is stored with the cat.
8. **Eligibility** (see the table): an event is offered only if it is not switched off, the stage is wide and tall enough, any strict hour window fits, and it is not skipped under reduced motion. Nothing offerable (a very small stage, everything switched off) means the delay is drawn again and the engine tries later.
9. **A sleeping cat.** An event that needs an awake cat, drawn while the cat sleeps, is deferred by a random 20 to 90 seconds (`GRACE_MIN_MS`, `GRACE_MAX_MS`, fixed, not divided by the pace). Falling Star and Meteor Shower do not need an awake cat. A sleeping cat is woken only by an urgent invitation (urgency 0.5 or more: the wave, thunder, a startle), at most once every 5 seconds, and either with a startle (a jumpy cat) or a stretch (a calm one).
10. **Restarts.** On start, and when a profile import or a reset replaces the cat, the stored history is restored but the next event is rescheduled from a fresh delay. A half-played event is never restored. The first event after a launch therefore comes 5 to 30 minutes (at the default pace) of free time after the start.

### The pace setting

`settings.companion.events.pace` is a number from 0.5 to 2 (default 1). The Windows settings page marks 1 as "Default" (move right for more often, left for less); the Android panel shows "Normal" at 1, "Slower (0.5x)" below it and "Faster (2x)" above. It is the only scheduling control besides the master switch, the rare switch and the per-event switches (`enabled`, `rare`, `disabled`).

### What a session pause does

"Pause world events" (tray menu, cat menu, Companion page, Android panel) holds the schedule until you resume or restart. It is session only and stored nowhere. A running event winds down when you pause.

## Outcomes and the cat's temperament

Each event has two to four outcomes. The outcome is chosen when the event starts: each outcome has a base weight, tilted by how far the cat's temperament leans the way the outcome's bias asks (`outcomeWeights` in `engine.ts`; the tilt is clamped to between 0.1 and 4 times the base). So a bold, playful cat is more likely to chase the mouse; a calm one is more likely to watch it. The temperament comes from the personality, the traits, the mood and the energy (see [Personalities](personalities.md)).

The temperament also sets how long the cat takes to notice (alertness and interest; a drowsy cat is slow, a cat facing the prop is quicker), and how long the event lasts (persistent, calm and interested cats stay longer, for the events that list that dependency). An event whose catalogue entry allows it can be missed entirely; it then ends with the outcome `unnoticed`. The engine also records `cut` when an event is wound down while its props are still on screen. Neither `cut` nor `unnoticed` is ever written to the journal.

The cat's reactions are invitations from the catalogue's beats: watch, approach, sneak, chase, flee, play, hide, inspect, brace, climb, hop, shake, settle and react. The stand-off distance for prey-like props is never less than the event's minimum (0.6 body widths for the mouse and the bird, 0.5 for butterflies).

## The 26 events

Weight is the relative weight inside the pool. "Floor" is the free floor width needed in px at size 1 (it is multiplied by the cat's size); "height" is the free stage height above the floor in body widths (the stage is the floor of the cat's display, about five body widths high). Duration is the typical main part in seconds. An asterisk marks an outcome that is worth a journal line. "Awake" means the event starts only while the cat is awake. "Can miss" means a drowsy cat may not notice it at all.

### Normal events (20, weight shown)

| Event (id) | Weight | Eligibility | What happens | What the cat may do | Outcomes | Reduced motion |
|---|---|---|---|---|---|---|
| Little Mouse (`mouseEncounter`) | 10 | floor 380, height 1, any time, awake, 14-26 s, can miss | A tiny mouse scurries across the floor, bolts if the cat gets close, and always gets away. | Watch, sneak, approach, chase (never closer than 0.6 body widths). | watched; sneaked*; chased*; approached | Standard rules only. |
| Mini Tsunami (`miniTsunami`) | 6 | floor 640, height 1.5, any time, awake, 10-16 s, cannot be missed | A small, harmless wave (about 0.65 body widths high) rolls along the floor with a splash. | Hop over it, move out of its way, climb a screen edge where the platform allows it (otherwise it moves away or hops), or get a little wet and shake off. | hopped*; moved; climbed*; wet* | Starts nearer (at most 5 instead of 9 body widths away); fewer droplets. |
| Butterfly (`butterflyEncounter`) | 10 | floor 360, height 2.2, prefers day, awake, 16-30 s, can miss | A butterfly flutters by and flits away when approached. | Watch, follow slowly, chase. | watched; followed*; chased* | No extra wobble; slower wing beat. |
| Falling Leaf (`fallingLeaf`) | 11 | floor 300, height 2.2, any time, awake, 10-18 s, can miss | A leaf drifts down from above and settles on the floor. | Watch, tap it, sniff it. | followed; tapped*; inspected | Standard rules only. |
| Yarn Trouble (`yarnTrouble`) | 8 | floor 380, height 1, any time, awake, 16-28 s, can miss | A ball of yarn rolls in and stops near the cat; it rolls away again when the cat plays. | Play, chase, roll over, groom. | played; tangled*; rolled | Standard rules only. |
| Little Ghost (`littleGhost`) | 6 | floor 420, height 2.2, prefers night, awake, 14-24 s, can miss | A tiny, friendly ghost floats by and vanishes in a small puff of sparkles. | Startle and hide, hide, investigate, walk up to it. | startled*; hid; investigated*; approached* | One sparkle puff instead of three. |
| Cardboard Box (`boxAppears`) | 9 | floor 420, height 1, any time, awake, 18-34 s, can miss | A cardboard box appears for a while. | Sniff it, climb in and sit, rest beside it. | investigated; entered*; rested_beside* | Standard rules only. |
| Mysterious Ball (`mysteriousBall`) | 9 | floor 460, height 1, any time, awake, 14-24 s, can miss | A ball rolls in from nowhere and stops. | Watch, tap it, chase it. | watched; tapped*; chased* | Standard rules only. |
| Little Thunderstorm (`thunderstorm`) | 4 | floor 420, height 3.2, any time, awake, 14-24 s, cannot be missed | A small cloud hovers near the cat, rains and rumbles. One thin, small bolt appears beside the cat for about a third of a second. | Hide, sit through it calmly, or flinch and brace. A rumble sound can play (world sound). | hid*; calm*; startled | Five raindrops instead of ten; no bolt at all. |
| Flying Fish (`flyingFish`) | 6 | floor 560, height 2.8, any time, awake, 5-8 s, can miss | A small fish leaps in a long arc and splashes down. | Startle, watch, hop at it. A splash sound can play. | startled; watched; hopped* | Standard rules only. |
| Tiny UFO (`tinyUfo`) | 5 | floor 560, height 3.2, prefers night, awake, 12-20 s, can miss | A very small flying saucer crosses the sky. | Watch, follow it along the floor, startle. | watched; followed*; startled | Standard rules only. |
| Wind Gust (`windGust`) | 7 | floor 520, height 2, any time, awake, 6-10 s, cannot be missed | A gust of wind blows leaves and a paper plane past. | Crouch low, startle and smooth its fur, trot after a leaf. | braced; reacted; followed* | Three wind streaks instead of seven; leaves only, no paper plane. |
| Paper Plane (`paperPlane`) | 8 | floor 520, height 2.2, prefers day, awake, 9-16 s, can miss | A paper plane glides across and lands softly. | Watch, chase it, inspect it once it lands. | watched; chased*; inspected* | Standard rules only. |
| Magic Sparkles (`magicSparkles`) | 7 | floor 360, height 1.5, prefers night, awake, 10-18 s, can miss | A few sparkles twinkle near the floor and fade. | Reach out with a paw, watch, sniff. | reached*; watched; sniffed | Three sparkles instead of seven, twinkling more slowly. |
| Shadow Visitor (`shadowVisitor`) | 5 | floor 460, height 1, prefers night, awake, 14-24 s, can miss | A harmless dark shape slides by and fades. | Investigate, keep a careful distance, startle and hide briefly. | investigated*; cautious; startled | Standard rules only. |
| Toy Spring (`toySpring`) | 8 | floor 420, height 1.8, any time, awake, 12-22 s, can miss | A springy toy bounces around. | Bat it around, watch, hop along. | played*; watched; hopped | Standard rules only. |
| Bubble Party (`bubbleParty`) | 8 | floor 380, height 2.4, prefers day, awake, 9-16 s, can miss | Small bubbles drift up and pop. | Watch, pop some, hop and pat at them. | watched; popped*; hopped | Four bubbles instead of nine. |
| Curious Bird (`curiousBird`) | 8 | floor 460, height 2.4, prefers day, awake, 14-26 s, can miss | A small bird lands, hops about and flies off. | Watch, creep after it (never closer than 0.6 body widths), chatter at it. A chirp can play (cat sound). | watched; followed*; chattered* | Standard rules only. |
| Falling Star (`fallingStar`) | 6 | floor 420, height 2.4, prefers night, does not need an awake cat, 6-9 s, can miss | A star crosses the upper sky with a short sparkle trail. | Watch, sit quietly as if wishing, give a little meow. | watched; wished*; amazed* | One trail sparkle instead of three. |
| Tiny Treasure (`tinyTreasure`) | 6 | floor 380, height 1.5, any time, awake, 14-24 s, can miss | A tiny treasure turns up on the floor; the outcome is the object found. | Look, come over and inspect, then a sparkle. | coin*; gem*; shell*; button* | One glint sparkle instead of three. |

### Rare events (6)

Rare events are a separate pool, drawn with probability 0.06 per due event when "Rare events" is on, and excluded for the previous six events. None of them can be missed except the Midnight Visitor.

| Event (id) | Weight | Eligibility | What happens | What the cat may do | Outcomes | Reduced motion |
|---|---|---|---|---|---|---|
| Golden Butterfly (`goldenButterfly`) | 4 | floor 460, height 2.4, prefers day, awake, 34-55 s, cannot be missed | A rare golden butterfly lingers and leaves a trail of sparkles. | Watch, follow gently, dance. | watched*; followed*; danced* | One trail sparkle instead of three; no wobble. |
| Treasure Discovery (`treasureDiscovery`) | 4 | floor 520, height 2.2, any time, awake, 22-36 s, cannot be missed | A little chest appears and bursts into sparkles; a soft chime can play (world sound). | Open it with its nose, sniff it, tap it with a paw. | opened*; sniffed*; pawed* | Three burst sparkles instead of eight. |
| Friendly Ghost (`friendlyGhost`) | 3 | floor 420, height 2.2, prefers night, awake, 20-34 s, cannot be missed | A softly glowing ghost keeps the cat company for a moment. | Sit together, watch, play. | befriended*; watched*; played* | No glow sparkles; one puff instead of four. |
| Meteor Shower (`meteorShower`) | 4 | floor 520, height 3, prefers night, does not need an awake cat, 12-18 s, can miss | A small shower of meteors crosses the upper sky. | Watch, sit quietly, meow softly. | watched*; wished*; amazed* | Not offered at all under reduced motion. |
| Tiny Dragon (`tinyDragon`) | 3 | floor 520, height 3, any time, awake, 20-32 s, cannot be missed | A tiny, friendly dragon hovers and puffs little sparkles. | Watch, play along, startle then relax. | watched*; played*; startled* | Two sparkles per puff instead of three. |
| Midnight Visitor (`midnightVisitor`) | 3 | floor 460, height 1, only between 22:00 and 05:00, awake, 20-32 s, can miss | A quiet silhouette visits late at night. | Watch, greet it with a soft meow, keep out of sight. | watched*; greeted*; hid* | Standard rules only. |

Under reduced motion every event also follows the general rules below, not only the specifics in the column.

## Reduced motion

When `companion.reducedMotion` is on, or the system asks for reduced motion, the engine (`engine.ts`, `mechanics.ts`):

- plays the event clock at half speed and makes the main part 0.35 times as long (never under 2.5 seconds);
- shrinks travel spans to 0.4 of normal and uses fewer particles (fewer drops, bubbles, sparkles and streaks);
- never offers an event that is marked `skipReduced` (only Meteor Shower);
- draws no lightning bolt;
- slows twinkling and wing beats, and halves prop animation amplitude in the renderer (`props.ts`).

The cat itself is also calmer: no running by choice, hops only, calmer reactions and a slower cadence (`reducedMotion.ts`). Drags, throws and falls are the user's and stay as they are.

## Interruption and recovery

- **The user always wins.** A tap, a pet, a drag, a call, a play or a wake command ends a running event at once with a quick 250 ms fade. So does Laser Mode starting.
- **Suspend, lock and a display change** end the event at once and redraw the delay.
- **Everything else winds down gracefully** (a pause, hiding the cat, a fullscreen app arriving, switching events off, a command to sleep, typing hard, the cat being picked up): props that can run off do (the mouse, butterfly, bird and dragon flee), the others fade in place (1.5 s), dissolve (1.2 s) or pop (0.6 s). A prop is never frozen in mid-air. A safety limit winds down any event 20 seconds after it should have finished.
- **After an event** the aftermath beat plays on for a moment after the last prop is gone. The cat's body is released when the engine stops sending invitations (after 600 ms without one), and a hiding cat stays hidden a little longer. The schedule restarts only after the event has finished, with a fresh delay.
- **Not every invitation is taken.** The cat yields to a reaction, the user or the physics; a gentle invitation is ignored by a busy or drowsy cat. After another behaviour takes the body, the event waits 4 seconds before asking again.

## What never happens

- **The mouse is never caught.** No prop is prey: there is no pounce at a prop, no "caught" outcome, no hunt or pounce counters and no catch emote. Prey-like props keep a minimum stand-off. The mouse's outcomes are watched, sneaked, chased and approached, and in each of them it gets away.
- **Nothing covers the screen.** Props are small (their size is a fraction of the cat's body width), at most 24 are drawn at once, they are clamped into a stage of about five body widths above the floor, and they are drawn behind the cat with pointer events off. They are never part of the hit region, so they never take a click. On Android the stage window widens only as far as it needs, capped at 4096 x 900 dp, and never takes touches.
- **No flashes.** There is no full-screen or large-area brightness change. The only lightning is one small, thin bolt beside the cat for about a third of a second in the thunderstorm, and none under reduced motion. Twinkling is slow (roughly 1 to 2 times a second, slower under reduced motion). This is a statement about the code as read; it has not been checked by watching the app.
- **Nothing is sent anywhere, and no event is announced.** Events involve no network, no screen reading and no notification.

## Where it is pinned

Tests that cover this area were written and have NOT been run: `tests/unit/core/events/catalog.test.ts`, `engine.test.ts` and `tracks.test.ts` (the schedule rules, the catalogue, outcomes and interruption), `tests/unit/core/behavior/companion-sim.test.ts` (the sim integration), `tests/unit/renderer/props.test.ts` and `livingCompanion.test.ts` (drawing), `tests/unit/main/renderMapping.test.ts`, and `tests/unit/web/stageWindow.test.ts`.
