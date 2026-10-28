import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import type { DisplayGeometry } from '../../../src/shared/world';
import { crashBackoff, geometryChanged, planOverlaySync } from '../../../src/main/overlay/displayDiff';
import { displaysShowingCat, hiddenRenderState, mapRenderState, presenceRectPx } from '../../../src/main/overlay/renderMapping';

function display(id: string, x: number, scale: number, primary = false): DisplayGeometry {
  const wDip = 1600;
  const hDip = 900;
  return {
    id,
    primary,
    scaleFactor: scale,
    boundsDip: { x, y: 0, width: wDip, height: hDip },
    workAreaDip: { x, y: 0, width: wDip, height: hDip - 40 },
    boundsPx: { x: x * scale, y: 0, width: wDip * scale, height: hDip * scale },
    workAreaPx: { x: x * scale, y: 0, width: wDip * scale, height: (hDip - 40) * scale },
  };
}

function output(over: Partial<SimOutput> = {}): SimOutput {
  return {
    x: 400,
    y: 600,
    facing: 1,
    state: 'walking',
    clip: 'walk',
    clipStartedAt: 10,
    speed: 1.2,
    vy: 50,
    look: { x: 500, y: 500 },
    arousal: 0.4,
    contentment: 0.7,
    emote: 'heart',
    emoteStartedAt: 5,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: 'A',
    support: { kind: 'floor', displayId: 'A' },
    boundsPx: { x: 350, y: 540, width: 100, height: 60 },
    nextTickMs: 33,
    requests: [],
    ...over,
  };
}

describe('render mapping', () => {
  const appearance = { ...defaultSettings().appearance, size: 1.5, opacity: 0.8, skin: 'calico' as const, animationSpeed: 1.2 };

  it('maps world px into overlay-local DIP and applies appearance', () => {
    const d = display('B', 1600, 2);
    const state = mapRenderState(output({ x: 3400, y: 600, look: { x: 3600, y: 400 }, vy: 100, opacity: 0.5 }), appearance, {
      seq: 7,
      toLocalDip: (p) => ({ x: (p.x - d.workAreaPx.x) / d.scaleFactor, y: (p.y - d.workAreaPx.y) / d.scaleFactor }),
      scaleFactor: d.scaleFactor,
      forceSnap: false,
      hidden: false,
      simNow: 1234,
    });
    expect(state).toMatchObject({
      seq: 7,
      t: 1234,
      x: 100,
      y: 300,
      look: { x: 200, y: 200 },
      vy: 50,
      scale: 1.5,
      opacity: 0.4,
      skin: 'calico',
      animSpeed: 1.2,
      emote: 'heart',
      visible: true,
      snap: false,
    });
  });

  it('snaps when forced, hides emotes when disabled, and never emits non-finite numbers', () => {
    const state = mapRenderState(output({ x: Number.NaN, arousal: 7, look: { x: Number.POSITIVE_INFINITY, y: 0 } }), { ...appearance, emotes: false }, {
      seq: 1,
      toLocalDip: (p) => p,
      scaleFactor: 1,
      forceSnap: true,
      hidden: true,
      simNow: 0,
    });
    expect(state.snap).toBe(true);
    expect(state.emote).toBeNull();
    expect(state.x).toBe(0);
    expect(state.arousal).toBe(1);
    expect(state.look).toBeNull();
    expect(state.visible).toBe(false);
  });

  it('decides which displays draw the cat, including the emote margin across an edge', () => {
    const a = display('A', 0, 1, true);
    const b = display('B', 1600, 1);
    const appearanceN = defaultSettings().appearance;
    expect([...displaysShowingCat(output(), [a, b], appearanceN, false)]).toEqual(['A']);
    const nearEdge = output({ boundsPx: { x: 1500, y: 540, width: 95, height: 60 } });
    expect([...displaysShowingCat(nearEdge, [a, b], appearanceN, false)].sort()).toEqual(['A', 'B']);
    expect(displaysShowingCat(output(), [a, b], appearanceN, true).size).toBe(0);
    expect(displaysShowingCat(output({ visible: false }), [a, b], appearanceN, false).size).toBe(0);
    const r = presenceRectPx(output(), appearanceN, 2);
    expect(r.y).toBeLessThan(540 - 100);
  });

  it('builds a final hidden frame from the previous state', () => {
    const prev = mapRenderState(output(), appearance, { seq: 1, toLocalDip: (p) => p, scaleFactor: 1, forceSnap: false, hidden: false, simNow: 1 });
    const fin = hiddenRenderState(prev, 2, 50);
    expect(fin).toMatchObject({ seq: 2, t: 50, visible: false, emote: null, snap: true, x: prev.x });
  });
});

describe('display diff', () => {
  it('plans create / recreate / keep / remove', () => {
    const a = display('A', 0, 1);
    const b = display('B', 1600, 1.25);
    const existing = new Map([
      ['A', a],
      ['B', b],
      ['C', display('C', 3200, 1)],
    ]);
    const bScaled = { ...b, scaleFactor: 1.5 };
    const aMovedPx = { ...a, boundsPx: { ...a.boundsPx, x: 10 } };
    const plan = planOverlaySync(existing, [aMovedPx, bScaled, display('D', -1600, 1)]);
    expect(plan.keep.map((d) => d.id)).toEqual(['A']);
    expect(plan.recreate.map((d) => d.id)).toEqual(['B']);
    expect(plan.create.map((d) => d.id)).toEqual(['D']);
    expect(plan.remove).toEqual(['C']);
  });

  it('treats work-area changes (taskbar moved) as geometry changes', () => {
    const a = display('A', 0, 1);
    expect(geometryChanged(a, { ...a, workAreaDip: { ...a.workAreaDip, height: 800 } })).toBe(true);
    expect(geometryChanged(a, { ...a })).toBe(false);
  });

  it('limits crash recreation to 5 per 10 minutes with exponential backoff', () => {
    let history: number[] = [];
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const b = crashBackoff(history, 1000 + i);
      expect(b.allowed).toBe(true);
      delays.push(b.delayMs);
      history = b.recent;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(crashBackoff(history, 2000).allowed).toBe(false);
    expect(crashBackoff(history, 1000 + 10 * 60_000 + 5).allowed).toBe(true);
  });
});
