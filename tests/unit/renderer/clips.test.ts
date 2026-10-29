import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, ONE_SHOT_CLIPS, SKINS, type AnimClip } from '../../../src/shared/cat';
import { clipDurationS, gaitHz, sampleClip, type ClipContext } from '../../../src/renderer/overlay/cat/clips';
import { drawCat } from '../../../src/renderer/overlay/cat/draw';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { createPose, isPoseFinite, POSE_KEYS } from '../../../src/renderer/overlay/cat/pose';
import { CatPuppet } from '../../../src/renderer/overlay/cat/puppet';
import { getSkin, SKIN_DEFS } from '../../../src/renderer/overlay/cat/skins';
import { createMockCtx } from './mockCtx';

function ctxFor(t: number, extra: Partial<ClipContext> = {}): ClipContext {
  return { t, cycle: t * 2, speed: 0.8, vy: 0, lookX: 40, lookY: -40, hasLook: true, arousal: 0.4, contentment: 0.6, ...extra };
}

function advanceTo(puppet: CatPuppet, clip: AnimClip, seconds: number, extra: { speed?: number; vy?: number } = {}): void {
  const dt = 1000 / 60;
  for (let t = 0; t <= seconds * 1000; t += dt) {
    puppet.advance(
      {
        clip,
        clipStartedAt: 0,
        sleeping: clip === 'sleep',
        speed: extra.speed ?? (clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : 0),
        vy: extra.vy ?? (clip === 'jump' ? -300 : clip === 'fall' ? 400 : 0),
        lookX: 30,
        lookY: -30,
        hasLook: true,
        arousal: 0.5,
        contentment: 0.5,
        animSpeed: 1,
      },
      t,
      dt,
      0.5,
      0,
    );
  }
}

describe('animation clips', () => {
  it('every clip produces finite poses across many phases and contexts', () => {
    const out = createPose();
    for (const clip of ANIM_CLIPS) {
      for (let i = 0; i <= 80; i++) {
        const t = i * 0.05;
        for (const extra of [{}, { hasLook: false }, { speed: 0 }, { speed: 6 }, { vy: -900 }, { vy: 900 }, { arousal: 1, contentment: 0 }]) {
          sampleClip(clip, ctxFor(t, extra), out);
          expect(isPoseFinite(out), `${clip} @ ${t}s ${JSON.stringify(extra)}`).toBe(true);
        }
      }
    }
  });

  it('tolerates hostile context values without producing NaN', () => {
    const out = createPose();
    for (const clip of ANIM_CLIPS) {
      sampleClip(clip, ctxFor(Number.NaN, { speed: Number.NaN, vy: Number.POSITIVE_INFINITY, lookX: 1e9, lookY: -1e9 }), out);
      expect(isPoseFinite(out), clip).toBe(true);
      sampleClip(clip, ctxFor(-5), out);
      expect(isPoseFinite(out), clip).toBe(true);
    }
  });

  it('one-shot clips play once and hold their last pose', () => {
    const a = createPose();
    const b = createPose();
    for (const clip of ONE_SHOT_CLIPS) {
      const dur = clipDurationS(clip);
      expect(dur, clip).not.toBeNull();
      sampleClip(clip, ctxFor(dur!), a);
      sampleClip(clip, ctxFor(dur! + 7.5), b);
      for (const k of POSE_KEYS) expect(b[k], `${clip}.${k}`).toBeCloseTo(a[k], 9);
    }
  });

  it('looping clips keep moving (not frozen)', () => {
    const a = createPose();
    const b = createPose();
    for (const clip of ['walk', 'run', 'annoyed', 'groom', 'pawAt', 'rollOver', 'crouch', 'climb'] as const) {
      sampleClip(clip, ctxFor(1.0), a);
      sampleClip(clip, ctxFor(1.37), b);
      const moved = POSE_KEYS.some((k) => Math.abs(a[k] - b[k]) > 1e-3);
      expect(moved, clip).toBe(true);
    }
  });

  it('gait rate scales with speed and stays bounded', () => {
    expect(gaitHz('walk', 0.3)).toBeLessThan(gaitHz('walk', 1.2));
    expect(gaitHz('run', 2)).toBeLessThanOrEqual(gaitHz('run', 5));
    for (const s of [0, -1, Number.NaN, 1e6]) {
      expect(Number.isFinite(gaitHz('walk', s))).toBe(true);
      expect(gaitHz('walk', s)).toBeLessThanOrEqual(3.4);
    }
    expect(gaitHz('sit', 3)).toBe(0);
  });

  it('every clip draws with finite canvas calls for every skin and both detail levels', () => {
    for (const clip of ANIM_CLIPS) {
      const puppet = new CatPuppet(seededRandom(1));
      advanceTo(puppet, clip, 0.9);
      for (const skin of SKINS) {
        for (const ppu of [2, 0.33]) {
          const m = createMockCtx();
          drawCat(m.ctx, puppet, getSkin(skin), { outline: 1.6, shadow: true, pixelsPerUnit: ppu });
          expect(m.nonFinite, `${clip}/${skin}/${ppu}`).toEqual([]);
          expect(m.depth(), `${clip}/${skin} save/restore balance`).toBe(0);
          expect(m.calls.length).toBeGreaterThan(50);
        }
      }
    }
  });

  it('defines every skin in SKINS with a palette', () => {
    for (const id of SKINS) {
      const s = SKIN_DEFS[id];
      expect(s.id).toBe(id);
      for (const c of [s.coat, s.shade, s.outline, s.light, s.iris, s.pupil, s.nose]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(getSkin('not-a-skin').id).toBe('ginger');
  });
});
