// v1.2 contract step (ADR 0003 §8, §13): the new clips exist in the renderer as placeholders that
// borrow an existing clip's motion, every new one-shot has a duration, and the overlay accepts the
// new optional render hints without ever dropping a frame for a malformed one.
import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, ONE_SHOT_CLIPS, type AnimClip, type CatRenderState } from '../../../src/shared/cat';
import { baseClip, CLIP_BASE, clipDurationS, gaitHz, isGait, loopPeriodS } from '../../../src/renderer/overlay/cat/clips';
import { isRenderState } from '../../../src/renderer/overlay/validate';

const V11_CLIPS = ANIM_CLIPS.slice(0, ANIM_CLIPS.indexOf('climb') + 1);

describe('v1.2 clip placeholders', () => {
  it('every new clip is either authored or borrows a v1.1 clip directly (no chains)', () => {
    for (const [clip, base] of Object.entries(CLIP_BASE) as Array<[AnimClip, AnimClip]>) {
      expect(V11_CLIPS, clip).not.toContain(clip);
      expect(V11_CLIPS, `${clip} -> ${base}`).toContain(base);
      expect(CLIP_BASE[base], base).toBeUndefined();
    }
    for (const clip of V11_CLIPS) expect(baseClip(clip)).toBe(clip);
  });

  it('placeholders pace and loop like their base; every one-shot has a duration', () => {
    for (const clip of ANIM_CLIPS) {
      if (ONE_SHOT_CLIPS.has(clip)) {
        expect(clipDurationS(clip), clip).toBeGreaterThan(0);
        expect(loopPeriodS(clip), clip).toBeNull();
      }
      const base = baseClip(clip);
      expect(isGait(clip), clip).toBe(isGait(base));
      expect(gaitHz(clip, 1.2), clip).toBe(gaitHz(base, 1.2));
    }
  });
});

describe('render hints over IPC', () => {
  const state = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({
      seq: 1,
      t: 100,
      x: 10,
      y: 20,
      snap: false,
      scale: 1,
      facing: 1,
      state: 'jumping',
      clip: 'pounce',
      clipStartedAt: 0,
      speed: 0,
      vy: -200,
      look: null,
      arousal: 0.5,
      contentment: 0.5,
      emote: null,
      emoteStartedAt: 0,
      opacity: 1,
      visible: true,
      skin: 'ginger',
      style: 'smooth',
      shadow: true,
      animSpeed: 1,
      ...over,
    }) satisfies Partial<Record<keyof CatRenderState, unknown>>;

  it('keeps valid hints and drops malformed ones without rejecting the frame', () => {
    const ok = state({ jumpKind: 'pounce', impact: 0.7, balance: 0, sound: { kind: 'chirp', at: 50 } });
    expect(isRenderState(ok)).toBe(true);
    expect(ok).toMatchObject({ jumpKind: 'pounce', impact: 0.7, balance: 0, sound: { kind: 'chirp', at: 50 } });
    const bad = state({ jumpKind: 'teleport', impact: 2, balance: Number.NaN, sound: { kind: 'bark', at: 1 } });
    expect(isRenderState(bad)).toBe(true);
    expect(bad.jumpKind).toBeNull();
    expect(bad).not.toHaveProperty('impact');
    expect(bad).not.toHaveProperty('balance');
    expect(bad.sound).toBeNull();
    expect(isRenderState(state({ clip: 'notAClip' }))).toBe(false);
  });
});
