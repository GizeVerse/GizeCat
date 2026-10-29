# v1.2 diagnosis: why the cat is passive, and why its tab-strip stays are short

Date: 2026-10-29. Code: `feat/v1.2-lively` at `e9133bd` (= shipped v1.1.1). Phase: diagnosis only; no product source or existing test changed. Machine: Windows 11 Home 10.0.26200, one 1920×1200 display at 125 % (body width bw = 84 DIP = 105 px, body height bh = 64 DIP = 80 px), auto-hide bottom taskbar (work area = full screen).

**Labels.** REAL = executed or observed on this machine (own windows and builds only), or read from the user's 1.1.1 install as counts. REAL(code) = read in the code at the cited line. SIMULATED = the real `src/core` (and, where stated, the real provider/helper pipeline) run headless on synthetic input. MOCKED = OS side stubbed. UNVERIFIED = not executed (inference, desk research, design proposal).

**Sources.** Six investigations; raw output under `C:\Users\enes1\.claude\jobs\4f08f8fb\tmp\v12\<key>\`.

| Key | Method | Labels |
|---|---|---|
| baseline | New harness `tests/profile/behaviorProfile.ts` (opt-in, `DESKTOP_CAT_PROFILE=1`, not in the default vitest include) + `scripts/behavior-profile.mjs`: real Sim, Mover, `createCatHost` loop and activity monitor, synthetic user, provider-shaped surfaces. 2 profiles × 3 layouts × 8 seeds × 3 sim-h = 144 sim-h, 0 tick/event errors. | SIMULATED, OS MOCKED; `verify fast` PASS (REAL) |
| tabstrip | Copy of the real surfaces pipeline (provider, window surfaces, UIA service, helper stand-in), user profile, 20 seeds × 60 sim-min per scenario, runtime ablations; plus the dev build on an own Edge 156 (temp profile, time ×8). | SIMULATED + REAL |
| behaviour | Real `decide.ts` scorer (static decision tables) and `CatSimImpl`+Mover through the unit-test Harness, 189 sim-min × 3 seeds; throw Monte-Carlo (40 seeds per cell). | SIMULATED |
| physics | Real Mover/world/graph and renderer rig headless on the user's screen geometry. | SIMULATED, REAL(code) |
| tab-discovery | C# UIA probe against own Explorer, Terminal, System Properties, WinForms and WPF windows; desk research for Firefox/Electron. Detail: [tab-discovery.md](tab-discovery.md). | REAL + UNVERIFIED |
| settings-audit | Shipped settings/decide code bundled into probes; throwaway Electron 44.9.3 WebAudio probe. | REAL + SIMULATED + UNVERIFIED design |

New untracked files in the worktree from this phase: `tests/profile/`, `scripts/behavior-profile.mjs`, `docs/research/v1.2/` (git status, REAL). `out/profile/baseline.json` is wiped by `npm run build`; a copy is in `tmp/v12/baseline/`.

**User evidence (REAL, as handed to this phase; counts only, not re-read here).** Installed 1.1.1, 189 awake min: pets 145, drags 61, throws 26, chasesStarted 1, chasesEngaged 0, windowsInspected 2, naps 12. Memory: every `throw:hard` is followed by `startle` and `hide`. Favourite spots: all floor. Settings: autonomy 0.8, cursorPlay 0.7, attentionSeeking 0.5, activitySensitivity 0.95, sleepAfterIdle 30 min, chase 5 s, speed 1, perception local-stats. Traits curiosity .65 playfulness .38 affection .44 confidence .51 energyLevel .54 laziness .33; stats energy .95 boredom .013 bond .60. `main.log`: `frontMaximized`, nothing listed, while a maximized window was in front; with a floating browser in front 15:42–15:51, 3 excursions in about 9 min, support `tabStrip` at 15:49:11 and `floor` at the next line, 15:50:11.

## 1. Baseline behaviour profile (SIMULATED)

Profiles: **P1** = the user's settings, traits and stats; **P2** = a fresh cat with default settings. Layouts: **L1** = floating browser with a tab strip; **L2** = floating editor window (window top only); **L3** = L1 alternating every 10 min with a maximized window in front. Start 18:30 local. Full tables: `tmp/v12/baseline/tables.txt`.

### 1.1 Time budget (% of sim time)

| | P1/L1 | P1/L2 | P1/L3 | P2/L1 | P2/L2 | P2/L3 |
|---|---|---|---|---|---|---|
| calm + asleep | 87.7 | 87.8 | 87.2 | 91.3 | 91.3 | 91.3 |
| of which asleep | 9.7 | 10.4 | 9.0 | 8.8 | 10.4 | 9.2 |
| active states | 9.4 | 9.1 | 9.8 | 5.4 | 5.6 | 5.4 |
| moving (position changes) | 12.0 | 11.7 | 11.0 | 8.1 | 7.6 | 6.7 |
| up on a window (any) | 31.3 | 29.2 | 14.7 | 32.0 | 31.1 | 13.3 |
| up while the maximized window is in front | – | – | 0.0 | – | – | 0.0 |

Top states P1/L1: resting 31.2 (loaf clip 25.8), watchingUser 21.9, idle 9.8, sleeping 9.5, walking 8.0, grooming 7.3, inspectingWindow 4.3, watchingCursor 3.3.

### 1.2 Decisions

| | P1/L1 | P1/L2 | P1/L3 | P2/L1 | P2/L2 | P2/L3 |
|---|---|---|---|---|---|---|
| decisions per awake min | 4.28 | 4.13 | 4.28 | 3.28 | 3.25 | 3.24 |
| floor: expected pick calm % | 66.0 | 65.9 | 66.4 | 73.1 | 73.4 | 75.0 |
| floor: wander % | 19.4 | 18.9 | 21.4 | 13.7 | 13.1 | 14.3 |
| floor: trip up % (% of decisions where possible) | 6.2 (100) | 6.5 (99.5) | 2.6 (40.5) | 6.0 (100) | 6.2 (99.7) | 3.0 (42.3) |
| floor: chase % (possible) | 0.3 (1.4) | 0.4 (2.3) | 0.5 (2.7) | 0.1 (1.5) | 0.2 (2.4) | 0.3 (3.6) |
| floor: play % | 3.7 | 3.7 | 4.8 | 1.9 | 1.8 | 2.2 |
| autonomous locomotion picks /h | 61.1 | 57.6 | 58.5 | 36.7 | 33.2 | 32.2 |

Up on a top or strip: expected calm 61–73 %, come down 12.5–15.8 %, wander 5.6–13.2 %, edge look (tops only) 5.9–6.1 %, the dedicated walk-along-strip option 0 % (0 of 3,409 decisions). Cooldown blocks: grooming 23–29 % of decisions, watchingUser 9–13 %, playing 2–10 %, climb 4–12 %.

### 1.3 Getting up and staying up

| | own arrivals /h | dwell min / median / p90 / max (s) | how stays ended |
|---|---|---|---|
| P1/L1 strip | 10.5 | 0.5 / 80.5 / 177 / 501 | stepOff 166, jumpDown 66, user drag 32, climbDown 1 |
| P1/L2 top | 9.92 | 3.9 / 76.6 / 159 / 534 | jumpDown 154, stepOff 51, drag 45, climbDown 3 |
| P1/L3 strip | 5.21 | 0.9 / 71.3 / 154 / 547 | stepOff 78, jumpDown 24, drag 18, covered 15 |
| P2/L1 strip | 8.54 | 3.4 / 91 / 234 / 690 | stepOff 114, drag 49, jumpDown 48 |
| P2/L2 top | 7.54 | 3.3 / 115 / 251 / 721 | jumpDown 106, drag 47, stepOff 39 |
| P2/L3 strip | 3.96 | 0.5 / 88.5 / 202 / 401 | stepOff 53, jumpDown 20, covered 16, drag 10 |

- Own stays ≥ 60 s / ≥ 120 s / ≥ 300 s: P1 61–66 / 20–25 / 1–2 %; P2 73–84 / 33–46 / 3–6 %. 74–86 % of stays end by the cat's own decision.
- Every own arrival is floor → leap → climb → pull-up (858 leaps, 842 pull-ups, 0 reversals); 0 arrivals by jumping between surfaces. Approach median ~20 s (p90 ~25 s); trips succeed 95–100 %.
- Strip arrivals come through the perch ("explore") option; the separate tab-strip visit option fires only 0.2–0.5 /h.
- Independent cross-checks of the strip dwell: tabstrip pipeline (user profile, no user input) median 69.8 s (p25 48.1, p75 92.7, n = 261); behaviour harness 68–73 s; REAL dev build, own Edge, 8 stays of 56–137 sim-s.

### 1.4 Cursor, falls, reactions, stats

| per hour | P1/L1 | P1/L2 | P1/L3 | P2/L1 | P2/L2 | P2/L3 |
|---|---|---|---|---|---|---|
| chase starts | 0.83 | 1.29 | 1.13 | 0.29 | 0.33 | 0.83 |
| pounces | 0.08 | 0.13 | 0.08 | 0 | 0.08 | 0.21 |
| watchingCursor starts | 24.6 | 21.3 | 21.0 | 23.1 | 20.3 | 19.5 |
| cursor within reach, % of awake time (and moving > 150 DIP/s) | 12.8 (2.2) | 14.7 (2.8) | 17.8 (3.4) | 12.9 (2.7) | 17.5 (3.2) | 21.0 (3.9) |
| falls | 13.0 | 9.0 | 10.1 | 11.5 | 8.5 | 9.7 |
| voluntary jumps down | 2.75 | 6.42 | 1.0 | 2.0 | 4.42 | 0.83 |

- Hard throws: P1 startled 89–95 % (else annoyed), **hid 92–97 %**, recovery median 13.4 s; P2 hid 57–65 %. Gentle drags and sub-threshold throws: idle or grooming, hid 0 %.
- Stats (min / mean / max): energy 0.59–0.69 / 0.84–0.90 / 1; boredom 0 / 0.06–0.12 / 0.30–0.57; fear mean 0.00, max 0.57–0.59 (only after hard throws).
- Floor time within 2 bw of a screen edge: 12.6–18.8 % (those strips are 21.9 % of the floor width).

### 1.5 Simulation against the user's counters (per awake hour)

| | SIMULATED P1/P2 | REAL user |
|---|---|---|
| pets | 47–62 | 46.0 |
| drags | 6.6–7.7 | 19.4 |
| throws | 1.7–2.6 | 8.25 |
| chasesStarted | 0.32–1.44 | 0.32 |
| chasesEngaged | 0–0.18 | 0 |
| windowsInspected | 2.6–12.8 | 0.63 (mostly a maximized window in front) |
| naps | 1.15–1.26 | 3.81 (gap UNVERIFIED; possibly idle-sleep while away, decide.ts:202–204) |

The synthetic user handles the cat 2.5–4× less than the real one; throw-reaction conclusions hold anyway (the chain is deterministic, §2 P4).

## 2. Root causes of passive behaviour (ranked)

| # | Cause | Mechanism (REAL(code)) | Evidence | Label |
|---|---|---|---|---|
| P1 | **The picker discards lively options.** Top-4 softmax at T = 0.12; calm scores carry no boredom term, almost every active score is multiplied by boredom. | `decide.ts:197–199` (idle .229, grooming .213, resting ~.17 for the user); wander `:213`, corner `:216`, chase `:230`, play `:233–236`, trips `:257, :269, :274`, curious `:284` all scale with `s.boredom`; `DECISION_TEMPERATURE 0.12`, `DECISION_TOP_K 4` `:299–300`; `random.ts:61–70` drops everything outside the top 4. | Floor, user profile: top 4 = wander .312 (44 %), idle .229 (22 %), grooming .213 (20 %), resting .174 (14 %); pawAt .085, curious .072, zoomies .032, chase .151 get **0 %**. pawAt still out of the top 4 at boredom 0.5. Baseline: calm 87–91 % of time, expected calm pick 66–75 %. | SIMULATED; REAL counters consistent |
| P2 | **Boredom never builds.** Interaction drains it 10–40× faster than calm states raise it. | `stats.ts:35–52, 75, 91–97`: idle +0.00067/s; one stroke −0.02·strength (up to 4/s), beingPetted −0.006/s, chase/play −0.012/s. | One 5 s petting ≈ −0.23. Boredom p50: untouched 0.20–0.26, with the user's handling 0.07–0.09, with a browser to explore 0.04–0.06. User's REAL value 0.013. Through P1 this zeroes the active side. | SIMULATED + REAL stat |
| P3 | **Cursor hunting is starved.** Chase only at a decision instant, only within 3.5 bh above the feet, never while typing, and below the top-4 cut; flicks need ≥ 2500 px/s; acceptance decays on every ignored chase; playful retreat is closed for playfulness < 0.5. | Gate `decide.ts:228` (reachable, !typing, > 150 DIP/s, < 12 bw); reach `sim.ts:2773` (bottom 280 px of the user's screen, 23 %); pounce `sim.ts:1688` (within 1.6 bh, gap 0.7–2.6 bw; bottom 128 px); flick event `activityMonitor.ts:41–42, 125–134`, relevance `stimuli.ts:175–187`, chase at r ≥ 0.4 and reachable `sim.ts:2571`; acceptance EMA `sim.ts:1426`; retreat `sim.ts:1302`. | Chase score .151 (cursor 3 bw, 400 DIP/s) vs .174 cut, and watchingCursor .329 enters the top 4 first. Chase possible at 1.4–3.6 % of floor decisions; 0.3–1.3 starts/h, 0–0.21 pounces/h. 0 chases in 189 min with the cursor high on screen; ~125 with it always low and near. | SIMULATED; REAL 1 chase / 0 engaged |
| P4 | **One fixed fear response to throws.** Speed only decides "thrown or not"; the landing → startle → hide chain is deterministic for confidence < 0.6. | `mover.ts:851` (thrown above 1100 DIP/s, `constants.ts:27`); landing fear +0.25, startled unless annoyance > 0.35 or confidence > 0.65 `sim.ts:2019–2025`; startle +0.35 fear; hide if fear > 0.45 and confidence < 0.6 `sim.ts:1922`; fear half-life 4.03 s (`stats.ts:81`); memory always `'hard'` `sim.ts:2347`; `LandingInfo.impactDip/fallHeightDip` unused. | Fear at the end of the startle 0.469–0.511. 160/160 throws → hide at confidence .51 and prior annoyance ≤ .15; 1500 vs 3000 px/s identical; confidence .62 → startled > idle; .70 → annoyed. | SIMULATED; REAL memory log |
| P5 | **Typing is a total gate, and "typing" includes scroll and clicks.** | Detector `activityMonitor.ts:5–7` (any input without cursor motion or button hold); while typing: activeMul ×0.3 `decide.ts:187`, watchingUser +0.4 `:220`, chase and play removed `:228, :232`, attention ×0.15 `:242`, excursions ×0.3·(1−0.85·intensity) `:250`; flick off `sim.ts:2556`, pounce off `:1686`, `onTypingStart` `:2532`. | Floor P(active) 44 % → 0 %; P(trip up) at urge 1: 99.4 % → 36.7 %; watchingUser wins 74 % of decisions. | SIMULATED; user's real typing share UNVERIFIED (not logged) |
| P6 | **Only one way up, and nothing to climb when a maximized window is in front.** | Wall nodes have only pullUp/dismount (`surfaceGraph.ts:376, 544`); `legFrom` needs a pull-up after a leap (`mover.ts:2071–2110`); no surface-to-surface hops in practice (tops ~1055 px up vs 420 DIP jump, `constants.ts:15`); maximized windows offer no surfaces (ADR 0002 §4); no screen-edge kind (§4). | 100 % of own arrivals floor → leap → climb → pull-up; L3: 0 % up while the maximized window is in front, own arrivals halve. | SIMULATED; REAL log `frontMaximized`, 0 listed |
| P7 | **Repetition penalty keyed on state, not variant.** All `walking` variants (wander, climb, tab strip, down, climb-down) share one counter. | `decide.ts:289–297`: ×0.65 per recent same state, ×0.35 if equal to the current state. | Right after a wander, climb .812 → .120 and tabStrip .743 → .110 (×0.148); at urge 0.5 no trip stays in the top 4 except explore. | SIMULATED |
| P8 | **Autonomy shortens calm dwells instead of adding activity.** | `decide.ts:187–188` (activeMul 1.17, calmMul 0.82 at 0.8); calm dwell ×(1.4 − 0.8·autonomy) = 0.76 `sim.ts:703`; spot learning needs ≥ 60 s contiguous rest `sim.ts:97`, max resting dwell 53 s at 0.8. | More decisions per minute, rests of 15–53 s; favourite spots only from naps: autonomy 0.8 → 2–3 floor spots; 0.5 → 8 spots, 3–4 on windows. | SIMULATED; REAL "all floor" consistent |
| P9 | **Screen-edge visits depend on boredom.** | Corner walk `(0.03 + 0.16·b)` `decide.ts:216`. | walking/corner < 0.5 % of picks; edges under-visited (§1.4). | SIMULATED |
| P10 | **Social drive is a 16-min quiet timer.** | seekingAttention needs `quietMs ≥ 20 min·(1.3 − attentionSeeking)` `decide.ts:239–240`. | 0 attention bouts in the user-handling scenario; in headless runs without input it is 10 % of strip departures (artefact). | SIMULATED |

## 3. Root causes of short tab-strip stays (ranked)

**T1 (blocking) — designed descent with three interchangeable paths.** Once the top is "explored" (`topExplored`, `sim.ts:3066–3076`: ≥ 20 s and ≥ 2 bw walked, or ≥ 60 s; constants `sim.ts:134, 136, 138`) three floor options switch on:
1. `wanderTarget` returns the nearest floor point 50 % of the time (`sim.ts:2829`). Wander is the strongest option up there (raw .312, §8.1).
2. `downTarget` (`sim.ts:3078`) with the down pull ramping 20 s → 140 s (`decide.ts:138–139, 279–283`).
3. Climb down (scored at `decide.ts:265–270`).

| time up (s) | 0–20 | 20–40 | 40–60 | 60–80 | 80–100 | 100–120 | 120–140 |
|---|---|---|---|---|---|---|---|
| mean P(descend) per decision (1,276 decisions, one per ~16 s) | 0 | 0.12 | 0.19 | 0.27 | 0.36 | 0.43 | 0.53 |

| ablation (20 seeds × 60 sim-min) | median stay |
|---|---|
| none (user profile) | 69.8 s (min 20.2 = `TOP_MIN_STAY_MS`) |
| no wander-to-floor | 102.9 s |
| no down pull | 74.5 s |
| neither | 190.8 s (climb-down takes over) |
| all three off | 515.5 s (ended only by seekingAttention, a no-input artefact) |

90 % of departures are autonomous floor decisions (SIMULATED); 8/8 REAL dev-build departures were `<calm state> → walking (autonomous) → falling/jumping` within 3.2 sim-s of the decision. Removing one path is compensated by the others, so the fix must replace the model (one per-visit stay intent and one "leave" intent), not tune a constant.

**T2 (major) — a window coming to the front drops the cat within 0.4–0.8 s.** A covered attached strip is served as the bare edge with confidence ≤ 0.3, unlisted (`provider.ts:1018–1032`); the Mover waits `perchGraceMs` 450 ms (`constants.ts:40`) and loses support `'occluded'` (`mover.ts:1366–1378`), which is a free fall (only `retracted`/`disabled` settle, `mover.ts:1408`); the sim treats it as calm (no reaction, §8.4). SIMULATED: with a maximized window brought forward every 60–150 s, 147/217 departures were occlusion drops, stay median 35 s, 82 % under 60 s; baseline L3 (10-min alternation) 11–16 % of stays. REAL occlusion drop: UNVERIFIED (no own window was put over a strip while the user was at the desk).

**T3 (major) — autonomy 0.8 shortens stays.** activeMul scales wander and the down pull (`decide.ts:187`); calm dwell ×0.76 (`sim.ts:703`). Median 69.8 s at 0.8 vs 85.8 s at 0.6 (< 60 s: 39 % vs 26 %); ~100 s at 0.5. SIMULATED.

**T4 (major) — nothing strip-specific to do up there.** Resting after arrival lasts 15–53 s (`decide.ts:275` then 'resting', dwell `sim.ts:694–705`). The dedicated walk-along option needs the selected-tab span (`rest`) ≥ 1.5 bw = 157.5 px (`sim.ts:2956, 2987`): SIMULATED Edge 156 geometry on a 1000 px window gives 110 px; REAL `rest` shrank 189 → 33 px as tabs were added. Edge look requires `windowTop` (`sim.ts:1766`). Naps up there are rare (nap ×0.3 while energy > 0.9, `decide.ts:202`). The cat still strolls along the strip through ordinary wander (§8.3).

**T5 (minor) — stimuli pull it off.** seekingAttention, closed/appeared/moved-window stimuli (`sim.ts:2458–2530`, `decide.ts:238–244`): 5–10 % of departures. SIMULATED.

**T6 (minor, real bug) — read-failure alias target.** During a strip read failure the strip falls back to the whole window-top edge (`windowSurfaces.ts:384–392`, `service.ts:741–756`); a wander target picked there lies outside the restored strip span; the cat stalls at the strip end and a re-plan maps the point to the floor (`mover.ts:722–725, 2031–2066`). ~1 % of injected read failures; 0 read errors in 252 REAL reads. SIMULATED.

**Refuted (SIMULATED over ~2,800 stays; REAL 14 updates, 252 reads, 0 errors):** surface-id flips, geometry churn from tab add/select/remove, 3 px moves, 4 px resizes and drags, confidence decay (floor 0.25 for the attached surface), helper idle/shutdown while asleep, paused or hidden, any stay timeout (stays up to 54 min with descent off).

**Measurement gap (REAL(code)).** `surfaces summary` is checked every 10 s and written at most every 60 s, on change only (`app.ts:73–74`, `surfaceDiagnostics.ts:33, 285–298`). "tabStrip at 15:49:11, floor at 15:50:11" bounds the stay only to 0–120 s, which fits a 70–90 s median. The REAL dev run logged `floor` on all 5 minute lines although 7 trips happened. Whether the user's 15:50 departure was T1 or T2: UNVERIFIED (the `frontMaximized`/listed fields of that line were not read; the browser was in front at the sampled instants, which favours T1).

## 4. Physics, animation and screen-edge gaps

| Gap | Evidence | Label |
|---|---|---|
| **No screen-edge surfaces.** Display boundaries only bounce falling cats. | No screen kind in `shared/surfaces.ts:7`; `wallTrackOrReason` accepts only windowSide (`world.ts:404`); flight bounce `mover.ts:1219–1230`. A prototype left-edge wall is accepted (yTop 105 px, standX 57.75) and mountable, but has 0 outgoing edges and 0 climb options. These walls would be the only climbable feature in the user's commonest state (`frontMaximized`). | REAL(code) + SIMULATED |
| **Wall nodes are dead ends.** No wall jump, no reversal, no hold mid-wall; a climb with no top ledge waits 450 ms and turns back. | `surfaceGraph.ts:376, 544`; `mover.ts:2071–2110` (legFrom), `:1771–1783`; goals are floors or ledges only (`mover.ts:722`). | REAL(code) |
| **Jump-down and drop have no height limit; climb-down never wins.** | Jumps capped only upward (`surfaceGraph.ts:452`); drop edges reach the first surface below (`:509–523`). From a 1055 px top: one 921 DIP jump, landing at 2189 DIP/s, the same 0.25 s `land` clip as a 46 DIP hop. Climb-down 0–1.5 % of descents. | SIMULATED |
| **Landing ignores impact.** | `enterLanding` uses only reason/thrown/forced (`sim.ts:2009–2036`); planned jumps and steps skip any reaction (`:2016`); a soft drop from 778 DIP lands at 2011 DIP/s, like a throw. | REAL(code) + SIMULATED |
| **Pounce is a fixed on-surface hop.** | Crouch fixed 280 ms (`constants.ts:23`), apex 46 DIP (`:44`), clamp 2.2 bw, current surface only (`mover.ts:767–788`); the crouch-clip wiggle starts at 0.35 s so it never shows. 1, 2.2 and 4 bw all take 726 ms. | SIMULATED |
| **Throws: no wall catch, no tumble.** | Flight collides only with work-area edges, lands only on floors/ledges (`mover.ts:1210–1270`). | REAL(code) |
| **Paces and gaits.** slow 42, walk 70, chase 210, run 260 DIP/s; no stalk or sprint. Clean gait limits: walk 106, run 394, climb grip 63 DIP/s; `movementSpeed` 2 (`settings.ts:141`) makes walk (140) and run (520) slide. | `constants.ts:6–7`; renderer `clips.ts:53–66`. | SIMULATED arithmetic |
| **No narrow ledges or balance.** Ledges < 0.9 bw rejected (strips need 0.25 bw). | `world.ts:342`. | REAL(code) |
| **Animation repertoire.** 22 clips; one `jump` for every jump kind (the renderer cannot tell up/across/down/pounce apart). Missing: stalk, sprint, swat, hiss, slip, impact/recover, balance, stretch (only inside wake), edge sit, tail chase, grumpy stare. | `shared/cat.ts:39–63`; `sim.ts:3297`; `behavior/clips.ts:64–76`. | REAL(code) |
| **Render headroom.** Climb pose reaches 99.6 DIP above the anchor against a 100 DIP presence margin (0.4 DIP headroom, ~5.6 DIP at the sides); emote 122.5 DIP. A wall top at `wa.y + 1 bw` (`world.ts:421`) would clip ears and emote at the screen top. | anim-measure.json; `renderMapping.ts:20–24`; `scene.ts:394`. | SIMULATED; visual UNVERIFIED |
| **T8 exposure at screen edges.** A clinging cat's hit area (48.8 DIP inward, ~105 DIP tall) would cover maximized windows' scrollbars, caption buttons, top-corner tabs and the VS Code activity bar; `excludeRects` today holds only taskbar bands. | `clickThrough.ts:89–102`; `overlayManager.ts:597–615`. | SIMULATED; real apps UNVERIFIED |
| **Topology change mid-climb snaps 475 px** to the floor. | `mover.ts:2230–2273`. | SIMULATED |
| Multi-monitor floors join correctly (negative coordinates, mixed DPI, ≤ 1 px vertical step per tick); a stacked-above display is reachable only by throw. Edge walls must be the exact complement of the floor join (`world.ts:456`). | multiMonitor runs. | SIMULATED; hardware UNVERIFIED |

Working and measured (SIMULATED): run speed reached in 231 ms; jumps up to 420 DIP (787 ms) and across 600 DIP (571 ms); leap + climb + pull-up of a typical window in 11.15 s; riding a window dragged 400 px in one tick keeps the offset; closed window → fall on the next tick.

## 5. Generic tab discovery: feasibility per application

| App (installed version) | Tab control | On the window's top edge | Measured cost | Verdict | Label |
|---|---|---|---|---|---|
| Edge 156 / Chrome 155 | Chromium tab strip | yes | 0.8–1.7 ms per read (v1.1) | shipped adapter | REAL |
| File Explorer (Win11 tabs) | WinUI `TabView` in a XAML island (`CabinetWClass` > `DesktopChildSiteBridge` > InputSite > TabView > ListView) | yes, tabs 11 px below the frame top, ~310×40 px | refresh 0.31 ms median (max 2.2), re-find 5.7 ms, first lookup 49 ms, app memory +0.0 MB | **feasible** (`tabview` adapter) | REAL |
| Windows Terminal 1.24 | same `TabView` (`CASCADIA_HOSTING_WINDOW_CLASS` > `DesktopWindowContentBridge` > …) | yes | 0.41 ms (max 2.6), re-find 4.7 ms, first 43 ms, +0.7 MB | **feasible**; "tabs not in title bar" setting UNVERIFIED | REAL |
| Notepad 11.2607 | very likely WinUI 3 `TabView` (depends on WindowsAppRuntime 2.5) | probably | not probed: the user's saved session (23 tab-state files) would be restored and rewritten | enable only after a REAL probe on a clean profile | UNVERIFIED |
| VS Code 1.134 (Electron) | web content | – | querying would switch on Chromium web accessibility and may flip VS Code into Screen Reader Optimized mode | **reject before any UIA call**; keep its window top | UNVERIFIED (desk) |
| Firefox (not installed) | Gecko | – | first UIA contact starts Gecko accessibility in every content process | reject before any UIA call | UNVERIFIED (desk, Gecko source) |
| Win32 `SysTabControl32`, WinForms, WPF | native/managed tab controls | no: 38–48 px down, inside the client area | 1.4–7.7 ms | not a surface | REAL |

Constraints for the design (REAL(code) unless noted):
- The gate must use Win32 data only (top-level class + exe + required child window class via `FindWindowEx`) before `FromHandle`; never Name or AutomationId-based matching (`native/uia-helper/Native.cs:163–177`).
- Protocol v2, additive `kind: 'chromium' | 'tabview'` (`Program.cs:21`, `src/main/uia/protocol.ts:7, 22–37`).
- `provider.ts:942–943` `usable()` requires `category === 'browser'` and `TAB_STRIP_BROWSERS`; explorer.exe is `system` and windowsterminal.exe is `terminal` (`processNames.ts:30, 108`), so the allow-list must replace the category test (checked by the synthesizer).
- `segment.ts` `computeTabStripSegment` accepts the measured rects unchanged: walkable span 189 px (Explorer, 1 tab), 483 px (Terminal, 2 tabs) (SIMULATED on REAL rects).
- TabView raises ElementSelected/StructureChanged (duplicated, Explorer up to 1.7 s late) but no rect-change events: keep polling.
- Privacy scope changes: `PRIVACY.md:16` says "Edge and Chrome only"; the toggle text names them. Tab names (folder paths, shell titles) must never be read. The settings-audit statement that VS Code tab items carry file names in `Name` is UNVERIFIED (VS Code was deliberately not queried).
- REAL test harness pitfalls: `explorer.exe <dir>` opens a tab in the user's existing Explorer window (use the `opennewprocess` verb); posted `WM_CLOSE` is ignored by a 2-tab Explorer (use `SC_CLOSE`); never launch Notepad while a saved session exists.

## 6. Settings, presets and migration constraints

| Constraint | Evidence | Label |
|---|---|---|
| Settings v2 writes every value including defaults, so only values that differ from a v2 default prove intent. The user's deliberate fields: autonomy, cursorPlay, attentionSeeking, activitySensitivity, sleepAfterIdleMinutes, chaseDurationSec. | `settingsStore.ts:89, 106`; probe: a file with only `behavior.autonomy` parses to all 12 behaviour keys. | REAL |
| One unknown ID empties `disabledBehaviors`. Adding v1.2 IDs to that list makes a downgrade to 1.1.1 re-enable everything the user turned off. | `settings.ts:76–79, 156` (`.catch([])`); probe `[zoomies, taskbarPlay, stalkCursor]` → `[]`; a separate list keeps `[zoomies, taskbarPlay]`. | REAL |
| Migrated settings are not saved until the first change, so the migration runs on every launch: it must be pure and idempotent. | `settingsStore.ts:139–146`. | REAL(code) |
| Bumping `CAT_STATE_SCHEMA_VERSION` without an up-migration replaces every cat (new traits, bond 0.15, counters lost). New stats/preferences/counters fields with defaults need no bump; new memory kinds/details must be registered or are dropped on load. | `catState.ts:8, 103`; `migrate.ts:20–31` (checked); `memory.ts:7, 24`; `migrate.ts:42`. | REAL(code) |
| `cursorPlay` barely changes autonomous chasing (chase ranks 7th of 12 for the user, 5th at playfulness .55); `autonomy` shortens perches (§3 T3). Keep the keys and defaults; rewire their meaning. | settings-audit and behaviour probes. | SIMULATED |
| Presets: main already applies a multi-section patch atomically and rejects it whole on one bad value; the renderer store sends one value at a time and must stay zod-free. | `ipc.ts:120`, `handlers.ts:163–181`; `renderer/settings/store.ts:102–121`, `patch.ts:11–17`, `catalog.ts:67–70`. | REAL probe + REAL(code) |
| Presets must never touch consent or privacy (`perception`, `ai`, `loginItem`), opt-out lists, sound, appearance, movementSpeed or sleepAfterIdleMinutes. The pinned literals (`visualMode … 'off'`, `allowCloud … false`, `settings.ts:173, 190`) stay byte-identical. | `.claude/standard.json`; CLAUDE.md invariants. | REAL(code) |
| A schema bump breaks `schemaVersion` 2 assertions (`tests/e2e/lifecycle.spec.ts:204`, `persistence.spec.ts:42, 54, 120`) and `settingsExample.test.ts:7–11` (regenerate `docs/settings.example.json`). | grep. | REAL(code) |
| Synthesized WebAudio works in a renderer configured like the overlay (sandbox, context isolation, same CSP, deny-all permissions): context `running` without a gesture, 0 permission requests, 0.046 % CPU running / 0.013 % suspended. Risks: double playback when the cat straddles two overlays (`overlayManager.ts:488–516`), re-trigger on `snap:true` snapshots (`:689`). Default must be off. | audio-probe outputs. | REAL; sound quality UNVERIFIED |

The settings-audit's v3 proposal (keep all v2 keys/defaults; new fields exploration, heights, agility, mischief, tabStripStaySec, edgeExploration, workDisruption, `interaction.reactionIntensity`, a `sound` section off by default, a main-owned migration record, a separate tolerant opt-out list; presets Calm / Playful (= v2 defaults) / Mischievous; migration seeded from explicit autonomy/cursorPlay, never raising mischief or work disruption by inference) is **UNVERIFIED design input for ADR 0003**, not a finding.

## 7. Extension points and risks the design must respect

### Extension points (REAL(code))

| Area | Where |
|---|---|
| Decision scheduler | `scoreCandidates` / `applyRepetitionPenalty` / `chooseActivity` `decide.ts:172–305`; context seam `DecisionView` `decide.ts:58–116`, built in `decisionView()` `sim.ts:2777`; triggers `reconsider()` `sim.ts:991` and the 1 Hz `drives()` `sim.ts:1262` (place for a salience pass) |
| Dwell and stays | `dwellFor` `sim.ts:694–705`; `trackElevation` / `topVisit` `sim.ts:3035, 3052`; `topExplored` `:3066`; `wanderTarget` `:2822`; `downTarget` `:3078`; down pull `decide.ts:138–139, 279–283` |
| Drives and persistence | `StatsSchema` `catState.ts:23–34`, `PreferencesSchema` `:65`, counters `:48–62`; `stepStats` `stats.ts:66–83`; memory kinds `memory.ts:7, 24` |
| Hunt | chase stalk phase `sim.ts:1345–1349`; `tryPounce` `:1685`; `cursorInfo` `:2764–2774`; `onFlick` `:2555`; `Mover.pounce` `mover.ts:767–788`; paces `constants.ts:6–7` |
| Throw reaction | `onDragEnd` `sim.ts:2340`; `enterLanding` `:2009`; `afterStartle` `:1920`, `afterAnnoyed` `:1928`; `LandingInfo` `mover.ts:74–84` |
| Movement graph | `GraphEdgeKind` `surfaceGraph.ts:23`; `edgesBetween` `:361–380`; `jumpEdge` `:438`; `dropEdges` `:509`; `legFrom` `mover.ts:2071`; `stepClimb` `:1665`; `stepAir` `:1158`; `liveWall` `:1282`; `revalidate` `:2230`; world walls `world.ts:403–440`, floors `:442–463` |
| Clips | `ANIM_CLIPS` `shared/cat.ts:39`; `CLIP_MAP` `behavior/clips.ts`; `computeClip` `sim.ts:3287–3307`; renderer `CLIPS` registry, `FULL_RATE_CLIPS`, `TAIL_AUTHORED` |
| Click guard | `overlayManager.ts:~570–615` → `clickThrough.ts:89–102` |
| Tab discovery | §5 |
| Diagnostics | `SurfaceSummary` `surfaceDiagnostics.ts:255–277`; 10 s timer `app.ts:73–74, 669–675`; export `diagnosticsReport.ts`; Mover `supportLost` `mover.ts:89–98` |
| Sim hooks | `SimHooks` has only `onTransition` (`sim.ts:64–65`); the profile harness reads private fields (`act`, `excursion`, `fallReason`, `decisionView`, `requestCandidate`). Add `onDecision`, `onExcursion`, `onFall`. |
| Profile harness | layouts `Desktop`/`setPhase` (`behaviorProfile.ts:155, 180`), usage `DEFAULT_USAGE`/`User` (`:339, 385`), buckets `bucketOf` (`:1308`); re-run `node scripts/with-lock.mjs profile -- node scripts/behavior-profile.mjs --label v12 …`, compare with `--compare` |

### Risks

1. **Tests pin the passive mix** (REAL(code)): `behavior-mix.test.ts:41–45` (calm > 0.8, active < 0.08, resting < 0.65) and `:131–135` (calm > 0.75, surface share < 0.45, climbs ≤ 12/h); `sim-liveness.test.ts:31–40` (3–15 trips/sim-h); `decide-urge.test.ts`. Rewrite them as v1.2 bounds with the change; keep ceilings for "never in the way".
2. **Longer stays cut trips per hour** and interact with the urge reset on arrival and the rhythm factor (`decide.ts:254`); longer stays also expose the cat more to occlusion (T2), the alias bug (T6) and window stimuli (T5).
3. **T8 click-through**: more activity under the cursor, screen-edge walls over scrollbars and caption buttons, pounces landing on the next click target. Guard bands via `excludeRects` are required; pounces should land short of the hotspot.
4. **ADR 0002 §3**: the cat must never float above a visible edge; any "hold on while covered" design must respect it. Overlay windows are never hidden or moved (CLAUDE.md).
5. **Privacy**: no keyboard hook; a finer typing detector stays content-free and touches main (`activityMonitor.ts`) and PRIVACY.md wording; titles never leave `src/main/win32`; tab discovery widens the documented scope (§5).
6. **Platform boundaries**: `src/core` and `src/shared` stay platform-agnostic; AI may only pick from the reaction allow-list; all new randomness through `this.random` (determinism).
7. **Persistence**: no cat-state version bump without an up-migration; settings opt-out list frozen (§6); downgrade to 1.1.1 drops new fields (acceptable, document it).
8. **Rendering**: ~0 DIP presence headroom above the climb pose; animator pair tests grow from 462 to ~1,406 with ~16 new clips; pixel style at 125 % (0.31 px per rig unit) drops fangs and whiskers, so hiss/swat must read through silhouette.
9. **CPU**: awake budget ~1 % of a core (bench 1.05 %, TEST_REPORT v1.1.1); continuous hunt evaluation must fit it.
10. **Harness validity**: probes depend on private sim names (a rename shows as probe "missing"; a semantic change can undercount silently); fixture `providerSurfacesFromWindows` takes z-order from object-key order (`tests/unit/core/behavior/fixtures.ts:272`), so integer-like window ids silently flip occlusion (REAL, caught in the first baseline run); the usage model under-handles the cat 2.5–4×.

## 8. Investigator disagreements, resolved by the synthesizer (REAL(code))

1. **Wander score on a strip: 0.31 (tabstrip) vs 0.203 (behaviour).** Both right. 0.312 is the raw score `(0.12 + 0.22·0.65 + 0.28·b)·1.17` (`decide.ts:213`, activeMul `:187`); 0.203 = 0.312 × 0.65 after one recent `walking` entry (`decide.ts:289–297`). The penalty hits every walking variant equally, including the ways down.
2. **Flick threshold.** The settings-audit's flick relevance at 800–1800 DIP/s describes events that never occur: the activity monitor emits `cursor.flick` only above 2500 physical px/s sustained 80 ms (`activityMonitor.ts:41–42, 125–134`) = 2000 DIP/s at 125 %, where the speed term of `flickRelevance` is already saturated (`stimuli.ts:176`). The behaviour finding is right: with r ≥ 0.4 required (`sim.ts:2571`) a flick triggers a chase only within ~5.7 bw (acceptance 0.4) to ~6.2 bw (0.45), and only if the cursor is also in the reach band.
3. **"The cat cannot walk along a strip" (baseline).** Only the dedicated tab-strip walk option is gated on `rest` ≥ 1.5 bw (`sim.ts:2956, 2987`). Ordinary wander still walks 2–8 bw inside the strip's walk range (`sim.ts:2833–2836`); the v1.1.1 REAL E2E runs walked 366 px (Edge) and 846 px (Chrome) along strips. The real gap is no strip-specific activity and no long dwell (T4), not immobility.
4. **Covered strip: "calm drop, retracted" (baseline) vs "occluded free fall" (tabstrip).** The same event seen at two layers: the Mover reports `'occluded'` and free-falls (only `retracted`/`disabled` settle onto a nearby surface, `mover.ts:1408`); the sim's `calmLoss` treats every loss except `'gone'` as calm (`sim.ts:1224–1228`) and sets `fallReason = 'retracted'` (`:1187`), so no startle follows. The rate differs only through the usage model (10-min alternation vs 60–150 s switching); the user's real switching rate is UNVERIFIED.
5. **Cause of the 15:49–15:50 stay.** Physics proposed occlusion; tabstrip found behaviour. Behaviour (T1) is the primary cause: the browser was in front at the sampled instants, 90 % of SIMULATED and 8/8 REAL dev-build departures were decisions. Occlusion (T2) is a credible second cause in the user's maximized-window-heavy desktop; for that particular stay it is UNVERIFIED.
6. **Walk-down odds** (settings-audit 0 / 0.18 / 0.36 / 0.72 at 30 / 60 / 90 / 140 s; tabstrip 0.12–0.53; behaviour 46 % at 140 s) measure different things: the down option alone in a synthetic view, all three descent paths in the full sim, and one static table with the repetition penalty. All agree on the 20 s onset, the ramp and the autonomy effect.
7. **Reach band 280 vs 285 px.** Same rule (`sim.ts:2773`: 3.5 bh above the feet to 0.5 bh below): 280 px above the floor line, 285 px of screen counting the 5 px floor inset.

## 9. Open items (UNVERIFIED)

- The user's real typing share, pointer positions and maximized-window switching rate (none are logged; add content-free counters).
- The cause of the user's higher nap rate (3.81/h REAL vs 1.2/h SIMULATED).
- The REAL occlusion drop from a strip; tab removal or selection without input; Chrome in the v1.2 dwell runs; the user's own browsers.
- Notepad's tab tree; VS Code and Firefox activation costs (desk research only); Terminal with tabs outside the title bar; Explorer tab overflow.
- Visual checks: screen-top clipping of a climbing cat, new poses inside the presence margins, screen-edge cats over real apps' controls.
- Multi-monitor, mixed DPI and Windows 10 hardware.
