// The animation metadata contract (Living Companion). One declarative table that says, for every clip
// the renderer can draw: its posture, whether it loops, how long a one-shot runs, whether it may be
// interrupted, what it needs from the world, which gait it is, and how big it is. On top of the table:
// a deterministic posture-transition model (which clip may follow which, and the neutral clips that
// bridge two postures) and a graceful-fallback resolver, so the brain can never ask for a pose that
// does not exist on a platform. Pure data and pure functions: platform-agnostic (ESLint-enforced for
// src/shared), no DOM, no Node. The drawing itself stays in src/renderer/overlay/cat/clips.ts; a
// renderer test cross-checks that every AnimClip has an entry here (the Record type enforces it at
// compile time too).
import { ANIM_CLIPS, GAIT_LIMIT_DIP, ONE_SHOT_CLIPS, type AnimClip, type GaitClip } from './cat';

export type Posture = 'stand' | 'sit' | 'lie' | 'crouch' | 'air' | 'wall' | 'held';

/** What a clip needs underneath the cat. 'floor' is every platform; 'wall' (screen edge or window side) and 'ledge' are not. */
export type ClipSupport = 'floor' | 'ledge' | 'wall' | 'air' | 'held';

export const CLIP_TAGS = ['rest', 'bodyCare', 'locomotion', 'emotion', 'play', 'reaction', 'environment', 'physics'] as const;
export type ClipTag = (typeof CLIP_TAGS)[number];

export interface ClipMeta {
  readonly posture: Posture;
  /** Plays until the brain changes clip. */
  readonly loop: boolean;
  /** One-shot length in seconds (non-looping clips), null for loops. */
  readonly durationS: number | null;
  /** May the brain cut it short? Physical clips and short reactions are not interruptible. */
  readonly interruptible: boolean;
  /** 0 ambient .. 3 physical: a higher priority is never replaced by a lower one without its completion. */
  readonly priority: 0 | 1 | 2 | 3;
  /** Cross-fade into this clip, ms. */
  readonly fadeInMs: number;
  /** Supports the clip may play on; the first entry is the preferred one. */
  readonly support: readonly ClipSupport[];
  /** Locomotion clips: which gait limit (DIP/s at size 1) caps their anchor speed. */
  readonly gait?: GaitClip;
  readonly tags: readonly ClipTag[];
  /** Nominal visual footprint at size 1, DIP (the renderer's exact hit region is separate). */
  readonly footprintDip: { readonly width: number; readonly height: number };
  /** Entry and exit conditions, for humans and the docs (the sim enforces them in code). */
  readonly entry: string;
  readonly exit: string;
}

const W = 84;
const H = 64;
const fp = (width = W, height = H) => ({ width, height });

type Opt = Partial<Omit<ClipMeta, 'posture' | 'loop' | 'durationS' | 'entry' | 'exit'>> & { entry?: string; exit?: string };
const loop = (posture: Posture, o: Opt = {}): ClipMeta => ({
  posture,
  loop: true,
  durationS: null,
  interruptible: true,
  priority: 0,
  fadeInMs: 200,
  support: ['floor', 'ledge'],
  tags: ['rest'],
  footprintDip: fp(),
  entry: 'any time the sim selects it',
  exit: 'the sim selects another clip',
  ...o,
});
const once = (posture: Posture, durationS: number, o: Opt = {}): ClipMeta => ({
  posture,
  loop: false,
  durationS,
  interruptible: true,
  priority: 1,
  fadeInMs: 120,
  support: ['floor', 'ledge'],
  tags: ['reaction'],
  footprintDip: fp(),
  entry: 'selected by a sim phase',
  exit: 'completes, then holds its last pose until the sim selects another clip',
  ...o,
});

export const CLIP_META: Readonly<Record<AnimClip, ClipMeta>> = {
  stand: loop('stand', { tags: ['rest'] }),
  sit: loop('sit', { tags: ['rest'], footprintDip: fp(60, 64) }),
  loaf: loop('lie', { tags: ['rest'], footprintDip: fp(72, 40) }),
  sleep: loop('lie', { tags: ['rest'], fadeInMs: 400, footprintDip: fp(64, 36) }),
  wake: once('lie', 1.6, { tags: ['rest', 'bodyCare'], priority: 1, interruptible: false }),
  yawn: once('sit', 1.2, { tags: ['bodyCare'] }),
  walk: loop('stand', { tags: ['locomotion'], gait: 'walk', fadeInMs: 160 }),
  run: loop('stand', { tags: ['locomotion'], gait: 'run', fadeInMs: 140, footprintDip: fp(100, 56) }),
  crouch: loop('crouch', { tags: ['play'], fadeInMs: 140, footprintDip: fp(84, 40) }),
  jump: loop('air', { tags: ['locomotion', 'physics'], priority: 3, interruptible: false, support: ['air'], footprintDip: fp(90, 70) }),
  fall: loop('air', { tags: ['physics'], priority: 3, interruptible: false, support: ['air'], footprintDip: fp(80, 72) }),
  land: once('stand', 0.25, { tags: ['physics'], priority: 3, interruptible: false, support: ['floor', 'ledge'] }),
  startle: once('stand', 0.8, { tags: ['emotion', 'reaction'], priority: 2, interruptible: false }),
  annoyed: loop('sit', { tags: ['emotion'], priority: 1 }),
  petted: loop('sit', { tags: ['emotion'], priority: 2 }),
  groom: loop('sit', { tags: ['bodyCare'] }),
  pawAt: loop('sit', { tags: ['play'], footprintDip: fp(96, 60) }),
  held: loop('held', { tags: ['physics'], priority: 3, interruptible: false, support: ['held'], fadeInMs: 60 }),
  meow: once('sit', 0.9, { tags: ['emotion'] }),
  hide: loop('crouch', { tags: ['emotion'], priority: 1, footprintDip: fp(80, 34) }),
  rollOver: loop('lie', { tags: ['play', 'emotion'], footprintDip: fp(80, 48) }),
  climb: loop('wall', { tags: ['locomotion', 'environment'], gait: 'climb', support: ['wall'], priority: 2, footprintDip: fp(40, 84), exit: 'the sim ends the wall manoeuvre' }),
  stalk: loop('crouch', { tags: ['locomotion', 'play'], gait: 'stalk', footprintDip: fp(92, 34) }),
  sprint: loop('stand', { tags: ['locomotion'], gait: 'sprint', fadeInMs: 120, footprintDip: fp(110, 52) }),
  pounce: loop('air', { tags: ['play', 'physics'], priority: 3, interruptible: false, support: ['air'], footprintDip: fp(110, 56) }),
  slip: once('air', 0.9, { tags: ['physics', 'environment'], priority: 3, interruptible: false, support: ['ledge', 'wall'] }),
  impact: once('stand', 0.45, { tags: ['physics'], priority: 3, interruptible: false }),
  landRecover: once('sit', 0.9, { tags: ['physics', 'bodyCare'], priority: 2, interruptible: false }),
  swat: once('sit', 0.45, { tags: ['play', 'reaction'], priority: 2, interruptible: false, footprintDip: fp(108, 60) }),
  hiss: once('stand', 1.2, { tags: ['emotion', 'reaction'], priority: 2, interruptible: false }),
  grumpy: loop('sit', { tags: ['emotion'], priority: 1 }),
  slink: loop('stand', { tags: ['locomotion', 'emotion'], gait: 'slink', footprintDip: fp(96, 44) }),
  stretch: once('stand', 1.6, { tags: ['bodyCare'] }),
  balance: loop('crouch', { tags: ['environment', 'physics'], priority: 2, support: ['ledge', 'wall'] }),
  tailChase: loop('sit', { tags: ['play'], footprintDip: fp(72, 64) }),
  edgeSit: loop('sit', { tags: ['environment'], support: ['ledge'], footprintDip: fp(60, 64) }),
  scratch: loop('sit', { tags: ['bodyCare'], footprintDip: fp(72, 64) }),
  shake: once('stand', 1.1, { tags: ['bodyCare', 'reaction'], priority: 2, interruptible: false }),
  confused: loop('sit', { tags: ['emotion'], footprintDip: fp(64, 64) }),
};

// ---- the posture transition model ------------------------------------------------------------

/** Direct posture moves that need no bridge. Anything else goes through the neutral clips on the shortest path. */
const POSTURE_EDGES: Readonly<Record<Posture, readonly Posture[]>> = {
  lie: ['sit'],
  sit: ['lie', 'stand', 'crouch'],
  stand: ['sit', 'crouch', 'air', 'wall'],
  crouch: ['sit', 'stand', 'air'],
  air: ['stand'], // landing: the 'land' one-shot is the bridge
  wall: ['stand', 'air'],
  held: ['air'],
};

/** The neutral clip that represents a posture when a path needs to pass through it. */
export const POSTURE_NEUTRAL: Readonly<Record<Posture, AnimClip>> = {
  stand: 'stand',
  sit: 'sit',
  lie: 'loaf',
  crouch: 'crouch',
  air: 'fall',
  wall: 'climb',
  held: 'held',
};

/** Landing bridges the air to the ground. */
const BRIDGE_OVERRIDE: Partial<Record<`${Posture}>${Posture}`, AnimClip>> = { 'air>stand': 'land' };

/** Shortest posture path from `a` to `b` (inclusive of both), or null if unreachable. Deterministic (BFS in table order). */
export function posturePath(a: Posture, b: Posture): readonly Posture[] | null {
  if (a === b) return [a];
  const prev = new Map<Posture, Posture>();
  const queue: Posture[] = [a];
  const seen = new Set<Posture>([a]);
  while (queue.length > 0) {
    const cur = queue.shift() as Posture;
    for (const n of POSTURE_EDGES[cur]) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      if (n === b) {
        const path: Posture[] = [b];
        let p: Posture | undefined = prev.get(b);
        while (p !== undefined) {
          path.unshift(p);
          p = prev.get(p);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

/**
 * The neutral clips to play between `from` and `to` so no pose pops: [] when the two clips share a
 * posture (they cross-fade directly), the intermediate postures' neutral clips otherwise, or null when no
 * path exists (the caller then keeps the current clip). Physical clips ('jump', 'fall', 'held') are
 * never bridged: the physics, not the brain, ends them.
 */
export function bridgeClips(from: AnimClip, to: AnimClip): readonly AnimClip[] | null {
  const a = CLIP_META[from].posture;
  const b = CLIP_META[to].posture;
  if (a === b) return [];
  const path = posturePath(a, b);
  if (!path) return null;
  const out: AnimClip[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const hop = BRIDGE_OVERRIDE[`${path[i] as Posture}>${path[i + 1] as Posture}`];
    const mid = path[i + 1] as Posture;
    if (hop) out.push(hop);
    else if (i + 1 < path.length - 1) out.push(POSTURE_NEUTRAL[mid]);
  }
  return out;
}

/** May the brain switch from the clip that is playing to `to` right now (elapsedS since the clip started)? */
export function canSwitch(from: AnimClip, to: AnimClip, elapsedS: number): boolean {
  if (from === to) return true;
  const m = CLIP_META[from];
  const t = CLIP_META[to];
  if (m.interruptible) return true;
  if (t.priority > m.priority) return true;
  // A non-interruptible one-shot must finish; a non-interruptible loop (physics) is ended by its owner.
  return m.durationS !== null && elapsedS >= m.durationS;
}

// ---- graceful fallback -----------------------------------------------------------------------

/** What a platform can draw or support. Absent flags mean "yes". */
export interface ClipCapabilities {
  readonly walls?: boolean;
  readonly ledges?: boolean;
}

/** The nearest clip that exists and fits, when a requested one needs something the platform lacks. */
export const CLIP_FALLBACK: Readonly<Partial<Record<AnimClip, AnimClip>>> = {
  climb: 'stand',
  balance: 'stand',
  edgeSit: 'sit',
  slip: 'stand',
  scratch: 'groom',
  shake: 'stand',
  confused: 'sit',
  tailChase: 'sit',
  rollOver: 'loaf',
  stalk: 'walk',
  slink: 'walk',
  sprint: 'run',
  swat: 'pawAt',
  hiss: 'startle',
  grumpy: 'annoyed',
  impact: 'land',
  landRecover: 'stand',
  stretch: 'stand',
};

/** Resolve a requested clip to one that is known and supported (walks the fallback chain; 'stand' is the floor of it). */
export function resolveClip(requested: string, caps: ClipCapabilities = {}): AnimClip {
  let c: AnimClip | undefined = (ANIM_CLIPS as readonly string[]).includes(requested) ? (requested as AnimClip) : undefined;
  for (let hops = 0; hops < 4 && c !== undefined; hops++) {
    const s = CLIP_META[c].support;
    const needsWall = s.length > 0 && s.every((x) => x === 'wall');
    const needsLedge = s.length > 0 && s.every((x) => x === 'ledge' || x === 'wall');
    const blocked = (needsWall && caps.walls === false) || (needsLedge && caps.ledges === false);
    if (!blocked) return c;
    c = CLIP_FALLBACK[c];
  }
  return 'stand';
}

// ---- the behaviour catalogue ----------------------------------------------------------------

/**
 * How each behaviour the product asks for is realised. Honest about it: 'clip' is its own drawn clip,
 * 'variant' a clip plus a procedural layer or render hint, 'alias' an existing clip standing in for
 * it, 'composite' a sequence of clips, 'layer' procedural layers only (ears, tail, pupils, look-at),
 * 'sim' a sim-side phase that selects among the clips. The docs table is generated from this.
 */
export type Realization = 'clip' | 'variant' | 'alias' | 'composite' | 'layer' | 'sim';

export interface BehaviorEntry {
  readonly clip: AnimClip;
  readonly realization: Realization;
  readonly note: string;
}

export const BEHAVIOR_CATALOG = {
  standingIdle: { clip: 'stand', realization: 'clip', note: 'breathing, blinks and tail sway are procedural layers' },
  sittingIdle: { clip: 'sit', realization: 'clip', note: 'head tracks the look target' },
  lyingDown: { clip: 'loaf', realization: 'clip', note: 'paws tucked' },
  sleeping: { clip: 'sleep', realization: 'clip', note: 'curled, slow breathing' },
  deepSleep: { clip: 'sleep', realization: 'variant', note: 'sleepDepth render hint slows breathing, eases the posture and quietens the frame rate' },
  wakingUp: { clip: 'wake', realization: 'clip', note: 'front then back stretch' },
  lookingAround: { clip: 'sit', realization: 'layer', note: 'look-at layer driven by sim glances' },
  tailMovement: { clip: 'stand', realization: 'layer', note: 'procedural tail physics plus the tailFlick reaction' },
  earMovement: { clip: 'stand', realization: 'layer', note: 'procedural ear twitches plus the earFlick reaction' },
  randomIdleVariation: { clip: 'stand', realization: 'sim', note: 'idle episodes pick among sit, loaf, groom, yawn, stretch, look, tail chase' },
  yawning: { clip: 'yawn', realization: 'clip', note: '' },
  stretching: { clip: 'stretch', realization: 'clip', note: '' },
  scratching: { clip: 'scratch', realization: 'clip', note: 'new in the Living Companion release' },
  grooming: { clip: 'groom', realization: 'clip', note: '' },
  washingPaws: { clip: 'groom', realization: 'alias', note: 'the groom clip licks a paw; one clip covers paw washing' },
  cleaningFace: { clip: 'groom', realization: 'alias', note: 'the groom clip wipes the face with the paw' },
  shakingBody: { clip: 'shake', realization: 'clip', note: 'new; also the wet-cat recovery' },
  settlingDown: { clip: 'loaf', realization: 'composite', note: 'sit then loaf through the posture bridge' },
  walking: { clip: 'walk', realization: 'clip', note: '' },
  fastWalking: { clip: 'walk', realization: 'variant', note: 'walk at the top of its gait limit' },
  running: { clip: 'run', realization: 'clip', note: 'sprint for flat-out dashes' },
  sneaking: { clip: 'stalk', realization: 'clip', note: 'slink for retreats' },
  smallJump: { clip: 'jump', realization: 'variant', note: 'jumpKind hop' },
  largeJump: { clip: 'jump', realization: 'variant', note: 'jumpKind up / across / leap where the platform has surfaces' },
  stopping: { clip: 'stand', realization: 'sim', note: 'the mover decelerates before the clip changes' },
  turning: { clip: 'stand', realization: 'layer', note: 'facing flip with a cross-fade' },
  fallingRecovering: { clip: 'fall', realization: 'composite', note: 'fall, land or impact, then landRecover' },
  happy: { clip: 'petted', realization: 'variant', note: 'mood happy: upright tail, soft eyes, optional purr and heart emote' },
  curious: { clip: 'sit', realization: 'variant', note: 'mood curious: forward ears, head tilt reaction, question emote' },
  surprised: { clip: 'startle', realization: 'clip', note: '' },
  startled: { clip: 'startle', realization: 'clip', note: '' },
  scared: { clip: 'hide', realization: 'variant', note: 'hide, slink or hiss by personality' },
  sleepy: { clip: 'sit', realization: 'variant', note: 'mood sleepy: slow blinks, heavy lids, yawn' },
  confused: { clip: 'confused', realization: 'clip', note: 'new' },
  excited: { clip: 'tailChase', realization: 'variant', note: 'mood excited: wide pupils, fast tail; tailChase, rollOver or sprint' },
  mischievous: { clip: 'crouch', realization: 'variant', note: 'mood mischievous: crouch and wiggle, swat, narrowed eyes' },
  relaxed: { clip: 'loaf', realization: 'variant', note: 'mood relaxed: half-closed eyes, slow tail, optional purr' },
  edgeClimbing: { clip: 'climb', realization: 'clip', note: 'screen edges on every platform, window sides on Windows' },
  cornerTransition: { clip: 'climb', realization: 'composite', note: 'floor to wall through the sim wall manoeuvre (balance at the top corner)' },
  floorMovement: { clip: 'walk', realization: 'sim', note: '' },
  windowSurface: { clip: 'walk', realization: 'sim', note: 'Windows only: ledges on window tops and the taskbar' },
  safeFalling: { clip: 'fall', realization: 'composite', note: 'fall, land, impact, landRecover; never breaks the cat' },
  eventMovement: { clip: 'walk', realization: 'sim', note: 'world events steer the same mover and clips' },
} as const satisfies Readonly<Record<string, BehaviorEntry>>;
export type BehaviorKey = keyof typeof BEHAVIOR_CATALOG;

/** Dev helper for the docs and a renderer test: do all gait clips agree with GAIT_LIMIT_DIP and the one-shot set? */
export function catalogConsistencyProblems(): string[] {
  const problems: string[] = [];
  for (const c of ANIM_CLIPS) {
    const m = CLIP_META[c];
    if (m.loop === ONE_SHOT_CLIPS.has(c)) problems.push(`${c}: loop flag disagrees with ONE_SHOT_CLIPS`);
    if (m.gait && !(m.gait in GAIT_LIMIT_DIP)) problems.push(`${c}: unknown gait ${m.gait}`);
    if (!m.loop && m.durationS === null) problems.push(`${c}: one-shot without a duration`);
  }
  for (const [k, e] of Object.entries(BEHAVIOR_CATALOG)) {
    if (!(ANIM_CLIPS as readonly string[]).includes(e.clip)) problems.push(`behaviour ${k}: unknown clip ${e.clip}`);
  }
  return problems;
}
