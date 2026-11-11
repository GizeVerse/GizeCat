# Animation system

Status: IMPLEMENTED and statically verified (type-check, lint, read-only review). NOT RUN: no clip has been drawn by a running 1.5.0 build, and the three new clips (`scratch`, `shake`, `confused`) have never been seen. The tables on this page are transcribed from `src/shared/animationCatalog.ts` and `src/shared/cat.ts`, which are the source of truth; if this page and those files disagree, the files are right.

Back to the [overview](README.md). The drawing itself is in `src/renderer/overlay/cat/clips.ts`, `animator.ts` and `rig.ts`; the pure metadata and the transition model are in `src/shared/animationCatalog.ts`.

## The clip metadata contract

`CLIP_META` is one declarative table, a `Record<AnimClip, ClipMeta>`. Because it is typed as a record over every clip name, adding a clip to `ANIM_CLIPS` without an entry fails to compile. For each clip it says:

| Field | Meaning |
|---|---|
| `posture` | `stand`, `sit`, `lie`, `crouch`, `air`, `wall` or `held`. Drives the transition model below. |
| `loop` | Plays until the brain changes clip. Must agree with `ONE_SHOT_CLIPS` (a consistency check reports a disagreement). |
| `durationS` | One-shot length in seconds; `null` for loops. A one-shot holds its last pose until the sim selects another clip. |
| `interruptible` | May the brain cut it short? Physical clips and short reactions are not interruptible. |
| `priority` | 0 ambient, 1 and 2 intermediate, 3 physical. A higher priority is never replaced by a lower one without its completion. |
| `fadeInMs` | Cross-fade into this clip. |
| `support` | What the clip needs underneath the cat: `floor`, `ledge`, `wall`, `air`, `held`. The first entry is the preferred one. |
| `gait` | Locomotion clips only: which gait limit caps the anchor speed (`GAIT_LIMIT_DIP`: walk 106, run 394, climb 63, stalk 40, slink 90, sprint 440 DIP/s at size 1). |
| `tags` | `rest`, `bodyCare`, `locomotion`, `emotion`, `play`, `reaction`, `environment`, `physics`. |
| `footprintDip` | Nominal visual footprint at size 1 (the exact hit region is separate and comes from the rig). |
| `entry`, `exit` | Plain-text entry and exit conditions, for people. The sim enforces them in code. |

Defaults: a loop is interruptible, priority 0, 200 ms fade, supports floor and ledge, 84 x 64 DIP. A one-shot is interruptible, priority 1, 120 ms fade, tagged `reaction`.

`canSwitch(from, to, elapsedS)` decides whether the brain may change clip now: always when `from` is interruptible or `to` has higher priority; otherwise only after a non-interruptible one-shot has run its full duration. A non-interruptible loop (a physics clip such as `fall` or `held`) is ended by its owner, not by the brain.

### Every clip (39)

Postures: S stand, Si sit, L lie, C crouch, A air, W wall, H held. Int = interruptible; P = priority; Fade in ms.

| Clip | Posture | Loop or one-shot (s) | Int | P | Fade | Support | Gait | Tags | Footprint DIP |
|---|---|---|---|---|---|---|---|---|---|
| `stand` | S | loop | yes | 0 | 200 | floor, ledge | | rest | 84 x 64 |
| `sit` | Si | loop | yes | 0 | 200 | floor, ledge | | rest | 60 x 64 |
| `loaf` | L | loop | yes | 0 | 200 | floor, ledge | | rest | 72 x 40 |
| `sleep` | L | loop | yes | 0 | 400 | floor, ledge | | rest | 64 x 36 |
| `wake` | L | 1.6 | no | 1 | 120 | floor, ledge | | rest, bodyCare | 84 x 64 |
| `yawn` | Si | 1.2 | yes | 1 | 120 | floor, ledge | | bodyCare | 84 x 64 |
| `walk` | S | loop | yes | 0 | 160 | floor, ledge | walk | locomotion | 84 x 64 |
| `run` | S | loop | yes | 0 | 140 | floor, ledge | run | locomotion | 100 x 56 |
| `crouch` | C | loop | yes | 0 | 140 | floor, ledge | | play | 84 x 40 |
| `jump` | A | loop | no | 3 | 200 | air | | locomotion, physics | 90 x 70 |
| `fall` | A | loop | no | 3 | 200 | air | | physics | 80 x 72 |
| `land` | S | 0.25 | no | 3 | 120 | floor, ledge | | physics | 84 x 64 |
| `startle` | S | 0.8 | no | 2 | 120 | floor, ledge | | emotion, reaction | 84 x 64 |
| `annoyed` | Si | loop | yes | 1 | 200 | floor, ledge | | emotion | 84 x 64 |
| `petted` | Si | loop | yes | 2 | 200 | floor, ledge | | emotion | 84 x 64 |
| `groom` | Si | loop | yes | 0 | 200 | floor, ledge | | bodyCare | 84 x 64 |
| `pawAt` | Si | loop | yes | 0 | 200 | floor, ledge | | play | 96 x 60 |
| `held` | H | loop | no | 3 | 60 | held | | physics | 84 x 64 |
| `meow` | Si | 0.9 | yes | 1 | 120 | floor, ledge | | emotion | 84 x 64 |
| `hide` | C | loop | yes | 1 | 200 | floor, ledge | | emotion | 80 x 34 |
| `rollOver` | L | loop | yes | 0 | 200 | floor, ledge | | play, emotion | 80 x 48 |
| `climb` | W | loop | yes | 2 | 200 | wall | climb | locomotion, environment | 40 x 84 |
| `stalk` | C | loop | yes | 0 | 200 | floor, ledge | stalk | locomotion, play | 92 x 34 |
| `sprint` | S | loop | yes | 0 | 120 | floor, ledge | sprint | locomotion | 110 x 52 |
| `pounce` | A | loop | no | 3 | 200 | air | | play, physics | 110 x 56 |
| `slip` | A | 0.9 | no | 3 | 120 | ledge, wall | | physics, environment | 84 x 64 |
| `impact` | S | 0.45 | no | 3 | 120 | floor, ledge | | physics | 84 x 64 |
| `landRecover` | Si | 0.9 | no | 2 | 120 | floor, ledge | | physics, bodyCare | 84 x 64 |
| `swat` | Si | 0.45 | no | 2 | 120 | floor, ledge | | play, reaction | 108 x 60 |
| `hiss` | S | 1.2 | no | 2 | 120 | floor, ledge | | emotion, reaction | 84 x 64 |
| `grumpy` | Si | loop | yes | 1 | 200 | floor, ledge | | emotion | 84 x 64 |
| `slink` | S | loop | yes | 0 | 200 | floor, ledge | slink | locomotion, emotion | 96 x 44 |
| `stretch` | S | 1.6 | yes | 1 | 120 | floor, ledge | | bodyCare | 84 x 64 |
| `balance` | C | loop | yes | 2 | 200 | ledge, wall | | environment, physics | 84 x 64 |
| `tailChase` | Si | loop | yes | 0 | 200 | floor, ledge | | play | 72 x 64 |
| `edgeSit` | Si | loop | yes | 0 | 200 | ledge | | environment | 60 x 64 |
| `scratch` (new) | Si | loop | yes | 0 | 200 | floor, ledge | | bodyCare | 72 x 64 |
| `shake` (new) | S | 1.1 | no | 2 | 120 | floor, ledge | | bodyCare, reaction | 84 x 64 |
| `confused` (new) | Si | loop | yes | 0 | 200 | floor, ledge | | emotion | 64 x 64 |

### The three new clips

| Clip | What it is (from `ANIM_CLIPS`) | Used by |
|---|---|---|
| `scratch` | Sitting, hind leg scratching behind the ear; a loop. | Grooming variety (a scratch as one of a few body-care steps, `simLaser.ts`). Declared stand-in: `groom`. |
| `shake` | Standing full-body shake-off, as after getting wet; a one-shot of about 1.1 s. | The wet-cat recovery of the Mini Tsunami, and a small chance after being annoyed for a while or after a hard landing. Declared stand-in: `stand`. |
| `confused` | Sitting, head tilting side to side, one ear up; a loop. | Event aftermaths (the "question" ending of several events), and a puzzled look when the pointer vanishes after a hunt or the laser dot is lost. Declared stand-in: `sit`. |

All three are IMPLEMENTED and statically verified only; the rig drawing them has never been looked at on a screen.

## The posture transition model

Clips are grouped by posture, and the model decides which clips bridge two postures so that no pose pops. It is deterministic.

Direct moves that need no bridge (`POSTURE_EDGES`):

| From | May go directly to |
|---|---|
| lie | sit |
| sit | lie, stand, crouch |
| stand | sit, crouch, air, wall |
| crouch | sit, stand, air |
| air | stand (the `land` one-shot is the bridge) |
| wall | stand, air |
| held | air |

Anything else goes through the neutral clip of each intermediate posture, on the shortest path (breadth-first, in table order). The neutral clips (`POSTURE_NEUTRAL`) are: stand to `stand`, sit to `sit`, lie to `loaf`, crouch to `crouch`, air to `fall`, wall to `climb`, held to `held`.

`bridgeClips(from, to)` returns the clips to play between the two. Two clips of the same posture cross-fade directly (an empty list). If no path exists it returns null and the caller keeps the current clip. For example (derived by reading the function, not by running it): lie to stand bridges through `sit`; air to stand through `land`; wall to sit through `stand`; held to stand through `fall` then `land`. Physical clips (`jump`, `fall`, `held`) are never bridged by the brain: the physics, not the brain, ends them.

## Graceful fallback

Some clips need something a platform may lack: a wall (a screen edge or a window side) or a ledge. `resolveClip(requested, caps)` returns a clip that is known and supported, so the brain can never ask for a pose that does not exist. An unknown name resolves to `stand`. It walks the fallback chain (`CLIP_FALLBACK`, at most four hops), and `stand` is the floor of it.

| Requested | Falls back to | Requested | Falls back to |
|---|---|---|---|
| `climb` | `stand` | `sprint` | `run` |
| `balance` | `stand` | `swat` | `pawAt` |
| `edgeSit` | `sit` | `hiss` | `startle` |
| `slip` | `stand` | `grumpy` | `annoyed` |
| `scratch` | `groom` | `impact` | `land` |
| `shake` | `stand` | `landRecover` | `stand` |
| `confused` | `sit` | `stretch` | `stand` |
| `tailChase` | `sit` | `rollOver` | `loaf` |
| `stalk` | `walk` | `slink` | `walk` |

As `resolveClip` is written, a fallback is taken only when a clip's only supports are walls (and the platform has none), or only ledges and walls (and it has no ledges). That is true of four clips: `climb` (wall), `balance`, `slip` (ledge or wall) and `edgeSit` (ledge). For instance, with `walls: false` a `climb` request resolves to `stand`. The other entries in the table (`scratch`, `shake`, `confused` and the rest) are declared stand-ins for a renderer or platform that lacks that clip; `resolveClip` does not exercise them, because those clips only need the floor.

## Layers on top of the clips

Mood, deep sleep and reduced motion are not clips. They are layers the animator applies on top of whichever clip plays (`animator.ts`):

- **Mood layers.** Each of the eight moods has an eased weight (a mood never pops in or out; a startle comes in quickly and leaves slowly). The layers are small additive tweaks to ears, tail, pupils, eyelids and head: happy (tail up, soft eyes), curious (ears forward, head tipped), sleepy (heavy lids, drooping ears, slow tail), startled (ears flat, pupils wide), scared (ears back, tail low and puffed, a crouch bias), excited (wide pupils, fast higher tail), relaxed (half-closed eyes, slow tail), confused (one ear up, head tilting). Authored tails take only a share of a mood's tail motion.
- **Deep sleep.** `sleepDepth` (0 to 1) slows the breathing and the ears, eases the posture and lowers the frame rate further (`frameRate.ts`).
- **Reduced motion.** The animator damps the tail swing. The sim drops the decorative ear and tail flicks and head tilts. The props are drawn with halved amplitude and the laser dot does not pulse.

## The behaviour catalogue

`BEHAVIOR_CATALOG` lists every behaviour the product asks for and how it is really realised. The word matters, and it is deliberately honest:

| Realisation | Meaning |
|---|---|
| clip | Its own drawn clip. |
| variant | A clip plus a procedural layer or render hint. |
| alias | An existing clip standing in for it. |
| composite | A sequence of clips. |
| layer | Procedural layers only (ears, tail, pupils, look-at). |
| sim | A sim-side phase that selects among the clips. |

Counts: 17 clip, 11 variant, 2 alias, 4 composite, 4 layer, 5 sim (43 in all).

| Behaviour | Clip | Realisation | Note |
|---|---|---|---|
| standingIdle | `stand` | clip | breathing, blinks and tail sway are procedural layers |
| sittingIdle | `sit` | clip | head tracks the look target |
| lyingDown | `loaf` | clip | paws tucked |
| sleeping | `sleep` | clip | curled, slow breathing |
| deepSleep | `sleep` | variant | the `sleepDepth` render hint slows breathing, eases the posture and quietens the frame rate |
| wakingUp | `wake` | clip | front then back stretch |
| lookingAround | `sit` | layer | look-at layer driven by sim glances |
| tailMovement | `stand` | layer | procedural tail physics plus the tailFlick reaction |
| earMovement | `stand` | layer | procedural ear twitches plus the earFlick reaction |
| randomIdleVariation | `stand` | sim | idle episodes pick among sit, loaf, groom, yawn, stretch, look, tail chase |
| yawning | `yawn` | clip | |
| stretching | `stretch` | clip | |
| scratching | `scratch` | clip | new in the Living Companion release |
| grooming | `groom` | clip | |
| washingPaws | `groom` | alias | the groom clip licks a paw; one clip covers paw washing |
| cleaningFace | `groom` | alias | the groom clip wipes the face with the paw |
| shakingBody | `shake` | clip | new; also the wet-cat recovery |
| settlingDown | `loaf` | composite | sit then loaf through the posture bridge |
| walking | `walk` | clip | |
| fastWalking | `walk` | variant | walk at the top of its gait limit |
| running | `run` | clip | sprint for flat-out dashes |
| sneaking | `stalk` | clip | slink for retreats |
| smallJump | `jump` | variant | `jumpKind` hop |
| largeJump | `jump` | variant | `jumpKind` up, across or leap where the platform has surfaces |
| stopping | `stand` | sim | the mover decelerates before the clip changes |
| turning | `stand` | layer | facing flip with a cross-fade |
| fallingRecovering | `fall` | composite | fall, land or impact, then `landRecover` |
| happy | `petted` | variant | mood happy: upright tail, soft eyes, optional purr and heart emote |
| curious | `sit` | variant | mood curious: forward ears, head tilt reaction, question emote |
| surprised | `startle` | clip | |
| startled | `startle` | clip | |
| scared | `hide` | variant | hide, slink or hiss by personality |
| sleepy | `sit` | variant | mood sleepy: slow blinks, heavy lids, yawn |
| confused | `confused` | clip | new |
| excited | `tailChase` | variant | mood excited: wide pupils, fast tail; tailChase, rollOver or sprint |
| mischievous | `crouch` | variant | "mood mischievous": crouch and wiggle, swat, narrowed eyes (see the note below) |
| relaxed | `loaf` | variant | mood relaxed: half-closed eyes, slow tail, optional purr |
| edgeClimbing | `climb` | clip | screen edges on every platform, window sides on Windows |
| cornerTransition | `climb` | composite | floor to wall through the sim wall manoeuvre (`balance` at the top corner) |
| floorMovement | `walk` | sim | |
| windowSurface | `walk` | sim | Windows only: ledges on window tops and the taskbar |
| safeFalling | `fall` | composite | fall, land, impact, `landRecover`; never breaks the cat |
| eventMovement | `walk` | sim | world events steer the same mover and clips |

Note on `mischievous`: the catalogue note says "mood mischievous", but the `Mood` type has eight moods and none of them is mischievous (`MOODS` in `src/shared/companion.ts`). Mischief reaches the cat as a personality knob and as a temperament value, not as a mood layer; the table row records what the catalogue says. Also note that the behaviour keys `happy`, `curious`, `scared`, `sleepy`, `excited` and `relaxed` are variants because the mood layers change the same clip rather than adding a clip.

## Consistency checks

`catalogConsistencyProblems()` (a dev helper, also used by a renderer test) reports a loop flag that disagrees with `ONE_SHOT_CLIPS`, an unknown gait, a one-shot without a duration, and a behaviour that names a clip that does not exist. The tests are written and NOT RUN: `tests/unit/renderer/livingCompanion.test.ts` references the catalogue, `tests/unit/renderer/clips.test.ts`, `v12clips.test.ts`, `animator.test.ts` and `presence.test.ts` cover the rig and its extents.
