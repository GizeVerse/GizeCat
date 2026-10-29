// Replay of the reporting user's real desktop (v1.1.1): the captured z-order, frames and
// maximized flags (tests/fixtures/user-layout-2026-10-29.json; geometry only) through the REAL
// composition (pipeline.ts). As captured, a maximized window is in front: no surfaces, and the
// verdict says so. With each floating window brought to the front, the floor has a route to it
// and the cat gets there by itself. SIMULATED geometry, MOCKED OS and helper.
import { afterEach, describe, expect, it } from 'vitest';
import { FRONT_MAXIMIZED_TEXT, SURFACE_VERDICT_CODES } from '../../../src/main/diagnostics/surfaceVerdict';
import { ELEVATED, onFloor, onTopOf, onWindow, Pipeline, userCat, userLayout } from './pipeline';

const MIN = 60_000;
const layout = userLayout();
const foreground = layout.find((w) => w.fg)!;
/** Floating app windows of other processes (the cat's own Settings window is never a surface). */
const floating = layout.filter((w) => !w.own && !w.zoomed && !w.tool && w.cls !== 'Progman');

const open: Pipeline[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.dispose();
});

function replay(seed: number): Pipeline {
  const p = new Pipeline({ windows: layout, completeZOrder: true, foreground: foreground.hwnd, seed, cat: userCat(seed) });
  open.push(p);
  return p;
}

const elevatedListed = (p: Pipeline) => p.surfaces.filter((s) => ELEVATED.has(s.kind));

describe("the user's layout as captured", () => {
  it('fixture: geometry only, generic process names except chrome.exe, the maximized console in front', () => {
    expect(layout).toHaveLength(13);
    for (const w of layout) {
      expect(Object.keys(w).some((k) => /title|name|path|text/i.test(k))).toBe(false);
      expect(w.exe).toMatch(/^(app\d+|shell|self|chrome)\.exe$/);
    }
    expect(foreground.zoomed).toBe(true);
    expect(floating.map((w) => w.exe)).toEqual(['app3.exe', 'app4.exe', 'app5.exe', 'chrome.exe', 'app6.exe']);
  });

  it('a maximized window in front: 0 surfaces for 10 minutes, verdict frontMaximized, the cat stays on the floor', async () => {
    const p = replay(1);
    await p.run(10 * MIN);
    expect(p.samples.length).toBeGreaterThan(1000);
    expect(p.samples.every((s) => s.surfaceId === null)).toBe(true);
    expect(p.samples.some((s) => ELEVATED.has(s.support))).toBe(false);
    expect(elevatedListed(p)).toEqual([]);
    const { diagnostics: d, code } = p.diagnostics();
    expect(code).toBe('frontMaximized');
    expect(SURFACE_VERDICT_CODES).toContain(code);
    expect(d.verdict).toBe(FRONT_MAXIMIZED_TEXT);
    expect(d.provider.frontMaximized).toBe(true);
    expect(d.provider.listed).toMatchObject({ windowTop: 0, windowSide: 0, tabStrip: 0 });
    // Three maximized windows; every floating one is hidden behind the one in front.
    expect(d.provider.skipped.maximized).toBe(3);
    expect(d.provider.skipped.covered).toBe(floating.length);
    expect(d.nav.reachable).toMatchObject({ windowTop: 0, windowSide: 0, tabStrip: 0 });
    expect(onFloor(p.last)).toBe(true);
  });
});

describe("the user's layout with each floating window brought to the front", () => {
  // Measured (user cat, seeds 1-3): first arrival 148-221 sim-s for every window.
  for (const w of floating) {
    it(`${w.exe} ${JSON.stringify(w.frame)}: the floor has a route to it, the cat gets onto it, and the maximized window back in front takes it all away`, async () => {
      const p = replay(1);
      await p.run(2000);
      p.bringToFront(w.hwnd);
      await p.run(3000);
      // Only the front window offers surfaces now (everything else is behind the maximized one).
      const listed = elevatedListed(p);
      expect(listed.length).toBeGreaterThanOrEqual(1);
      expect(listed.every((s) => s.ownerId === w.hwnd)).toBe(true);
      expect(listed.some((s) => s.kind === (w.exe === 'chrome.exe' ? 'tabStrip' : 'windowTop'))).toBe(true);
      const d = p.surfaceDiagnostics();
      const reachable = d.nav.reachable.windowTop + d.nav.reachable.windowSide + d.nav.reachable.tabStrip;
      expect(reachable, 'routes from the floor').toBeGreaterThanOrEqual(1);
      expect(d.nav.rejected).toEqual({});
      expect(p.diagnostics().code).toBe('exploring');

      const up = await p.runUntil(onTopOf(w.hwnd), 10 * MIN);
      expect(up, 'the cat got onto the window by itself').not.toBeNull();
      expect(up!.support).toBe(w.exe === 'chrome.exe' ? 'tabStrip' : 'windowTop');
      expect(p.diagnostics().code).toBe('elevated');

      // The maximized console back in front covers the window: the cat comes down calmly.
      const i0 = p.samples.length;
      p.bringToFront(foreground.hwnd);
      await p.run(4000);
      expect(elevatedListed(p)).toEqual([]);
      const after = p.samples.slice(i0);
      expect(onFloor(p.last)).toBe(true);
      expect(after.map((s) => s.state)).not.toContain('startled');
      expect(p.diagnostics().code).toBe('frontMaximized');
      expect(p.samples.slice(i0 + after.findIndex(onFloor)).some(onWindow(w.hwnd))).toBe(false);
      expect(p.host.debug().tickErrors).toBe(0);
    });
  }
});
