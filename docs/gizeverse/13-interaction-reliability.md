# Interaction reliability: long runs and the soak (1.3.0)

Status: the record for release 1.3.0. Labels as in [02-verification.md](02-verification.md): REAL (executed and observed here), SIMULATED, MOCKED, UNVERIFIED. All runs are on the validation machine (Windows 11 Home 10.0.26200, one 1920×1200 display at 125 %).

## The report

After several hours of running, the owner's 1.2.0 cat stopped responding to clicks, drags and throws. Hovering still worked: a stroke pet was recorded 21 h into the session. The profile's `falls.thrown` and `falls.dropped` stayed flat for about 18 h.

The field logs show *that* handling stopped, not *why*: 1.2.0 logged lost presses only at debug level, below the owner's info level. So the diagnosis read the whole pipeline, ranked the candidate causes, gave each a deterministic test, and fixed each mechanism that exists in the code:

| | Cause | In 1.1.1 | Fix | Where the fix lives |
|---|---|---|---|---|
| H1 | The lost-press heuristic ended a live press on the Win32 button state alone, 400 ms after the press, even while the renderer was still reporting the button held. Effects: taps lost, throws turned into zero-speed drops, slow drags cut short, still holds ignored | yes | F1: the renderer is authoritative while it is alive (below) | `src/main/overlay/overlayManager.ts`, `src/main/win32/win32Api.ts`, `src/main/win32/activityMonitor.ts` |
| H2 | The v1.2 click guard could leave the whole cat click-through: a bail-out keyed on the surface list, fail-closed polls with no grace, and a hover dwell reset by every such poll | no | F2 (the bug parts): the bail-out comes from the real bail-out and is capped by grounded time (10 s ceiling), a stale obstacle list gets a 250 ms grace, and fail-closed polls no longer reset the dwell. The `band` policy is unchanged (ADR 0003 §6.1(a)) | `src/main/catHost.ts` |
| H3 | Timing and bookkeeping: a context menu left the recogniser's press or drag alive; events were stamped with handler time; the main/renderer clock offset kept its lifetime minimum | yes | F3: context ends the press in the recogniser too, events carry `Event.timeStamp` (with coalesced moves), and the offset is a sliding window, reset by `noteResume()` after resume or unlock | `overlayManager.ts`, `src/renderer/overlay/input.ts`, `src/core/interaction/gestures.ts` |
| H4–H8 | Health-check gaps, lock/suspend latches, press-start races, bounds and topmost drift, event-cap ordering | yes | F4–F7: lock and suspend re-derived and recovered (also when Windows misses the unlock or resume event); recreation retried after the failure budget, on a failed load and on a renderer not ready in 30 s; kept overlays that drifted more than 2 px recreated (never moved); pointer and lifecycle events never dropped by the event cap. F8: info-level observability (below) | `catHost.ts`, `overlayManager.ts`, `src/main/app.ts` |

### The root cause that was fixed (H1)

1.2.0 ended a press when, 400 ms after the press, Win32's `GetAsyncKeyState` read the left button as up. It never asked whether the cat's own window was still receiving the held button. Three things make that reading wrong or late:
- `GetAsyncKeyState` returns 0 in documented desktop and foreground conditions, and its failure fallback was "up" (`win32Api.ts`).
- A main-thread stall of 400 ms or more between `down` and `up` (a busy PC) lets the timer fire inside a normal tap or throw.
- The renderer's `up` arriving 400 ms or more late.

The press then ended with a zero-speed drag end, and the real `up` that followed found no press and was ignored. With a reading stuck at "up", every press was cut 400 ms in. A still hold longer than that produced nothing at all, which also fits the owner's flat drop counter.

**The fix (F1).** The renderer is authoritative while it is alive:
- A press ends with the renderer's own `up`, `cancel` or a buttonless move.
- Main ends a press on its own only when Win32 reads "up" **and** the pressing renderer has been silent for `LOST_PRESS_MS` (400 ms). After a move with the button held (a drag that may have paused into a still hold), the silence must last `LOST_PRESS_HELD_MS` (1.5 s).
- Win32's "up" counts only for a press that Win32 saw down at least once. Otherwise the button state is unknown for that press, and only a cursor that moved 12 DIP with no pointer event ends it.
- A failed `GetAsyncKeyState` read is "unknown" (`null`), not "up".
- Silence counted per cursor poll is capped at 130 ms, so a stall of main itself never counts.
- When main does end a press, the press ends at the renderer's last sample, so a throw keeps its speed.
- The T8 rule keeps working: the press releases its capture of the whole overlay only when Win32 has read up for more than 400 ms **and** the renderer has been silent for more than 400 ms.

**How it is proven.**
- Mechanism: REAL run, SIMULATED input. The new press-path tests drive the real overlay manager and recogniser with Win32 reading "up", main stalls and late `up`s.
  - Run against a copy of the source with the five press-path files reverted to 1.2.0, 36 of the 41 new press-path tests fail.
  - 30 of them fail on the old behaviour. With Win32 always reading "up", a throw leaves at speed 0 instead of 860. A lost `up` ends the press at 416 ms. A 450 ms stall loses a tap, and an `up` 450 ms late loses a throw.
  - 6 fail only because they call new API, and 5 pass on both versions (controls).
  - All pass on 1.3.0.
- In the real app: under CDP input Win32 always reads "up", which is trigger (a) by construction. Throws with a wind-up longer than 400 ms land as throws (lively run: 10 of 10 thrown) and the soak's held drags land (below). App REAL, input SIMULATED.
- That H1 is what the owner hit: UNVERIFIED. It needs the owner's cat running 1.3.0 for hours. The info-level lines below make the answer visible in the owner's own log.

## Test layers

| Layer | File | What runs for real | Label of results |
|---|---|---|---|
| Sim over 24 h | `tests/unit/core/behavior/interaction.longrun.test.ts` | the real sim and Mover | SIMULATED (injected environment and clock) |
| Press path over long runs | `tests/unit/main/overlayManager.longrun.test.ts` | real overlay manager and gesture recogniser | SIMULATED (Electron windows MOCKED) |
| Click guard and lifecycle latches | `tests/unit/main/catHostGuard.longrun.test.ts` | real cat host and click-through decision | SIMULATED (Win32 MOCKED) |
| Gesture fuzz | `tests/unit/core/interaction/gestures.fuzz.test.ts` | real recogniser | SIMULATED |
| Real-app soak | `tests/e2e/soak.spec.ts` (opt-in) | the app, renderer input path, IPC, gestures, sim, click-through | app REAL; pointer and cursor input SIMULATED (CDP and `injectCursor`); power events SIMULATED (the app's own handlers) |

### Sim over 24 h (`interaction.longrun.test.ts`)

One continuous simulated day with seed 1 (`DESKTOP_CAT_LONGRUN_SEED` for others). Ticks are 250 ms (the host's longest step) outside gestures and 33 ms while a hand is on the cat.

- **Environment.** The cursor follows a play/work/away rhythm, so the cat hunts, watches a busy hand, and sleeps at an empty desk. The local hour runs from 08:00 round the clock. Window layouts change, and edge bands are clear, or covered when a maximized window is in front.
- **Perturbations, every 6–25 sim-minutes.**
  - Lock/unlock, suspend/resume, and lock → suspend → resume → unlock.
  - Suspend and resume in one tick.
  - Hide/show, pause, fullscreen (hidden by default), a maximized window on or off, a layout change, dragging switched off and on, and a display change.
- **Gestures, about every 75 s.** A gesture comes sooner while a situation still lacks a gesture kind.
  - Situations: floor, asleep, hunting, window top, climbing a window side, screen edge, held, airborne, hidden.
  - Kinds: tap, double tap, stroke bout, drop, slow drag (450 ms – 3 s), throw, lost release (the host stops reporting the drag), mid-air catch, and presses while held.
- **Invariants, checked on every press and every tick.**
  - Every grab outside a designed guard state gives `held` on the same tick. The guard states are: hidden or behind a fullscreen app, and dragging off.
  - Every release gives exactly one fall with the right cause (`thrown` above 1100 DIP/s, else `dropped`). A catch in mid-air replaces the earlier flight.
  - A lost release is dropped by the sim within `DRAG_LOST_MS`. The late "up" is ignored.
  - Presses on a held or airborne cat are no click and no stroke, and do not let go.
  - The counters (`clicks`, `doubleClicks`, `drags`, `throws`, `pets` within bounds) and the profile's thrown/dropped match the oracle exactly.
  - The sim's mode equals the mode the environment implies before every gesture. After every perturbation ends, it is that mode at once, and a probe grab works. A resume before unlock stays `locked`: by design, only unlock ends a lock.
  - The cat is never held without a hand for longer than `DRAG_LOST_MS` + 500 ms, never airborne for longer than the longest flight, and grab attempts are never more than 5 sim-minutes apart.
- Separate cases cover lock and suspend in eight orders, a lock while held, and a resume without unlock.

### Real-app soak (`soak.spec.ts`)

```
node scripts/with-lock.mjs build -- npm run build
DESKTOP_CAT_E2E_SOAK=1 DESKTOP_CAT_SOAK_MIN=120 node scripts/with-lock.mjs soak -- npx playwright test tests/e2e/soak.spec.ts
```

Optional settings:
- `DESKTOP_CAT_SOAK_SCALE`: sim time scale between gestures, default 3.
- `DESKTOP_CAT_SOAK_SEED`.
- `DESKTOP_CAT_SOAK_ONLY`: comma-separated gesture kinds.
- `DESKTOP_CAT_SOAK_PERTURB=0`: no perturbations; a comma-separated list draws only those.
- `DESKTOP_CAT_SOAK_OS_MOUSE=1`: see "Click-through during gestures" below.

- **Isolation.** The soak launches its own app from `out/` with a temp userData. That also isolates Electron's single-instance lock, so an installed GizeCat running for the user is not involved. The test asserts that `getStartup().userData` is the temp folder.
- **Own windows only.** The only window it opens is its own, `ownWindows.ts` `openOwnWindow`, and it calls `restrictSurfacesToPids([own pid])`. If that helper window goes away (for example someone at the desk closes it), the soak reopens it and records a harness incident; the helper writes `closedFromOutside` when its window was closed from outside the test.
- **Loop.** Every 1.5–4.5 s of wall time, one random gesture through CDP mouse events on the cat's overlay page, with `injectCursor` alongside. The gestures are:
  - tap and double tap;
  - a hover stroke;
  - a drag;
  - a throw with a wind-up (the press lasts more than 400 ms);
  - a slow drag of 0.9–2.6 s that keeps moving;
  - a right-click whose native menu is closed by the test, half of them during a drag, each followed by a tap.
- **Perturbations, every 30–80 s.**
  - The own window maximized and then minimized.
  - Hide/show and pause/resume, with a gesture during each.
  - A 4 s renderer freeze: CDP `Debugger.pause`, or a busy loop as fallback.
  - A 6 s CPU hog: up to 4 child processes, started and killed by the test.
  - Suspend/resume and lock/unlock, through the `systemEvent` test hook, which runs the app's own powerMonitor handlers.
  - A nap command.
- **Measures** (attached as `soak-report.json`, and written to the test's folder under `out/e2e-results/`).
  - Success per gesture type, from the counters in the saved cat state and the falls in the behaviour profile.
  - Latency from `mouse.down` to the sim being held.
  - `interactionStats` deltas: presses, lost presses by reason, Win32 disagreements, context cancels, fail-closed polls, ignore toggles, recreates, stale-region denials, click-guard time per reason, and lock/resume recoveries.
  - Click-through with the injected cursor on and off the cat.
  - Main event-loop delay (`eventLoopDelay` hook, 10 s windows).
  - Main and renderer heaps at start and end.
- **Pass criteria.**
  - Every gesture outside a designed guard state lands. The guard states are: hidden, and a press meaning nothing to a held, airborne or landing cat.
  - Nothing sticks: within 3 s main holds no press or drag, and within 9 s the sim is not held.
  - The overlay never takes the mouse off the cat (T8).
  - With the cursor on the cat, the overlay takes the mouse unless a designed guard says otherwise: the click guard active, a physical state, or clinging to a wall.
  - A frozen renderer's overlay is click-through and recovers.
  - Heap growth under 48 MB + 32 MB per hour, for main and for each renderer.
  - No tick errors and no error log lines.
- **Click-through during gestures.** While a gesture runs, the overlay is held click-through with `forceInteractive(false)`. CDP input still reaches the page, and the real mouse cannot.
  - Why it is needed. With `injectCursor` on the cat, the app makes the whole overlay window take the real mouse, wherever the real cursor is. That blocks the desk for the length of the gesture.
  - It also breaks slow drags. Under CDP input, Win32 reads the button as up. After `LOST_PRESS_MS` the press loses its capture of the whole overlay (the F1 T8 rule), and the overlay follows the hit zone. Each switch to interactive lets Windows send the overlay a real mouse move with the button up, which the recogniser reads as the release.
  - With real input, that OS move carries the held button.
  - Click-through itself is measured with the app's own routing, by the probes and the freeze check.
  - `DESKTOP_CAT_SOAK_OS_MOUSE=1` turns the hold off, to reproduce this.
  - The soak also records, in the page, any buttonless pointer move while the primary button is down (`strayButtonlessMoves`).
- **Limits.**
  - CDP input never reaches `GetAsyncKeyState`, so Win32 reads the button as up throughout. A still hold of more than 1.5 s, and trigger (a) under real input, need real OS input. Real OS input moves the user's cursor, so it needs the owner's consent.
  - Multi-monitor is untested on hardware.
  - Only the cat's own display is driven.

## Results

| Run | Command / config | Result | Label |
|---|---|---|---|
| Sim over 24 h, seed 1 | `npx vitest run tests/unit/core/behavior/interaction.longrun.test.ts` | 11/11 pass, about 8 s. In one simulated day: 1,254 gestures; 59 recoveries; falls thrown 329, dropped 521 (exactly the oracle's); 147 mid-air catches; 59 grabs refused, all in designed guard states (hidden, dragging off); 14 grabs each while climbing and on a screen edge, 22 while hunting | REAL run, SIMULATED behaviour |
| Sim over 24 h, seeds 2–11 | `DESKTOP_CAT_LONGRUN_SEED=<n>` | pass (7–10 s each when the machine is quiet) | REAL run, SIMULATED behaviour |
| Sim suite against mutated sims | scratch probe patching the sim's prototype: grabs ignored on walls, throws counted as drops, resume undoing a lock latch, taps counted while held, the lost-drag release disabled | every mutation fails the suite | REAL run, SIMULATED behaviour |
| Press-path tests against the 1.2.0 code | the 41 new press-path tests run in a scratch copy of `src` with the five press-path files (`overlayManager.ts`, `gestures.ts`, `input.ts`, `win32Api.ts`, `activityMonitor.ts`) reverted | 36 of 41 fail: 30 on the old behaviour, 6 only for calling new API; 5 controls pass on both. All pass on 1.3.0 | REAL run, SIMULATED input |
| Soak smoke, 3 min, before the click-through hold (two runs, same build) | `DESKTOP_CAT_SOAK_MIN=3` | 33 of 34 gestures landed in each run. The one miss each time was a slow drag that the sim stopped holding about 0.8 s in, with no lost press counted in main. Otherwise: no stuck state; on-cat probes interactive 8/8; off-cat blocking 0; no lost presses; recreates 0; event-loop p99 about 20 ms; main heap 12 → 16 MB | app REAL, input SIMULATED |
| Slow-drag A/B, 2 min each, no perturbations | `DESKTOP_CAT_SOAK_ONLY=slowDrag DESKTOP_CAT_SOAK_PERTURB=0`, with and without `DESKTOP_CAT_SOAK_OS_MOUSE=1` | Held click-through: 20/20, ignore toggles 12. OS mouse allowed: 18/19 in each of two runs, same signature, ignore toggles 60. In the second OS-mouse run the page recorded exactly one buttonless, trusted `pointermove` while the button was down: at (1535, 504) DIP, far from the drag path, during the failing drag. A real OS mouse move ended the synthetic drag. Across all runs: 4/42 without the hold, 0/20 with it. A harness artifact, not a product defect: with real input the OS move carries the held button (that last point is UNVERIFIED, since it needs real input) | app REAL, input SIMULATED |
| Soak smoke, 3 min, with the hold | `DESKTOP_CAT_SOAK_MIN=3 DESKTOP_CAT_SOAK_PERTURB=freeze,cpuHog,nap,pauseResume` | Passed. 39/39 gestures landed (tap 4, double tap 11, stroke 6, drag 3, throw 4, slow drag 5, right-click 6). No stuck state; mouse.down → held p50 75 ms, max 83 ms; on-cat probes interactive 7/7; off-cat blocking 0; stray buttonless moves 0; lost presses 0; recreates 0; event-loop p99 18–20 ms; main heap 12.3 → 17.4 MB; renderer 2.5 → 3.7 MB. Perturbations drawn: pause/resume 1, nap 2. The freeze and CPU-hog paths were not drawn in this run. The `systemEvent` hook was wired in `app.ts` after this run (`abc7ace`) | app REAL, input SIMULATED |
| Lively throws through the real drag path, 1.3.0 | `DESKTOP_CAT_E2E_LIVELY=1 … lively.spec.ts -g "throws: several throws"` at `ca7f0a2` (app code of `0ec2dd2`) | Passed. 10 of 10 thrown, 0 dropped; flick 104–212 ms after a wind-up longer than 400 ms. The first attempt (at `0ec2dd2`) had 6 of 10: the harness's flick waited on test-hook round trips and was too slow to count as a throw; fixed in `2edf337` (test only) | app REAL, input SIMULATED |
| Soak, 120 min, first attempt | `DESKTOP_CAT_SOAK_MIN=120` at `0ec2dd2` | Lost at 52 min to the harness, not the app: the own-window helper process had ended (exit 0) and the maximize perturbation's report never came. The soak then reopened nothing, so the whole run's report was lost. Fixed in `8d2d0f3` (the soak reopens its own window and counts a harness incident) | — |
| Soak, 120 min, second attempt | `DESKTOP_CAT_SOAK_MIN=120` at `ca7f0a2` (app code of `0ec2dd2`), all gestures and perturbations | **Ran the full 120.1 min; failed its gesture check** (29 of 1,203 judged gestures did not land; details below). Everything else held | app REAL, input SIMULATED |
| Soak, 12 min, the delivered-input oracle and the new flick, the gesture kinds that missed | `DESKTOP_CAT_SOAK_MIN=12 DESKTOP_CAT_SOAK_ONLY=throw,slowThrow,tap,doubleTap,stroke` at `c8402a9` (app code of `0ec2dd2`) | Passed. Tap 34/34, double tap 25/25, stroke 19/19, throw 24/24, slow throw 28/28; **nothing set aside as harness input**. 143 presses, 0 lost; Win32 "up" while held 58 times, none ended a press; on-cat probes 28/28, off-cat blocking 0; 1 freeze, recovered in 262 ms; 0 recreates; event-loop p99 at most 23 ms (a quieter machine than the second attempt) | app REAL, input SIMULATED |
| Soak, 120 min, with the delivered-input oracle | `DESKTOP_CAT_SOAK_MIN=120` at `c8402a9` (app code of `0ec2dd2`), all gestures and perturbations | **Passed, 120.1 min** (2026-11-07 17:02–19:03). Every judged gesture landed: 1,251 of 1,251; 2 flicks set aside as harness input (they reached the page at 0 DIP/s). Numbers below | app REAL, input SIMULATED |

**The second 120-minute attempt in numbers** (`soak-report.json`, 2026-11-07 14:35–16:35; seed 1, time scale 3):

| Measure | Result |
|---|---|
| Gestures landed / judged | tap 163/164, double tap 136/138, stroke 139/140, drag 189/190, throw 127/143, slow drag 148/148, slow throw 148/156, right-click 124/124 (16 attempts set aside in designed guard states) |
| Stuck states | 0 |
| Click-through probes | on the cat: 269 of 269 interactive; off the cat: 0 blocking (T8) |
| Renderer freezes (4 s each) | 17; click-through while frozen in all 17; recovered after 277–348 ms; 0 recreates |
| Win32 "up" while the renderer held the button | 643 times; presses ended on Win32 "up": **0**. In 1.2.0 each of these ended the press after 400 ms (H1) |
| Lost presses (button-up / silent / moved) | 0 / 0 / 3 |
| mouse.down → held | p50 118 ms, p95 227 ms, max 1,416 ms (n = 637) |
| Perturbations | lock/unlock 20, hide/show 16, freeze 17, CPU hog 14, nap 14, pause/resume 11, maximize 11, suspend/resume 7 |
| Click guard | 3 band episodes (4.6 s in all, longest 2.7 s); no bail-out, no fail-closed poll |
| Main event loop | p99 per 10 s window: median 20.4 ms, worst 302.8 ms; one stall of 5.1 s |
| Heap, start → end | main 11.8 → 16.2 MB; renderer 2.5 → 3.8 MB |
| Host | 139,686 ticks, 0 tick errors, 0 dropped events |
| Harness incidents | 2: the own-window helper had exited (code 0); the soak reopened it and went on |

**The 29 misses, read from their details.**
- **Throws turned into drops.** The report keeps the details of 10 misses per kind, so 18 of the 24 throw and slow-throw misses have them: 16 are drops with no lost press, and 2 had a lost press (below). The other 6 have no details; the run's 3 lost presses are all among the 18, so none of the 6 had one. The harness took a test-hook round trip between the flick and the release, and stepped the flick through hook calls. On the loaded machine that is a pause of the hand before letting go, and the release speed comes from the last 100 ms (`gestures.ts`), so the throw arrives as a drop by design. The lively throw had the same artifact (6 of 10 thrown) and 10 of 10 after the flick stopped waiting on hooks (`2edf337`).
- **Double taps counted as two taps (2).** A double tap needs the second release within 350 ms of the first, by event time. CDP stamps events when they are dispatched, and each harness step is a CDP round trip, so on a loaded machine the gap stretches. Real input carries the OS's own event times.
- **A stroke on a hiding cat (1).** The strokes stay where the cat was when the gesture started.
- **Presses ended by the "cursor moved, no pointer event" rule (3).** This rule applies only when Win32 never saw the press down, which CDP input causes on every press. All three fell in very slow stretches (the cat was held only after 1,416 ms in one of them).
- **A tap right after hide/show (1).** Unexplained by the report's fields.

These readings are hypotheses until a run checks them. The third run adds what is needed to check them: the page records the input it actually received, and a gesture is judged against that (a flick that reached the page under 1,100 DIP/s is a drop by design). Each judged miss records whether main counted the press, and the longest gap in the delivered input. The flick no longer waits on hooks. Gestures set aside this way are counted apart, and at most a quarter of any kind may be set aside.

**The passing 120-minute soak in numbers** (`soak-report.json`, seed 1, time scale 3, the same app code as the installer):

| Measure | Result |
|---|---|
| Gestures landed / judged | tap 175/175, double tap 152/152, stroke 140/140, drag 175/175, throw 155/155, slow drag 164/164, slow throw 153/153, right-click 137/137 (16 attempts in designed guard states; 2 set aside as harness input) |
| Stuck states | 0 |
| Click-through probes | on the cat: 272 of 272 interactive; off the cat: 0 blocking (T8) |
| Renderer freezes (4 s each) | 18; click-through while frozen in all 18; recovered after 282–338 ms; 0 recreates |
| Win32 "up" while the renderer held the button | 660 times; presses ended on Win32 "up": **0** |
| Lost presses (button-up / silent / moved) | 0 / 0 / 0 |
| Right-clicks | 78 context menus ended a press or drag; all 137 right-click gestures passed, each including a tap afterwards that must count |
| mouse.down → held | p50 114 ms, p95 154 ms, max 254 ms (n = 649) |
| Perturbations | freeze 18, pause/resume 16, hide/show 16, lock/unlock 15, CPU hog 15, nap 14, suspend/resume 13, maximize 4 |
| Lock and resume bookkeeping | 15 locks; 8 lock recoveries and 1 resume recovery (the paths for a missed unlock or resume event) |
| Click guard | 3 band episodes (2.1 s in all, longest 0.8 s); no bail-out, no fail-closed poll |
| Main event loop | p99 per 10 s window: median 20.1 ms, worst 36.3 ms; longest stall 374 ms |
| Heap, start → end | main 11.4 → 20.3 MB; renderer 2.5 → 3.3 MB (the limit for 2 h is 112 MB) |
| Host | 141,412 ticks, 0 tick errors, 0 dropped events; no error lines in the main log |
| Harness incidents | 3: the own-window helper had exited after **its window was closed from outside the test**: its close button, Alt+F4 or another program, while the desk was in use. The soak reopened it each time. The same exit (code 0, window gone) ended the first 120-minute attempt and the lively edge and covered runs earlier that day; those runs had no marker yet |

**What became of the second attempt's misses.**
- **Throws.** With the flick no longer waiting on hooks, 308 throws and slow throws were judged and all 308 landed as throws. Only 2 were set aside, both delivered at 0 DIP/s. The second attempt's throw misses were the harness.
- **Double taps.** 152 of 152 landed. None reached the page too far apart to count, so the earlier two were not seen again.
- **Strokes.** 140 of 140.
- **"Cursor moved, no pointer event" lost presses.** 0 in this run, against 3 in the second attempt, which had a much slower machine (mouse.down → held up to 1,416 ms; event-loop stall 5.1 s). The rule ends a press only when Win32 never saw it down: always under CDP; with real input only in diagnosis case H1a. It then also needs the cursor to have moved 12 DIP while the renderer sent nothing for 400 ms. A real hand that keeps holding still through such a stall stays held, because an unmoved cursor does not trigger the rule. **Known limit:** with H1a, moving the mouse during a renderer stall of 400 ms or more ends the press (the cat is dropped, and the next press works). This is UNVERIFIED with real input.
- **The tap right after hide/show.** It did not recur: 175 taps and 16 hide/shows in this run. Its cause is unexplained (UNVERIFIED). Each miss now records whether main counted the press, so a recurrence would say whether the press reached main.

**What the soaks do not show.**
- They drive the real app for two hours at a time (two full 120-minute runs on the same app code, the second passing), not for the many hours of the owner's session. Uptime-related build-up is bounded by the heap check and by the 24 h simulated day, and nothing in the diagnosis builds up with uptime. Even so, reliability over more than two hours on a real desk is **UNVERIFIED**.
- The input is SIMULATED: CDP mouse events and an injected cursor. A real hand, real `GetAsyncKeyState` readings (trigger (a) under real input), and an elevated window in front were not exercised.
- Only one display, at 125 %.

## Field observability (for the owner)

The 1.2.0 build logged lost presses and guard transitions only at debug level. The fixed build adds the following, without needing a debug build:
- info-level, rate-limited lines for lost presses (with the reason), Win32/renderer disagreements, guard episodes, and the overlay input reset after resume or unlock;
- the press-path counters in the diagnostics export.

If the cat stops responding again, use **Export diagnostics** while it is unresponsive.
