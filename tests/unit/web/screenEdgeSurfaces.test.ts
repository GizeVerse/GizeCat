// The floating cat's screen-edge provider (src/web/screenEdgeSurfaces.ts, 1.4.2). Written for 1.4.2 and
// NOT RUN by the agent that wrote it (owner rule: no tests); the owner or CI runs it.
import { describe, expect, it } from 'vitest';
import type { DisplayService } from '../../../src/main/contracts';
import { ANDROID_EDGE_COOLDOWN_SCALE, createScreenEdgeProvider } from '../../../src/web/screenEdgeSurfaces';

/** Only what the provider reads: each display's id and work area. */
function displayWith(...areas: Array<{ id: string; x: number; y: number; width: number; height: number }>): Pick<DisplayService, 'world'> {
  return { world: { displays: areas.map((a) => ({ id: a.id, workAreaPx: { x: a.x, y: a.y, width: a.width, height: a.height } })) } } as unknown as Pick<DisplayService, 'world'>;
}

describe('screen-edge provider (Android floating cat)', () => {
  it('has no window surfaces: an app cannot see other apps', () => {
    const p = createScreenEdgeProvider(displayWith({ id: 'a', x: 0, y: 0, width: 1080, height: 2200 }));
    expect(p.getSurfaces(0, 1000)).toEqual([]);
    expect(p.status.windowSurfaces).toBe('unavailable');
    expect(p.status.tabStrips).toBe('unavailable');
  });

  it('offers the left and right edge of every display, clear along the whole work area', () => {
    const p = createScreenEdgeProvider(
      displayWith({ id: 'a', x: 0, y: 40, width: 1080, height: 2100 }, { id: 'b', x: 1080, y: 0, width: 800, height: 1200 }),
    );
    const bands = p.edgeBands?.() ?? [];
    expect(bands).toHaveLength(4);
    const one = bands.filter((b) => b.displayId === 'a');
    expect(one.map((b) => b.side).sort()).toEqual(['left', 'right']);
    expect(one[0]?.clearSpans).toEqual([{ y0: 40, y1: 2140 }]);
  });

  it('skips a display with no work area height', () => {
    const p = createScreenEdgeProvider(displayWith({ id: 'a', x: 0, y: 0, width: 1080, height: 0 }));
    expect(p.edgeBands?.()).toEqual([]);
  });

  it('declares the edges guardless, both sides, with the shortened pause between visits', () => {
    const p = createScreenEdgeProvider(displayWith({ id: 'a', x: 0, y: 0, width: 1080, height: 2200 }));
    expect(p.guardlessScreenEdges).toEqual({ fullBothSides: true, cooldownScale: ANDROID_EDGE_COOLDOWN_SCALE });
    expect(ANDROID_EDGE_COOLDOWN_SCALE).toBeGreaterThan(0);
    expect(ANDROID_EDGE_COOLDOWN_SCALE).toBeLessThan(1);
  });

  it('reads the pause scale each time, and falls back when it is not a number', () => {
    let scale = 0.5;
    const p = createScreenEdgeProvider(displayWith({ id: 'a', x: 0, y: 0, width: 1080, height: 2200 }), { cooldownScale: () => scale });
    expect(p.guardlessScreenEdges?.cooldownScale).toBe(0.5);
    scale = Number.NaN;
    expect(p.guardlessScreenEdges?.cooldownScale).toBe(ANDROID_EDGE_COOLDOWN_SCALE);
  });
});
