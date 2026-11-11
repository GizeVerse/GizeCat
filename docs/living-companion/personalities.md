# Personalities

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: no 1.5.0 code has been executed by anyone, so none of the behaviour described here has been seen on a desktop or a phone. Everything below is read from `src/core/behavior/personalityProfiles.ts` and the files that call it.

Back to the [overview](README.md).

## The rule

You choose the personality. The cat never changes your choice.

- The choice is stored in `settings.companion.personality`: one of `curious`, `playful`, `energetic`, `lazy`, `shy`, `mischievous`, `calm` or `auto` (`src/shared/settings.ts`). Only you, or an imported profile you accept, write it.
- A named profile gives the cat that profile's target traits plus a small drift from experience. The drift is bounded: no trait ever moves more than 0.08 from the profile's target (`MAX_TRAIT_DRIFT`), and it is halved, step by step, until the cat still reads as its own personality (`adaptTraits`). With no drift at all it always does. The cat's persisted traits and your choice are never rewritten by this: the drifted values are computed on the fly and recomputed every 3 minutes (`PERSONALITY_RECHECK_MS`).
- Auto keeps the traits the cat was born with, unchanged, and uses neutral knobs, so every cat that existed before 1.5.0 behaves as it did. Auto is shown as the nearest profile (the closest of the seven by distance over the seven traits). The 1.5.0 drift above is not applied to Auto.

## The seven profiles in plain words

The words are the ones the settings pages show (`src/shared/personalityText.ts`); a unit test is meant to keep them in step with the numbers below (written, NOT RUN).

| Profile | In one sentence | What you may notice |
|---|---|---|
| Curious | Wants to know what everything is, and goes to look. | Notices world events quickly, walks over to look, goes close to anything new, explores more than it rests. |
| Playful | Turns almost anything into a game. | Stays longest with toys and games, chases a little longer than most, rests less than average. |
| Energetic | Always on the move. | Moves a lot and rests very little, chases for the longest of all, bold with new things. |
| Lazy | Happiest curled up somewhere comfortable. | Rests most of the time, often lets small things such as a falling leaf go by, keeps chases short, plays little. |
| Shy | Careful with anything new. | Watches new things from a distance for a few seconds first, startles easily, comes closer slowly if at all, stays further from things. |
| Mischievous | Always up to something a little cheeky. | Tries unusual reactions, walks straight up to new things, hard to startle. |
| Calm | Relaxed and composed, whatever happens. | Few sudden movements, very hard to startle, reacts to surprises with a quiet look. |

Mischievous is a temperament (a personality profile), not one of the eight moods. The Shy and Lazy lines about watching first and letting small things go are carried out by two flags the event engine reads, see the knob table below.

## The tunable parameters

Every number lives in one table, `PERSONALITY_PROFILES`. Retuning a personality is editing that table, not hunting for an if-chain.

### Target traits (seven per profile, 0 to 1)

| Profile | curiosity | playfulness | affection | confidence | energyLevel | laziness | startleSensitivity |
|---|---|---|---|---|---|---|---|
| curious | 0.88 | 0.55 | 0.50 | 0.62 | 0.55 | 0.30 | 0.40 |
| playful | 0.60 | 0.88 | 0.62 | 0.60 | 0.68 | 0.25 | 0.45 |
| energetic | 0.62 | 0.72 | 0.45 | 0.66 | 0.90 | 0.14 | 0.45 |
| lazy | 0.38 | 0.30 | 0.58 | 0.50 | 0.18 | 0.88 | 0.40 |
| shy | 0.50 | 0.35 | 0.42 | 0.16 | 0.40 | 0.45 | 0.84 |
| mischievous | 0.72 | 0.80 | 0.30 | 0.78 | 0.66 | 0.22 | 0.25 |
| calm | 0.45 | 0.35 | 0.66 | 0.62 | 0.34 | 0.62 | 0.14 |

### Knobs (beyond the traits)

0.5 is neutral for the 0 to 1 knobs; 1 is neutral for the two multipliers. Auto uses the neutral values (`NEUTRAL_KNOBS`).

| Profile | restBias | eventInterest | approachBoldness | chaseDuration | startleScale | calmness | mischief | playAppetite | watchFromDistance | ignoreMinorEvents |
|---|---|---|---|---|---|---|---|---|---|---|
| auto (neutral) | 0.50 | 0.50 | 0.50 | 1.00 | 1.00 | 0.50 | 0.50 | 0.50 | false | false |
| curious | 0.40 | 0.90 | 0.70 | 1.00 | 0.90 | 0.45 | 0.45 | 0.55 | false | false |
| playful | 0.35 | 0.70 | 0.65 | 1.30 | 1.00 | 0.35 | 0.55 | 0.95 | false | false |
| energetic | 0.15 | 0.75 | 0.75 | 1.60 | 1.00 | 0.20 | 0.50 | 0.75 | false | false |
| lazy | 0.92 | 0.25 | 0.35 | 0.55 | 0.85 | 0.70 | 0.20 | 0.25 | false | true |
| shy | 0.55 | 0.50 | 0.12 | 0.70 | 1.50 | 0.50 | 0.15 | 0.30 | true | false |
| mischievous | 0.30 | 0.80 | 0.80 | 1.20 | 0.70 | 0.25 | 0.95 | 0.85 | false | false |
| calm | 0.65 | 0.50 | 0.50 | 0.80 | 0.50 | 0.95 | 0.25 | 0.40 | false | false |

What each knob does, as the code reads it:

- `restBias` (0 restless to 1 a sofa): becomes a resting multiplier of 0.75 to 1.25 (`restFactor` in `simCore.ts`), lowers the temperament's `energy` (span 0.5), widens the Laser Mode dead zone and lengthens Laser Mode breaks.
- `eventInterest`: moves the temperament's `interest` (span 0.6), which sets how quickly and how readily the cat engages with a world event.
- `approachBoldness`: moves `boldness` (span 0.7), which scales how close the cat dares to go.
- `chaseDuration` (0.5 to 1.6): multiplies the temperament's `persistence`, which stretches chases and play and lengthens an event for a persistent cat. It also sets the Laser Mode chase budget.
- `startleScale` (0.5 to 1.5): multiplies how strongly the cat startles, both in the event temperament and in the sim's reactions.
- `calmness`: moves `calm` (span 0.7) and becomes a multiplier of 0.7 to 1.3 on sudden activity (`liveliness`).
- `mischief`: moves the temperament's `mischief` (span 0.7), the weight of unusual, playful or sneaky outcomes.
- `playAppetite`: moves `playfulness` (span 0.6) and sets how readily the cat reaches toward the laser dot.
- `watchFromDistance` (only shy sets it): `temperamentFor` turns it into `watchFirst` on the event temperament. After a shy cat notices an event it first only watches for 6 to 12 seconds (at most 45 % of the time the event has left), then comes closer, and while it does it keeps a stand-off 1.5 times wider than other cats. Urgent beats (scares, thunder, waves) are never delayed, and a shy cat never catches anything.
- `ignoreMinorEvents` (only lazy sets it): becomes `ignoreMinor`. When a minor event starts (a falling leaf, paper plane, magic sparkles, bubble party or falling star: gentle, low-stakes and able to be missed), a lazy cat lets it pass 60 % of the time. The props still play, the cat does not react, and the event ends as `unnoticed`, which never writes a journal line. Events you start yourself with "play one now" or from the dev menu are never ignored.
- Both flags are `false` for Auto and for every other profile, and they add no random draws on that path, so an Auto cat behaves exactly as before. The final model: two numeric knobs steer how much of everything a cat does, and these two flags add one distinct behaviour each (watch first, let small things go). Details: [World events](events.md#personality-and-novelty).

### How a knob becomes behaviour

`temperamentFor` (same file) builds the nine numbers the event engine sees (`interest`, `boldness`, `persistence`, `startle`, `playfulness`, `calm`, `mischief`, `alertness`, `energy`). It starts from the traits, the live stats and drives, the mood and the time of night, then moves the result by the knob. The engine never sees the profile table, so personalities stay tunable in one place. The temperament then steers three things in the engine: how long the cat takes to notice an event, how long the event lasts for this cat, and the weights of the outcomes (see [World events](events.md#outcomes-and-the-cats-temperament)).

The mood nudges the temperament only a little (for example a scared cat gets +0.25 startle and -0.25 boldness): a mood colours a reaction, it does not decide it.

### Experience drift

A named profile's traits drift slowly with what the cat has lived through (`ADAPT_RULES`). Each rule saturates (count / (count + scale)) and has a small maximum weight:

| Counter | Trait | Direction | Half-weight at | Most it moves alone |
|---|---|---|---|---|
| pets | affection | up | 400 | 0.05 |
| attentionAnswered | affection | up | 150 | 0.04 |
| throws | startleSensitivity | up | 40 | 0.05 |
| hardLandings | startleSensitivity | up | 80 | 0.03 |
| throws | confidence | down | 60 | 0.04 |
| chasesEngaged | playfulness | up | 200 | 0.05 |
| pounces | playfulness | up | 150 | 0.03 |
| chasesIgnored | playfulness | down | 150 | 0.04 |
| hunts | energyLevel | up | 200 | 0.03 |
| windowsInspected | curiosity | up | 200 | 0.05 |
| excursions | curiosity | up | 150 | 0.04 |
| naps | laziness | up | 400 | 0.04 |

The sum per trait is clamped to plus or minus 0.08. Counters only grow slowly, so this changes over days, not minutes. Clearing history resets the counters and therefore the drift.

## Where it is pinned

- `tests/unit/core/behavior/personalityProfiles.test.ts` covers the table, nearest profile and drift (written, NOT RUN).
- `tests/unit/renderer/settings/companionPages.test.ts` references the personality text (written, NOT RUN).
- `tests/unit/shared/companionSettings.test.ts` covers the `companion` settings section (written, NOT RUN).
