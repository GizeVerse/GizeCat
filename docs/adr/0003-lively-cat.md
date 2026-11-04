# ADR 0003 — v1.2: a lively, curious cat

- Status: proposed, revision 2 (2026-10-29), after two design reviews (see **Review** at the end). Branch `feat/v1.2-lively` from `e9133bd` (= v1.1.1).
- Evidence: [docs/research/v1.2/diagnosis.md](../research/v1.2/diagnosis.md) (baseline, root causes P1–P10, T1–T6, gaps, constraints, risks) and [docs/research/v1.2/tab-discovery.md](../research/v1.2/tab-discovery.md). "P1", "T2" etc. point at the diagnosis. "REAL handling rate" means the user's 1.1.1 numbers in diagnosis §1: 46 pets/h, 19 drags/h, 8.3 throws/h.
- Builds on ADR 0001 (architecture) and ADR 0002 (surfaces, startup). Nothing here changes an invariant in CLAUDE.md.
- **Labels.** §1–§13 are design: UNVERIFIED until a package implements them and its tests run. The numbers are starting calibrations; the **target bands in §14 are the assertions** and win over any constant here. Arithmetic marked "worked" is the architect's and the reviewers' hand calculation (UNVERIFIED). §17 (contract steps C1 and C2) is implemented in this branch; its `verify fast` result is REAL (see the report).

## 0. Decisions at a glance

| # | Concern | Decision | Replaces / fixes |
|---|---|---|---|
| D1 | Picker | Utility scoring over **all** feasible candidates: interest × feasibility × context × repetition (keyed on the **variant**) × energy cost × rhythm; softmax over log-utility at τ = 0.5. Drive-gated candidates have no interest baseline. One activity-class table (`activityClassOf`) for scorer, rhythm and profile. | Top-4 / T = 0.12 (P1), state-keyed penalty (P7) |
| D2 | Needs and moods | Bounded drives with explicit update rules: needs social, play, explore (explore growth scaled by **opportunity**); moods sleepiness, mischief, hunt drive, irritability, frustration, wariness; trait `startleSensitivity`. Petting satisfies social only and **soothes** wariness, fear and irritability when gentle. | Boredom as the only active driver (P2, P9, P10) |
| D3 | Rhythm | Active bursts alternate with calm spells; choice and length depend on activity, energy, sleepiness and context. | Forced movement through autonomy (P8) |
| D4 | Stays | One stay intent per visit (typically 1–5 min, sometimes much longer, now and then short) and a specified on-surface plan; one leave intent (jump down within the safe height, climb down, climb part-way and leap, hop, walk off; an emergency hang-and-drop only when nothing else exists). Resume token after a cover. Watchdogs and caps. | Three descent paths (T1), autonomy shortening stays (T3), nothing to do up there (T4) |
| D5 | Covered or vanished support | Controlled bail-out within the 450 ms grace (a single hop or jump, never a walk across the covered part), also on maximize/minimize; the covering window gets the clicks during it. | Occlusion free fall (T2) |
| D6 | Hunting | Continuous hunt drive (4 Hz) with proximity-weighted prey salience and a threshold that the slider moves continuously. Approach → stalk → crouch with wiggle (a still cursor keeps it waiting) → pounce whose **hit region** lands short of the hotspot → bat / jump-swat → re-stalk or lose interest. Never while typing (raw signal), after a click, near petting, at the taskbar, in a strip or caption band. | Hunting only at decision instants (P3) |
| D7 | Rough handling | Softmax over nine reaction kinds with landing-room input, water-filled caps; moods recover within minutes and petting speeds it up; wariness never blocks grabbing. Physics is never cancelled. | Deterministic startle → hide (P4) |
| D8 | Physics | Screen-edge walls (outer edges only) with a **fail-closed T8 click guard** fed by a dedicated obstacle source; wall jumps; jump-down limits that never land hard by default; impact-scaled landings; ballistic pounce; `jumpKind`; recoverable slips on take-offs; narrow ledges; stalk/sprint paces bounded by gait limits; stale-plan cancellation; stuck-state watchdogs. | §4 gaps |
| D9 | Tabs | WinUI `TabView` reader (Explorer, Terminal) in helper protocol 2; Win32-only allow-list gate on the full image path before any UIA call; never-read property list; Explorer kill switch, rate limit and soak gate; T6 fixed in provider and Mover. | Browser-only strips, T6 |
| D10 | Animation | 14 new procedural clips, `jumpKind` poses, more headroom; published `GAIT_LIMIT_DIP` and `HIT_FRONT_EXTENT_DIP`. | 22 clips, 0.4 DIP headroom |
| D11 | Settings | Schema v3 keeps every v2 key and default; a **Personality** preset (Calm / Playful / Mischievous), three up-front sliders plus "Fine-tune"; a tolerant opt-out list mirrored to a downgrade-proof sidecar; every v2 switch also gates the new acts under it (`behaviorGates.ts`). | — |
| D12 | Sound | Optional procedural WebAudio, off by default, one cue played once (global dedupe), context closed when idle. Lowest priority; may be descoped. | — |
| D13 | Observability | Behaviour profile (Settings, export, hooks) with mood exposure, naps, stuck resets, slips, edge peeks, pounce clearance; rate-limited `stay ended` and `behavior summary` lines without typing data. | Measurement gap (§3) |
| D14 | States | **No new `BehaviorState`.** New behaviour is variants, phases, clips and render hints. | — |

## 1. Behaviour model

### 1.1 Knobs: settings feed the model

| Symbol | Setting | Default | Meaning in v1.2 |
|---|---|---|---|
| A | `behavior.autonomy` (**Activity**) | 0.6 | Odds and length of active episodes (§1.6). It **no longer shortens stays or calm dwells** (T3, P8). |
| H | `behavior.cursorPlay` (**Cursor hunting**) | 0.5 | Gain and threshold of the hunt drive, continuous: H = 0 only watches; small H hunts only close, fast, erratic play. |
| X | `behavior.exploration` | 0.6 | Growth of the explore need; weight of trips, screen edges and corners. |
| Ht | `behavior.heights` | 0.55 | Jump-down limits, willingness to climb high, slip odds. |
| M | `behavior.mischief` | 0.4 | Target of the mischief mood. |
| W | `behavior.workDisruption` (**Play near my work**) | 0.25 | Raises the hunt threshold inside the foreground window and damps play targets within 3 bw of the cursor. Never overrides the typing, click or T8 gates. |
| S | `behavior.stayLength` | 0.5 | Median of the stay intent. |
| R | `interaction.reactionIntensity` | 0.5 | Pushes rough-handling reactions toward mild (0) or big (1). |
| C | `behavior.chaseDurationSec` (v2) | 4.5 s | Budget of one stalk-to-bat cycle: 1.5 × C (default 6.75 s, the user's 7.5 s). |
| — | `behavior.reactToTyping` (v2) | on | Only the **typing reactions** (calming down, watching the user). Every "never in the way" gate reads the raw typing signal whatever it says (§4.3). |
| — | `behavior.disabledBehaviors` (v2) `pawAtCursor`, `zoomies`, `grooming`, `taskbarPlay`, `inspectWindows`… | — | Also gate the new acts under them (§9.4, `behaviorGates.ts`). |
| Sens, Att, P | activitySensitivity, attentionSeeking, patience | v2 | Event salience gain (§1.8), social-need growth, irritability half-life. |

A behaviour in `disabledBehaviorSet(settings.behavior)` (plus the sidecar, §9.3) is never generated; a sub-act is generated only if `subBehaviorAllowed(act, set)`.

### 1.2 Drives

All drives are 0..1 and clamped after every step. Drives step from an **accumulator on sim time** at 1 Hz, the hunt evaluation at 4 Hz (never per host tick, so ×8 time scale and 33 / 66 ms host ticks give the same results). `relax(x, x*, τ)` means `x ← x* + (x − x*)·e^(−dt/τ)`; `half(x, h)` means `x ← x·2^(−dt/h)`. Persisted in `PersistedCat.drives`. **At load:** moods decay for the wall-clock time since `savedAt` (capped at 1 h); needs never grow across downtime; after more than 1 h off, sleepiness relaxes to its default.

| Drive | Default | Grows | Satisfied or decays | Used by |
|---|---|---|---|---|
| `socialNeed` nₛ | 0.3 | +(0.4 + 0.6·affection)·(0.5 + Att)/1800 per s, awake and not touched | per stroke −0.04·strength; beingPetted −0.004/s; greet or answered attention −0.25; held −0.001/s | seekingAttention (I = nₛ², no baseline); watchingUser |
| `playNeed` nₚ | 0.4 | +(0.3 + 0.7·playfulness)·(0.5 + A)/1500 per s, awake, not playing or hunting | playing/hunting −0.012/s; pounce −0.08; bat or swat −0.04; zoomies or tail chase −0.02/s. **Petting: no effect** | play, hunt gain, mischief target, rhythm |
| `exploreNeed` nₑ | 0.4 | +(0.3 + 0.7·curiosity)·(0.5 + X)/1800 per s **×(0.3 + 0.7·o)**, o = 1 when a novel reachable elevated target or a clear screen-edge band exists, else 0 | **per visit**: arrival on a window top or strip −0.25; full screen-edge climb with the top hold −0.2; covered-band peek −0.12; a floor place > 6 bw from the last 5 places −0.05; curious or inspecting −0.002/s | trips, wander, corners, screen edges, rhythm |
| `sleepiness` z | 0.2 | awake: +1/T per s, T = 3600·(1.4 − 0.8·laziness)·(1.2 − 0.4·energyLevel) s, ×1.4 at night (23–6 h), ×(1 + 0.3·darkBias) | asleep −1/720 per s; resting −1/5400 per s | z_eff = clamp(z + 0.6·max(0, 0.55 − energy)/0.55) drives naps and damps the rhythm; `sleepiness()` reads z_eff |
| `mischief` m | 0.3 | relax toward **m\* = M·(0.5 + 0.5·nₚ)·(1 − 0.5·z_eff)·(1 − 0.8·fear)**, τ = 300 s; +0.15 when an attention request goes unanswered; +0.05 per ignored hunt | −0.2 after a mischief act (§1.7) | mischief acts, rhythm, trip targets. Worked: m\* ≈ 0.24 at Playful, 0.06 at Calm, 0.45 at Mischievous |
| `huntDrive` h | 0.05·H | 4 Hz: h ← h + (q̂·k_h − (h − h₀)/τ_h)·dt with **k_h = 0.2·H·(0.6 + 0.8·playfulness)·(0.6 + 0.8·nₚ)**, **τ_h = 20 s**, **h₀ = 0.05·H**, q̂ = q·prox (§4.1). In the petting zone (§4.3) q̂ = 0 and τ_h = 5 s | pounce −0.25; caught −0.35; losing interest halves it | hunt start (§4.2). Worked: defaults start after ~5.4 s of close fast play, need > 30 s of moderate motion, never start below q̂ 0.24; the user's cat after ~3.7 s; Calm after ~15 s, only for close fast play |
| `irritability` i | 0 | di/dt = 0.004·annoyance − i/τᵢ, τᵢ = 120·(1 + 1.5·(1 − P)) s; impulses: hard throw +0.12·severity; rough drag (> 1500 DIP/s for > 300 ms) +0.04; taps beyond 3 in 8 s +0.03 each; **frantic strokes (> 3/s) or strokes within 15 s of a throw +0.03 each, at most +0.1 per petting bout** | decays with τᵢ; **gentle stroke** (strength ≥ 0.5, ≤ 3 strokes/s) −0.01 | reactions, petting tolerance, grumpy idles |
| `frustration` f | 0 | missed pounce +0.2; cursor lost mid-stalk +0.12; failed trip +0.15 | half-life 90 s | losing interest at f > 0.5 (tail lash, displacement groom p 0.3 if `groom` allowed); the failed variant's utility ×(1 − f) for 5 min |
| `wariness` w | 0 | after a reaction k: w ← max(w, w_k), **w_k = avoid 0.8, hide 0.8, defensive 0.7, flight 0.6, startledJump 0.5, grumpy 0.4, surprise 0.2**, shrug/playful 0 | **half-life 45·(2.5 − 1.5·bond)·(1 + 0.5·i) s**; gentle stroke w ×0.85 | at w > 0.3: no hunts; slink rule (§5.3); never blocks grabbing or petting |
| `fear`, `annoyance` (v1.1) | — | fear impulses ×(0.5 + startleSensitivity) | v1.1 half-lives; gentle stroke fear −0.03 | reactions, contentment |
| `boredom` (v1.1) | — | display only: max(nₚ, nₑ) each second (a 1.1.1 downgrade sees a sensible value) | — | — |
| `energy` | — | v1.1 tables; active drains recalibrated so a default cat at 30 % active keeps energy ≥ 0.5 over 3 h | — | energy gate, rhythm |

**Worked recovery (UNVERIFIED).** At bond 0.3 and i ≈ 0.3 the wariness half-life is ≈ 106 s, so w falls from 0.9 to 0.05 in ≈ 7.4 min without petting; with gentle strokes at the REAL rate (≈ 1 per 16 s) the combined rate halves that to ≈ 3 min. Mean exposure above 0.3 is ≈ 70 s per throw without petting and ≈ 30 s with it, ≈ 7 % of awake time at 8.3 throws/h (band B8b ≤ 15 %).

**Trait `startleSensitivity` σ** (default 0.5 for cats saved before v1.2). The contract derives it from confidence with no draw. BEH-b switches new cats to σ = clampTrait(0.5·u + 0.5·(1 − confidence)), with u from a **separate** generator seeded by a hash of `bornAt`, so the main RNG stream and every seeded test cat's other traits are unchanged (resolves the old Q5).

The **exploration urge** u (v1.1.1) stays: it grows while an elevated target is reachable but unvisited and resets on arrival. Its trip bonus is u³·0.8·(0.35 + 0.65·X)·nₑ^0.5.

### 1.3 Scheduler

A decision is taken (at most every 400 ms) when the activity is done or its dwell elapsed; a rhythm episode ends (§1.6); a stay starts or its timer elapses (§2); the salience pass interrupts (§1.8: an event, or the 4 Hz hunt evaluation); a command arrives; or the **progress monitor** resets a stuck activity (§6.9, cause `watchdog`). Hunting and salience cost O(1) per evaluation. Full scoring runs only at decision points, about 4 per awake minute. All draws go through `this.random`; ESLint now forbids `Math.random`, `Date.now`, `performance.now` and `new Date()` in `src/core` (contract C2).

### 1.4 Candidate scoring

For every feasible candidate c (never a top-k cut): `U(c) = B_c · I_c · F_c · C_c · N_c · E_c · R_e(c)`.

| Term | Definition |
|---|---|
| B_c base | Per-variant constant (table below). |
| I_c interest | Plain candidates: 0.2 + Σₖ w_c,k·drive_k. **Drive-gated candidates** (seekingAttention, hunt, nap, hiding, startled:surprise, ambush): Σₖ w_c,k·drive_k, **no baseline**. |
| F_c feasibility | Unreachable targets are never generated. risk = exp(−r_c/ρ), ρ = 0.15 + 0.6·confidence·(0.4 + Ht), r_c from the planner. distance = 1/(1 + (d/d₀)²), d in body widths, d₀ = 10·(0.6 + energy). |
| C_c context | typingRaw: active ×0.35, observe ×1.2, hunts and play-near-cursor 0. Fast app switching: active ×0.4. Video in front: active ×0.4. Night: active ×0.75. **Work disruption**: a target within 3 bw of the cursor gets ×(0.2 + 0.8·W) (not the whole client rect of a maximized window). |
| N_c repetition | Key `state:variant` (trips add `:surfaceKind`). N = Πⱼ (1 − 0.45·sim(c, rⱼ)·0.7ʲ) over the last 8 picks; sim = 1 same key, 0.35 same family. Repeating the current key ×0.4 (not idle/observe). Place novelty: visited in the last 20 min ×0.7; never this session ×(1 + 0.3·curiosity). |
| E_c energy cost | exp(−2·κ_c·(1 − energy)), κ = 0 calm, 0.2 walk, 0.5 climb or trip, 0.7 sprint, zoomies, hunt. |
| R_e rhythm | §1.6. Stimulus, stay and leave decisions ignore it. Classes come from `activityClassOf(state, variant)` (contract), the same table the profile measures B1 with. |

**Choice.** Drop U < 0.03·U_max, then P(c) ∝ U(c)^(1/τ), τ = 0.5 (half the utility keeps ~25 % of the leader's odds).

| Candidate (state:variant) | Class | Family | B | Interest | Gates (besides opt-outs and sub-act gates) |
|---|---|---|---|---|---|
| idle (sit/stand, look around) | calm | observe | 0.30 | 0.2 + 0.3·laziness | — |
| watchingUser | calm | observe | 0.25 | 0.2 + 0.4·nₛ + 0.3·affection | foreground known |
| watchingCursor (incl. `chatter` for a cursor > 2.5 bh above) | calm | observe | 0.25 | 0.2 + 0.7·h | cursor in the watch band (14 bw × −0.6..4.5 bh, §4.1) |
| curious:look | calm | observe | 0.12 | 0.2 + 0.5·nₑ | a target |
| resting (loaf) | calm | rest | 0.30 | 0.2 + 0.4·(1 − energy) + 0.3·z_eff | — |
| resting:ambush | calm | rest | 0.10 | 0.8·m + 0.4·h | m > 0.15, not typing, at a side's foot, strip end or corner; `ambush` |
| fallingAsleep / walking:favorite → nap | calm | rest | 0.60 | **2·max(0, z_eff − 0.25)^1.5** (no hard gate) | or the user idle past sleepAfterIdle (then only rest options, as now) |
| grooming | calm | groom | 0.25 | 0.2 + 0.3·(annoyance + frustration) | `groom` |
| idle:stretch | calm | groom | 0.08 | 0.2 + 0.5 after ≥ 60 s of rest or sleep | — |
| walking:wander | active | explore | 0.30 | 0.2 + 0.6·nₑ + 0.1·m | — |
| walking:corner | active | explore | 0.12 | 0.2 + 0.7·nₑ | — |
| inspectingWindow:explore, walking:climb, walking:tabStrip | active | tripUp | 0.25 | 0.2 + 0.5·nₑ + 0.2·m (strips) + urge bonus | `tripUp` / v1.1.1 toggles, reachability, cooldowns |
| walking:hop | active | tripUp | 0.15 | 0.2 + 0.5·nₑ | `surfaceHop` (+ `taskbarTarget` onto a taskbar) |
| walking:screenEdge | active | tripUp | 0.15 | 0.2 + 0.6·nₑ, ×2 when no other elevated target exists | `screenEdgeClimb`, `env.edgeBands` present, §6.1 |
| chasingCursor:hunt | active | hunt | 0.60 | h² | **h > θ_h and the hunt cooldown elapsed** (one start path with the 4 Hz pass) |
| playing:pawAt | active | play | 0.20 | 0.2 + 0.7·nₚ | not typingRaw, `huntBat` gate for paws at the cursor |
| playing:rollOver | active | play | 0.12 | 0.2 + 0.5·nₚ + 0.3·bond | not typingRaw |
| playing:zoomies (sprint) | active | play | 0.08 | 0.2 + nₚ·energy | energy > 0.55, `zoomies` |
| playing:tailChase | active | play | 0.05 | 0.2 + 0.6·nₚ + 0.3·m | `tailChase` |
| seekingAttention | active | social | 0.35 | nₛ² | user present (< 60 s idle), `seekAttention` |
| hiding | reaction | wary | 0.05 | w + 0.5·rough memory | rough memory > 0 |
| startled:surprise | reaction | wary | 0.02 | 0.5 + curiosity (only while a recent stimulus exists) | v1.1 cooldown |

Worked (UNVERIFIED): at nₛ = 0 seekingAttention is now 0 (it was 0.07, ~25 % of wander's odds); the nap ramps in smoothly from z_eff 0.25 instead of jumping at 0.35.

### 1.5 Variety

The log-utility softmax, repetition keyed on the variant (a recent wander no longer suppresses a climb, P7) and place novelty. Families group variants that should not repeat back to back: every descent is in `leave`, every trip up in `tripUp`.

### 1.6 Rhythm: bursts and calm spells

When an episode ends, the next is active with probability σ(4·(D − 0.5)):

`D = 0.25·A + 0.2·energy + 0.25·max(nₚ, nₑ, m) + 0.1·h + 0.1·(1 − z_eff) − 0.45·z_eff − c_ctx`, `c_ctx = 0.25·typingRaw + 0.15·typingIntensity + 0.2·busySwitching + 0.2·video + 0.1·night`.

| Episode | Duration | R_e |
|---|---|---|
| active | U(25, 75) s·(0.7 + 0.6·energyLevel)·**(0.8 + 0.4·A)** | active ×1, calm ×0.3 |
| calm | LogNormal(median 100 s·(1.3 − 0.6·A), σ 0.5), clamped 30..600 s | active ×(0.12 + 0.2·m), calm ×1 |

Worked (UNVERIFIED): defaults D ≈ 0.37, P(active) ≈ 0.37, 52 s active against 106 s calm → ≈ 22 % active-episode time; the user's cat (A 0.8, energyLevel 0.54) D ≈ 0.43 → ≈ 32 %. Both inside B1 (20–35 %), which stays the assertion (resolves the old Q4). Because nₑ grows ×0.3 without an opportunity, the maximized-window state no longer saturates the explore need (B1b).

**Calibrated (BEH-c, the bands win; SIMULATED).** The implementation adds 0.3 to D, active episodes run ×1.3 and calm picks weigh ×0.1 in an active episode (B1). **Nothing to climb** (a maximized window in front, or nothing in reach to go up onto: `nothingToClimb`): D − 0.3 and nₑ left out of the max. That is the fix for the restless empty desktop: nothing there satisfies the explore need, it saturated and kept D and the walk candidates up (P1/L4 53 % active, 28 % of the time walking; B1c).

### 1.7 Mischief (unobtrusive by construction)

Mischief reweights existing acts and adds no new way to get in the way. All acts need m > 0.15 (none at Calm), fire with probability ∝ m, and pass the typing, click, petting and T8 gates (§4.3) and their sub-act gates:

- foreground trip targets get +0.4·m·(0.5 + W) in place novelty;
- `mischiefSwat`: a cursor passing within 1 bw while the cat sits, p = 0.5·m per pass, cooldown 60 s/(0.5 + M), only with the strike clearance (§4.2);
- `ambush` (`resting:ambush`, §1.4): lying low, then a hunt when the cursor passes (normal hunt gates and threshold);
- `overstimSwat`: after ≥ 8 strokes in a bout, p = (0.1 + 0.3·i)·m/M (0 when M = 0): a soft swat at the hand, then a hop away (the hand is already over the cat, so click-through is unchanged);
- tail chase, a taskbar run (`taskbarTarget`), ignoring a call (v1.1 bound, ≤ 35 %).

### 1.8 Event salience

Salience = relevance(e) (v1.1) × (1 − habituation) × (0.4 + Sens) × receptivity (asleep 0.2, calm 1, active 0.5, stay 0.6, reaction or physical 0). Above 0.6 it interrupts a calm activity (cause `stimulus`).

| Event | Reaction |
|---|---|
| `tabs.changed` on its strip | selected → ear flick, head turn to `focusX`, walks toward it with p 0.3; added → look toward the new tab's end; removed within 1.5 bw → `startled:surprise`; geometry → nothing (`tabReaction`) |
| window shown / closed / moved / foreground | v1.1 relevance |
| **window restored / un-maximized** | salience 0.7: a curious look at the new top, +0.2 to the urge (`inspectWindow`) |
| a window covers or removes the stay surface | bail-out (§3), then a glance at the front window; resume token (§2.4) |
| taskbar shown / hidden | v1.1 (look, hop, ride; `taskbarTarget`) |
| `cursor.flick` | q += 0.5 for that evaluation (§4.1); no direct chase |

## 2. Stay model

### 2.1 Stay intent (drawn once, on arrival at a window top or tab strip)

| Branch | Probability | Duration |
|---|---|---|
| short | p_s = 0.10·(1.5 − S) | U(20, 60) s |
| long | p_l = 0.08 + 0.12·S·(0.5 + laziness) | LogNormal(median 7 min, σ 0.35), capped at 25 min |
| typical | 1 − p_s − p_l | LogNormal(median m, σ 0.55), m = 150 s·(0.55 + 0.9·S)·(0.8 + 0.4·laziness)·(1.15 − 0.3·curiosity)·(z_eff > 0.5 ? 1.4 : 1)·(strip ? 1.1 : 1) |

Worked: median ~150 s, p10 ≈ 50 s, ~19 % over 5 min, p90 ≈ 7 min. A nap up there extends `plannedMs` by its length, but a stay never exceeds **30 min including naps** (hard cap, then the leave intent). While the user types, plannedMs ×1.3. Activity (A) is not in the formula (T3).

### 2.2 On-surface plan

During a stay the pool holds only these candidates plus high-salience interrupts; the rhythm applies with calm-leaning episodes (active R_e ×0.6). Leaving is not a candidate.

| Candidate | Class | B | Interest | Gates |
|---|---|---|---|---|
| walking:patrol (walk along) | active | 0.20 | 0.3 + 0.4·nₑ | ≥ 2 bw of walk range, at most once per 45 s (the v1.1.1 rest-span gate is removed, T4) |
| edgeSit (sit at the end, look down) | calm | 0.25 | 0.3 + 0.4·curiosity | window tops and a strip's open end; `edgeSit` |
| idle:watchTab | calm | 0.25 | 0.4 | strips; faces `focusX`, now and then moves within 1 bw of it; `watchTab` |
| resting (loaf) | calm | 0.30 | 0.3 + 0.4·(1 − energy) | — |
| grooming | calm | 0.20 | 0.3 | `groom` |
| nap | calm | 0.60 | as §1.4 | z_eff > 0.5 |
| watchingCursor, ledge-bound hunt | calm / active | as §1.4 | as §1.4 | no pounce off the ledge; no hunt while the cursor is in the strip container or the caption band |

### 2.3 Leave intent (one decision, when `elapsed ≥ plannedMs`)

`Mover.leaveOptions()` lists the feasible ways off; each is scored `U(o) = w_kind · exp(−o.risk/ρ) · N_leave(kind) / (1 + o.effort/20)`:

| Kind | w_kind | Notes |
|---|---|---|
| jumpDown | (0.6 + 0.8·Ht)·(0.5 + confidence)·(soft 1, medium 0.7, hard 0.3·Ht) | only where dropDip ≤ H_max (§6.3) |
| climbDown | 0.8·(1.2 − Ht)·(0.5 + laziness) | window side, or a screen edge it holds on |
| climbLeap | 0.9 | swing down, climb to a grip ≤ min(H_safe, 0.8·h_hard) above the support below, then a wall jump (`windowWallJump`) |
| hop | 1.0·(0.5 + nₑ) | to another reachable surface (`surfaceHop`; a taskbar also needs `taskbarTarget`) |
| walkOff | 0.6 | a joined end at the same height |

N_leave ×0.55 per each of the last 4 leaves of the same kind; same τ = 0.5 softmax; runs through `Mover.leaveBy(o, pace)`. While typing, climbDown and walkOff get ×1.5. While the cat is being petted the leave is **deferred** 10–20 s.

**Failure and the emergency path.** If `leaveBy` returns false, the options are listed again after a backoff of 2 → 4 → 8 s. After 3 failures in 30 s (or when `leaveOptions()` has nothing but an `emergency` option) the cat takes the **emergency option** (`LeaveOption.emergency`, contract C2): it hangs from the edge (start ~1 bh lower) and drops, impact as it comes, end reason `leave`. Only emergency legs may exceed H_max and `MOVEMENT.jumpDownAbsoluteMaxDip`. A stay still running 2 min past `plannedMs` logs `stay overdue` (debug, rate-limited).

### 2.4 Imposed ends and the resume token

`STAY_END_REASONS`: user drag → `drag`; call → `called` (leaves by the best option); covered → `covered` (§3); window closed, minimized or maximized → `gone` (§3 bail-out too); setting off → `disabled`; fullscreen → `fullscreen`; nₛ > 0.9 at least 60 s in → `stimulus`. **Resume token:** when an own stay ended `covered` or `gone` and its surface reappears within 3 min, that surface's trip gets ×2 and the new stay (`resumed: true`) gets at least the remaining planned time (≥ 60 s). The three v1.1.1 descent paths and `topExplored` are **removed**, not tuned.

## 3. Covered or vanished support (T2): controlled bail-out

When the ledge under the cat becomes covered (served covered or unlisted, and `getSurface` no longer holds it) **or vanishes** (its window minimized, maximized or closed), the Mover (with `cfg.bailOut`) acts within `perchGraceMs` (450 ms) and picks the first that applies:

1. the nearest still-visible stretch of the same edge, **only as a single hop ≤ 0.6 s from the cover to take-off**, or as a walk only when the feet already stand on the visible stretch (never a walk across the covered part, ADR 0002 §3);
2. a visible support reachable by one jump within H_max, soft impact preferred;
3. a visible wall within leap reach, then climbing down;
4. otherwise the **emergency** controlled drop (`LeaveOption.emergency`).

It takes off after a 120 ms crouch, ≤ 0.6 s after the cover, and reports `MoverStep.bailedOut`; the stay ends `covered`/`gone` with `bailOut` set in the ExcursionRecord. The sim treats it as calm (ear flick, a glance, no startle). **Click guard:** from the moment the support is reported covered until the landing, `catHost.clickGuardRectsPx()` includes the covering window's rect, so the user's first click after a maximize goes to the window, never to the floating cat. A covered loss **without** a bail-out is fall cause `covered` (physics error, B9/B13).

## 4. Hunting

### 4.1 Prey salience (4 Hz)

`q = inWatchBand · max(move · (1 + 0.3·erratic) · still + flick, presence)`, q̂ = q·prox with **prox = 1/(1 + (dx/4 bw)²)**:

- move = clamp(v/400), v the cursor speed in DIP/s (v < 30 counts as 0); erratic = 1 if the direction turned > 90° within 400 ms; still = 0 once `cursorIdleMs` > 1500 (except during a running crouch, §4.2); `cursor.flick` adds 0.5.
- **presence = 0.8 until the cursor has rested 20 s** (BEH-c). A cursor merely hanging around is what ordinary use offers: movement in the start band alone peaked the drive at 0.15 against a threshold of 0.45-0.55 (P2/L1/U-active, 0 hunts/h, SIMULATED).
- **Watch band** (watchingCursor, `cursorInReach` context): 14 bw horizontally, 0.6 bh below to 4.5 bh above the feet, same display, not off limits.
- **Start band** (hunts): the watch band with dy ≤ 2.5 bh above the feet.

### 4.2 Start and phases

A hunt starts when h > **θ_h = 0.4 − 0.15·H − 0.05·m (+ 0.1·(1 − W) while the cursor is inside the foreground window)**, the cooldown U(4, 7) min·(1.6 − H) has elapsed and no gate (§4.3) holds. The drive follows q̂ with gain k_h = 0.34·H·(0.6 + 0.8·playfulness)·(0.6 + 0.8·nₚ) and τ 45 s, and keeps building through a press hold (only a button held down, or typing, stops it). It interrupts calm activities only. The scheduler's hunt candidate uses the same threshold and cooldown (one start path). (Started at 0.55 and 0.3, k_h 0.2, τ 30 s; calibrated against B5 and B5d, SIMULATED.)

| Phase | Rule | Clip |
|---|---|---|
| notice | 0.4–1.2 s; ears forward, look | sit / crouch |
| approach | low trot at `chase` pace until 4 bw from the cursor's projection | walk / run |
| stalk | `stalk` pace (24 DIP/s) for at most 6 s toward 1.5–2.5 bw short of the hotspot (measured from the hit region's front), pausing 0.3–1 s every 1–2 bw. Prey already within a pounce's reach: 1.2 s of it, then the crouch | `stalk` |
| crouch | 600–1600 ms, wiggle visible from 0 s. **A still cursor keeps the crouch alive (wiggling) for a wait drawn per cycle, U(2.5, 6) s; its next movement > 30 DIP/s within reach triggers the pounce.** Prey out of the start band for 1 s: a stalk turns into this crouch, lying low for it, instead of ending the hunt. At the end of the wait it leaps 85 % of the time, at the cursor or at the place the prey left (a miss like any other), else it loses interest; a press still too recent for the leap holds it up to 3 s more | `crouch` |
| pounce | `Mover.pounceAt` with `frontExtentPx = HIT_FRONT_EXTENT_DIP.pounce·size·scale` and `shortPx = max(0.35 bw, hysteresis + HIT_CLEARANCE_DIP)`: the hit region lands ≥ 8 DIP + hysteresis short of the hotspot (≈ 0.85–1.0 bw of anchor clearance). ≤ 3.2 bw; prey past the end of what it stands on gets a shorter leap, 0.2 bw inside the end (no leap under 0.3 bw) | `pounce` (jumpKind `pounce`) |
| jump-swat | cursor 1.2–2.5 bh above: a vertical hop with a swat at the apex (jumpKind `up`), same cooldown and clearance (`huntJumpSwat`) | `jump` + `swat` |
| bat | pawAt 0.6–1.5 s, or `swat` within 0.8 bw — **only when the paw's maximum reach (`HIT_FRONT_EXTENT_DIP.pawAt/swat`) stays ≥ 8 DIP + hysteresis short of the hotspot**; otherwise a look or a tail lash (`huntBat`) | `pawAt` / `swat` |
| next | caught = the cursor within 1 bw of the paw point at landing. Re-stalk if the cursor still moves in the start band, h > 0.35, f < 0.6 and < 3 cycles have run; otherwise lose interest (sit and look away 40 %, groom 25 % if allowed, walk away 35 %) | — |

**Budget:** each stalk-to-bat cycle ends at 1.5 × `chaseDurationSec` (approach and notice excluded). A miss adds f += 0.2. Pounces: global cooldown 90 s, at most 2 per hunt. A cursor more than 2.5 bh above is only watched (`watchingCursor:chatter`). Every pounce or strike records the clearance actually achieved (`HuntRecord.minClearanceDip`, B5c). Each hunt emits a `HuntRecord` (`startedAt`, `pounceTimes`, `gate`).

### 4.3 Gates: never in the way

No hunt starts, and a running one ends within 0.5 s (`HuntRecord.gate`), when any of these holds:

- **typing**: `typingRaw = env.typing || env.typingIntensity > 0.35`, or less than 3 s since it ended. This raw signal drives every "never in the way" gate (hunt start/abort, pounce, swat, mischief, play near the cursor, the 3 s hold, W) **whatever `reactToTyping` says**; that setting governs only the typing reactions.
- **buttons**: `pointerButtonDown`, or a press (`env.pointerButtonPresses` increased) too recent: **6 s** close to the cat; **2 s** with the press and the cursor both more than 4 bw from it (nothing the cat does reaches them); **10.5 s** for a hand at work, 3 presses within 30 s and moved within the last 3 s, wherever it is (a hand that has come to rest has stopped working). A press within 1 s, or the button down, close to the cat ends a running hunt (`click`); a press far from it only holds the leap back (2 s). This is what ordinary use needed: U-active presses about 680 times an hour, and a flat 6 s hold rejected more of the time in the start band than every other gate together (SIMULATED).
- **petting zone**: the cursor within the cat's hit rect grown by 0.5 bw, `beingPetted`, and 3 s after petting: q̂ = 0 and h relaxes with τ 5 s.
- **taskbar**: a taskbar shown, less than **10 s** since it hid (the hand that used it is at work; 1 s to begin with, 14 % of the U-mouse-work hunts started within 15 s of one, SIMULATED), or the cursor inside a taskbar's band (the user's bottom auto-hide reveal).
- **strip and caption**: the cursor inside the container of a strip the cat stands on or next to, or in the caption band (top 1 bh) of the window it stands on.
- `chaseCursor` off, or H = 0; w > 0.3 or fear > 0.3; asleep, away, paused, quiet or fullscreen; a command.

`pounce` off keeps stalking and watching. `pawAtCursor` off removes every strike at the cursor (bat, jump-swat, mischief, overstimulation and defensive swats; §9.4): the hunt ends with a look. **Hold-still zone:** while the hotspot is within 0.5 bw of the hit region, the cat takes no take-off and pauses walking for up to 3 s, then walks on away from the cursor, never toward it (grabbing and petting stay easy; no stuck state). The v1.1.1 freeze under a pressed cursor stays.

## 5. Throw and rough-handling reactions

### 5.1 Inputs and logits

Inputs (0..1): severity s = 0.6·clamp((v − 1100)/1500) + 0.4·hardness (soft 0, medium 0.5, hard 1); handling frequency hf = clamp((throws + rough drags in the last 10 min)/5); irritability i; confidence c; bond b; recent startles st = clamp(n_5min/3); reaction intensity R; σ; playfulness pl; playNeed nₚ; **landing room ℓ = 1 when it landed on an elevated ledge with < 4 bw of room**.

z_k from the table, then z_k += 1.2·(R − 0.5)·ι_k, −0.5 for a repeat of the previous reaction, and the ℓ terms.

| Kind | z_k | ι_k | ℓ | Plays out as | w_k |
|---|---|---|---|---|---|
| shrug | 0.6 + 1.2c − 1.8s − 0.8i − 0.6hf | −1 | 0 | lands, looks around 1 s, carries on; fear +0.02 | 0 |
| surprise | 0.7 + 0.8σ − 0.5hf − 0.3s | −0.4 | +0.5 | short startle 0.8 s, sits, looks at the cursor 2 s, grooms 40 % (if allowed); fear +0.15 | 0.2 |
| startledJump | −0.1 + 1.1σ + 0.9s − 0.7c | 0.5 | −1.5 | startle + `hop` 1.5–3 bw away, slinks 2–4 bw, sits facing back; fear +0.3 | 0.5 |
| grumpy | −0.4 + 1.6i + 0.8hf + 0.5c | 0.2 | +0.5 | `grumpy` stare 3–8 s, tail thumps, turns away; i +0.05 | 0.4 |
| defensive | −1.2 + 2.0i + 0.8hf·s − 0.9b (excluded if `defensiveHiss` is not allowed) | 1 | 0 | `hiss`; a `swat` (`defensiveSwat`, strike clearance) if the cursor comes within 1.5 bw in 8 s; grumpy 3 s; i +0.08 | 0.7 |
| flight | −0.5 + 1.0s + 0.7(1 − c) + 0.6st | 0.7 | −1.5 | `sprint` 4–8 bw away, sits and watches; fear +0.25 | 0.6 |
| playful | −0.6 + 1.4·b·pl + 0.8nₚ − 1.4i − 0.9s | 0 | 0 | rollOver, a 3 s zoomie (`reactionZoomie`), or (b > 0.6) a mini pounce (`reactionPounce`, counts toward the pounce cooldown); nₚ −0.1 | 0 |
| avoid | −0.7 + 0.9hf + 0.6i + 0.4(1 − b) | 0.3 | −1.5 | soft avoidance: walk targets ≥ 4 bw from the cursor for 1–3 min; moves only under the slink rule | 0.8 |
| hide | −1.3 + 1.1(1 − c) + 0.8hf + 0.6st − 0.6b | 0.6 | 0 | v1.1 hiding, 20–60 s | 0.8 |

### 5.2 Choice, triggers and order

- **Caps by water-filling**: P = softmax(z); clamp every kind above its cap (hide 0.25, others 0.5), renormalise the rest, repeat until nothing changes (≤ 9 passes). Caps apply only when ≥ 3 kinds are eligible; otherwise P is normalised and the case logged. `ReactionRecord.capped` says when a cap changed the draw; B7 is asserted on the **uncapped** softmax and wants the cap active in < 10 % of draws.
- **Triggers**: a throw (release ≥ 1100 DIP/s), and a **rough drag** (> 1500 DIP/s for > 300 ms in the last 2 s) released slowly, with severity ×0.6 (`trigger: 'roughDrag'`). Other releases keep the v1.1 calm outcomes; a hard impact from a high drop → surprise.
- **Order**: the reaction starts after the Mover lands (the flight is never cancelled). After a thrown hard landing the `impact` squash plays 300–450 ms, then the reaction's own entry **replaces** `landRecover` (a startled cat bolts at once); shrug and surprise may use `landRecover` as their body.
- **Room**: reaction moves pin their goal to the current surface (`MoveGoal.surfaceId`) and clamp to its walk range. If avoidance still needs room, the cat takes the best leave option within H_safe (stay end `stimulus`). A step-off during a reaction is fall cause `physics` (B9).
- Each reaction emits a `ReactionRecord` and is remembered as `throw` with the kind (in the rough-handling list, §5.4).

**Worked check** (the user's cat: c 0.51, b 0.60, pl 0.38; i 0.2, hf 0.5, s 0.7, st 0.3, R 0.5, σ 0.5, ℓ 0): shrug 6 %, surprise 18 %, startledJump 19 %, grumpy 17 %, defensive 3 %, flight 19 %, playful 4 %, avoid 10 %, hide 5 %. Nine kinds, max 19 %, hide 5 %, no cap active (v1.1.1 baseline: hide 92–97 %).

### 5.3 The slink rule (wariness never blocks the controls)

At w > 0.3 the cat slinks 3–6 bw away **only** from a cursor that approaches faster than 6 bw/s, from within 4 bw, at or above the cat's level, and not inside the strip container or the support window's client area. It **never** moves while `cursorOverCat` or with the cursor within 1 bw; it stops retreating when the cursor slows below 1.5 bw/s within 3 bw (the user is aiming); it retreats at `slink` pace only, at most twice per approach episode; with less than 2 bw of free space it sits `grumpy` instead. A slow approach gets ears back and a hold, then petting is accepted (and soothes, §1.2). Calls, sleep and tray commands override wariness.

### 5.4 Rough-handling memory

`throw` and `annoyed` memories live in a separate bounded list of 16 (BEH), so frequent new events cannot evict them; stays, hunts, pounces and slips are counted (profile, counters), **not** written to the 40-entry `recent` ring. A throw is still counted 59 min later after 60 hunts and stays (BEH unit test).

**Recovery (B8):** 10 min after a burst of 5 hard throws (bond ≥ 0.3), fear < 0.05, irritability < pre + 0.1 and wariness < 0.05; with petting at the REAL rate after the burst, within 8 min.

## 6. Physics

### 6.1 Screen-edge walls and corners (T8-safe)

- **Where.** `WorldModel` builds a wall (`WallTrack` kind `screenEdge`) for each left and right work-area edge of a display that has **no neighbour** on that side. A neighbour is another display whose bounds overlap that side over a positive length > 2 px, in physical px, with the join tolerance taken at the larger scale of the two displays; corner-only contact is no neighbour. There is never a wall between monitors (also with `allowMultiMonitor` off), never on a side with a taskbar (auto-hide included), never on displays shorter than 2 bh above the floor, and none unless `cfg.screenEdges` (§6.1(b)).
- **Geometry.** The cat clings inside the screen (left edge: right of the line facing left; mirrored on the right). yBottom = floor; yTop = work-area top + 120 DIP·scale so the climb pose and the ears stay on screen; the emote is clamped inside the overlay (§8.2).
- **Graph.** Mount from the floor, dismount at the bottom, no pull-up. At the top the cat holds (`holdOnWall`, 3–12 s, never more than `MOVEMENT.maxWallHoldMs` = 20 s whatever it is given; `climb` clip clinging, `balance` 0.6), then climbs down or takes a `wallJump` to a ledge or floor within reach. `climbOptions()` returns these with `wallKind: 'screenEdge'`. A display removed while the cat clings is cause `gone`, never `physics`; no snap > 0.5 bw except on display removal.
- **T8 guard**, three layers, fail-closed:
  - **(a) main, click guard (PRV).** A dedicated source `clickObstaclesPx()` (win32): every visible, uncloaked top-level window **except this app's overlays**, including the app's own Settings window and dialogs, topmost, tool and popup windows (browser picture-in-picture, Task Manager) and privacy-excluded windows, as `GetWindowRect` (resize borders included) grown by 8 DIP. It is cached and invalidated by WinEvents (create, show, hide, location change, foreground, uncloak, destroy), and enumerated only on invalidation and only while the cat is within 1 bw of a cling band. A pure `wallGuardRects(catBoundsPx, obstacles)` (clickThrough.ts) returns the obstacles meeting the cat's bounds; `catHost.clickGuardRectsPx()` (contract seam) returns them whenever the cat's bounds meet a cling band, while the Mover leaps, climbs or wall-jumps to or from a screen edge, and during a bail-out (§3). **Fail closed:** while the cache is invalid or older than 250 ms near a band, it returns the whole cat bounds; a throw makes the overlay manager return EVERYWHERE (existing). **Hover dwell:** while clinging, the hit region stays click-through until the cursor has hovered over it for 300 ms, so a passing click never lands on the cat and a deliberate grab still works.
  - **(b) behaviour (BEH).** `cfg.screenEdges` is set only when the setting allows it **and `env.edgeBands` is present**: a host without the guard never gets edge climbs. Clear spans are computed from the real footprint (bw × `appearance.size` + 2 × `BODY_MARGIN_SIDE_DIP`). Full climbs only within the clear span that contains the wall's foot. Covered bands, and the **left edge of a visible desktop** (desktop icons sit there by default), allow only peeks: ≤ 2 bh, ≤ 8 s, ≤ 4 per hour, with the cursor more than 6 bw away; with a maximized foreground the left edge is preferred (scrollbars are on the right), over the desktop the right edge is preferred for full climbs. No climb starts with the cursor within 3 bw of the band or moving toward it in the last second; the cat climbs down when the cursor comes within 2 bw.
  - **(c) setting.** Opt-out `screenEdges` (implied by `climbWindows` off).
- Whether real apps' controls stay usable next to a clinging cat is UNVERIFIED until the REAL E2E (§15.4).

### 6.2 Jump kinds

`JumpKind` is reported by `Mover.jumpKind` while airborne, in `LandingInfo.jumpKind` and as the render hint: hop (on-surface, |dy| < 0.5 bh, dx ≤ 1 bw), up / down (dy < −0.5 bh / > 0.5 bh), across, pounce, leap (onto a wall), wallJump (off a wall). The graph gains `wallJump` edges, filtered by the jump-down limits; `climbLeap` is swing, climb down to a grip, wallJump.

### 6.3 Jump-down limits

- h_hard = `impactHardFromDip²/(2·gravityDip)` ≈ 492 DIP (the height above which a drop lands hard).
- `H_safe = min((240 + 520·Ht)·(0.7 + 0.6·confidence)·(0.6 + 0.4·energy), 0.95·h_hard·(0.8 + 0.4·Ht))`.
- `H_max = min(1.35·H_safe, 900)` for non-emergency legs.

Defaults: H_safe ≈ 477 DIP (medium landing), H_max ≈ 644. Heights 0 → ≈ 230; heights 1 → ≈ 561 (a daring cat accepts some hard landings). climbLeap grips at ≤ min(H_safe, 0.8·h_hard ≈ 394). Legs beyond H_max are removed; between H_safe and H_max they carry risk (dy − H_safe)/(H_max − H_safe). The 844 DIP browser top is left by climbDown, climbLeap or hop at the defaults.

### 6.4 Impact-scaled landings

`impactClass`: soft below 1000 DIP/s (drops up to ~190 DIP), medium below 1600 (~490 DIP), hard from 1600.

| Class | Unplanned (fall, throw, slip miss) | Planned (own jump or drop) |
|---|---|---|
| soft | `land` 250 ms | `land` 250 ms |
| medium | `land` 400 ms, impact ≈ 0.5 | `land` 350 ms |
| hard | `impact` 450 ms + `landRecover` 900 ms, energy −0.01, fear +0.05 unless confidence > 0.7 | `impact` squash 300 ms only; no landRecover, no fear |

Unit test (MOV/BEH): the default cat's planned descents land soft or medium.

### 6.5 Ballistic pounce

`Mover.pounceAt(now, target, {crouchMs, shortPx, maxDistPx, frontExtentPx})`: a crouch (wiggle), then an arc with apex 30 + 40·(dist/maxDist) DIP, dist ≤ 3.2 bw; the anchor lands at `target.x − facing·(frontExtentPx + shortPx)` (contract C2) on the current surface or one joined at the same height, inside the walk range; a target beyond a ledge end lands at the end minus 0.2 bw (never off a ledge); a surface that vanishes or moves > 0.5 bw during the crouch cancels it (`planCancelled`).

### 6.6 Deliberate slips

**Every take-off is a candidate**: leap, hop, wallJump, climbLeap and pull-ups onto strips; never pounces, bail-outs or emergency legs. Risk (`nextLegRisk`, 0..1) grows with a landing span < 1.2 bw, a gap > 0.7·maxJumpAcross, dy > 0.7·maxJumpUp, a target moving > 50 DIP/s, energy < 0.3. The sim draws a slip with **p = min(0.2, (0.03 + 0.15·risk)·(1.3 − confidence)·(0.7 + 0.6·(1 − energy)))** (sub-act `slip`), via `armSlip` during the crouch. Worked: ≈ 0.5 slips/h at ~20 take-offs/h for the default cat.

| Slip | Probability | What happens |
|---|---|---|
| scramble | 70 %, or always when a miss is not allowed (drop below > H_safe) | front paws catch the edge, `slip` 0.9 s, pull up |
| miss | 30 % | slides off to the support below (fall cause `slip`, `LandingInfo.slipped`), impact landing, f +0.1; retries with p 0.5 after 10–30 s |

Each emits a `SlipRecord`.

### 6.7 Paces, gaits, narrow ledges, balance

| Pace | stalk | slow | walk | chase | run | sprint |
|---|---|---|---|---|---|---|
| DIP/s | 24 | 42 | 70 | 210 | 260 | 360 |

`GAIT_LIMIT_DIP` (contract C2, `src/shared/cat.ts`: walk 106, run 394, climb 63, stalk 40, slink 90, sprint 440) is what each locomotion clip must animate cleanly (REN authors to it and cross-checks `clips.ts`); the Mover clamps every pace to 1.1 × its clip's limit whatever `movementSpeed` says. With `cfg.narrowLedges`, ledges 0.25–0.9 bw wide are accepted; on them the cat walks ×0.6, never runs or pounces, and `balance = clamp((0.9 bw − width)/0.65 bw)`.

### 6.8 Stale plans and physics-error accounting

- **During the crouch**: a target surface or wall gone, moved > 0.5 bw or covered (confidence < 0.25) cancels the take-off (`planCancelled`) and replans. After 2 cancels within 10 s the Mover reports the goal unreachable for 3–5 s (`MOVEMENT.planCancelBackoff*`), so dragging a window cannot loop the cat.
- **In the air**: no cancel; the cat lands where the arc meets a surface. `LandingInfo.plannedSupportId/plannedOutcome` (contract C2) say whether it landed on the support it aimed at: `gone` → fall cause `gone` (environmental), `missed` → `physics`.
- **Topology change mid-climb**: the cat stays on the same wall if it exists; otherwise it lets go from where it is; never a snap > 0.5 bw except on display removal.
- **Physics errors** are FallCause `covered` (no bail-out) and `physics` (headroom, forced landing, a missed planned landing, a step-off during a reaction, a re-validation snap). Target 0 (B9). `fallCauseOf` (contract C2) implements the mapping; a slipped landing is always `slip`.

### 6.9 Stuck-state watchdogs (B14)

- Mover: `maxWallHoldMs` 20 s; plan-cancel backoff (§6.8).
- Stays: 30 min hard cap including naps; leave retry backoff and the emergency path (§2.3).
- Reactions: avoidance with < 2 bw of free space sits grumpy, no movement.
- Sim **progress monitor**: the same activity with goal `moving` and less than 0.25 bw of progress for 10 s → a calm reset (idle), recorded as a decision with cause `watchdog` and counted as `stuckResets`.

## 7. Tabs

### 7.1 TabView reader (helper, protocol 2)

- **Gate.** `CheckTabWindow(h) → kind | reject` uses Win32 data only (visible, uncloaked, not iconic, not hung, top-level class, the **full image path** — `%WINDIR%\explorer.exe`, Terminal under `%ProgramFiles%\WindowsApps\Microsoft.WindowsTerminal_*` — required child class via `FindWindowEx`) with `TAB_STRIP_APPS`, **before** `FromHandle`.
- **Discovery.** island → input site → `Microsoft.UI.Xaml.Controls.TabView` → `ListView`: children-scoped `FindFirst` on ClassName; validation (TabView top within 16 DIP of the frame top, horizontal list, TabItem children); fallback bounded BFS (depth 4, 200 nodes, 56 DIP band) reading `FrameworkId` first, XAML nodes only.
- **Response.** `kind: 'tabview'`; `newTab` from ControlType and position; `grab` from the drag child HWND via `GetWindowRect`; `captions` from the Win32 TitleBar.
- **Events.** `ElementSelected` and `StructureChanged` subscribed **on the tab ListView only** (never Subtree on TabView, which can include tab content), coalesced per 250 ms. REAL check: ≤ 2 events/s while `ping -t` prints in an own Terminal tab.
- **Never read**: `Name`, `AutomationId`, `LegacyIAccessible*`, Value and Text patterns, `HelpText`, `FullDescription`, `ItemStatus`, web content. Acceptance greps the helper for `NameProperty|\.Current\.Name\b|AutomationIdProperty|LegacyIAccessible|ValuePattern|TextPattern|HelpText|FullDescription|ItemStatus` and finds nothing.
- **Versions.** `UIA_PROTOCOL_VERSION` → 2 on both ends in one change; protocol-1 strips parse unchanged (`kind` absent = chromium).

### 7.2 Main side

`TAB_STRIP_APPS` / `tabStripRuleFor` replace `TAB_STRIP_BROWSERS` and the `category === 'browser'` test; rejection code `unsupportedApp`; per-app opt-outs `explorerTabs`, `terminalTabs`; `UIA_NEVER_QUERY` (firefox, code, notepad) checked before any request. Main **drops a strip whose `stripKind` differs from `tabStripRuleFor(processName).kind`**. Diagnostics carry strips by reader kind (`tabStrips.byKind`, contract C2).

**Explorer is the shell's own process** (taskbar, desktop), so its rule gets extra protection: at most 1 Explorer request per second and 3 Explorer windows, its own timeout (≥ 2 s), last in each polling cycle (it cannot starve Edge). **Kill switch**: if `TaskbarCreated` (hooked at `app.ts`) fires within 10 min of any Explorer request, the Explorer rule is off for the session (warning logged); a second such event turns it off until the next app version (a counter in `uia-health.json` in userData, PRV-owned). **Soak gate**: the Explorer rule ships `enabled: false` unless a REAL soak in wave 3 passes (≥ 2 h on this machine with the cat on Explorer strips, no `TaskbarCreated`, ≤ 1 helper timeout per hour). Terminal is enabled together with the protocol-2 helper. Notepad stays off until a REAL probe on a profile without a saved Notepad session.

### 7.3 T6 fix (two layers)

1. **Provider.** A strip read failure keeps the last good strip geometry, shifted with the window and **clamped to the current frame minus the caption buttons**, for up to 10 s (confidence 0.5 → 0.3); it is dropped at once on a width change > 4 px or on maximize. Then it falls back to the top as now.
2. **Mover.** `MoveGoal.surfaceId` pins a goal to its strip: clamped into the strip's current [x0, x1] at every replan, never re-mapped to the floor.

### 7.4 Strip activities and the rule against clicking

Walk along, watch the active tab, react to `tabs.changed` (§2.2, §1.8). The app never clicks or invokes anything: no input injection exists, and UIA is read for geometry only. Hunts are off with the cursor in the strip container or the caption band (§4.3).

## 8. Animation

### 8.1 Clips

All 14 new clips are procedural, same rig, every skin, legible as pixel-style silhouettes (hiss and swat read through the arched back, puffed tail and raised paw). The contract registers them with placeholder poses (`CLIP_BASE`).

| Clip | Kind | Pose notes | Placeholder |
|---|---|---|---|
| stalk | gait | belly 30 % lower, head level and forward, rolling shoulder blades, slow high steps, tail low with a twitching tip | walk |
| sprint | gait | longer extension than run, ears back, tail straight out | run |
| pounce | air | forelegs reaching forward and down, hind legs trailing, ears forward; follows vy | jump |
| slip | one-shot 0.9 s | front paws hooked on the ledge, body hanging, hind legs paddling, then the pull-up | fall |
| impact | one-shot 0.45 s | deep squash, legs splayed, head dips; depth ∝ `impact` | land |
| landRecover | one-shot 0.9 s | head shake, looks left and right, sits up | sit |
| swat | one-shot 0.45 s | weight back, one forepaw strikes toward `look` and returns | pawAt |
| hiss | one-shot 1.2 s | arched back, puffed tail, ears flat, mouth open, side-on | startle |
| grumpy | loop | low sit, ears sideways, narrowed eyes, slow tail thumps | annoyed |
| slink | gait | low, ears back, tail low | walk |
| stretch | one-shot 1.6 s | front then back stretch, standing | wake |
| balance | loop | crouched, tail out as a counterweight, sway ∝ `balance` | stand |
| tailChase | loop | turning on the spot, the tail leads | rollOver |
| edgeSit | loop | sits at the ledge end, paws at the edge, head down toward `look` | sit |

`jump`/`fall` read `jumpKind` (up, across, down, wallJump poses); without a hint the v1.1 poses play. Full-rate and tail-authored lists as before; the crouch wiggle starts at 0 s.

**Published constants** (contract C2): `GAIT_LIMIT_DIP` (§6.7) and `HIT_FRONT_EXTENT_DIP` (crouch 40, pounce 46, land 42, pawAt 50, swat 54 DIP at size 1; UNVERIFIED upper bounds until REN's test): REN's tests assert the real rig's hit region never reaches further ahead of the anchor than these, in both styles and facings, and that each gait animates cleanly up to its limit.

### 8.2 Headroom

| Margin | v1.1.1 | v1.2 |
|---|---|---|
| `BODY_MARGIN_TOP_DIP` | 36 | 60 |
| `BODY_MARGIN_SIDE_DIP` | 32 | 44 |
| `BODY_MARGIN_BOTTOM_DIP` | 40 | 48 |
| `EMOTE_MARGIN_TOP_DIP` | 64 | 84 |

`presence.test.ts` asserts ≥ 6 DIP of headroom for every clip in both styles and facings, with and without emotes; the emote is clamped inside its overlay. Pair tests grow from 462 to 1260; over +15 s they move to a sampled, seeded subset.

## 9. Settings v3

### 9.1 Fields (v2 keys and defaults unchanged)

| Key | Type / range | Default | UI |
|---|---|---|---|
| `behavior.activityPreset` | 'calm' \| 'playful' \| 'mischievous' \| 'custom' | 'playful' | group **Personality**: three cards; "Custom (closest: Playful)" via `closestPreset` (contract C2) |
| `behavior.autonomy` (v2) | 0..1 | 0.6 | up front: **Activity** ("0: mostly rests and watches") |
| `behavior.cursorPlay` (v2) | 0..1 | 0.5 | up front: **Cursor hunting** ("0: it only watches the pointer") |
| `behavior.workDisruption` | 0..1 | 0.25 | up front: **Play near my work** ("never while you type or click") |
| `behavior.exploration` | 0..1 | 0.6 | Fine-tune: **Exploring** |
| `behavior.heights` | 0..1 | 0.55 | Fine-tune: **Heights and climbing** |
| `behavior.mischief` | 0..1 | 0.4 | Fine-tune: **Mischief** ("0: never cheeky") |
| `behavior.stayLength` | 0..1 | 0.5 | Fine-tune: **Stays on windows and tabs** |
| `interaction.reactionIntensity` | 0..1 | 0.5 | Fine-tune: **Reactions to rough handling** |
| `behavior.disabledExtras` | tolerant slug list | [] | Fine-tune toggles for `LIVELY_BEHAVIORS` |
| `sound.enabled` / `sound.volume` | bool / 0..1 | false / 0.4 | toggle plus slider |

Every slider's help text says what 0 does.

### 9.2 Presets (`settingsPresets.ts`, zod-free)

| Key | Calm | **Playful** (default = v2 defaults) | Mischievous |
|---|---|---|---|
| autonomy | 0.35 | 0.6 | 0.8 |
| cursorPlay | 0.25 | 0.5 | 0.75 |
| exploration | 0.35 | 0.6 | 0.8 |
| heights | 0.3 | 0.55 | 0.75 |
| mischief | 0.1 | 0.4 | 0.75 |
| workDisruption | 0.05 | 0.25 | 0.45 |
| stayLength | 0.65 | 0.5 | 0.4 |
| reactionIntensity | 0.35 | 0.5 | 0.7 |

A preset never touches consent or privacy (`perception`, `ai`, `loginItem`), the opt-out lists, sound, appearance, movementSpeed, sleepAfterIdleMinutes, attentionSeeking or activitySensitivity. The renderer sends `presetPatch(id)` as one multi-section patch through the existing channel (no new IPC action); a governed slider change sends that key plus `activityPreset: 'custom'`; main re-runs `matchingPreset` after every patch.

### 9.3 Migration and downgrade

Migration v2 → v3 (final in logic): every v2 key keeps its value (the user's autonomy 0.8, cursorPlay 0.7, attentionSeeking 0.5, activitySensitivity 0.95, sleepAfterIdle 30, chaseDurationSec 5); new keys take their defaults and are never inferred; `activityPreset` is the matching preset or 'custom' (the user: custom, closest Playful); `disabledBehaviors` untouched and never given a new id; `perception`, `ai`, `loginItem` not read or written; pinned literals byte-identical; pure and idempotent (it runs every launch until the first save).

**Downgrade to 1.1.1** — REAL against a frozen copy of its schema (`tests/fixtures/v1.1.1/settings.ts`, contract C2 test): 1.1.1 parses a v3 file without error, `schemaVersion` becomes 2, unknown keys are dropped, `disabledBehaviors` and every v2 value survive. Its first save **does** drop `disabledExtras`, so a later re-upgrade would re-enable the v1.2 opt-outs. Fix (SET): `disabledExtras` is mirrored into a sidecar `behavior-opt-outs.json` in userData that 1.1.1 never touches; on load the effective list is the union of settings and sidecar (tolerant, bounded like the list); an id leaves the sidecar only through an explicit re-enable in v1.2+. Release notes say v3-only slider values are lost on a downgrade.

### 9.4 Opt-out lists and sub-act gates

`LIVELY_BEHAVIORS` live in the tolerant `behavior.disabledExtras` (malformed entries and duplicates dropped, unknown well-formed ids kept and ignored). `disabledBehaviorSet` adds the implied opt-outs (chaseCursor → pounce; climbWindows → screenEdges; perchOnWindows → surfaceHops; tabStrips → explorerTabs, terminalTabs, tabReactions).

**Sub-act gates** (`src/shared/behaviorGates.ts`, contract C2): every new act the behaviour package generates is checked with `subBehaviorAllowed(act, disabledSet)`, so no v2 switch is re-enabled under a new name:

| v2 / v1.2 switch | Removes these v1.2 acts |
|---|---|
| chaseCursor | huntStalk, huntPounce, huntJumpSwat, huntBat, ambush, reactionPounce |
| pawAtCursor | huntBat, huntJumpSwat, mischiefSwat, overstimSwat, defensiveSwat (the hunt ends with a look; defensive is a hiss only) |
| taskbarPlay | taskbarTarget: every planned move onto a taskbar (hop, wall jump, leave); only an emergency bail-out may still land there |
| zoomies | zoomies, reactionZoomie |
| grooming | groom: every groom (idle, displacement after losing interest or a surprise, on a stay) |
| inspectWindows | inspectWindow (looking at, approaching, the restored-window look), edgeSit — the trip up (`tripUp`) stays with perchOnWindows, as in v1.1.1 |
| perchOnWindows | tripUp, surfaceHop, edgeSit |
| climbWindows | screenEdgeClimb, screenEdgeWallJump, windowWallJump |
| tabStrips | watchTab, tabReaction |
| pounce, hissing, tailChase, slips, screenEdges, surfaceHops, tabReactions | their acts (table in `behaviorGates.ts`) |

A property test (BEH) runs 10⁴ decisions and reactions per switch and finds no clip, phase or variant from its gated set.

## 10. Sound (lowest priority; may be descoped without touching the contract)

- Procedural WebAudio in the overlay renderer (`sound.ts`), no assets, microphone or network; cues meow, chirp, trill, purr (only while petted, ≤ 8 s), hiss, growl, thud.
- Off by default; at most one cue per 1.5 s; none while fullscreen, quiet, paused, hidden or asleep (purr excepted).
- **Played once**: main sends each cue (by `sound.at`) once, globally, to the overlay holding the anchor at first emission (PRV implements the dedupe in `overlayManager.ts`); the renderer also plays once per `at` and drops cues older than 500 ms against the snapshot `t`.
- **AudioContext** created on the first cue after enabling and **closed** after 10 s idle (a suspended context can hold a Windows audio power request). E2E: `powercfg /requests` shows no audio request 15 s after the last cue. Measured probe cost: 0.046 % running, 0.013 % suspended (REAL, diagnosis §6). Quality UNVERIFIED.

## 11. Diagnostics and logs

- **Profile.** `CatSim.behaviorProfile()`: session-only snapshot of kinds, counts and durations: time by `activityClassOf` class and the active share; decisions; stays (arrivals, dwell quantiles, end reasons, leave kinds, bail-outs, resumes); hunts and pounces; falls by cause and impact; slips; reactions; screen-edge visits and peeks; naps; stuck resets; mood exposure (time with w > 0.3, i > 0.5, fear > 0.3); content-free context durations (typing, maximized window in front, cursor in reach).
- **Settings and export.** Settings → Diagnostics → **Behaviour**; the export gains a `behaviorProfile` section (seam in contract C2, `DiagnosticsInput.behaviorProfile`), validated against a strict `BehaviorProfileSchema` (SET).
- **Log lines** (`behaviorLog.ts`, seam in contract C2, called from the 10 s timer): `stay ended {kind, dwellS, plannedS, reason, leave, arrivedBy, bailOut}` at most one per 20 s and 60 per hour (suppressed lines counted into the next); `behavior summary` every 10 min on change (active share, arrivals/h, hunts, falls by cause, stuck resets). **Neither carries typing time or any window, surface or app id** (SET unit test).
- **Hooks.** `SimHooks.onDecision / onExcursion / onFall / onReaction / onHunt / onSlip / onEdgeVisit` deliver the records; the harness reads hooks only.

## 12. Performance budget (awake, one core)

| Item | Budget | Basis |
|---|---|---|
| v1.1.1 total | 1.05 % | REAL bench (TEST_REPORT v1.1.1) |
| Drives (1 Hz), salience and hunt (4 Hz) | ≤ 0.02 % | O(1) |
| Full scoring (~4/min, ≤ 48 candidates) | ≤ 0.03 % | — |
| Screen-edge walls, wallJump edges | ≤ 0.05 % | incremental graph updates |
| Click-obstacle source (enumerated only on WinEvent invalidation, only near a band) | ≤ 0.05 % | — |
| TabView reads (0.31–0.41 ms, ≤ 1/s per app, ≤ 3 windows) | ≤ 0.1 % | REAL probe |
| Renderer, new clips | ≤ 0.1 % | — |
| Sound (closed unless playing) | ≤ 0.05 % | REAL probe |
| **Total** | **≤ 1.5 %** (B12), no regression > 0.3 pp | — |

## 13. Privacy and security deltas

The lead writes the PRIVACY.md and THREAT_MODEL.md text after PRV and BEH merge (it depends on Q1 and Q2):

- **Tab strips**: Edge, Chrome, and from v1.2 Windows Terminal (and File Explorer once its soak passes). Geometry only; the never-read list of §7.1; Notepad, VS Code / Electron apps and Firefox are never queried, checked before any accessibility call; Explorer and Terminal can be switched off individually.
- **Mouse buttons** (Q2): if accepted, `GetAsyncKeyState` for the left, right and middle buttons only: clicks are not counted as typing, and the content-free press counter (`pointerButtonPresses`) ends hunts. No keyboard hook, no key, character or text. If declined: left button only.
- **Click-guard obstacles**: rects of all visible top-level windows (privacy-excluded ones included) are used **only inside main** to keep the overlay click-through; never passed to the sim, logged or exported.
- **Behaviour profile**: counts and durations (including typing and maximized-window time) in memory, Settings and the export; **not** in log lines. Never which windows or apps.
- **Sound** row (off by default, synthesized, no recordings).
- **THREAT_MODEL**: T8 gains the fail-closed screen-edge and bail-out click guard, the hover dwell and the hit-region pounce/strike clearance; T11 the mouse buttons; T15 the Win32-only full-path gate, the TabView path, `UIA_NEVER_QUERY`, the Explorer rate limit, kill switch and soak gate; T2 the profile reply schema and multi-section preset patches; T3 the tolerant list and the sidecar (bounded slugs); T10 sound rate limit and context close.

## 14. Target bands as test assertions

Measured with `tests/profile/behaviorProfile.ts` from hook records only. Profiles: P1 (the user's settings and cat), P2 (defaults); Calm and Mischievous presets informational (active share Calm < P2 < Mischievous, Calm ≥ 10 %). Layouts: L1 floating browser with a strip, L2 floating editor, L3 alternating a maximized window, L4 nothing reachable but screen edges, **L4b** a maximized window in front most of the time (the user's commonest state), L5 two floating windows a hop apart (B4). Users:

- **U-active**: moving the cursor, not typing, handling at the REAL rate.
- **U-typing**: typing 60 % of the time (run with `reactToTyping` on and off).
- **U-play**: the cursor lingers within 6 bw of the cat, erratic, no clicks, 20 % of the time.
- **U-mouse-work**: a button press every 2–10 s, the cursor commuting, taskbar reveals at the bottom every 1–3 min.

8 seeds × 3 sim-h per cell (2 seeds in calibration loops). A short subset runs in `verify fast` as `tests/integration/behavior/bands-short.test.ts` (L1/P2, 2 seeds × 1.75 sim-h, binomially widened, wall-time budget ≤ 20 s with a vitest timeout; over budget it moves to the profile tier).

| # | Band (assert) | Metric | Cells |
|---|---|---|---|
| B1 | active share 20–35 % of awake time | `timeMs.active / awake` (`activityClassOf`) | P1, P2 × L1–L3 × U-active |
| B1b | active share ≤ the same seed's L1 value; 1–4 edge peeks/h | profile, `onEdgeVisit` | L4b |
| B1c | active share ≤ 35 % of awake time with nothing to climb | `timeMs.active / awake` | P1, P2 × L4, L4b × U-active |
| B2 | elevated arrivals 4–15 /h; ≤ 12 window climbs/h (edges excluded) | `onExcursion` arrive | L1, L2 |
| B3 | stays (Kaplan–Meier, imposed ends right-censored): median 90–300 s, p10 ≥ 20 s, P(> 5 min) ≥ 8 %, P(> 15 min) monitored; plannedMs draws: median 120–200 s, p10 ≥ 30 s, ≥ 12 % > 5 min, p90 ≤ 12 min; the experienced (uncensored) median is reported | `onExcursion` end | L1, L2 |
| B4 | departures varied on two windows: no leave kind > 70 % of own departures, ≥ 3 kinds; ≥ 2 kinds on one window | `leaveKind` | L5; L1, L2 |
| B5 | hunts 4–12 /h; pounces ≥ 1 /h; never two pounces < 90 s apart | `onHunt` | U-play |
| B5d | ordinary use: on average over the layouts hunts ≥ 2 /h and pounces ≥ 1 /h; never two pounces < 90 s apart | `onHunt` | P1, P2 × L1, L2, L3, L4b × U-active |
| B5b | hunts ≤ 1 /h; 0 pounces within 2 s of a press or within 1 bw of a press point | `onHunt` vs the harness's presses | U-mouse-work |
| B5c | every pounce and strike: `minClearanceDip` ≥ 8 | `onHunt` | all hunting cells |
| B6 | 0 hunts, pounces, swats or play near the cursor started while typing or < 3 s after (also with `reactToTyping` off); excursions 0.2–0.9 × the U-active rate | `onHunt`, `onDecision` | U-typing |
| B7 | ≥ 4 kinds over 100 throws, no kind > 50 %, hide ≤ 25 %, on the **uncapped** softmax at the REAL throw spacing; caps active in < 10 % of draws; every opt-out combination keeps ≥ 3 kinds or logs | `onReaction` | P1, P2, Monte Carlo 100 × 8 |
| B8 | after 5 hard throws (bond ≥ 0.3): fear < 0.05, i < pre + 0.1, w < 0.05 within 10 min; within 8 min with petting at the REAL rate | drives | P1, P2, bond 0.3 |
| B8b | w > 0.3 ≤ 15 % and i > 0.5 ≤ 10 % of awake time | `moodMs` | U-active |
| B9 | physics-error falls = 0 | `onFall` ∈ `PHYSICS_ERROR_CAUSES` | every cell + covered-strip churn + window-drag churn |
| B10 | deliberate slips 0.3–3 per awake hour (reinterpreted denominator, Q10) | `onSlip` | L1, L2 |
| B11 | screen-edge visits 2–8 /h when nothing else is reachable (on); 0 when off; 0 without `env.edgeBands` | `onEdgeVisit` | L4 on, off, no bands |
| B12 | CPU awake ≤ 1.5 % of a core, regression ≤ 0.3 pp | REAL bench (§15.4) | REAL |
| B13 | covered strip and maximize/minimize of the support window: 0 free falls; every covered/gone end has `bailOut` | `onExcursion`, `onFall` | L3 fast churn |
| B14 | `stuckResets` = 0 | profile | every cell incl. churn |
| B15 | asleep 8–20 % of present time; 0.8–2.5 autonomous naps/h | `timeMs.asleep`, `sleeps` | P1, P2 × L1–L3 × U-active |

"Never in the way" ceilings stay: no locomotion under a pressed cursor, no hunts or play near the cursor while typing, ≤ 12 window climbs per hour. The v1.1.1 passive-mix assertions (`behavior-mix.test.ts:41–45, 131–135`, `sim-liveness.test.ts:31–40`, `decide-urge.test.ts`) are rewritten as these bands by BEH.

**Lead decisions on the bands (2026-11-04; numbers SIMULATED, 8 seeds × 3 sim-h, `docs/research/v1.2/profile-v12.json`):**

- **B6's upper bound is 0.9, not 0.6.** Measured 0.75–0.83 (0.65–0.89 before the raw typing weight went from 0.25 to 0.2). Trips between typing bursts are not disruptive; what would be stays at 0: hunts, pounces, swats and play near the cursor while typing.
- **B3's P(> 15 min) is monitored, not a gate.** Kaplan–Meier holds S flat after its last event, and under the REAL handling rate most stays end by the user's hand, so the tail says little (0–0.10 on L1 and L2, 0.02–0.14 in the previous run). Median, p10 and P(> 5 min) stay gates: 149–198 s, 53–66 s, 0.17–0.32.
- **B4 is measured on a two-window layout.** A single tall window structurally offers two ways down (§6.3), which is what L1 and L2 still show (2 kinds, at least 2 asserted). L5, two windows a hop apart: 4 kinds, the commonest 36–38 %.

**Added for ordinary use (BEH-c):** B5d, after U-active measured 0 hunts/h: 2.50 hunts/h and 1.41 pounces/h on P2, 2.65 and 1.30 on P1 (L1 1.5–1.9 hunts/h, L4b 3.3–3.7; about 700 presses/h), with U-play 6.4–6.7 hunts/h, U-mouse-work 0.92–0.96 hunts/h and no pounce near a press. B1c, after the empty desktop measured 53 % (P1) and 39 % (P2): now 32.6 % and 25.6 %, L4b 22.8 % and 17.9 %; edge visits 3.5–4.1/h on L4, peeks 1.7–1.8/h on L4b.

**Still outside its band: B15's asleep share**, 5.5–7.9 % of present time against 8–20 % (0.8–2.5 naps/h holds at 1.7–2.4). Not a matter of dwell: at the REAL handling rate 70–80 % of naps are ended by the user's hand or a stimulus (P2/L1: 23 of 63 picked up, 20 woken by a touch, 6 by a stimulus, 14 ran out; median 87 s against a dwell of 288–960 s), so at the band's top nap rate the share stays near 8 %. Getting there would take letting the cat sleep through touches. Left to the lead.

## 15. Test plan

### 15.1 Unit (per package; `verify fast`)

- **Drives**: each rule, petting leaves playNeed unchanged, gentle petting soothes, bounds under fuzz; same seed at 33 ms and 66 ms host ticks gives hunt-start counts within ±1 (accumulators).
- **Scorer**: no top-k, variant-keyed repetition, rhythm shares, no-baseline drive-gated candidates.
- **Stay**: `plannedMs` quantiles over 10⁴ draws; leave variety; leave failure backoff and the emergency path; 30 min cap; defer while petted.
- **Hunt**: phases, the still-cursor crouch, every gate (typingRaw with `reactToTyping` off, presses, petting zone, taskbar, strip and caption bands), budget from `chaseDurationSec`, `pawAtCursor` off, cooldowns, clearance (10⁴ random cursor and cat placements: `decideInteractive` on the predicted landing and strike regions with the cursor at the target is false).
- **Reactions**: logits, ℓ, water-filling with every opt-out combination, rough-drag trigger, recovery times, the slink rule (at w = 0.9 a scripted approach-and-press reaches the hit region within 2 s in 100/100 seeds), rough memory survives 60 hunts and stays.
- **Sub-act gates**: the property test of §9.4.
- **Mover**: screen-edge walls across layouts (negative origins, a diagonal corner touch, 100/150 % mixed, `allowMultiMonitor` off, hot-unplug while clinging), hold cap, wallJump, H_safe never hard at the defaults, impact classes, pounce geometry with `frontExtentPx`, slips, narrow ledges, bail-out order (single hop only), stale-plan cancel and backoff, no snap > 0.5 bw, no non-emergency leg > `jumpDownMaxDip`, emergency only with no other option.
- **Provider, UIA, guard**: gate table, full-path checks, kind cross-check, protocol 2, TabView segment on the REAL rects, T6 retention clamp, edge bands, the click guard with own Settings rect, a PiP rect, a stale cache, a throwing source and a cat mid-leap, the hover dwell, the Explorer rate limit and kill switch, typing detector and press counter.
- **Settings**: migration, presets and `closestPreset`, tolerant list, sidecar union, the frozen-schema downgrade test, UI controls.
- **Renderer**: clips finite, one-shots hold, headroom, pair pops, `HIT_FRONT_EXTENT_DIP` and `GAIT_LIMIT_DIP` against the rig, sound dedupe and replay guard (fake AudioContext), context close.
- **Diagnostics**: profile reply schema, log-line rate limits, no typing time or ids in the lines.

### 15.2 Integration (vitest, SIMULATED)

The real sim, Mover, host and provider pipeline with synthetic users: the short band subset; covered-strip and maximize churn (B13); window-drag churn (B14); T6 read-failure alias; tab events; a scripted hunt; a 1000-throw Monte Carlo (B7).

### 15.3 Profile (opt-in, SIMULATED)

`node scripts/with-lock.mjs profile -- node scripts/behavior-profile.mjs --label v12 …`, `--compare` against the v1.1.1 baseline; writes `out/profile/v12.json` (copied out before any build). The full matrix (~400 sim-h) runs **detached** (`Start-Process -WindowStyle Hidden`), with per-cell checkpoints in `out/profile/` and stopped by whoever started it; calibration loops use 2-seed matrices. The usage model gains the REAL handling rate, presses, taskbar reveals and the four user profiles.

### 15.4 REAL E2E (Playwright, real app, under the lock, own windows only)

- **Own windows only**: every spec calls `restrictSurfacesToPids([own pids])` (test hook, C2) so the user's windows never join a run; cursor-dependent checks use `injectCursor` (never the real cursor).
- **Browser dwell**: own Edge window (temp profile), floating, time ×8; tab add/select/remove via the browser's own automation of its own window; the 3 px move / 4 px resize churn expressed in **sim time** (every 4 s real at ×8) or run at ×1. Asserts ≥ 5 own stays, median ≥ 90 s sim-equivalent, every `stay ended` line has a reason, ≥ 2 departure kinds, no `physics` falls.
- **Covered strip**: own maximized window over the strip → `bailedOut`, no free fall, end `covered`; `WindowFromPoint` with the injected cursor over the cat during the bail-out returns the window.
- **Screen edge**: own maximized WinForms window in front, nothing else reachable, setting on; with the injected cursor over the clinging cat, the overlay has `WS_EX_TRANSPARENT` and `WindowFromPoint` returns the **window**; over a clear desktop band (only if one exists in the real obstacle list, else that case is UNVERIFIED) the overlay after the 300 ms dwell; setting off → no climbs. (`forceInteractive` skips the guard and is not used here.)
- **TabView**: Terminal via `wt -w dcat-e2e-<rand>` with self-ending tabs; only HWNDs that appeared after launch are closed (window-list diff); Terminal process exit is **not** asserted (one process hosts all windows). Explorer via `opennewprocess` on an own temp folder, closed with `SC_CLOSE`, process exit best effort, never kill explorer.exe. Asserts strips with `kind: 'tabview'`, owner memory +≤ 2 MB, the cat walks on the strip, ≤ 2 UIA events/s under `ping -t`.
- **Never queried**: a VS Code window, if present, never reaches the helper (counts-only request log).
- **Sound** (if not descoped): `powercfg /requests` clean 15 s after the last cue.
- **Lifecycle**: `schemaVersion` 3; the upgrade test gains a v2 user-shaped case from the 1.1.x installer; if `scripts/upgrade-test.ps1` refuses (Desktop Cat installed for the user), that result is UNVERIFIED.
- **Bench (B12)**: `scripts/bench.mjs` on the production `out/` build, hooks used only for phase control, plus a new **lively** phase (injected cursor path, own Edge, Explorer and Terminal windows, the scorer and the guard exercised; no forced `command.play`). For the packaged build, a passive `Win32_Process` CPU sample, labelled as such. `smoke-packaged.mjs` and `qa-traversal-packaged.mjs` as before.
- **Explorer soak** (gate of §7.2), ≥ 2 h, REAL.

UNVERIFIED unless run here: multi-monitor, Windows 10, Notepad, a REAL occlusion drop at the user's desk, sound quality.

## 16. Work packages

### 16.1 Order and integration

```
C1+C2  CONTRACT (this branch; committed by the lead: SHA = ec690a5)
│
├─ Wave 1 (parallel) ───────────────────────────────────────────────────────────
│   MOV  movement               PRV  provider / UIA / native / main input / click guard
│   SET  settings / UI / diag   REN  renderer animation (+sound)
│   INT-a harness on hooks, band specs as it.todo, E2E scaffolding
│   BEH-a behaviour core on the stub Mover (first commit: no-behaviour-change split of sim.ts)
│
├─ Wave 2 ─ BEH-b behaviour on the real Mover: stays/leave, screen edges, slips, bail-out,
│           pounce, jump-down limits (needs MOV merged; screen edges also need PRV's guard merged)
│
└─ Wave 3 ─ INT-b calibration (profile bands), REAL E2E, bench, Explorer soak;
            the lead writes PRIVACY.md and THREAT_MODEL.md; fix-ups go to the owner
```

- **Contract commit.** Every package worktree is created from the single contract commit (C1+C2) the lead makes after `verify fast` passes on this exact tree; its SHA goes in the line above.
- **Integration (lead decision, Q7).** Packages run as parallel agents **in the same worktree** on their disjoint file sets (the model that worked for v1.1.1); nobody commits but the lead, who commits each wave with explicit paths after `verify fast` passes on the combined tree. No package worktrees, no cherry-picks, no merges; nothing goes to main.
- **Amendments.** Any change to `src/shared/**` outside SET's settings files, to `src/main/app.ts`, or to a seam signature is a contract amendment by the lead, announced to every package.
- **Rules.** MOV never edits `sim.ts` (BEH maps settings to `MoverConfig`). PRV's guard merges before BEH-b turns screen edges on. Six parallel packages queue on the verify lock; nobody runs E2E before wave 3.

### 16.2 Packages

#### MOV: movement

- **Owns**: `src/core/movement/**`, `tests/unit/core/movement/**`.
- **Provides** (signatures fixed by C1+C2):
  ```ts
  type Pace = 'stalk' | 'slow' | 'walk' | 'run' | 'chase' | 'sprint';
  interface MoveGoal { /* v1.1 */ surfaceId?: string }
  interface MoverConfig { /* v1.1 */ screenEdges?: boolean; jumpDownSafeDip?: number; jumpDownMaxDip?: number; narrowLedges?: boolean; bailOut?: boolean; wallJumps?: boolean }
  interface LandingInfo { /* v1.1 */ impact: LandingImpact; jumpKind: JumpKind | null; slipped: boolean; plannedSupportId: string | null; plannedOutcome: PlannedLandingOutcome | null }
  interface MoverStep { /* v1.1 */ slipped: SlipKind | null; bailedOut: boolean; planCancelled: boolean }
  interface ClimbOption { /* v1.1 */ wallKind?: 'windowSide' | 'screenEdge' }
  interface LeaveOption { kind: LeaveKind; target: {x: number; y: number}; toKind: 'floor' | SupportSurfaceKind; toSurfaceId: string | null; dropDip: number; impact: LandingImpact | null; effort: number; risk: number; startX: number; emergency: boolean }
  interface PounceOptions { crouchMs: number; shortPx: number; maxDistPx: number; frontExtentPx?: number }
  class Mover {
    get jumpKind(): JumpKind | null; get balance(): number; get nextLegRisk(): number;
    leaveOptions(): LeaveOption[];   // emergency option only when nothing else exists
    leaveBy(option: LeaveOption, pace: Pace): boolean;
    pounceAt(now: number, target: {x: number; y: number}, opts: PounceOptions): boolean;
    armSlip(kind: SlipKind): boolean;
    holdOnWall(untilMs: number | null): boolean;   // capped at MOVEMENT.maxWallHoldMs
    climbOptions(): ClimbOption[];   // + screen-edge climbs
  }
  ```
  Internally: `WallTrack.kind`, `GraphEdgeKind` `'wallJump'`, `WorldModel` screen-edge walls, pace clamps from `GAIT_LIMIT_DIP`, the plan-cancel backoff.
- **Consumes**: `src/shared/{cat,surfaces,sim,behaviorProfile}.ts`.
- **Acceptance**: every §6 bullet has a unit test; with every new flag off the v1.1.1 movement suites pass unchanged; no inner walls in the multi-monitor fixtures (§15.1 list); pounce landings honour `frontExtentPx + shortPx` and stay inside the walk range; no non-emergency leg > `jumpDownMaxDip`; emergency only with no other option; the default cat's planned descents land soft or medium; bail-out is a single hop or jump in every covered-strip fixture; `verify fast` passes.
- **Risks**: graph cost with wallJump edges (cap per kind); revalidation snaps; short displays.

#### BEH: behaviour (BEH-a in wave 1 on the stub Mover; BEH-b in wave 2)

- **Owns**: `src/core/behavior/**` (new `drives.ts`, `utility.ts`, `rhythm.ts`, `stay.ts`, `hunt.ts`, `reactions.ts`, `salience.ts`, `watchdog.ts`), `tests/unit/core/behavior/**`; may flip the `it.todo` / `it.skip` markers (only those) in `tests/integration/behavior/bands-*.test.ts` (declared shared file, INT owns the bodies).
- **Provides**: `CatSim.behaviorProfile()`; `SimOutput.{jumpKind, impact, balance, sound}`; every `SimHooks` record (incl. `onSlip`, `onEdgeVisit`, `HuntRecord.minClearanceDip`, `ReactionRecord.capped`); memory as §5.4; drives persisted with the load rules of §1.2; the `typingRaw` split; sub-act gating through `subBehaviorAllowed`; σ from the `bornAt` stream (BEH-b). Suggested internals:
  ```ts
  stepDrives(d: Drives, ctx: DriveContext, dtMs: number): void            // accumulator-driven
  scoreAll(v: DecisionView): Array<Scored<Candidate>>; pickWithVariety(r: Random, s: Array<Scored<Candidate>>, tau = 0.5): Candidate | null
  drawStayIntent(r: Random, ctx: StayContext): { plannedMs: number }
  chooseLeave(r: Random, opts: readonly LeaveOption[], ctx: LeaveContext, recent: readonly LeaveKind[]): LeaveOption | null
  throwReactionWeights(ctx: ReactionContext): { weights: Record<ThrowReactionKind, number>; capped: boolean }  // water-filled
  strikeClearancePx(pose: StrikePose, catAnchor: Point, facing: Facing, hotspot: Point, scale: number, size: number): number
  ```
- **Consumes**: the MOV API; `SimEnv.{pointerButtonDown, pointerButtonPresses, cursorIdleMs, edgeBands}`; settings v3, `disabledBehaviorSet`, `behaviorGates`; `HIT_FRONT_EXTENT_DIP`, `HIT_CLEARANCE_DIP`; the new clips.
- **Acceptance**: BEH-a — §15.1 behaviour units, B1, B6, B7, B8, B8b, B15 in the short subset or units; the gate property test; seeded ±1 tick-size test. BEH-b — B2–B4, B10, B11, B13, B14 (short subset), the slink and clearance tests; the v1.1.1 "never in the way" ceilings; all randomness through `this.random`; lint clean; `verify fast` passes.
- **Risks**: `sim.ts` size (split first, no behaviour change); calibration loops with INT; seeded fixtures (update in the same commit); the AI reaction allow-list must still map to existing behaviours only.

#### PRV: provider, UIA, native helper, main input, click guard

- **Owns**: `native/uia-helper/**`, `scripts/build-uia-helper.mjs`, `scripts/uia-probe.mjs`, `src/main/uia/**` (incl. new `health.ts` and `uia-health.json`), `src/main/surfaces/**` (new `edgeBands.ts`, `restrictToPids`), `src/main/win32/**` (new `clickObstaclesPx`, press counter, buttons), `src/main/catHost.ts` (`clickGuardRectsPx`, env fields), `src/main/overlay/overlayManager.ts` (hover dwell, global sound dedupe), `src/core/interaction/clickThrough.ts` (`wallGuardRects`, hover dwell in `decideInteractive`), `src/main/display/**`; tests `tests/unit/{uia,win32}/**`, `tests/unit/main/{surfaces*,overlayManager,overlay,catHost}.test.ts`, `tests/integration/{uia,surfaces}/**` (`pipeline.ts` included; INT uses its exports read-only until wave 3).
- **Provides**:
  ```ts
  computeEdgeBands(world: WorldGeometry, obstaclesTopDown: readonly Rect[], footprintPx: (displayId: string) => number): ScreenEdgeBand[]
  clickObstaclesPx(): { rects: readonly Rect[]; fresh: boolean }          // win32, WinEvent-invalidated cache
  wallGuardRects(catBoundsPx: Rect, obstacles: readonly Rect[]): Rect[]  // pure, clickThrough.ts
  CatHost.clickGuardRectsPx(): readonly Rect[]                           // fail-closed, contract seam
  SurfaceProvider.restrictToPids(pids: readonly number[] | null): void   // test mode
  ```
  Also: `SimEnv.{pointerButtonDown, pointerButtonPresses, cursorIdleMs, edgeBands}` filled in `catHost.ts`; the typing detector; the TabView rules and protocol 2 on both ends (Terminal on, Explorer behind the soak gate); the Explorer limits and kill switch; the T6 retention; `tabStrips.byKind` and `screenEdges` diagnostics; the sound dedupe as REN specifies it.
- **Acceptance**: the guard unit tests of §15.1 (own Settings rect, PiP, stale cache, throwing source, mid-leap, hover dwell); gate, full-path and kind cross-check tests; TabView validation and retention tests; the REAL TabView probe through the shipped helper (Terminal; Explorer within the rate limit; owner memory ≤ +2 MB; the never-read grep empty); the typing detector with buttons; `verify fast` passes.
- **Risks**: Explorer UI-thread hangs (limits, kill switch); `FindWindowEx` races on Terminal launch; WinEvent cache staleness (fail closed); privacy regressions (geometry-only checks in `tests/integration/uia/probe.ts`).

#### SET: settings, UI, diagnostics

- **Owns**: `src/shared/settings.ts`, `src/shared/settingsPresets.ts`, new `src/shared/behaviorProfileSchema.ts`, `src/renderer/settings/**`, `src/preload/settings.ts`, `src/shared/ipc.ts` (the diagnostics reply field), `src/main/ipc/**`, `src/main/diagnostics/**` (`behaviorLog.ts` body, the export section; `surfaceDiagnostics.ts` pass-through is already in C2), `src/main/store/**` (the opt-out sidecar), `docs/settings.example.json`, `docs/USER_GUIDE.md`; tests `tests/unit/shared/settings*.test.ts`, `tests/unit/renderer/settings/**`, `tests/unit/main/{diagnostics*,exportDiagnostics,ipc*,settingsStore}.test.ts`.
- **Provides**: `createBehaviorLog(log, opts)` (seam signature fixed in C2), `BehaviorProfileSchema` (strict, bounded), the Behaviour diagnostics page, the export section, the Personality group, sliders with help texts, Fine-tune, "Custom (closest: …)", sound controls, `matchingPreset` reconciliation, the sidecar.
- **Acceptance**: migration, preset and sidecar tests (C1/C2 contract tests stay green); every new field has a control; the reply schema rejects extras; log-line rate limits and the no-typing/no-id assertion; `verify fast` passes.
- **Risks**: the renderer store's one-value path (multi-key patch, zod-free); the pinned literals; page density.

#### REN: renderer animation (+sound)

- **Owns**: `src/renderer/overlay/**`, `src/main/overlay/renderMapping.ts`, `scripts/render-preview.cjs`, `scripts/preview-page/**`, `src/preload/overlay.ts` if needed; `tests/unit/renderer/**` except settings.
- **Provides**: the authored clips (each `CLIP_BASE` entry removed as drawn), `jumpKind`/`impact`/`balance` handling, the §8.2 margins, the emote clamp, the wiggle from 0 s, gaits meeting `GAIT_LIMIT_DIP`, hit regions within `HIT_FRONT_EXTENT_DIP`, and
  ```ts
  createSoundPlayer(ctx: { now: () => number; audio?: () => AudioContextLike }): { play(cue: CatSoundCue, snapshotT: number): void; close(): void; dispose(): void }
  ```
- **Acceptance**: all renderer suites over all clips; headroom ≥ 6 DIP; the gait and hit-extent tests; preview PNGs of every new clip in both styles at 125 % (visual REAL only once looked at); sound dedupe, replay and close tests; `verify fast` passes.
- **Risks**: pair-test runtime; pixel-style legibility; wider overlays near seams.

#### INT: integration, E2E, profile

- **Owns**: `tests/integration/behavior/**` (new; the band specs, written as `it.todo` in INT-a), `tests/e2e/**`, `tests/profile/**`, `scripts/behavior-profile.mjs`, `scripts/qa-*.mjs`, `scripts/bench.mjs`, `scripts/upgrade-test.ps1`, `src/main/testHooks.ts` (seams in C2; never in packaged builds — the gate in `index.ts` is pinned), `playwright.config.*`, `docs/TEST_REPORT.md`; from wave 3 also `tests/integration/surfaces/pipeline.ts`.
- **Provides**: the harness on hooks with the four user profiles and L4b; the §14 bands (full in the profile, short in integration); the §15.4 E2E; the bench gate with the lively phase; the Explorer soak; the TEST_REPORT section with labels.
- **Acceptance**: every §14 band asserted (failures go to the owner with the profile JSON); the E2E specs pass on this machine; nothing UNVERIFIED labelled REAL.
- **Risks**: harness validity; the shared machine (everything under `with-lock`, long runs detached); own windows only.

## 17. Contract steps (implemented in this branch)

**C1** (first revision) — behaviour unchanged: every new Mover flag off, stubs return the v1.1.1 result, no new clip selected, TabView rules disabled, sound off.

| File | Contract |
|---|---|
| `src/shared/cat.ts` | 14 new `ANIM_CLIPS`, 6 one-shots; `JumpKind`, `LandingImpact`, `SoundCue`, `CatSoundCue`; `CatRenderState.{jumpKind, impact, balance, sound}` |
| `src/shared/sim.ts` | `SimEnv.{pointerButtonDown, cursorIdleMs, edgeBands}`; `SimSupport.surfaceKind`; `SimOutput` hints; `CatSim.behaviorProfile()` |
| `src/shared/surfaces.ts` | `SCREEN_EDGE_KIND`, `SupportSurfaceKind`, `ScreenEdgeBand`, `MAX_EDGE_SPANS` |
| `src/shared/behaviorProfile.ts` (new) | vocabularies, records, snapshot, `quantiles`, log limits |
| `src/shared/catState.ts` | trait `startleSensitivity`, `drives`, 7 counters, `prefs.roughRatePerHour` (no schema bump) |
| `src/shared/settings.ts`, `settingsPresets.ts` (new) | schema v3, §9.1 fields, `LIVELY_BEHAVIORS`, tolerant `disabledExtras`, implied opt-outs, presets, migration |
| `src/shared/surfaceDiagnostics{,Schema}.ts`, `src/main/diagnostics/surfaceDiagnostics.ts` | 'screenEdge' supports |
| `src/core/movement/*` | the MOV interface as stubs; `impactClass`/`impactLevel`; constants |
| `src/core/behavior/{sim,profile,memory,personality,summary}.ts` | hooks, the recorder wired in, memory kinds, σ derived, drives |
| renderer `clips.ts`, `validate.ts`; main `renderMapping.ts`, `overlayManager.ts`; `uia/protocol.ts`, `uia/allowList.ts` (new); settings UI strings and fields | placeholders, hint validation and mapping, sound routing, protocol 2 types, allow-list |
| tests | fixtures, e2e `schemaVersion` 3, `upgrade-test.ps1` v3, `settings.example.json`, `contractV12.test.ts` (shared and renderer) |

**C2** (this revision, from the reviews) — still no behaviour change; the measurement fixes only change what the recorder writes:

| File | Change |
|---|---|
| `src/shared/behaviorProfile.ts` | `activityClassOf` + `VARIANT_ACTIVITY_CLASS`; `DecisionRecord.activityClass`, cause `watchdog`; `ExcursionRecord.{bailOut, resumed}`; `ReactionRecord.{trigger, capped, onLedge}`; `HuntRecord.{startedAt, pounceTimes, minClearanceDip, gate}`; new `SlipRecord`, `EdgeVisitRecord`, `HUNT_GATES`, `MOOD_EXPOSURES` and thresholds, `BailOutKind`; snapshot `screenEdgePeeks`, `sleeps`, `stuckResets`, `moodMs` |
| `src/core/behavior/profile.ts` | pure `fallCauseOf` (slip, missed and vanished planned landings) and `arrivalRouteOf`; recorder: variant-aware time, naps, mood exposure, stuck resets, slips by record, edge visits |
| `src/core/behavior/sim.ts` | uses them; `lastFlightReason` survives `enterLanding` (arrival routes were 'other'); `SimHooks.onSlip`, `onEdgeVisit`; decisions carry `activityClass`; lint exemptions for the two injection defaults |
| `src/core/movement/mover.ts`, `constants.ts`, `index.ts` | `LandingInfo.{plannedSupportId, plannedOutcome}` (real), `PlannedLandingOutcome`; `LeaveOption.emergency`; `PounceOptions.frontExtentPx` (honoured by the stub); `MOVEMENT.{emergencyHangBodyHeights, jumpDownSafeHardFraction, maxWallHoldMs, planCancelBackoffCount, planCancelBackoffWindowMs}` |
| `src/shared/cat.ts` | `GAIT_LIMIT_DIP`, `HIT_FRONT_EXTENT_DIP`, `HIT_CLEARANCE_DIP` |
| `src/shared/sim.ts` | `SimEnv.pointerButtonPresses`; `edgeBands` absent = no edge climbs |
| `src/shared/behaviorGates.ts` (new) | `SUB_BEHAVIORS`, `SUB_BEHAVIOR_GATES`, `subBehaviorAllowed` |
| `src/shared/settingsPresets.ts` | `closestPreset` |
| `src/shared/surfaceDiagnostics{,Schema}.ts`, `src/main/diagnostics/surfaceDiagnostics.ts` | optional `tabStrips.byKind`, `screenEdges {bands, clearSpans, coveredSpans, guard, failClosed}` (strict) |
| `src/main/catHost.ts` | `clickGuardRectsPx()` (stub []), `setInjectedCursor()` (test seam, real) |
| `src/main/app.ts` | click guard = taskbars ∪ host guard; `behaviorLog.onProfile` in the 10 s timer; report `behaviorProfile` input; test hooks wired |
| `src/main/testHooks.ts` | `getBehaviorProfile`, `injectCursor`, `restrictSurfacesToPids` (validated) |
| `src/main/surfaces/provider.ts` | optional `restrictToPids` (the hook throws until PRV implements it) |
| `src/main/diagnostics/behaviorLog.ts` (new), `diagnosticsReport.ts` | the log seam (stub); `DiagnosticsInput.behaviorProfile` (not exported until SET validates it) |
| `eslint.config.mjs` | `src/core`: no `Math.random`, `Date.now`, `performance.now`, `new Date()` |
| tests | `tests/unit/shared/contractV12c2.test.ts` (new), `tests/fixtures/v1.1.1/settings.ts` (frozen), additions to `testHooks.test.ts`, `catHost.test.ts`, `contractV12.test.ts` |

## 18. Open questions (for the lead or the user)

1. **Screen edges over a maximized window.** Proposed and specified: covered-band peeks only (≤ 2 bh, ≤ 8 s, ≤ 4/h, cursor > 6 bw away), fully click-through via the guard and the hover dwell; full climbs only over clear bands. Confirm, or allow clear bands only.
2. **Three mouse buttons in GetAsyncKeyState** (typing detector and the press counter) widen a documented privacy statement, to mouse buttons only. Accept? If not, the counter uses the left button only.
3. **Default values** of Playful (mischief 0.4, work disruption 0.25): with the revised mischief rule the default shows mischief acts (m\* ≈ 0.24). Confirm.
4. **Sound in v1.2 or descoped?** The contract carries it either way.
5. **Notepad**: who runs the clean-profile REAL probe, and when? Until then never queried.
6. **B10 denominator** (new): the brief's "per hour of climbing" is read as "per awake hour in layouts with reachable elevated surfaces" (0.3–3/h). Confirm, or give the intended denominator.
7. **Package integration** (new): cherry-pick (proposed) or a local `git merge --no-ff` into `feat/v1.2-lively`? The standard says "never merge"; the user decides whether that covers local feature-branch integration.
8. **Explorer soak gate** (new): if the 2 h soak fails or is not run, v1.2.0 ships with Explorer tab strips off (Terminal on). Acceptable?

**Lead decisions (2026-10-29; the brief asks for autonomous decisions):** Q1 accepted as specified (covered-band peeks only, click-through; full climbs only over clear bands). Q2 accepted (mouse buttons only, never keys; PRIVACY.md updated by the lead). Q3 accepted (mischief 0.4, work disruption 0.25). Q4 sound stays in scope at the lowest priority, off by default; REN may descope it if it risks the overlay. Q5 Notepad stays never-queried in v1.2 (UNVERIFIED; the user's saved session must not be touched). Q6 accepted (per awake hour with reachable surfaces). Q7 same-worktree packages on disjoint files, lead commits per wave (§16.1). Q8 a shorter REAL Explorer soak (own windows) if time allows; otherwise Explorer tab strips ship off and Terminal on.

Resolved in this revision: P1's active share (recalibrated, band kept), `startleSensitivity` for new cats (separate stream from `bornAt`), persisted moods (persist with decay; needs frozen across downtime), profile scope (session-only; the log lines persist dwell).

## Review (revision 2): dispositions

Critic A = the behaviour-calibration review, critic B = the contract-and-safety review. "Accepted" means the ADR or the contract now does what the critic asked; differences are noted.

| # | Critic, severity | Point | Disposition |
|---|---|---|---|
| A1 | A, blocker | Hunt drive saturates; reach band too wide | **Accepted**: k_h, τ_h, h₀, θ_h as proposed; q·prox; start band dy ≤ 2.5 bh, watch band 14 bw; cooldown changed to U(4,7) min·(1.6 − H) so U-play stays ≤ 12/h (§1.2, §4.1–4.2, B5) |
| A2 | A, blocker | Clicks, taskbar reveals, petting feed hunts; W not in the start rule | **Accepted** (a)–(e): press counter in `SimEnv` (C2), petting zone, taskbar gate, caption band, θ_h + 0.3·(1 − W) inside the foreground window, W damping within 3 bw only (§4.3, §1.4) |
| A3 | A, major | Pounce clearance from the anchor (T8) | **Accepted**: clearance from the hit region via `HIT_FRONT_EXTENT_DIP` and `PounceOptions.frontExtentPx` (C2, honoured by the stub), strike rule, B5c (§4.2, §6.5) |
| A4 | A, major | Wariness exposure, no soothing petting, irritability loop, thin B8 | **Accepted**: gentle strokes soothe; frantic-only irritation capped per bout; slink rule; w_k lowered and half-life 45·(2.5 − 1.5b)·(1 + 0.5i) so B8 holds without petting too; B8 with petting; B8b (§1.2, §5.3, §14) |
| A5 | A, major | Mischief unreachable at Playful | **Accepted**: m\* formula, gate m > 0.15 with p ∝ m, cooldown 60 s/(0.5 + M), ambush candidate, foreground bonus, overstimulation swat (§1.2, §1.7) |
| A6 | A, major | 0.2 interest baseline drives drive-named candidates | **Accepted**: no baseline for drive-gated candidates; one hunt start path; smooth nap ramp; B15 (§1.4, §14) |
| A7 | A, major | Explore need saturates when maximized | **Accepted**: opportunity-scaled growth, per-visit satisfaction, peek limits and edge preference, L4b / B1b (§1.2, §6.1, §14) |
| A8 | A, major | Slip floor unreachable; denominator changed silently | **Accepted**: every take-off a candidate, new p; B10 0.3–3 per awake hour, flagged as a reinterpretation (Q6) (§6.6, §14) |
| A9 | A, major | H_safe above the hard threshold | **Accepted**: H_safe capped at 0.95·h_hard·(0.8 + 0.4Ht); climbLeap grips ≤ min(H_safe, 0.8·h_hard); planned hard landings squash only; unit test (§6.3–6.4) |
| A10 | A, major | Reactions ignore landing room | **Accepted**: ℓ input, surface-pinned reaction moves, leave option for room, step-off = physics (§5.1–5.2) |
| A11 | A, major | Stalk too slow, still cursor ends interest, unreachable heights | **Accepted**: approach phase, ≤ 6 s stalk, still-cursor crouch, jump-swat 1.2–2.5 bh, chatter above (§4.2) |
| A12 | A, major | B3 censored by imposed ends; no way back after a cover | **Accepted**: Kaplan–Meier B3 plus plannedMs draws and the experienced median; resume token; restore salience 0.7 (§2.4, §1.8, §14) |
| A13 | A, major | chaseDurationSec, pawAtCursor, reactToTyping lose meaning | **Accepted**: cycle budget 1.5 × C; `behaviorGates.ts` (C2) for pawAtCursor; raw typing signal for every gate (§1.1, §4.3, §9.4) |
| A14 | A, major | Bands blind to nuisance; capped B7 tautological; contradictory ceilings | **Accepted**: U-play and U-mouse-work, B5b, B7 on the uncapped softmax with the cap rate, reconciled ceilings, B6 floor, B11 ceiling, sleep and mood bands (§14) |
| A15 | A, minor | On-surface plan undefined; leave failure; petting/typing | **Accepted**: §2.2 table; backoff and emergency; overdue log; deferral while petted; typing ×1.3 (§2.2–2.3) |
| A16 | A, minor | P1 above B1; class tables differ | **Accepted** (recalibration rather than preset-specific bands): 0.25·A in D, A lengthens active episodes; one table `activityClassOf` (C2); presets informational (§1.6, §14) |
| A17 | A, minor | Rough drags below 1100 DIP/s; landRecover before bolting | **Accepted** (§5.2) |
| A18 | A, minor | Desktop icons on the left edge | **Accepted**: left desktop edge treated as covered, right preferred; 300 ms hover dwell while clinging (§6.1) |
| A19 | A, minor | Settings UI naming and density | **Accepted**: Personality group, three up-front sliders, Fine-tune, `closestPreset` (C2), help texts. The key stays `activityPreset` (only the label changes) (§9.1) |
| B1 | B, blocker | Contract not committed | **Accepted, executed by the lead**: this revision was produced under an instruction not to commit. `verify fast` ran on this exact tree (report); the lead commits C1+C2 as one conventional commit (explicit paths) and writes the SHA into §16.1; worktrees branch from it. Integration by cherry-pick; local merge is Q7, because the standard forbids merging without saying it is limited to PRs |
| B2 | B, blocker | Screen-edge guard can fail open | **Accepted** all six: dedicated obstacle source incl. own Settings, topmost/tool/popup and privacy-excluded windows, GetWindowRect + 8 DIP; WinEvent cache with fail-closed rules; `wallGuardRects` during bands, leaps, wall jumps and bail-outs via the `clickGuardRectsPx` seam (C2, wired in app.ts); no edge climbs without `env.edgeBands` (doc fixed in C2); real footprint; unit tests listed (§6.1, §15.1) |
| B3 | B, major | Typing gate tied to reactToTyping | **Accepted**: `typingRaw` (§4.3, B6 with the setting off) |
| B4 | B, major | Strikes can place the hit region under the cursor | **Accepted** (with A3); "freeze all movement within 0.5 bw" adopted as the hold-still zone with a 3 s limit, so a resting cursor cannot strand the cat (§4.3) |
| B5 | B, major | v2 opt-outs re-enabled under new acts | **Accepted**: `behaviorGates.ts` with tests (C2); inspectWindows semantics stated; property test in BEH (§9.4) |
| B6 | B, major | jumpDownAbsoluteMaxDip vs "no option"; H_safe lands hard | **Accepted**: `LeaveOption.emergency` (C2), hang-and-drop, acceptance reworded; H_safe cap (with A9) (§2.3, §3, §6.3) |
| B7 | B, major | fallCause and arrival measurement bugs | **Accepted and fixed in C2**: `plannedSupportId/plannedOutcome` (real in the Mover), `fallCauseOf`, `lastFlightReason`; tests for the slip, the vanished and the moved target, and a dropped-onto arrival recorded as `carried` |
| B8 | B, major | No stuck-state watchdog | **Accepted**: §6.9 and B14; `maxWallHoldMs` and the backoff constants in C2; decision cause `watchdog` |
| B9 | B, major | Wariness blocks grabbing | **Accepted** (with A4): never moves with the cursor over or within 1 bw, stops when the user aims, slink pace, ≤ 2 retreats, commands override, the 100/100 test (§5.3) |
| B10 | B, major | Explorer is the shell | **Accepted**: kill switch, rate limit, full image path, kind cross-check, soak gate (Explorer off unless the soak passes; Q8) (§7.1–7.2) |
| B11 | B, major | Bail-out walks over the covered edge; clicks during the grace; maximize still free-falls | **Accepted**: single hop only, covering rect in the click guard, the same bail-out for gone (maximize/minimize), churn test (§3, B13) |
| B12 | B, major | Package files not disjoint | **Accepted**: seams in C2 (app.ts click guard, behaviour log, report input, test hooks; catHost guard and injected cursor; provider `restrictToPids`; diagnostics fields; `GAIT_LIMIT_DIP`), upgrade-test.ps1 to INT, acceptance split, it.todo specs with skip markers as the only shared edit, the lead writes PRIVACY/THREAT_MODEL, the stated rules (§16) |
| B13 | B, major | E2E checks infeasible or vacuous | **Accepted**: `injectCursor` and `restrictSurfacesToPids` hooks (C2), WindowFromPoint with the injected cursor, named Terminal window and HWND diff, churn in sim time, bench on `out/` with a lively phase plus a passive packaged sample, upgrade v2 case or UNVERIFIED (§15.4) |
| B14 | B, minor | Downgrade loses disabledExtras | **Accepted**: sidecar (SET) and the frozen-schema test (C2, REAL: it confirms the loss without the sidecar) (§9.3) |
| B15 | B, minor | Memory ring eviction | **Accepted**: separate rough list of 16; frequent events counted, not remembered (§5.4) |
| B16 | B, minor | Caps do not guarantee ≤ 0.5 | **Accepted**: water-filling, ≥ 3 eligible, opt-out combinations tested (§5.2) |
| B17 | B, minor | Determinism unenforced | **Accepted**: ESLint rules (C2), accumulators, the 33/66 ms test; σ from a stream seeded by `bornAt` (the cat has no id) (§1.2–1.3) |
| B18 | B, minor | Multi-monitor geometry ambiguity | **Accepted**: px overlap rule, larger-scale tolerance, taskbars incl. auto-hide, fixtures, hot-unplug cause `gone` (§6.1) |
| B19 | B, minor | TabView property reads, Subtree storm, stale strip | **Accepted**: never-read list and grep, ListView-only subscription with an event-rate check, retention clamp and drop rules (§7.1, §7.3) |
| B20 | B, minor | Sound replays at seams; context keeps the PC awake | **Accepted**: global dedupe in overlayManager, close after 10 s idle, powercfg check (§10) |
| B21 | B, minor | Downtime growth; B1 metric; typing in logs | **Accepted**: needs frozen across downtime, sleepiness reset after > 1 h; `activityClass` on decisions and variant-aware time (C2); no typing time or ids in log lines (§1.2, §11) |
| B22 | B, minor | Profile runs hold the shared machine | **Accepted**: detached runs with checkpoints, 2-seed loops, bands-short budget ≤ 20 s (§14, §15.3) |

Rejected outright: none. Partially adopted, with the reason recorded above: B1 (commit done by the lead; local merge left to the user), B4 (hold-still limited to 3 s), A16 (recalibration instead of preset-specific bands), A19 (label renamed, key kept).

## Consequences

- Settings schema v3 plus an opt-out sidecar; a 1.1.1 downgrade keeps v2 opt-outs and values and loses v3-only slider values (documented); v1.2 opt-outs survive through the sidecar.
- The cat file gains `drives`, a trait, counters and a preference without a version bump; 1.1.1 drops them on load.
- One more tab reader in the existing helper; the privacy scope grows to Terminal (and Explorer after its soak).
- Main gains a window-obstacle source used only for the click guard.
- 36 clips; the renderer test matrix grows ~2.7×.
- The v1.1.1 passive-mix tests are replaced by the §14 bands; the "never in the way" ceilings stay and gain nuisance bands.
