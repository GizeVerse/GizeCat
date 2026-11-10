// The world-event catalogue: pure data, one entry per id in ALL_EVENT_IDS. Everything that makes an
// event itself lives here: how often it comes, how long it stays, which props it draws, what it needs
// from the stage, the time of day it likes, the outcome variants (weighted by the cat's temperament)
// and, per outcome, the beats the cat is invited through. The motion itself is in mechanics.ts (a
// handful of shared families that read this table); the scheduling rules are in schedule.ts.
//
// Beats: `from` is the fraction (0..1) of the ENGAGED window, from the moment the cat notices the event
// to the moment the props start to leave. For events with a key moment (a wave arriving, thunder, a
// gust's peak, a fish's apex, a treasure's sparkle burst) u = 0.5 IS that moment: the engine stretches
// the two halves of the window around it. A beat with from = 1 is the aftermath (the props are leaving
// or gone: the reaction to the escape, the shake-off, the lingering curiosity).
import type { AnimClip, Emote, SoundCue } from '../../shared/cat';
import type { AnyEventId, Mood, OutcomeId, PropKind } from '../../shared/companion';
import { ALL_EVENT_IDS, RARE_EVENT_IDS } from '../../shared/companion';
import type { IntentKind } from './types';

/** The temperament axes an outcome's probability can lean on (alertness is read by the notice model only). */
export type TempKey = 'interest' | 'boldness' | 'persistence' | 'startle' | 'playfulness' | 'calm' | 'mischief' | 'energy';
export type TempBias = Partial<Record<TempKey, number>>;

/** What an event's length depends on: 'persistence' (long chases), 'calm' (calm cats linger), 'interest'. */
export type PacingKey = 'persistence' | 'calm' | 'interest';

export type MechanicId = 'floorRunner' | 'flutter' | 'hopper' | 'wave' | 'weather' | 'drifter' | 'settler' | 'visitor';

/** What the engine does to the props when the event is interrupted from outside. */
export type InterruptStyle = 'fade' | 'flee' | 'pop' | 'dissolve';

export interface Beat {
  from: number;
  kind: IntentKind;
  pace?: 'slow' | 'walk' | 'run';
  clip?: AnimClip;
  emote?: Emote;
  /** One-shot: emitted only on the tick the beat starts. */
  sound?: SoundCue;
  /** Default 0.15: gentle invitations. Waves and thunder use 0.65+. */
  urgency?: number;
  /** Stop this far from the target, in body widths (scaled by boldness, never below the event's minStandoffBody). */
  standoff?: number;
  /** Where the intent points: the prop itself, the floor point under it, or nowhere. Default by kind. */
  target?: 'prop' | 'ground' | 'none';
  mood?: { mood: Mood; strength: number };
}

export interface OutcomeDef {
  id: OutcomeId;
  /** Base weight, tilted by `bias` (each coefficient -1..1 times how far the cat's trait is from its middle). */
  weight: number;
  /** A moment worth a journal line. */
  journal: boolean;
  bias?: TempBias;
  beats: readonly Beat[];
}

export interface EventDef {
  id: AnyEventId;
  rare: boolean;
  /** Relative weight inside its pool. */
  weight: number;
  /** Typical length of the main part, seconds (path events derive their own travel time from it). */
  durationS: readonly [number, number];
  mechanic: MechanicId;
  props: readonly PropKind[];
  /** Free floor width needed, px at scale 1 (multiplied by the cat's size). */
  minFloorPx: number;
  /** Free stage height needed above the floor, in body widths. */
  minHeightBody: number;
  time: { pref: 'any' | 'day' | 'night'; /** Hard window [fromHour, toHour), wraps midnight. */ strict?: readonly [number, number] };
  /** Starts only while the cat is awake (it is deferred a little when due during sleep). */
  needsAwake: boolean;
  /** Not offered under reducedMotion at all. */
  skipReduced?: boolean;
  /** Axes the outcome weights lean on (documentation, checked by the tests). */
  temperament: readonly TempKey[];
  pacing: readonly PacingKey[];
  /** Base delay between the props appearing and the cat noticing, ms [min, max]. */
  noticeMs: readonly [number, number];
  /** A drowsy or distracted cat may miss it entirely (outcome 'unnoticed'). Loud events cannot be missed. */
  canMiss: boolean;
  outcomes: readonly OutcomeDef[];
  mood: { mood: Mood; strength: number };
  interrupt: InterruptStyle;
  /** After the props are gone the engine keeps the aftermath beat for this long, ms. */
  recoverMs: number;
  /** Prey-like props: the cat is never invited closer than this many body widths. */
  minStandoffBody: number;
}

const b = (from: number, kind: IntentKind, o: Omit<Beat, 'from' | 'kind'> = {}): Beat => ({ from, kind, ...o });
const outcome = (id: OutcomeId, weight: number, journal: boolean, bias: TempBias | undefined, beats: readonly Beat[]): OutcomeDef => ({
  id,
  weight,
  journal,
  ...(bias ? { bias } : {}),
  beats,
});

// ---- small shared beat pieces ----
const SPARKLE_END = b(1, 'react', { emote: 'sparkle' });
const QUESTION_END = b(1, 'react', { emote: 'question', clip: 'confused' });
const treasureBeats = (): readonly Beat[] => [b(0, 'watch'), b(0.2, 'approach', { pace: 'walk', standoff: 0.5 }), b(0.4, 'inspect', { urgency: 0.25 }), b(0.8, 'react', { emote: 'sparkle' }), b(1, 'watch')];

const NORMAL: readonly EventDef[] = [
  {
    id: 'mouseEncounter',
    rare: false,
    weight: 10,
    durationS: [14, 26],
    mechanic: 'floorRunner',
    props: ['mouse'],
    minFloorPx: 380,
    minHeightBody: 1,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'boldness', 'persistence', 'mischief', 'playfulness', 'calm'],
    pacing: ['persistence'],
    noticeMs: [900, 3200],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.55 },
    interrupt: 'flee',
    recoverMs: 1600,
    minStandoffBody: 0.6,
    outcomes: [
      outcome('watched', 1, false, { boldness: -0.6, calm: 0.5, interest: 0.2 }, [b(0, 'watch'), QUESTION_END]),
      outcome('sneaked', 0.9, true, { mischief: 0.7, boldness: 0.4, interest: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'sneak', { pace: 'slow', standoff: 1.3 }),
        b(0.7, 'sneak', { pace: 'slow', standoff: 0.9 }),
        QUESTION_END,
      ]),
      outcome('chased', 0.9, true, { playfulness: 0.6, persistence: 0.4, boldness: 0.5 }, [
        b(0, 'watch'),
        b(0.12, 'approach', { pace: 'walk', standoff: 1.4 }),
        b(0.35, 'chase', { pace: 'run', standoff: 0.85, urgency: 0.3 }),
        b(1, 'react', { clip: 'confused', emote: 'exclaim' }),
      ]),
      outcome('approached', 0.7, false, { interest: 0.6, boldness: 0.2 }, [b(0, 'watch'), b(0.25, 'approach', { pace: 'slow', standoff: 1.6 }), QUESTION_END]),
    ],
  },
  {
    id: 'miniTsunami',
    rare: false,
    weight: 6,
    durationS: [10, 16],
    mechanic: 'wave',
    props: ['wave', 'splash'],
    minFloorPx: 640,
    minHeightBody: 1.5,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['boldness', 'startle', 'playfulness', 'calm', 'mischief', 'energy'],
    pacing: [],
    noticeMs: [500, 1200],
    canMiss: false,
    mood: { mood: 'startled', strength: 0.45 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('hopped', 1, true, { playfulness: 0.6, boldness: 0.4 }, [
        b(0, 'watch', { urgency: 0.5 }),
        b(0.3, 'brace', { urgency: 0.6 }),
        b(0.44, 'hop', { urgency: 0.8 }),
        b(0.62, 'watch'),
        SPARKLE_END,
      ]),
      outcome('moved', 1, false, { startle: 0.7, boldness: -0.4, calm: -0.2 }, [
        b(0, 'watch', { urgency: 0.5 }),
        b(0.15, 'flee', { pace: 'run', urgency: 0.8 }),
        b(0.7, 'watch'),
        b(1, 'react', { clip: 'sit' }),
      ]),
      outcome('climbed', 0.6, true, { boldness: 0.6, energy: 0.5, mischief: 0.3 }, [
        b(0, 'watch', { urgency: 0.5 }),
        b(0.12, 'climb', { urgency: 0.85 }),
        b(0.8, 'watch'),
        b(1, 'react', { emote: 'exclaim' }),
      ]),
      outcome('wet', 0.8, true, { playfulness: 0.3, boldness: 0.3, startle: -0.4, calm: 0.3 }, [
        b(0, 'watch', { urgency: 0.5 }),
        b(0.3, 'brace', { urgency: 0.7 }),
        b(0.5, 'react', { clip: 'startle', emote: 'exclaim', sound: 'splash', urgency: 0.8 }),
        b(0.72, 'shake', { clip: 'shake', urgency: 0.8 }),
        b(1, 'react', { clip: 'groom' }),
      ]),
    ],
  },
  {
    id: 'butterflyEncounter',
    rare: false,
    weight: 10,
    durationS: [16, 30],
    mechanic: 'flutter',
    props: ['butterfly'],
    minFloorPx: 360,
    minHeightBody: 2.2,
    time: { pref: 'day' },
    needsAwake: true,
    temperament: ['interest', 'playfulness', 'persistence', 'boldness', 'calm', 'energy'],
    pacing: ['persistence'],
    noticeMs: [700, 2600],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.6 },
    interrupt: 'flee',
    recoverMs: 1800,
    minStandoffBody: 0.5,
    outcomes: [
      outcome('watched', 1, false, { calm: 0.5, boldness: -0.3 }, [b(0, 'watch'), b(1, 'react', { emote: 'question', mood: { mood: 'curious', strength: 0.8 } })]),
      outcome('followed', 1, true, { interest: 0.6 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 1.5 }),
        b(0.8, 'watch'),
        b(1, 'react', { emote: 'sparkle', mood: { mood: 'curious', strength: 0.8 } }),
      ]),
      outcome('chased', 0.9, true, { playfulness: 0.7, persistence: 0.4, energy: 0.4 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'walk', standoff: 1.3 }),
        b(0.4, 'chase', { pace: 'run', standoff: 0.9 }),
        b(1, 'react', { emote: 'question', clip: 'sit', mood: { mood: 'curious', strength: 0.8 } }),
      ]),
    ],
  },
  {
    id: 'fallingLeaf',
    rare: false,
    weight: 11,
    durationS: [10, 18],
    mechanic: 'drifter',
    props: ['leaf'],
    minFloorPx: 300,
    minHeightBody: 2.2,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'playfulness', 'calm', 'mischief'],
    pacing: [],
    noticeMs: [800, 2400],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.35 },
    interrupt: 'fade',
    recoverMs: 1200,
    minStandoffBody: 0,
    outcomes: [
      outcome('followed', 1, false, { calm: 0.5, interest: 0.3 }, [b(0, 'watch'), b(1, 'watch')]),
      outcome('tapped', 0.9, true, { playfulness: 0.6, mischief: 0.4 }, [
        b(0, 'watch'),
        b(0.6, 'approach', { pace: 'walk', standoff: 0.8 }),
        b(0.72, 'play', { urgency: 0.2 }),
        SPARKLE_END,
      ]),
      outcome('inspected', 0.8, false, { interest: 0.6, calm: 0.3 }, [b(0, 'watch'), b(0.55, 'approach', { pace: 'slow', standoff: 0.8 }), b(0.7, 'inspect'), b(1, 'watch')]),
    ],
  },
  {
    id: 'yarnTrouble',
    rare: false,
    weight: 8,
    durationS: [16, 28],
    mechanic: 'settler',
    props: ['yarn'],
    minFloorPx: 380,
    minHeightBody: 1,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['playfulness', 'persistence', 'mischief', 'calm', 'interest', 'energy'],
    pacing: ['persistence'],
    noticeMs: [600, 2000],
    canMiss: true,
    mood: { mood: 'excited', strength: 0.5 },
    interrupt: 'fade',
    recoverMs: 1500,
    minStandoffBody: 0,
    outcomes: [
      outcome('played', 1, false, { playfulness: 0.6 }, [b(0, 'watch'), b(0.15, 'approach', { pace: 'walk', standoff: 0.6 }), b(0.3, 'play'), SPARKLE_END]),
      outcome('tangled', 0.8, true, { mischief: 0.5, playfulness: 0.4, calm: -0.3 }, [
        b(0, 'watch'),
        b(0.12, 'approach', { pace: 'walk', standoff: 0.6 }),
        b(0.3, 'play'),
        b(0.62, 'react', { clip: 'confused', emote: 'question', urgency: 0.3 }),
        b(0.8, 'react', { clip: 'rollOver', urgency: 0.3 }),
        b(1, 'react', { clip: 'groom' }),
      ]),
      outcome('rolled', 0.8, false, { energy: 0.4, persistence: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.7 }),
        b(0.45, 'chase', { pace: 'run', standoff: 0.6 }),
        SPARKLE_END,
      ]),
    ],
  },
  {
    id: 'littleGhost',
    rare: false,
    weight: 6,
    durationS: [14, 24],
    mechanic: 'visitor',
    props: ['ghost', 'sparkle'],
    minFloorPx: 420,
    minHeightBody: 2.2,
    time: { pref: 'night' },
    needsAwake: true,
    temperament: ['startle', 'boldness', 'interest', 'mischief', 'calm'],
    pacing: [],
    noticeMs: [900, 2400],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.4 },
    interrupt: 'dissolve',
    recoverMs: 1600,
    minStandoffBody: 0,
    outcomes: [
      outcome('startled', 0.9, true, { startle: 0.7, calm: -0.3, boldness: -0.3 }, [
        b(0, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.55, mood: { mood: 'startled', strength: 0.7 } }),
        b(0.25, 'hide', { urgency: 0.4 }),
        b(0.8, 'watch'),
        QUESTION_END,
      ]),
      outcome('hid', 0.7, false, { startle: 0.4, boldness: -0.7 }, [b(0, 'hide', { urgency: 0.45 }), b(0.85, 'watch'), b(1, 'react', { emote: 'question' })]),
      outcome('investigated', 1, true, { interest: 0.6, boldness: 0.5, mischief: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 1.4 }),
        b(0.55, 'inspect'),
        QUESTION_END,
      ]),
      outcome('approached', 0.8, true, { boldness: 0.6, calm: 0.3 }, [b(0, 'watch'), b(0.3, 'approach', { pace: 'walk', standoff: 1.1 }), b(0.7, 'watch'), b(1, 'react', { emote: 'heart' })]),
    ],
  },
  {
    id: 'boxAppears',
    rare: false,
    weight: 9,
    durationS: [18, 34],
    mechanic: 'settler',
    props: ['box'],
    minFloorPx: 420,
    minHeightBody: 1,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'playfulness', 'calm', 'mischief', 'boldness'],
    pacing: ['calm'],
    noticeMs: [800, 2600],
    canMiss: true,
    mood: { mood: 'relaxed', strength: 0.5 },
    interrupt: 'fade',
    recoverMs: 1500,
    minStandoffBody: 0,
    outcomes: [
      outcome('investigated', 1, false, { interest: 0.6 }, [b(0, 'watch'), b(0.18, 'approach', { pace: 'walk', standoff: 0.7 }), b(0.35, 'inspect'), b(1, 'watch')]),
      outcome('entered', 1, true, { playfulness: 0.4, mischief: 0.5, calm: 0.2 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'walk', standoff: 0.1 }),
        b(0.4, 'settle', { clip: 'sit', urgency: 0.2 }),
        b(0.8, 'settle', { clip: 'loaf', urgency: 0.2 }),
        b(1, 'settle', { clip: 'loaf', urgency: 0.2 }),
      ]),
      outcome('restedBeside', 0.8, true, { calm: 0.6, playfulness: -0.2 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 1.0 }),
        b(0.4, 'settle', { clip: 'loaf', urgency: 0.2 }),
        b(1, 'settle', { clip: 'loaf', urgency: 0.2 }),
      ]),
    ],
  },
  {
    id: 'mysteriousBall',
    rare: false,
    weight: 9,
    durationS: [14, 24],
    mechanic: 'settler',
    props: ['ball'],
    minFloorPx: 460,
    minHeightBody: 1,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['playfulness', 'persistence', 'mischief', 'calm', 'boldness', 'energy'],
    pacing: ['persistence'],
    noticeMs: [500, 1800],
    canMiss: true,
    mood: { mood: 'excited', strength: 0.4 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 0.8, false, { calm: 0.5, boldness: -0.3 }, [b(0, 'watch'), b(1, 'watch')]),
      outcome('tapped', 1, true, { playfulness: 0.5, mischief: 0.4 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.7 }),
        b(0.42, 'play', { urgency: 0.25 }),
        b(0.7, 'watch'),
        SPARKLE_END,
      ]),
      outcome('chased', 0.9, true, { energy: 0.5, persistence: 0.5, playfulness: 0.4 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'walk', standoff: 0.9 }),
        b(0.4, 'chase', { pace: 'run', standoff: 0.6 }),
        b(0.85, 'watch'),
        SPARKLE_END,
      ]),
    ],
  },
  {
    id: 'thunderstorm',
    rare: false,
    weight: 4,
    durationS: [14, 24],
    mechanic: 'weather',
    props: ['cloud', 'raindrop', 'bolt'],
    minFloorPx: 420,
    minHeightBody: 3.2,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['startle', 'calm', 'boldness', 'playfulness'],
    pacing: [],
    noticeMs: [500, 1200],
    canMiss: false,
    mood: { mood: 'scared', strength: 0.5 },
    interrupt: 'fade',
    recoverMs: 2200,
    minStandoffBody: 0,
    outcomes: [
      outcome('hid', 1, true, { startle: 0.8, calm: -0.5, boldness: -0.4 }, [
        b(0, 'watch', { urgency: 0.3 }),
        b(0.5, 'react', { clip: 'startle', emote: 'exclaim', sound: 'rumble', urgency: 0.85, mood: { mood: 'scared', strength: 0.8 } }),
        b(0.56, 'hide', { urgency: 0.6 }),
        b(0.78, 'hide', { urgency: 0.45, sound: 'rumble' }),
        b(1, 'react', { emote: 'question', clip: 'sit' }),
      ]),
      outcome('calm', 1, true, { calm: 0.8, startle: -0.6, boldness: 0.3 }, [
        b(0, 'watch'),
        b(0.5, 'react', { emote: 'question', sound: 'rumble', urgency: 0.7, mood: { mood: 'relaxed', strength: 0.5 } }),
        b(0.6, 'settle', { clip: 'sit', urgency: 0.3 }),
        b(0.78, 'settle', { clip: 'sit', urgency: 0.3, sound: 'rumble' }),
        b(1, 'react', { emote: 'heart', clip: 'yawn' }),
      ]),
      outcome('startled', 0.9, false, { startle: 0.5 }, [
        b(0, 'watch'),
        b(0.5, 'react', { clip: 'startle', emote: 'exclaim', sound: 'rumble', urgency: 0.85 }),
        b(0.6, 'brace', { urgency: 0.5 }),
        b(0.78, 'brace', { urgency: 0.4, sound: 'rumble' }),
        b(1, 'react', { clip: 'sit' }),
      ]),
    ],
  },
  {
    id: 'flyingFish',
    rare: false,
    weight: 6,
    durationS: [5, 8],
    mechanic: 'drifter',
    props: ['fish', 'splash'],
    minFloorPx: 560,
    minHeightBody: 2.8,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'startle', 'playfulness', 'boldness', 'calm', 'energy'],
    pacing: [],
    noticeMs: [300, 900],
    canMiss: true,
    mood: { mood: 'excited', strength: 0.45 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('startled', 0.8, false, { startle: 0.6, calm: -0.3 }, [
        b(0, 'watch', { urgency: 0.4 }),
        b(0.5, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.5 }),
        b(1, 'react', { clip: 'sit', emote: 'question', sound: 'splash' }),
      ]),
      outcome('watched', 1, false, { calm: 0.5, interest: 0.2 }, [b(0, 'watch'), b(1, 'react', { emote: 'question', sound: 'splash' })]),
      outcome('hopped', 0.8, true, { playfulness: 0.6, energy: 0.4, boldness: 0.3 }, [
        b(0, 'watch'),
        b(0.35, 'hop', { urgency: 0.3 }),
        b(0.6, 'watch'),
        b(1, 'react', { emote: 'question', sound: 'splash' }),
      ]),
    ],
  },
  {
    id: 'tinyUfo',
    rare: false,
    weight: 5,
    durationS: [12, 20],
    mechanic: 'drifter',
    props: ['ufo'],
    minFloorPx: 560,
    minHeightBody: 3.2,
    time: { pref: 'night' },
    needsAwake: true,
    temperament: ['interest', 'startle', 'boldness', 'calm', 'energy'],
    pacing: [],
    noticeMs: [700, 2000],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.5 },
    interrupt: 'fade',
    recoverMs: 1500,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, false, { calm: 0.5, interest: 0.3 }, [b(0, 'watch'), b(1, 'react', { emote: 'question' })]),
      outcome('followed', 0.9, true, { interest: 0.6, boldness: 0.3, energy: 0.3 }, [
        b(0, 'watch'),
        b(0.25, 'approach', { pace: 'walk', standoff: 0.5 }),
        b(0.8, 'watch'),
        SPARKLE_END,
      ]),
      outcome('startled', 0.5, false, { startle: 0.7, boldness: -0.3 }, [
        b(0, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.5 }),
        b(0.2, 'watch'),
        b(1, 'react', { emote: 'question' }),
      ]),
    ],
  },
  {
    id: 'windGust',
    rare: false,
    weight: 7,
    durationS: [6, 10],
    mechanic: 'weather',
    props: ['windStreak', 'leaf', 'paperPlane'],
    minFloorPx: 520,
    minHeightBody: 2,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['calm', 'startle', 'interest', 'playfulness', 'boldness', 'mischief'],
    pacing: [],
    noticeMs: [400, 1200],
    canMiss: false,
    mood: { mood: 'startled', strength: 0.3 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('braced', 1, false, { calm: 0.3, startle: 0.2, boldness: -0.2 }, [
        b(0, 'watch', { urgency: 0.3 }),
        b(0.35, 'brace', { urgency: 0.65, clip: 'crouch' }),
        b(0.7, 'watch'),
        b(1, 'react', { clip: 'sit' }),
      ]),
      outcome('reacted', 0.9, false, { startle: 0.5, mischief: 0.2 }, [
        b(0, 'watch'),
        b(0.4, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.5 }),
        b(0.55, 'brace', { urgency: 0.5 }),
        b(1, 'react', { clip: 'groom' }),
      ]),
      outcome('followed', 0.8, true, { interest: 0.6, playfulness: 0.5 }, [
        b(0, 'watch'),
        b(0.3, 'approach', { pace: 'walk', standoff: 0.9 }),
        b(0.6, 'play'),
        SPARKLE_END,
      ]),
    ],
  },
  {
    id: 'paperPlane',
    rare: false,
    weight: 8,
    durationS: [9, 16],
    mechanic: 'drifter',
    props: ['paperPlane'],
    minFloorPx: 520,
    minHeightBody: 2.2,
    time: { pref: 'day' },
    needsAwake: true,
    temperament: ['interest', 'playfulness', 'persistence', 'calm', 'boldness', 'energy'],
    pacing: ['persistence'],
    noticeMs: [500, 1800],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.4 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, false, { calm: 0.4 }, [b(0, 'watch'), b(1, 'watch')]),
      outcome('chased', 0.9, true, { playfulness: 0.6, persistence: 0.4, energy: 0.3 }, [
        b(0, 'watch'),
        b(0.12, 'chase', { pace: 'run', standoff: 0.8 }),
        b(0.7, 'watch'),
        SPARKLE_END,
      ]),
      outcome('inspected', 0.9, true, { interest: 0.6, boldness: 0.2 }, [
        b(0, 'watch'),
        b(0.6, 'approach', { pace: 'walk', standoff: 0.8 }),
        b(0.75, 'inspect'),
        QUESTION_END,
      ]),
    ],
  },
  {
    id: 'magicSparkles',
    rare: false,
    weight: 7,
    durationS: [10, 18],
    mechanic: 'drifter',
    props: ['sparkle'],
    minFloorPx: 360,
    minHeightBody: 1.5,
    time: { pref: 'night' },
    needsAwake: true,
    temperament: ['interest', 'playfulness', 'mischief', 'calm', 'boldness'],
    pacing: [],
    noticeMs: [600, 2000],
    canMiss: true,
    mood: { mood: 'excited', strength: 0.4 },
    interrupt: 'dissolve',
    recoverMs: 1200,
    minStandoffBody: 0,
    outcomes: [
      outcome('reached', 1, true, { playfulness: 0.5, interest: 0.4 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 0.6 }),
        b(0.4, 'play', { clip: 'pawAt' }),
        SPARKLE_END,
      ]),
      outcome('watched', 0.9, false, { calm: 0.5 }, [b(0, 'watch'), SPARKLE_END]),
      outcome('sniffed', 0.8, false, { interest: 0.5, boldness: 0.2 }, [b(0, 'watch'), b(0.25, 'approach', { pace: 'slow', standoff: 0.7 }), b(0.5, 'inspect'), b(1, 'watch')]),
    ],
  },
  {
    id: 'shadowVisitor',
    rare: false,
    weight: 5,
    durationS: [14, 24],
    mechanic: 'visitor',
    props: ['shadow'],
    minFloorPx: 460,
    minHeightBody: 1,
    time: { pref: 'night' },
    needsAwake: true,
    temperament: ['startle', 'boldness', 'interest', 'calm', 'mischief'],
    pacing: [],
    noticeMs: [1000, 3000],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.35 },
    interrupt: 'fade',
    recoverMs: 1500,
    minStandoffBody: 0,
    outcomes: [
      outcome('investigated', 1, true, { interest: 0.5, boldness: 0.6 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 1.3 }),
        b(0.5, 'inspect'),
        QUESTION_END,
      ]),
      outcome('cautious', 1, false, { boldness: -0.6, startle: 0.3, calm: 0.2 }, [
        b(0, 'watch'),
        b(0.25, 'flee', { pace: 'slow' }),
        b(0.5, 'brace', { urgency: 0.3 }),
        b(1, 'react', { emote: 'question' }),
      ]),
      outcome('startled', 0.5, false, { startle: 0.7 }, [
        b(0, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.5 }),
        b(0.2, 'hide', { urgency: 0.4 }),
        b(0.8, 'watch'),
        b(1, 'react', { clip: 'sit' }),
      ]),
    ],
  },
  {
    id: 'toySpring',
    rare: false,
    weight: 8,
    durationS: [12, 22],
    mechanic: 'settler',
    props: ['spring'],
    minFloorPx: 420,
    minHeightBody: 1.8,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['playfulness', 'persistence', 'mischief', 'interest', 'calm', 'boldness', 'energy'],
    pacing: ['persistence'],
    noticeMs: [400, 1500],
    canMiss: true,
    mood: { mood: 'excited', strength: 0.55 },
    interrupt: 'fade',
    recoverMs: 1400,
    minStandoffBody: 0,
    outcomes: [
      outcome('played', 1, true, { playfulness: 0.7, mischief: 0.3 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'walk', standoff: 0.7 }),
        b(0.3, 'play'),
        b(0.75, 'play', { clip: 'pawAt' }),
        SPARKLE_END,
      ]),
      outcome('watched', 0.7, false, { calm: 0.5 }, [b(0, 'watch'), b(1, 'react', { emote: 'question' })]),
      outcome('hopped', 0.8, false, { energy: 0.5, boldness: 0.3 }, [b(0, 'watch'), b(0.3, 'hop'), b(0.5, 'hop'), SPARKLE_END]),
    ],
  },
  {
    id: 'bubbleParty',
    rare: false,
    weight: 8,
    durationS: [9, 16],
    mechanic: 'drifter',
    props: ['bubble'],
    minFloorPx: 380,
    minHeightBody: 2.4,
    time: { pref: 'day' },
    needsAwake: true,
    temperament: ['playfulness', 'interest', 'calm', 'mischief', 'energy'],
    pacing: [],
    noticeMs: [400, 1400],
    canMiss: true,
    mood: { mood: 'happy', strength: 0.5 },
    interrupt: 'pop',
    recoverMs: 1200,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 0.8, false, { calm: 0.5 }, [b(0, 'watch'), SPARKLE_END]),
      outcome('popped', 1, true, { playfulness: 0.6, mischief: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.5 }),
        b(0.35, 'play', { clip: 'pawAt' }),
        SPARKLE_END,
      ]),
      outcome('hopped', 0.9, false, { energy: 0.5, playfulness: 0.4 }, [b(0, 'watch'), b(0.25, 'hop'), b(0.5, 'hop'), b(0.75, 'play'), SPARKLE_END]),
    ],
  },
  {
    id: 'curiousBird',
    rare: false,
    weight: 8,
    durationS: [14, 26],
    mechanic: 'hopper',
    props: ['bird'],
    minFloorPx: 460,
    minHeightBody: 2.4,
    time: { pref: 'day' },
    needsAwake: true,
    temperament: ['interest', 'boldness', 'persistence', 'mischief', 'calm', 'playfulness', 'energy'],
    pacing: ['persistence'],
    noticeMs: [600, 2000],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.5 },
    interrupt: 'flee',
    recoverMs: 1600,
    minStandoffBody: 0.6,
    outcomes: [
      outcome('watched', 1, false, { calm: 0.5, boldness: -0.3 }, [b(0, 'watch'), QUESTION_END]),
      outcome('followed', 0.9, true, { interest: 0.5, boldness: 0.4, mischief: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'sneak', { pace: 'slow', standoff: 1.5 }),
        b(0.7, 'sneak', { pace: 'slow', standoff: 1.0 }),
        b(1, 'react', { emote: 'question' }),
      ]),
      outcome('chattered', 0.7, true, { playfulness: 0.4, interest: 0.4, energy: 0.3 }, [
        b(0, 'watch'),
        b(0.25, 'react', { clip: 'meow', sound: 'chirp', emote: 'note', urgency: 0.2 }),
        b(0.6, 'watch'),
        b(1, 'react', { emote: 'question' }),
      ]),
    ],
  },
  {
    id: 'fallingStar',
    rare: false,
    weight: 6,
    durationS: [6, 9],
    mechanic: 'drifter',
    props: ['star', 'sparkle'],
    minFloorPx: 420,
    minHeightBody: 2.4,
    time: { pref: 'night' },
    needsAwake: false,
    temperament: ['interest', 'calm', 'playfulness', 'startle'],
    pacing: [],
    noticeMs: [600, 2200],
    canMiss: true,
    mood: { mood: 'relaxed', strength: 0.5 },
    interrupt: 'fade',
    recoverMs: 1800,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, false, { interest: 0.4, calm: 0.3 }, [b(0, 'watch'), SPARKLE_END]),
      outcome('wished', 0.7, true, { calm: 0.6, playfulness: -0.2 }, [b(0, 'watch'), b(0.5, 'settle', { clip: 'sit' }), b(1, 'react', { emote: 'heart', clip: 'sit' })]),
      outcome('amazed', 0.7, true, { interest: 0.6, startle: 0.2 }, [b(0, 'watch'), b(0.45, 'react', { clip: 'meow', emote: 'exclaim', urgency: 0.25 }), SPARKLE_END]),
    ],
  },
  {
    id: 'tinyTreasure',
    rare: false,
    weight: 6,
    durationS: [14, 24],
    mechanic: 'settler',
    props: ['treasure', 'sparkle'],
    minFloorPx: 380,
    minHeightBody: 1.5,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'mischief', 'boldness', 'calm'],
    pacing: [],
    noticeMs: [700, 2200],
    canMiss: true,
    mood: { mood: 'happy', strength: 0.5 },
    interrupt: 'dissolve',
    recoverMs: 1400,
    minStandoffBody: 0,
    // The outcome IS the object found (it picks the prop's variant): coin, gem, shell, button.
    outcomes: [
      outcome('coin', 1, true, undefined, treasureBeats()),
      outcome('gem', 1, true, undefined, treasureBeats()),
      outcome('shell', 1, true, undefined, treasureBeats()),
      outcome('button', 1, true, undefined, treasureBeats()),
    ],
  },
];

const RARE: readonly EventDef[] = [
  {
    id: 'goldenButterfly',
    rare: true,
    weight: 4,
    durationS: [34, 55],
    mechanic: 'flutter',
    props: ['goldenButterfly', 'sparkle'],
    minFloorPx: 460,
    minHeightBody: 2.4,
    time: { pref: 'day' },
    needsAwake: true,
    temperament: ['interest', 'calm', 'playfulness', 'boldness', 'energy'],
    pacing: ['calm'],
    noticeMs: [500, 1400],
    canMiss: false,
    mood: { mood: 'happy', strength: 0.8 },
    interrupt: 'dissolve',
    recoverMs: 2500,
    minStandoffBody: 0.5,
    outcomes: [
      outcome('watched', 1, true, { calm: 0.5 }, [b(0, 'watch'), b(1, 'react', { emote: 'sparkle' })]),
      outcome('followed', 1, true, { interest: 0.6 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'slow', standoff: 1.4 }),
        b(0.7, 'watch'),
        b(1, 'react', { emote: 'heart' }),
      ]),
      outcome('danced', 0.6, true, { playfulness: 0.7, energy: 0.5 }, [
        b(0, 'watch'),
        b(0.15, 'approach', { pace: 'slow', standoff: 1.2 }),
        b(0.3, 'hop', { urgency: 0.2 }),
        b(0.5, 'play'),
        b(1, 'react', { emote: 'heart' }),
      ]),
    ],
  },
  {
    id: 'treasureDiscovery',
    rare: true,
    weight: 4,
    durationS: [22, 36],
    mechanic: 'settler',
    props: ['treasure', 'sparkle'],
    minFloorPx: 520,
    minHeightBody: 2.2,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['interest', 'mischief', 'boldness', 'playfulness', 'calm'],
    pacing: [],
    noticeMs: [800, 2200],
    canMiss: false,
    mood: { mood: 'excited', strength: 0.8 },
    interrupt: 'dissolve',
    recoverMs: 2000,
    minStandoffBody: 0,
    outcomes: [
      outcome('opened', 1, true, { boldness: 0.5, interest: 0.4 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.8 }),
        b(0.42, 'inspect', { urgency: 0.3 }),
        b(0.5, 'react', { emote: 'sparkle', sound: 'chime', urgency: 0.3 }),
        b(0.7, 'play'),
        b(1, 'react', { emote: 'heart' }),
      ]),
      outcome('sniffed', 0.8, true, { calm: 0.4 }, [
        b(0, 'watch'),
        b(0.25, 'approach', { pace: 'slow', standoff: 0.9 }),
        b(0.42, 'inspect'),
        b(0.5, 'react', { emote: 'sparkle', sound: 'chime', urgency: 0.3 }),
        b(1, 'watch'),
      ]),
      outcome('pawed', 0.8, true, { playfulness: 0.5, mischief: 0.5 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.8 }),
        b(0.42, 'play', { clip: 'pawAt' }),
        b(0.5, 'react', { emote: 'sparkle', sound: 'chime', urgency: 0.3 }),
        SPARKLE_END,
      ]),
    ],
  },
  {
    id: 'friendlyGhost',
    rare: true,
    weight: 3,
    durationS: [20, 34],
    mechanic: 'visitor',
    props: ['ghost', 'sparkle'],
    minFloorPx: 420,
    minHeightBody: 2.2,
    time: { pref: 'night' },
    needsAwake: true,
    temperament: ['interest', 'boldness', 'calm', 'playfulness', 'mischief'],
    pacing: ['calm'],
    noticeMs: [800, 2000],
    canMiss: false,
    mood: { mood: 'happy', strength: 0.6 },
    interrupt: 'dissolve',
    recoverMs: 2200,
    minStandoffBody: 0,
    outcomes: [
      outcome('befriended', 1, true, { boldness: 0.5, calm: 0.4, interest: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'slow', standoff: 1.0 }),
        b(0.5, 'settle', { clip: 'sit', urgency: 0.2 }),
        b(1, 'react', { emote: 'heart', clip: 'sit' }),
      ]),
      outcome('watched', 0.8, true, { calm: 0.4, boldness: -0.3 }, [b(0, 'watch'), b(1, 'react', { emote: 'sparkle' })]),
      outcome('played', 0.8, true, { playfulness: 0.6, mischief: 0.4 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 1.0 }),
        b(0.4, 'play', { clip: 'pawAt' }),
        b(0.7, 'hop'),
        b(1, 'react', { emote: 'heart' }),
      ]),
    ],
  },
  {
    id: 'meteorShower',
    rare: true,
    weight: 4,
    durationS: [12, 18],
    mechanic: 'drifter',
    props: ['meteor', 'sparkle'],
    minFloorPx: 520,
    minHeightBody: 3,
    time: { pref: 'night' },
    needsAwake: false,
    skipReduced: true,
    temperament: ['interest', 'calm'],
    pacing: ['calm'],
    noticeMs: [800, 2500],
    canMiss: true,
    mood: { mood: 'relaxed', strength: 0.7 },
    interrupt: 'fade',
    recoverMs: 2200,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, true, { calm: 0.5, interest: 0.3 }, [b(0, 'watch'), SPARKLE_END]),
      outcome('wished', 0.8, true, { calm: 0.5, interest: 0.2 }, [b(0, 'watch'), b(0.35, 'settle', { clip: 'sit' }), b(1, 'react', { emote: 'heart' })]),
      outcome('amazed', 0.6, true, { interest: 0.6 }, [
        b(0, 'watch'),
        b(0.3, 'react', { clip: 'meow', emote: 'exclaim', urgency: 0.25 }),
        b(0.6, 'watch'),
        SPARKLE_END,
      ]),
    ],
  },
  {
    id: 'tinyDragon',
    rare: true,
    weight: 3,
    durationS: [20, 32],
    mechanic: 'visitor',
    props: ['dragon', 'sparkle'],
    minFloorPx: 520,
    minHeightBody: 3,
    time: { pref: 'any' },
    needsAwake: true,
    temperament: ['boldness', 'startle', 'playfulness', 'interest', 'calm', 'energy'],
    pacing: ['persistence'],
    noticeMs: [700, 1800],
    canMiss: false,
    mood: { mood: 'excited', strength: 0.6 },
    interrupt: 'flee',
    recoverMs: 2000,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, true, { calm: 0.4, boldness: -0.2 }, [b(0, 'watch'), b(1, 'react', { emote: 'sparkle' })]),
      outcome('played', 1, true, { playfulness: 0.6, boldness: 0.4, energy: 0.3 }, [
        b(0, 'watch'),
        b(0.2, 'approach', { pace: 'walk', standoff: 0.9 }),
        b(0.4, 'play', { clip: 'pawAt' }),
        b(0.7, 'hop'),
        b(1, 'react', { emote: 'heart' }),
      ]),
      outcome('startled', 0.5, true, { startle: 0.7, boldness: -0.4 }, [
        b(0, 'react', { clip: 'startle', emote: 'exclaim', urgency: 0.5 }),
        b(0.2, 'watch'),
        b(1, 'react', { emote: 'question' }),
      ]),
    ],
  },
  {
    id: 'midnightVisitor',
    rare: true,
    weight: 3,
    durationS: [20, 32],
    mechanic: 'visitor',
    props: ['visitor'],
    minFloorPx: 460,
    minHeightBody: 1,
    time: { pref: 'night', strict: [22, 5] },
    needsAwake: true,
    temperament: ['boldness', 'interest', 'calm', 'startle'],
    pacing: [],
    noticeMs: [1000, 3000],
    canMiss: true,
    mood: { mood: 'curious', strength: 0.4 },
    interrupt: 'fade',
    recoverMs: 2000,
    minStandoffBody: 0,
    outcomes: [
      outcome('watched', 1, true, { calm: 0.4 }, [b(0, 'watch'), b(1, 'react', { emote: 'question' })]),
      outcome('greeted', 1, true, { boldness: 0.5, interest: 0.5, calm: 0.2 }, [
        b(0, 'watch'),
        b(0.25, 'approach', { pace: 'slow', standoff: 1.2 }),
        b(0.55, 'react', { clip: 'meow', emote: 'heart', urgency: 0.2 }),
        SPARKLE_END,
      ]),
      outcome('hid', 0.8, true, { boldness: -0.7, startle: 0.5 }, [b(0, 'hide', { urgency: 0.4 }), b(0.85, 'watch'), b(1, 'react', { emote: 'question' })]),
    ],
  },
];

/** Every event, keyed by id. */
export const EVENT_CATALOG: Readonly<Record<AnyEventId, EventDef>> = Object.fromEntries([...NORMAL, ...RARE].map((d) => [d.id, d])) as Record<AnyEventId, EventDef>;

export function eventDef(id: AnyEventId): EventDef | undefined {
  return EVENT_CATALOG[id];
}

/** The ids of each pool, in catalogue order. */
export const NORMAL_POOL: readonly AnyEventId[] = ALL_EVENT_IDS.filter((id) => !(RARE_EVENT_IDS as readonly string[]).includes(id));
export const RARE_POOL: readonly AnyEventId[] = RARE_EVENT_IDS;

/** Is this outcome worth a journal line? Unknown outcomes ('cut', 'unnoticed') never are. */
export function isJournalWorthy(def: EventDef, outcomeId: OutcomeId): boolean {
  return def.outcomes.find((o) => o.id === outcomeId)?.journal === true;
}
