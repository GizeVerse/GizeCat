// World-event props in the overlay renderer: snapshot validation (old and new snapshots, malformed
// props dropped one by one), the padded bounds, drawing every kind without throwing, reduced motion,
// the blend between two snapshots and the laser dot.
import { describe, expect, it } from 'vitest';
import type { CatRenderState } from '../../../src/shared/cat';
import { MAX_PROPS, PROP_KINDS, type RenderProp } from '../../../src/shared/companion';
import { blendProps, drawLaser, drawProps, laserBounds, propsBounds, type DrawPropsOptions } from '../../../src/renderer/overlay/props';
import { isRenderState, sanitizeProps } from '../../../src/renderer/overlay/validate';
import type { Ctx2D } from '../../../src/renderer/overlay/cat/draw';

function base(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    t: 100,
    x: 50,
    y: 60,
    snap: false,
    scale: 1,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.2,
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

function prop(over: Partial<RenderProp> = {}): RenderProp {
  return { id: 1, kind: 'mouse', x: 100, y: 120, size: 30, dir: 1, alpha: 1, p: 0.5, rot: 0, variant: 0, ...over };
}

/** A recording 2D context: every method is a no-op that is logged, every property assignable. */
function fakeCtx(): { ctx: Ctx2D; calls: string[]; log: [string, unknown[]][]; assigned: Record<string, unknown> } {
  const calls: string[] = [];
  const log: [string, unknown[]][] = [];
  const assigned: Record<string, unknown> = {};
  const ctx = new Proxy(assigned, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      return (...args: unknown[]) => {
        calls.push(key);
        log.push([key, args]);
        return undefined;
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls, log, assigned };
}

const opts = (over: Partial<DrawPropsOptions> = {}): DrawPropsOptions => ({ t: 1234, scale: 1, style: 'smooth', reducedMotion: false, width: 1920, height: 1080, ...over });

describe('render snapshot validation: Living Companion fields', () => {
  it('accepts an old snapshot without any of the new fields', () => {
    const s = base();
    expect(isRenderState(s)).toBe(true);
    expect('props' in s).toBe(false);
    expect('mood' in s).toBe(false);
  });

  it('accepts a full new snapshot and keeps its fields', () => {
    const s = base({ props: [prop()], mood: 'happy', sleepDepth: 0.5, laser: { x: 3, y: 4 }, reducedMotion: true });
    expect(isRenderState(s)).toBe(true);
    expect((s.props as RenderProp[]).length).toBe(1);
    expect(s.mood).toBe('happy');
    expect(s.sleepDepth).toBe(0.5);
    expect(s.laser).toEqual({ x: 3, y: 4 });
    expect(s.reducedMotion).toBe(true);
  });

  it('drops malformed props one by one and never the frame', () => {
    const good = prop({ id: 7, kind: 'bubble' });
    const bad = [
      null,
      7,
      { ...prop({ id: 2 }), kind: 'dinosaur' },
      { ...prop({ id: 3 }), x: Number.NaN },
      { ...prop({ id: 4 }), dir: 0 },
      { ...prop({ id: 5 }), variant: 4 },
      { ...prop({ id: 6 }), variant: 1.5 },
      { ...prop({ id: 8 }), id: 1.5 },
      { ...prop({ id: 9 }), alpha: 'x' },
    ];
    const s = base({ props: [bad[0], good, ...bad.slice(1)] });
    expect(isRenderState(s)).toBe(true);
    expect((s.props as RenderProp[]).map((p) => p.id)).toEqual([7]);
  });

  it('clamps out-of-range numbers instead of rejecting the prop', () => {
    const out = sanitizeProps([prop({ size: 99999, alpha: 4, p: -2, rot: 1e9, x: 1e12 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.size).toBeLessThanOrEqual(600);
    expect(out[0]!.alpha).toBe(1);
    expect(out[0]!.p).toBe(0);
    expect(Math.abs(out[0]!.rot)).toBeLessThanOrEqual(20);
    expect(out[0]!.x).toBeLessThanOrEqual(100000);
  });

  it('caps the list at MAX_PROPS and drops repeated ids', () => {
    const many = Array.from({ length: MAX_PROPS + 10 }, (_, i) => prop({ id: i }));
    expect(sanitizeProps(many)).toHaveLength(MAX_PROPS);
    expect(sanitizeProps([prop({ id: 1 }), prop({ id: 1, x: 5 })])).toHaveLength(1);
    expect(sanitizeProps('nope')).toEqual([]);
  });

  it('drops a bad mood, sleepDepth, laser or reducedMotion without losing the frame', () => {
    const s = base({ mood: 'ecstatic', sleepDepth: 3, laser: { x: Number.NaN, y: 1 }, reducedMotion: 'yes' });
    expect(isRenderState(s)).toBe(true);
    expect('mood' in s).toBe(false);
    expect('sleepDepth' in s).toBe(false);
    expect(s.laser).toBeNull();
    expect('reducedMotion' in s).toBe(false);
    const t = base({ laser: 'x', props: 'x' });
    expect(isRenderState(t)).toBe(true);
    expect(t.laser).toBeNull();
    expect(t.props).toEqual([]);
  });
});

describe('propsBounds', () => {
  it('is null for no props and for props with broken positions', () => {
    expect(propsBounds([], 1)).toBeNull();
    expect(propsBounds([prop({ x: Number.NaN })], 1)).toBeNull();
  });

  it('covers every prop with padding, at least one size around its anchor', () => {
    const a = prop({ id: 1, x: 100, y: 100, size: 40 });
    const b = prop({ id: 2, x: 300, y: 200, size: 20 });
    const r = propsBounds([a, b], 1)!;
    expect(r.x).toBeLessThanOrEqual(100 - 40);
    expect(r.y).toBeLessThanOrEqual(100 - 40);
    expect(r.x + r.width).toBeGreaterThanOrEqual(300 + 20);
    expect(r.y + r.height).toBeGreaterThanOrEqual(200 + 20);
  });

  it('grows with the cat scale (outline and pixel snap slack)', () => {
    const small = propsBounds([prop()], 1)!;
    const large = propsBounds([prop()], 2)!;
    expect(large.width).toBeGreaterThan(small.width);
  });
});

describe('drawProps', () => {
  it('draws every kind in both styles, both motion modes and all variants without throwing', () => {
    for (const kind of PROP_KINDS) {
      for (const style of ['smooth', 'pixel'] as const) {
        for (const reducedMotion of [false, true]) {
          for (let variant = 0; variant < 4; variant++) {
            const { ctx, calls } = fakeCtx();
            expect(() => drawProps(ctx, [prop({ kind, variant, p: 0.8, dir: variant % 2 === 0 ? 1 : -1 })], opts({ style, reducedMotion })), kind).not.toThrow();
            expect(calls.some((c) => c === 'fill' || c === 'stroke'), `${kind} drew nothing`).toBe(true);
            // Every save is paired with a restore.
            expect(calls.filter((c) => c === 'save').length, kind).toBe(calls.filter((c) => c === 'restore').length);
          }
        }
      }
    }
  });

  it('draws nothing for an unknown kind, a transparent prop or one wholly off the canvas', () => {
    for (const p of [{ ...prop(), kind: 'dinosaur' }, prop({ alpha: 0 }), prop({ x: -5000 }), prop({ x: Number.NaN })]) {
      const { ctx, calls } = fakeCtx();
      expect(() => drawProps(ctx, [p as RenderProp], opts())).not.toThrow();
      expect(calls.filter((c) => c === 'fill' || c === 'stroke')).toHaveLength(0);
    }
  });

  it('never draws more than MAX_PROPS', () => {
    const one = fakeCtx();
    drawProps(one.ctx, [prop()], opts());
    const many = fakeCtx();
    drawProps(many.ctx, Array.from({ length: MAX_PROPS + 20 }, (_, i) => prop({ id: i })), opts());
    expect(many.calls.filter((c) => c === 'save').length).toBe(one.calls.filter((c) => c === 'save').length * MAX_PROPS);
  });

  it('the bolt flickers only when motion is not reduced', () => {
    const alphas = (reducedMotion: boolean): Set<unknown> => {
      const seen = new Set<unknown>();
      for (let t = 0; t < 400; t += 7) {
        const { ctx, assigned } = fakeCtx();
        drawProps(ctx, [prop({ kind: 'bolt' })], opts({ t, reducedMotion }));
        seen.add(assigned.globalAlpha);
      }
      return seen;
    };
    // The proxy keeps the last assigned globalAlpha (the bolt scales the prop's alpha by its flicker).
    expect(alphas(false).size).toBeGreaterThan(1);
    expect(alphas(true).size).toBe(1);
  });
});

describe('blendProps', () => {
  it('blends matching ids and passes the rest through', () => {
    const a = [prop({ id: 1, x: 0, y: 0 }), prop({ id: 2, x: 10, y: 10 })];
    const b = [prop({ id: 1, x: 100, y: 50 })];
    const out = blendProps(a, b, 0.5, []);
    expect(out).toHaveLength(2);
    expect(out[0]!.x).toBeCloseTo(50);
    expect(out[0]!.y).toBeCloseTo(25);
    expect(out[1]!.x).toBe(10);
  });

  it('does not blend a jump larger than maxJump, and reuses the output array', () => {
    const scratch: RenderProp[] = [];
    const out = blendProps([prop({ x: 0 })], [prop({ x: 900 })], 0.5, scratch, 400);
    expect(out).toBe(scratch);
    expect(out[0]!.x).toBe(0);
    expect(blendProps([prop()], undefined, 0.5, scratch)).toHaveLength(1);
    expect(blendProps([], [prop()], 0.5, scratch)).toHaveLength(0);
  });
});

describe('laser dot', () => {
  it('has padded bounds around the dot and none for a broken position', () => {
    const r = laserBounds(100, 200)!;
    expect(r.x).toBeLessThan(100 - 5);
    expect(r.x + r.width).toBeGreaterThan(100 + 5);
    expect(laserBounds(Number.NaN, 0)).toBeNull();
  });

  it('draws a dot, pulsing only when motion is not reduced', () => {
    const radii = (reducedMotion: boolean): Set<unknown> => {
      const seen = new Set<unknown>();
      for (let t = 0; t < 300; t += 11) {
        const { ctx, calls, log } = fakeCtx();
        drawLaser(ctx, 10, 10, { t, reducedMotion });
        expect(calls).toContain('fill');
        // The dot itself is the last full-circle arc but one (glow, dot, glint): record the dot's radius.
        const arcs = log.filter(([k]) => k === 'arc');
        seen.add(arcs[1]![1][2]);
      }
      return seen;
    };
    expect(radii(true).size).toBe(1);
    expect(radii(false).size).toBeGreaterThan(1);
    expect(()=> drawLaser(fakeCtx().ctx, Number.NaN, 1, { t: 0, reducedMotion: false })).not.toThrow();
  });
});

describe('type surface', () => {
  it('a snapshot with props is a CatRenderState', () => {
    const s = base({ props: [prop()] });
    expect(isRenderState(s)).toBe(true);
    const typed = s as unknown as CatRenderState;
    expect(typed.props?.[0]?.kind).toBe('mouse');
  });
});
