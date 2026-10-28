import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, type AnimClip } from '../../../src/shared/cat';
import { CatAnimator, type AnimInput } from '../../../src/renderer/overlay/cat/animator';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { blendPose, copyPose, createPose, isPoseFinite, POSE_KEYS, type PoseKey } from '../../../src/renderer/overlay/cat/pose';
import { CatPuppet } from '../../../src/renderer/overlay/cat/puppet';

const input = (clip: AnimClip, clipStartedAt: number, extra: Partial<AnimInput> = {}): AnimInput => ({
  clip,
  clipStartedAt,
  sleeping: clip === 'sleep',
  speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : 0,
  vy: 0,
  lookX: 0,
  lookY: 0,
  hasLook: false,
  arousal: 0.3,
  contentment: 0.5,
  animSpeed: 1,
  ...extra,
});

/**
 * Parameters whose per-frame change we bound during a cross-fade (positions in DIP, angles
 * in rad). Tail targets are excluded: the spring chain smooths them, and the visible
 * chain is checked separately below.
 */
const POSITIONAL: PoseKey[] = ['bodyX', 'bodyY', 'headX', 'headY', 'fnX', 'fnY', 'ffX', 'ffY', 'bnX', 'bnY', 'bfX', 'bfY', 'offX', 'offY'];
const ANGULAR: PoseKey[] = ['tilt', 'headRot', 'rot'];

describe('pose blending', () => {
  it('blendPose interpolates every parameter linearly and hits both ends', () => {
    const a = createPose();
    const b = createPose();
    for (const [i, k] of POSE_KEYS.entries()) b[k] = a[k] + i + 1;
    const out = createPose();
    blendPose(out, a, b, 0);
    for (const k of POSE_KEYS) expect(out[k]).toBeCloseTo(a[k], 12);
    blendPose(out, a, b, 1);
    for (const k of POSE_KEYS) expect(out[k]).toBeCloseTo(b[k], 12);
    blendPose(out, a, b, 0.25);
    for (const k of POSE_KEYS) expect(out[k]).toBeCloseTo(a[k] + (b[k] - a[k]) * 0.25, 12);
  });

  it('blendPose may alias its output with an input', () => {
    const a = createPose();
    const b = createPose();
    b.bodyX = a.bodyX + 10;
    const expected = a.bodyX + 5;
    blendPose(a, a, b, 0.5);
    expect(a.bodyX).toBeCloseTo(expected, 12);
  });
});

describe('animator cross-fades', () => {
  it('switching between any two clips never pops (bounded per-frame change)', () => {
    const dt = 1000 / 60;
    let worstPos = 0;
    let worstAng = 0;
    let worstPair = '';
    let worstAngPair = '';
    for (const from of ANIM_CLIPS) {
      for (const to of ANIM_CLIPS) {
        if (from === to) continue;
        const anim = new CatAnimator(() => 0.99);
        let t = 0;
        for (; t < 1500; t += dt) anim.update(input(from, 0), t, dt, 0);
        const prev = copyPose(createPose(), anim.base);
        const switchAt = t;
        for (let i = 0; i < 24; i++, t += dt) {
          anim.update(input(to, switchAt), t, dt, 0);
          const p = anim.base;
          for (const k of POSITIONAL) {
            const d = Math.abs(p[k] - prev[k]);
            if (d > worstPos) {
              worstPos = d;
              worstPair = `${from}>${to} ${k}`;
            }
          }
          for (const k of ANGULAR) {
            const d = Math.abs(p[k] - prev[k]);
            if (d > worstAng) {
              worstAng = d;
              worstAngPair = `${from}>${to} ${k}`;
            }
          }
          copyPose(prev, p);
        }
      }
    }
    // A 200 ms smoothstep fade over ~40 DIP moves at most ~5 DIP per 60 Hz frame.
    expect(worstPos, worstPair).toBeLessThan(8);
    expect(worstAng, worstAngPair).toBeLessThan(0.75);
  });

  it('the visible tail never teleports when clips switch', () => {
    const dt = 1000 / 60;
    let worst = 0;
    let worstPair = '';
    for (const from of ANIM_CLIPS) {
      for (const to of ANIM_CLIPS) {
        if (from === to) continue;
        const puppet = new CatPuppet(() => 0.99);
        let t = 0;
        for (; t < 1500; t += dt) puppet.advance(input(from, 0), t, dt, 0, 0);
        const px = Float64Array.from(puppet.tail.x);
        const py = Float64Array.from(puppet.tail.y);
        const switchAt = t;
        for (let i = 0; i < 30; i++, t += dt) {
          puppet.advance(input(to, switchAt), t, dt, 0, 0);
          for (let k = 0; k < puppet.tail.count; k++) {
            const d = Math.hypot(puppet.tail.x[k]! - px[k]!, puppet.tail.y[k]! - py[k]!);
            if (d > worst) {
              worst = d;
              worstPair = `${from}>${to} point ${k}`;
            }
            px[k] = puppet.tail.x[k]!;
            py[k] = puppet.tail.y[k]!;
          }
        }
      }
    }
    // A fast whip during a 150 ms fade moves the tip up to ~17 DIP per frame; a pop would be
    // on the order of the tail length (37 DIP).
    expect(worst, worstPair).toBeLessThan(24);
  });

  it('restarting the same one-shot clip cross-fades instead of jumping', () => {
    const anim = new CatAnimator(() => 0.99);
    const dt = 1000 / 60;
    let t = 0;
    for (; t < 1000; t += dt) anim.update(input('startle', 0), t, dt, 0);
    expect(anim.blending).toBe(false);
    anim.update(input('startle', t), t, dt, 0);
    expect(anim.blending).toBe(true);
  });

  it('stays finite under hostile inputs and frame times', () => {
    const anim = new CatAnimator(seededRandom(9));
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, -1e9, 1e9];
    let t = 0;
    for (const clip of ANIM_CLIPS) {
      for (const v of bad) {
        t += 16;
        const p = anim.update(input(clip, t - 5, { speed: v, vy: v, lookX: v, lookY: v, hasLook: true, arousal: v, contentment: v, animSpeed: v }), t, v, v);
        expect(isPoseFinite(p), `${clip} ${v}`).toBe(true);
      }
    }
  });

  it('blinks every 2-6 s while awake and never while eyes are closed', () => {
    const anim = new CatAnimator(seededRandom(42));
    const dt = 1000 / 60;
    let blinks = 0;
    let wasClosed = false;
    for (let t = 0; t < 60000; t += dt) {
      const p = anim.update(input('sit', 0), t, dt, 0);
      const closed = p.eyeOpen < 0.3;
      if (closed && !wasClosed) blinks++;
      wasClosed = closed;
    }
    // 60 s at one blink per 2-6 s (some doubles) => roughly 10-40 closures.
    expect(blinks).toBeGreaterThanOrEqual(9);
    expect(blinks).toBeLessThanOrEqual(45);

    const sleeper = new CatAnimator(seededRandom(42));
    let opened = false;
    for (let t = 0; t < 20000; t += dt) {
      const p = sleeper.update(input('sleep', 0), t, dt, 0);
      if (t > 500 && p.eyeOpen > 0.05) opened = true;
    }
    expect(opened).toBe(false);
  });

  it('breathes visibly, slower and deeper when sleeping', () => {
    const measure = (clip: AnimClip): { amp: number; crossings: number } => {
      const anim = new CatAnimator(() => 0.99);
      const dt = 1000 / 60;
      let lo = Infinity;
      let hi = -Infinity;
      let crossings = 0;
      let prev = 0;
      for (let t = 0; t < 20000; t += dt) {
        const p = anim.update(input(clip, 0), t, dt, 0);
        if (t > 5000) {
          lo = Math.min(lo, p.bodyH);
          hi = Math.max(hi, p.bodyH);
          const s = Math.sign(p.bodyH - 1);
          if (s !== 0 && s !== prev) crossings++;
          if (s !== 0) prev = s;
        }
      }
      return { amp: hi - lo, crossings };
    };
    const awake = measure('stand');
    const asleep = measure('sleep');
    expect(awake.amp).toBeGreaterThan(0.02);
    expect(asleep.amp).toBeGreaterThan(awake.amp * 1.8);
    expect(asleep.crossings).toBeLessThan(awake.crossings);
  });

  it('look-at turns the head and pupils toward the target, clamped', () => {
    const anim = new CatAnimator(() => 0.99);
    const dt = 1000 / 60;
    let p = anim.pose;
    for (let t = 0; t < 2000; t += dt) p = anim.update(input('stand', 0, { hasLook: true, lookX: 60, lookY: -120 }), t, dt, 0);
    const up = { rot: p.headRot, py: p.pupilY };
    for (let t = 2000; t < 4000; t += dt) p = anim.update(input('stand', 0, { hasLook: true, lookX: 60, lookY: 40 }), t, dt, 0);
    expect(up.rot).toBeGreaterThan(p.headRot);
    expect(up.py).toBeLessThan(p.pupilY);
    for (let t = 4000; t < 6000; t += dt) p = anim.update(input('stand', 0, { hasLook: true, lookX: 1e6, lookY: -1e6 }), t, dt, 0);
    expect(Math.abs(p.headRot)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(p.pupilX)).toBeLessThanOrEqual(1);
  });
});
