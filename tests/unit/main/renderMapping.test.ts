// Mapping of the simulation's one-off reaction into the overlay render snapshot.
import { describe, expect, it } from 'vitest';
import { MAX_PROPS, type RenderProp } from '../../../src/shared/companion';
import type { Rect } from '../../../src/shared/geometry';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import type { DisplayGeometry } from '../../../src/shared/world';
import { displaysShowingProps, hiddenRenderState, mapRenderState, type RenderMapContext } from '../../../src/main/overlay/renderMapping';

function output(over: Partial<SimOutput> = {}): SimOutput {
  return {
    x: 400,
    y: 600,
    facing: 1,
    state: 'idle',
    clip: 'sit',
    clipStartedAt: 10,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.4,
    contentment: 0.7,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'floor', displayId: '1' },
    boundsPx: { x: 360, y: 540, width: 84, height: 64 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

const ctx: RenderMapContext = { seq: 3, toLocalDip: (p) => ({ x: p.x / 1.25, y: p.y / 1.25 }), scaleFactor: 1.25, forceSnap: false, hidden: false, simNow: 5000 };

const prop = (over: Partial<RenderProp> = {}): RenderProp => ({ id: 1, kind: 'butterfly', x: 400, y: 300, size: 40, dir: 1, alpha: 0.8, p: 0.5, rot: 0.2, variant: 2, ...over });

// Two displays side by side: a 1920x1080 at scale 1 and a 2560x1440 px one at scale 2 (1280x720 DIP).
const left: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
const right: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };
const ctxLeft = (over: Partial<RenderMapContext> = {}): RenderMapContext => ({ ...ctx, scaleFactor: 1, toLocalDip: (p) => p, displayBoundsPx: left, ...over });
const ctxRight = (over: Partial<RenderMapContext> = {}): RenderMapContext => ({ ...ctx, scaleFactor: 2, toLocalDip: (p) => ({ x: (p.x - 1920) / 2, y: p.y / 2 }), displayBoundsPx: right, ...over });
const geo = (id: string, wa: Rect, scaleFactor: number): DisplayGeometry => ({ id, primary: id === 'a', scaleFactor, boundsDip: wa, workAreaDip: wa, boundsPx: wa, workAreaPx: wa });

describe('Living Companion mapping', () => {
  const appearance = defaultSettings().appearance;

  it('changes nothing when none of the new inputs are given', () => {
    const s = mapRenderState(output(), appearance, ctx);
    for (const key of ['props', 'mood', 'sleepDepth', 'laser', 'reducedMotion']) expect(key in s, key).toBe(false);
  });

  it('maps props from world px to local DIP, sizes by the scale factor', () => {
    const out = output({ props: [prop({ x: 2920, y: 600, size: 60 })] });
    const onRight = mapRenderState(out, appearance, ctxRight()).props!;
    expect(onRight).toHaveLength(1);
    expect(onRight[0]).toMatchObject({ id: 1, kind: 'butterfly', x: 500, y: 300, size: 30, dir: 1, alpha: 0.8, p: 0.5, rot: 0.2, variant: 2 });
    // The same prop is nowhere near the left display, so that overlay gets none.
    expect(mapRenderState(out, appearance, ctxLeft()).props).toEqual([]);
  });

  it('sends a prop far from the cat that is on this display, and keeps one straddling the seam on both', () => {
    const farFromCat = prop({ id: 5, x: 3000, y: 200 });
    const seam = prop({ id: 6, x: 1930, y: 500, size: 40 });
    const out = output({ x: 100, y: 600, props: [farFromCat, seam] });
    expect(mapRenderState(out, appearance, ctxRight()).props!.map((p) => p.id)).toEqual([5, 6]);
    expect(mapRenderState(out, appearance, ctxLeft()).props!.map((p) => p.id)).toEqual([6]);
  });

  it('without display bounds every prop is sent; broken positions and extra props are dropped', () => {
    const many = Array.from({ length: MAX_PROPS + 5 }, (_, i) => prop({ id: i }));
    const s = mapRenderState(output({ props: [prop({ id: 99, x: Number.NaN }), ...many] }), appearance, { ...ctx, displayBoundsPx: undefined });
    expect(s.props).toHaveLength(MAX_PROPS);
    expect(s.props!.some((p) => p.id === 99)).toBe(false);
  });

  it('maps the laser only for the overlay whose display holds it', () => {
    const laser = { x: 2920, y: 600 };
    expect(mapRenderState(output(), appearance, ctxRight({ laser })).laser).toEqual({ x: 500, y: 300 });
    expect(mapRenderState(output(), appearance, ctxLeft({ laser })).laser).toBeNull();
    expect(mapRenderState(output(), appearance, ctxLeft({ laser: null })).laser).toBeNull();
    expect(mapRenderState(output(), appearance, ctxLeft({ laser: { x: Number.NaN, y: 1 } })).laser).toBeNull();
    // The seam belongs to exactly one display (left edge inclusive, right edge exclusive).
    expect(mapRenderState(output(), appearance, ctxLeft({ laser: { x: 1920, y: 5 } })).laser).toBeNull();
    expect(mapRenderState(output(), appearance, ctxRight({ laser: { x: 1920, y: 5 } })).laser).toEqual({ x: 0, y: 2.5 });
  });

  it('passes mood, sleepDepth (clamped) and reducedMotion through', () => {
    const s = mapRenderState(output({ mood: 'sleepy', sleepDepth: 4 }), appearance, { ...ctx, reducedMotion: true });
    expect(s.mood).toBe('sleepy');
    expect(s.sleepDepth).toBe(1);
    expect(s.reducedMotion).toBe(true);
    expect('sleepDepth' in mapRenderState(output({ sleepDepth: Number.NaN }), appearance, ctx)).toBe(false);
  });

  it('routes displays by props: only displays a prop reaches, none while hidden', () => {
    const displays = [geo('a', left, 1), geo('b', right, 2)];
    const out = output({ props: [prop({ x: 3000, y: 200 })] });
    expect([...displaysShowingProps(out, displays, false)]).toEqual(['b']);
    expect(displaysShowingProps(out, displays, true).size).toBe(0);
    expect(displaysShowingProps(output(), displays, false).size).toBe(0);
    expect([...displaysShowingProps(output({ props: [prop({ x: 1925, y: 100 })] }), displays, false)].sort()).toEqual(['a', 'b']);
  });

  it('the hidden frame clears props and the laser dot and keeps the rest', () => {
    const s = mapRenderState(output({ props: [prop()] }), appearance, ctxLeft({ laser: { x: 10, y: 10 } }));
    const h = hiddenRenderState(s, 9, 7000);
    expect(h.props).toEqual([]);
    expect(h.laser).toBeNull();
    expect(h.visible).toBe(false);
    expect(h.snap).toBe(true);
    // A previous frame that never had them gets no new keys.
    const plain = hiddenRenderState(mapRenderState(output(), appearance, ctx), 9, 7000);
    expect('props' in plain).toBe(false);
    expect('laser' in plain).toBe(false);
  });
});

describe('reaction mapping', () => {
  it('carries the reaction kind and start time unchanged (sim time, not converted)', () => {
    const reaction = { kind: 'earFlick', at: 4980 } as const;
    const out = output({ reaction });
    const s = mapRenderState(out, defaultSettings().appearance, ctx);
    expect(s.reaction).toEqual({ kind: 'earFlick', at: 4980 });
    // A copy: later changes to the sim's object never leak into a snapshot already sent.
    expect(s.reaction).not.toBe(out.reaction);
    for (const kind of ['tailFlick', 'headTilt'] as const) {
      expect(mapRenderState(output({ reaction: { kind, at: 12 } }), defaultSettings().appearance, ctx).reaction).toEqual({ kind, at: 12 });
    }
  });

  it('maps a missing or null reaction to null', () => {
    expect(mapRenderState(output(), defaultSettings().appearance, ctx).reaction).toBeNull();
    expect(mapRenderState(output({ reaction: null }), defaultSettings().appearance, ctx).reaction).toBeNull();
  });

  it('the final hidden frame keeps the same reaction, so nothing replays when the cat comes back', () => {
    const s = mapRenderState(output({ reaction: { kind: 'headTilt', at: 4000 } }), defaultSettings().appearance, ctx);
    expect(hiddenRenderState(s, 4, 5100).reaction).toEqual({ kind: 'headTilt', at: 4000 });
  });
});
