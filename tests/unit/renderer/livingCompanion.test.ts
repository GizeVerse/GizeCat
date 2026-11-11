// Living Companion, renderer side: the clips scratch / shake / confused, the mood layers, deep sleep,
// reduced motion and the quiet frame rate, against the catalogue contract (src/shared/animationCatalog.ts).
import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, ONE_SHOT_CLIPS, type AnimClip, type CatRenderState } from '../../../src/shared/cat';
import { BEHAVIOR_CATALOG, catalogConsistencyProblems, CLIP_META } from '../../../src/shared/animationCatalog';
import { MOODS, type Mood } from '../../../src/shared/companion';
import { CatAnimator, type AnimInput } from '../../../src/renderer/overlay/cat/animator';
import {
  clipDurationS,
  CONFUSED_PERIOD_S,
  crossFadeMs,
  loopPeriodS,
  REDUCED_MOTION_AMP,
  sampleClip,
  SCRATCH_PERIOD_S,
  type ClipContext,
} from '../../../src/renderer/overlay/cat/clips';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { createPose, isPoseFinite, POSE_KEYS, type Pose, type PoseKey } from '../../../src/renderer/overlay/cat/pose';
import {
  DEEP_QUIET_FRAME_MS,
  frameIntervalMs,
  FULL_RATE_MS,
  QUIET_FRAME_MS,
  quietIntervalMs,
  type FrameMotion,
} from '../../../src/renderer/overlay/frameRate';
import { CatScene } from '../../../src/renderer/overlay/scene';

const DT = 1000 / 60;

const ctx = (t: number, extra: Partial<ClipContext> = {}): ClipContext => ({
  t,
  cycle: 0,
  speed: 0,
  vy: 0,
  lookX: 40,
  lookY: -30,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
  ...extra,
});
const pose = (clip: AnimClip, t: number, extra: Partial<ClipContext> = {}): Pose => sampleClip(clip, ctx(t, extra), createPose());

function poseDiff(a: Pose, b: Pose): number {
  let d = 0;
  for (const k of POSE_KEYS) d = Math.max(d, Math.abs(a[k] - b[k]));
  return d;
}

const input = (clip: AnimClip, extra: Partial<AnimInput> = {}): AnimInput => ({
  clip,
  clipStartedAt: 0,
  sleeping: clip === 'sleep',
  speed: 0,
  vy: 0,
  lookX: 0,
  lookY: 0,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
  animSpeed: 1,
  ...extra,
});

/** Runs an animator for `seconds` at 60 Hz, handing each frame's final pose to `each` (a shared object: copy what you keep). */
function runAnimator(clip: AnimClip, seconds: number, extra: (t: number) => Partial<AnimInput>, each: (p: Pose, t: number) => void, seed = 7): CatAnimator {
  const anim = new CatAnimator(seededRandom(seed));
  for (let t = 0; t <= seconds * 1000; t += DT) each(anim.update(input(clip, extra(t)), t, DT, 0), t);
  return anim;
}

/** Mean of the given pose keys over the frames between from and to seconds. */
function meanOver(clip: AnimClip, extra: (t: number) => Partial<AnimInput>, keys: PoseKey[], from: number, to: number): Record<string, number> {
  const sums: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  let n = 0;
  runAnimator(clip, to, extra, (p, t) => {
    if (t < from * 1000) return;
    n++;
    for (const k of keys) sums[k] = (sums[k] ?? 0) + p[k];
  });
  return Object.fromEntries(keys.map((k) => [k, sums[k]! / Math.max(1, n)]));
}

describe('the animation catalogue and the renderer agree', () => {
  it('every AnimClip has a CLIP_META entry and the catalogue is consistent', () => {
    for (const clip of ANIM_CLIPS) expect(CLIP_META[clip], clip).toBeDefined();
    expect(Object.keys(CLIP_META).sort()).toEqual([...ANIM_CLIPS].sort());
    expect(catalogConsistencyProblems()).toEqual([]);
  });

  it('one-shot durations and loop periods in the renderer match the catalogue', () => {
    for (const clip of ANIM_CLIPS) {
      const m = CLIP_META[clip];
      if (ONE_SHOT_CLIPS.has(clip)) expect(clipDurationS(clip), clip).toBe(m.durationS);
      else expect(clipDurationS(clip), clip).toBeNull();
    }
    expect(clipDurationS('shake')).toBe(1.1);
    expect(loopPeriodS('scratch')).toBe(SCRATCH_PERIOD_S);
    expect(loopPeriodS('confused')).toBe(CONFUSED_PERIOD_S);
    expect(loopPeriodS('shake')).toBeNull();
  });

  it('the behaviours that name the new clips point at drawn clips', () => {
    expect(BEHAVIOR_CATALOG.scratching.clip).toBe('scratch');
    expect(BEHAVIOR_CATALOG.shakingBody.clip).toBe('shake');
    expect(BEHAVIOR_CATALOG.confused.clip).toBe('confused');
  });

  it('the shake-off cross-fades in as quickly as the other quick reactions', () => {
    expect(crossFadeMs('stand', 'shake')).toBe(crossFadeMs('stand', 'startle'));
  });
});

describe('scratch', () => {
  it('lifts the near hind leg up beside the head while the other legs stay planted', () => {
    const sit = pose('sit', 1);
    const p = pose('scratch', 1);
    expect(p.bnY).toBeLessThan(sit.bnY - 20);
    expect(p.bfX).toBe(sit.bfX);
    expect(p.bfY).toBe(sit.bfY);
    expect(p.fnX).toBe(sit.fnX);
    // The head dips back and down to meet the paw, eyes narrowed.
    expect(p.headY).toBeGreaterThan(sit.headY + 4);
    expect(p.headX).toBeLessThan(sit.headX);
    expect(p.eyeOpen).toBeLessThan(0.6);
  });

  it('rubs: the paw moves quickly during the scratch and is back down at the loop point', () => {
    const a = pose('scratch', 1.0);
    const b = pose('scratch', 1.0 + 1 / 30);
    expect(Math.hypot(a.bnX - b.bnX, a.bnY - b.bnY)).toBeGreaterThan(0.5);
    expect(poseDiff(pose('scratch', 0), pose('scratch', SCRATCH_PERIOD_S))).toBeLessThan(1e-9);
    expect(poseDiff(pose('scratch', 0), pose('sit', 0))).toBeLessThan(1e-9);
  });

  it('rubs less under reduced motion but still lifts the leg', () => {
    const swing = (extra: Partial<ClipContext>): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0.8; t <= 1.4; t += 0.01) {
        const x = pose('scratch', t, extra).bnX;
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      return hi - lo;
    };
    const full = swing({});
    const calm = swing({ reducedMotion: true });
    expect(calm).toBeLessThan(full * 0.6);
    expect(pose('scratch', 1, { reducedMotion: true }).bnY).toBeLessThan(-20);
  });
});

describe('shake', () => {
  it('shudders hard in the middle and ends at the standing pose', () => {
    const stand = pose('stand', 0);
    // The stand clip adds a small head bob (about 0.27 at t = 0) that the bare standing pose under the shake does not have.
    expect(poseDiff(pose('shake', 0), stand)).toBeLessThan(0.3);
    expect(poseDiff(pose('shake', 1.1), stand)).toBeLessThan(0.3);
    expect(poseDiff(pose('shake', 5), stand)).toBeLessThan(0.3);
    let headSwing = 0;
    for (let t = 0.1; t <= 0.5; t += 0.01) headSwing = Math.max(headSwing, Math.abs(pose('shake', t).headRot));
    expect(headSwing).toBeGreaterThan(0.15);
  });

  it('damps: the shudder at the end is far smaller than at the start', () => {
    const peak = (from: number, to: number): number => {
      let m = 0;
      for (let t = from; t <= to; t += 0.005) m = Math.max(m, Math.abs(pose('shake', t).headRot));
      return m;
    };
    expect(peak(0.8, 1.1)).toBeLessThan(peak(0.1, 0.4) * 0.3);
  });

  it('never reaches further ahead than the standing cat does by more than a couple of DIP', () => {
    const stand = pose('stand', 0);
    for (let t = 0; t <= 1.1; t += 0.01) {
      const p = pose('shake', t);
      expect(p.headX + p.offX, `t=${t}`).toBeLessThan(stand.headX + 3);
      expect(p.fnX + p.offX, `t=${t}`).toBeLessThanOrEqual(stand.fnX + 2);
    }
  });

  it('is damped under reduced motion (amplitudes at REDUCED_MOTION_AMP)', () => {
    const peak = (extra: Partial<ClipContext>): number => {
      let m = 0;
      for (let t = 0.1; t <= 0.6; t += 0.005) m = Math.max(m, Math.abs(pose('shake', t, extra).headRot));
      return m;
    };
    expect(peak({ reducedMotion: true })).toBeLessThan(peak({}) * (REDUCED_MOTION_AMP + 0.05));
    expect(peak({ reducedMotion: false })).toBe(peak({}));
  });
});

describe('confused', () => {
  it('tilts the head from side to side with one ear up and the loop closes', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < CONFUSED_PERIOD_S; t += 0.02) {
      const p = pose('confused', t);
      lo = Math.min(lo, p.headRot);
      hi = Math.max(hi, p.headRot);
      expect(p.earFR, `t=${t}`).toBeLessThan(-0.2);
      expect(p.earBR, `t=${t}`).toBeGreaterThan(0.1);
    }
    expect(lo).toBeLessThan(-0.1);
    expect(hi).toBeGreaterThan(0.1);
    expect(poseDiff(pose('confused', 0), pose('confused', CONFUSED_PERIOD_S))).toBeLessThan(1e-9);
  });

  it('blinks slowly once per loop', () => {
    let closed = 0;
    for (let t = 0; t < CONFUSED_PERIOD_S; t += 0.02) if (pose('confused', t).eyeOpen < 0.2) closed++;
    // The closed stretch is a few tenths of a second, not a flicker.
    expect(closed * 0.02).toBeGreaterThan(0.1);
    expect(closed * 0.02).toBeLessThan(0.6);
  });
});

describe('the new clips are well behaved', () => {
  it('stay finite across phases, hostile contexts and every mood/depth/reduced-motion combination', () => {
    for (const clip of ['scratch', 'shake', 'confused'] as const) {
      for (let i = 0; i <= 120; i++) {
        for (const extra of [{}, { reducedMotion: true }, { hasLook: true, lookX: 1e9, lookY: -1e9 }]) {
          expect(isPoseFinite(pose(clip, i * 0.05, extra)), `${clip}@${i}`).toBe(true);
        }
      }
      expect(isPoseFinite(pose(clip, Number.NaN)), clip).toBe(true);
      expect(isPoseFinite(pose(clip, -3)), clip).toBe(true);
      const anim = new CatAnimator(seededRandom(3));
      let t = 0;
      for (const mood of [...MOODS, undefined]) {
        for (const sleepDepth of [0, 1, Number.NaN, 5]) {
          for (const reducedMotion of [false, true]) {
            t += 33;
            expect(isPoseFinite(anim.update(input(clip, { mood, sleepDepth, reducedMotion }), t, 33, 0)), `${clip}/${String(mood)}`).toBe(true);
          }
        }
      }
    }
  });

  it('are drawn at the full frame rate where they are quick, calm otherwise', () => {
    const calm: FrameMotion = { clip: 'stand', state: 'idle', speed: 0, vy: 0, moved: false, transition: false, poseSpeed: 0, quiet: false };
    expect(frameIntervalMs({ ...calm, clip: 'shake' }, 1e9)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, clip: 'scratch' }, 1e9)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, clip: 'confused' }, 1e9)).toBeGreaterThan(0);
  });
});

describe('mood layers', () => {
  const CLIP: AnimClip = 'sit';
  const none = (): Partial<AnimInput> => ({});
  const keys: PoseKey[] = ['earBR', 'earFR', 'earBF', 'earFF', 'pupilSize', 'tailBase', 'tailCurl', 'headY', 'headRot', 'bodyY', 'eyeOpen', 'eyeSquint', 'blush', 'tailPuff'];
  const base = meanOver(CLIP, none, keys, 3, 6);
  const withMood = (mood: Mood): Record<string, number> => meanOver(CLIP, () => ({ mood }), keys, 3, 6);

  it('absent mood renders exactly as before (bit for bit)', () => {
    const a: number[] = [];
    const b: number[] = [];
    runAnimator(CLIP, 4, none, (p) => a.push(...POSE_KEYS.map((k) => p[k])));
    runAnimator(CLIP, 4, () => ({ mood: undefined, sleepDepth: undefined, reducedMotion: false }), (p) => b.push(...POSE_KEYS.map((k) => p[k])));
    expect(b).toEqual(a);
    // An unknown mood string (a stale or hostile snapshot) is no mood either.
    const c: number[] = [];
    runAnimator(CLIP, 4, () => ({ mood: 'furious' as Mood }), (p) => c.push(...POSE_KEYS.map((k) => p[k])));
    expect(c).toEqual(a);
  });

  it('happy: tail up, soft eyes', () => {
    const m = withMood('happy');
    expect(m.tailBase!).toBeGreaterThan(base.tailBase! + 0.1);
    expect(m.eyeSquint!).toBeGreaterThan(base.eyeSquint! + 0.05);
    expect(m.blush!).toBeGreaterThan(base.blush! + 0.1);
  });

  it('curious: ears forward', () => {
    const m = withMood('curious');
    expect(m.earFR!).toBeLessThan(base.earFR! - 0.08);
    expect(m.earBR!).toBeLessThan(base.earBR! - 0.06);
  });

  it('sleepy: heavy lids, drooping head', () => {
    const m = withMood('sleepy');
    expect(m.eyeOpen!).toBeLessThan(base.eyeOpen! - 0.2);
    expect(m.headY!).toBeGreaterThan(base.headY! + 0.5);
  });

  it('startled: ears flat, wide pupils', () => {
    const m = withMood('startled');
    expect(m.earBF!).toBeGreaterThan(base.earBF! + 0.3);
    expect(m.pupilSize!).toBeGreaterThan(base.pupilSize! + 0.15);
  });

  it('scared: ears back, tail low and puffed, a crouch bias', () => {
    const m = withMood('scared');
    expect(m.earBR!).toBeGreaterThan(base.earBR! + 0.25);
    expect(m.tailBase!).toBeLessThan(base.tailBase! - 0.3);
    expect(m.tailPuff!).toBeGreaterThan(base.tailPuff! + 0.2);
    expect(m.bodyY!).toBeGreaterThan(base.bodyY! + 1);
  });

  it('excited: wide pupils', () => {
    expect(withMood('excited').pupilSize!).toBeGreaterThan(base.pupilSize! + 0.15);
  });

  it('relaxed: half-closed eyes', () => {
    expect(withMood('relaxed').eyeOpen!).toBeLessThan(base.eyeOpen! - 0.2);
  });

  it('confused: one ear up', () => {
    expect(withMood('confused').earFR!).toBeLessThan(base.earFR! - 0.15);
  });

  it('never pops: the difference to the no-mood cat changes only a little per frame, in and out', () => {
    const series = (mood: (t: number) => Mood | undefined): number[][] => {
      const out: number[][] = [];
      runAnimator(CLIP, 9, (t) => ({ mood: mood(t) }), (p) => out.push(['earBR', 'earFR', 'earBF', 'earFF', 'pupilSize', 'tailBase', 'tailCurl', 'headY', 'headRot', 'bodyY'].map((k) => p[k as PoseKey])));
      return out;
    };
    const ref = series(() => undefined);
    for (const mood of MOODS.filter((m) => m !== 'sleepy')) {
      // On from 1 s to 5 s, off again after.
      const got = series((t) => (t >= 1000 && t < 5000 ? mood : undefined));
      let worst = 0;
      for (let i = 1; i < got.length; i++) {
        for (let k = 0; k < got[i]!.length; k++) {
          const d = got[i]![k]! - ref[i]![k]!;
          const dPrev = got[i - 1]![k]! - ref[i - 1]![k]!;
          worst = Math.max(worst, Math.abs(d - dPrev));
        }
      }
      // (The excited tail's own 3.4 Hz sway moves ~0.13 rad per frame by design; a pop would be a whole step.)
      expect(worst, mood).toBeLessThan(0.16);
      // Gone again by the end (the weights fall away, nothing lingers).
      const last = got.length - 1;
      for (let k = 0; k < got[last]!.length; k++) expect(Math.abs(got[last]![k]! - ref[last]![k]!), `${mood} key ${k}`).toBeLessThan(0.02);
    }
  });

  it('keeps the ears within the ranges the drawing expects, even stacked on a clip that already lays them back', () => {
    for (const clip of ['hiss', 'startle', 'run', 'sit'] as const) {
      for (const mood of MOODS) {
        runAnimator(clip, 2, () => ({ mood }), (p) => {
          for (const k of ['earBF', 'earFF'] as const) {
            expect(p[k]).toBeGreaterThanOrEqual(0);
            expect(p[k]).toBeLessThanOrEqual(1);
          }
          for (const k of ['earBR', 'earFR'] as const) expect(p[k]).toBeLessThanOrEqual(1.3 + 1e-9);
        });
      }
    }
  });
});

describe('deep sleep', () => {
  const sleep = (depth: number | undefined) => (): Partial<AnimInput> => (depth === undefined ? {} : { sleepDepth: depth });

  it('absent depth, depth 0 and a depth while awake all render as today (bit for bit)', () => {
    const collect = (clip: AnimClip, extra: () => Partial<AnimInput>): number[] => {
      const out: number[] = [];
      runAnimator(clip, 6, extra, (p) => out.push(...POSE_KEYS.map((k) => p[k])));
      return out;
    };
    expect(collect('sleep', sleep(0))).toEqual(collect('sleep', sleep(undefined)));
    expect(collect('sit', () => ({ sleepDepth: 1 }))).toEqual(collect('sit', sleep(undefined)));
  });

  it('breathes slower and shallower, and settles lower', () => {
    const stats = (depth: number): { range: number; cycles: number; headY: number; bodyH: number } => {
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      let sumH = 0;
      let n = 0;
      const ys: number[] = [];
      runAnimator('sleep', 60, sleep(depth), (p, t) => {
        if (t < 20_000) return;
        lo = Math.min(lo, p.headY);
        hi = Math.max(hi, p.headY);
        sum += p.headY;
        sumH += p.bodyH;
        n++;
        ys.push(p.headY);
      });
      const mean = sum / n;
      let cycles = 0;
      for (let i = 1; i < ys.length; i++) if (ys[i - 1]! < mean && ys[i]! >= mean) cycles++;
      return { range: hi - lo, cycles, headY: mean, bodyH: sumH / n };
    };
    const light = stats(0);
    const deep = stats(1);
    expect(deep.range).toBeLessThan(light.range * 0.85);
    expect(deep.cycles).toBeLessThan(light.cycles - 1);
    expect(deep.headY).toBeGreaterThan(light.headY + 1);
    expect(deep.bodyH).toBeLessThan(light.bodyH);
    // Half depth sits in between.
    const half = stats(0.5);
    expect(half.range).toBeLessThan(light.range);
    expect(half.range).toBeGreaterThan(deep.range);
  });

  it('eases in over a second or two instead of snapping', () => {
    let prev = Number.NaN;
    let worst = 0;
    runAnimator('sleep', 8, (t) => ({ sleepDepth: t < 4000 ? 0 : 1 }), (p, t) => {
      // Compare the settled posture (headY includes breathing, so look at the slow part: bodyH).
      if (t > 3000 && !Number.isNaN(prev)) worst = Math.max(worst, Math.abs(p.bodyH - prev));
      prev = p.bodyH;
    });
    expect(worst).toBeLessThan(0.01);
  });

  it('lowers the quiet frame rate further, in proportion to the depth', () => {
    expect(quietIntervalMs(0)).toBe(QUIET_FRAME_MS);
    expect(quietIntervalMs(undefined)).toBe(QUIET_FRAME_MS);
    expect(quietIntervalMs(Number.NaN)).toBe(QUIET_FRAME_MS);
    expect(quietIntervalMs(1)).toBe(DEEP_QUIET_FRAME_MS);
    expect(quietIntervalMs(7)).toBe(DEEP_QUIET_FRAME_MS);
    expect(quietIntervalMs(-3)).toBe(QUIET_FRAME_MS);
    expect(quietIntervalMs(0.5)).toBeGreaterThan(QUIET_FRAME_MS);
    expect(quietIntervalMs(0.5)).toBeLessThan(DEEP_QUIET_FRAME_MS);
    expect(DEEP_QUIET_FRAME_MS).toBeGreaterThan(QUIET_FRAME_MS);
    // Never so slow that the animator's 100 ms layer-dt cap would slow the breathing down.
    expect(DEEP_QUIET_FRAME_MS + 4).toBeLessThanOrEqual(100);
    const quiet: FrameMotion = { clip: 'sleep', state: 'sleeping', speed: 0, vy: 0, moved: false, transition: false, poseSpeed: 0, quiet: true };
    expect(frameIntervalMs(quiet, 1e9)).toBe(QUIET_FRAME_MS);
    expect(frameIntervalMs({ ...quiet, sleepDepth: 1 }, 1e9)).toBe(DEEP_QUIET_FRAME_MS);
    // Depth never slows a cat that is not quiet.
    expect(frameIntervalMs({ ...quiet, quiet: false, sleepDepth: 1 }, 1e9)).toBeLessThan(DEEP_QUIET_FRAME_MS);
    expect(frameIntervalMs({ ...quiet, moved: true, sleepDepth: 1 }, 1e9)).toBe(FULL_RATE_MS);
  });
});

function renderState(clip: AnimClip, t: number, extra: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq: Math.round(t),
    t,
    x: 400,
    y: 300,
    snap: false,
    scale: 1,
    facing: 1,
    state: clip === 'sleep' ? 'sleeping' : 'idle',
    clip,
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.3,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...extra,
  };
}

/** Runs a scene; returns the furthest the hit region reached ahead of the anchor (facing +1) over the run. */
function runScene(scene: CatScene, clip: AnimClip, ms: number, extra: Partial<CatRenderState> = {}): number {
  let front = -Infinity;
  for (let t = 0; t <= ms; t += DT) {
    const s = renderState(clip, t, extra);
    scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : DT, snapped: t === 0 });
    for (let i = 0; i < scene.hitCount; i++) {
      const r = scene.hitRects[i]!;
      front = Math.max(front, r.x + r.width - s.x);
    }
  }
  return front;
}

describe('hit region (T8) of the new clips', () => {
  it('none reaches further ahead of the anchor than the pose it grows out of', () => {
    const front = (clip: AnimClip, extra: Partial<CatRenderState> = {}): number => runScene(new CatScene(seededRandom(5)), clip, 4000, extra);
    expect(front('scratch')).toBeLessThanOrEqual(front('sit') + 1);
    expect(front('confused')).toBeLessThanOrEqual(front('sit') + 5);
    expect(front('shake')).toBeLessThanOrEqual(front('stand') + 4);
    // Reduced motion and every mood only ever pull the cat in, or move it a hair.
    for (const mood of MOODS) {
      expect(front('sit', { mood }), mood).toBeLessThanOrEqual(front('sit') + 4);
      expect(front('stand', { mood }), mood).toBeLessThanOrEqual(front('stand') + 4);
    }
  });

  it('the hit region stays non-empty and inside the drawn bounds for the new clips and every mood', () => {
    for (const clip of ['scratch', 'shake', 'confused'] as const) {
      for (const mood of [undefined, ...MOODS]) {
        const scene = new CatScene(seededRandom(2));
        for (let t = 0; t <= 2500; t += DT) {
          const s = renderState(clip, t, { mood, reducedMotion: mood === 'scared' });
          scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : DT, snapped: t === 0 });
          expect(scene.hitCount, `${clip}/${String(mood)}`).toBeGreaterThanOrEqual(2);
          const b = scene.bounds;
          for (let i = 0; i < scene.hitCount; i++) {
            const r = scene.hitRects[i]!;
            expect(r.x).toBeGreaterThanOrEqual(b.x);
            expect(r.x + r.width).toBeLessThanOrEqual(b.x + b.width + 1e-6);
            expect(r.y).toBeGreaterThanOrEqual(b.y);
            expect(r.y + r.height).toBeLessThanOrEqual(b.y + b.height + 1e-6);
          }
        }
      }
    }
  });
});

describe('reduced motion', () => {
  const lash = (reduced: boolean | undefined): { range: number; mean: number } => {
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    runAnimator('annoyed', 12, () => ({ reducedMotion: reduced }), (p, t) => {
      if (t < 4000) return;
      lo = Math.min(lo, p.tailBase);
      hi = Math.max(hi, p.tailBase);
      sum += p.tailBase;
      n++;
    });
    return { range: hi - lo, mean: sum / n };
  };

  it('damps the tail swing but keeps its carriage', () => {
    const full = lash(false);
    const calm = lash(true);
    expect(calm.range).toBeLessThan(full.range * 0.6);
    expect(Math.abs(calm.mean - full.mean)).toBeLessThan(0.15);
  });

  it('false and absent are exactly today (bit for bit)', () => {
    const collect = (reduced: boolean | undefined): number[] => {
      const out: number[] = [];
      runAnimator('startle', 3, () => ({ reducedMotion: reduced }), (p) => out.push(...POSE_KEYS.map((k) => p[k])));
      return out;
    };
    expect(collect(false)).toEqual(collect(undefined));
  });

  it('shrinks the startle hop and the sideways slide', () => {
    const hop = (extra: Partial<ClipContext>): number => Math.min(...[0.1, 0.15, 0.2, 0.25, 0.3].map((t) => pose('startle', t, extra).offY));
    expect(hop({ reducedMotion: true })).toBeCloseTo(hop({}) * REDUCED_MOTION_AMP, 6);
    expect(hop({ reducedMotion: false })).toBe(hop({}));
  });

  it('eases in and out instead of snapping the tail', () => {
    let prev = Number.NaN;
    let worst = 0;
    runAnimator('annoyed', 10, (t) => ({ reducedMotion: t >= 3000 && t < 7000 }), (p) => {
      if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(p.tailCurl - prev));
      prev = p.tailCurl;
    });
    // The annoyed tail lashes about 0.7 rad over ~0.7 s on its own; the switch adds no step of its own.
    expect(worst).toBeLessThan(0.15);
  });

  it('a spinning cat never turns edge-on', () => {
    let narrowest = 1;
    runAnimator('tailChase', 4, () => ({ reducedMotion: true }), (p, t) => {
      if (t > 1500) narrowest = Math.min(narrowest, p.turnX);
    });
    expect(narrowest).toBeGreaterThan(0.45);
  });
});

describe('the scene hands the Living Companion hints to the cat', () => {
  it('mood, sleep depth and reduced motion reach the animator; absent changes nothing', () => {
    const final = (extra: Partial<CatRenderState>, clip: AnimClip = 'sit'): Pose => {
      const scene = new CatScene(seededRandom(8));
      runScene(scene, clip, 3000, extra);
      return scene.puppet.pose;
    };
    const plain = final({});
    expect(final({ mood: undefined, sleepDepth: undefined, reducedMotion: false })).toEqual(plain);
    expect(final({ mood: 'scared' }).earBR).toBeGreaterThan(plain.earBR + 0.2);
    const sleepPlain = final({}, 'sleep');
    expect(final({ sleepDepth: 1 }, 'sleep').headY).toBeGreaterThan(sleepPlain.headY);
  });

  it('a deeply asleep, still cat asks for the slower quiet frame rate', () => {
    const intervalAfter = (extra: Partial<CatRenderState>): number => {
      const scene = new CatScene(seededRandom(4));
      runScene(scene, 'sleep', 4000, extra);
      return scene.frameIntervalMs(400, 300, renderState('sleep', 4000, extra));
    };
    expect(intervalAfter({})).toBe(QUIET_FRAME_MS);
    expect(intervalAfter({ sleepDepth: 1 })).toBe(DEEP_QUIET_FRAME_MS);
  });
});
