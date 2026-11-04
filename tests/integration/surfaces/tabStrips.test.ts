// Tab strips end to end (v1.1.1): a floating browser's strip is measured while the cat is still on
// the floor, and the cat gets onto it; a missing or hung helper leaves the window top in use and
// the diagnostics say what the helper is doing. SIMULATED geometry through the REAL composition
// (pipeline.ts) with the REAL TabStripService; the helper process is a MOCKED stand-in answering
// with the strip geometry the REAL uia-probe measured on this machine (Edge 156, 125 %).
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgeSurface } from '../../../src/shared/surfaces';
import { appWindow, BODY_PX, freshCat, onFloor, onTopOf, Pipeline, stays, type HelperMode } from './pipeline';

const MIN = 60_000;
/** The probe's own throwaway Edge window: the REAL measured frame [133,125,1359,867]. */
const EDGE = '29494942';
const PROBE_FRAME: [number, number, number, number] = [133, 125, 1359, 867];
const STRIP = `tabStrip:${EDGE}`;

const open: Pipeline[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.dispose();
});

function browser(seed: number, helper: HelperMode = 'probe'): Pipeline {
  const p = new Pipeline({ windows: [appWindow(EDGE, 'msedge.exe', PROBE_FRAME)], seed, cat: freshCat(seed), helper });
  open.push(p);
  return p;
}

describe('a floating browser (probe-shaped strip)', () => {
  // Measured (seeds 1-4): strip listed 1 s after start, first arrival on it at 184-275 sim-s.
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: the strip reaches the sim while the cat is on the floor, and the cat gets onto it`, async () => {
      const p = browser(seed);
      const listed = await p.runUntil(() => p.surfaces.some((s) => s.id === STRIP), 10_000);
      expect(listed, 'strip listed').not.toBeNull();
      expect(onFloor(p.last)).toBe(true);
      // Same strip as the REAL service produced from the same measurement (tmp uia-probe.json: surface y 125, x0 239.5, x1 1025.5).
      const strip = p.surfaces.find((s) => s.id === STRIP) as LedgeSurface;
      expect(strip).toMatchObject({ kind: 'tabStrip', ownerId: EDGE, y: 125, x0: 239.5, x1: 1025.5, excluded: false });
      // The strip replaced the window top; both sides lead to it.
      expect(p.surfaces.some((s) => s.id === `windowTop:${EDGE}`)).toBe(false);
      const sides = p.surfaces.filter((s) => s.kind === 'windowSide');
      expect(sides).toHaveLength(2);
      for (const s of sides) expect(s.orientation === 'wall' && s.topLedgeId).toBe(STRIP);
      // Measured from the floor: the browser is far beyond the 300 DIP interest radius (RC4).
      expect(p.helper.stripReads.some((r) => r.hwnd === EDGE)).toBe(true);
      const d0 = p.diagnostics().diagnostics;
      expect(d0.provider.tabStrips).toMatchObject({ helperRunning: true, strips: 1, errors: 0 });
      expect(d0.nav.reachable.tabStrip).toBe(1);

      await p.run(10 * MIN);
      const first = stays(p.samples).find((s) => s.surfaceId === STRIP);
      expect(first, 'arrived on the tab strip within 10 sim-min').toBeDefined();
      expect(first!.to - first!.from).toBeGreaterThanOrEqual(10_000);
      expect(first!.pathPx).toBeGreaterThanOrEqual(3 * BODY_PX);
      // On the strip it stays on the browser's open top edge (strip.land, RC6). A pull-up from the
      // right side ends at the corner, over the caption buttons: from there it only walks straight
      // onto the strip's span (measured: 4.7 s from x 1440 to 1026), it never stops outside it.
      const land = strip.land!;
      expect(land).toEqual({ x0: 143, x1: 1482 });
      let outside: Array<{ t: number; d: number }> = [];
      const outsides: Array<{ seg: Array<{ t: number; d: number }>; endedOnSpan: boolean }> = [];
      for (const s of p.samples) {
        if (s.surfaceId !== STRIP) {
          // Left the strip from outside its span (e.g. to swing down a side): no walk-in to check.
          if (outside.length > 0) outsides.push({ seg: outside, endedOnSpan: false });
          outside = [];
          continue;
        }
        expect(s.y).toBe(125);
        expect(s.x).toBeGreaterThanOrEqual(land.x0);
        expect(s.x).toBeLessThanOrEqual(land.x1);
        const d = s.x < strip.x0 ? strip.x0 - s.x : s.x > strip.x1 ? s.x - strip.x1 : 0;
        if (d > 1) outside.push({ t: s.t, d });
        else if (outside.length > 0) {
          outsides.push({ seg: outside, endedOnSpan: true });
          outside = [];
        }
      }
      expect(outside, 'not left outside the span at the end of the run').toEqual([]);
      for (const { seg, endedOnSpan } of outsides) {
        // It never stops out there: however far it was, the walk takes no longer than that distance at its slowest pace (52 px/s here).
        const far = Math.max(...seg.map((p) => p.d));
        expect(seg[seg.length - 1]!.t - seg[0]!.t).toBeLessThanOrEqual((far / 45) * 1000 + 1000);
        if (endedOnSpan) for (let i = 1; i < seg.length; i++) expect(seg[i]!.d).toBeLessThanOrEqual(seg[i - 1]!.d + 0.5);
      }
      // A climb whose planned top was replaced re-resolves instead of reversing (RC3).
      expect(p.surfaceDiagnostics().nav.climbs.reversed).toBe(0);
    });
  }
});

describe('tab-strip helper missing or hung', () => {
  for (const helper of ['missing', 'hung'] as const) {
    it(`${helper}: the window top is listed and used, and the diagnostics show the helper's state`, async () => {
      const p = browser(1, helper);
      await p.run(10_000);
      expect(p.surfaces.map((s) => s.id).sort()).toEqual([`windowSide:${EDGE}:left`, `windowSide:${EDGE}:right`, `windowTop:${EDGE}`]);
      const d = p.diagnostics().diagnostics;
      expect(d.provider.listed).toMatchObject({ windowTop: 1, windowSide: 2, tabStrip: 0 });
      expect(d.nav.reachable.windowTop).toBe(1);
      if (helper === 'missing') {
        expect(d.provider.tabStrips).toMatchObject({ state: 'unavailable', helperRunning: false, strips: 0, reads: 0 });
        expect(p.helper.spawns).toBe(0);
      } else {
        // The read timed out (1.5 s); the stuck helper was replaced, the browser set aside for a while.
        expect(d.provider.tabStrips.strips).toBe(0);
        expect(d.provider.tabStrips.errors).toBeGreaterThanOrEqual(1);
        expect(d.provider.tabStrips.lastRejection).toBe('timeout');
        expect(d.provider.tabStrips.lastReadAt).toBe(0);
        expect(p.helper.spawns).toBeGreaterThanOrEqual(1);
      }
      expect(await p.runUntil(onTopOf(EDGE), 10 * MIN), 'reached the window top').not.toBeNull();
      expect(p.last.support).toBe('windowTop');
      // A hung helper never stalls the cat's host loop.
      expect(p.host.debug().tickErrors).toBe(0);
      if (helper === 'hung') {
        const later = p.diagnostics().diagnostics.provider.tabStrips;
        // Backed off: a handful of attempts in 10+ minutes, not a retry storm.
        expect(later.errors).toBeLessThanOrEqual(8);
        expect(p.helper.stripReads.length).toBeLessThanOrEqual(8);
      }
    });
  }
});
