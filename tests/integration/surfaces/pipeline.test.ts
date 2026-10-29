// Self-checks of the headless pipeline (pipeline.ts): its stand-ins reproduce what was measured
// on the real machine, and the composition is the app's (real win32 classification, real
// provider), so the scenario tests exercise production code paths.
import { afterEach, describe, expect, it } from 'vitest';
import { appWindow, FLOOR_Y, Pipeline, probeStrip, SCREEN } from './pipeline';

const open: Pipeline[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.dispose();
});

describe('pipeline stand-ins', () => {
  it('probeStrip on the probe frame is the REAL uia-probe measurement (Edge 156, 125 %)', () => {
    const s = probeStrip({ left: 133, top: 125, right: 133 + 1359, bottom: 125 + 867 }, false);
    expect(s.frame).toEqual({ x: 133, y: 125, w: 1359, h: 867 });
    expect(s.dpi).toBe(120);
    expect(s.leftButton).toEqual({ x: 139, y: 125, w: 40, h: 45 });
    expect(s.tabs.map((t) => [t.x - 133, t.y - 125, t.w, t.h])).toEqual([
      [41, 0, 320, 52],
      [340, 0, 320, 52],
      [638, 0, 320, 52],
    ]);
    expect(s.newTab).toEqual({ x: 1086, y: 125, w: 40, h: 52 });
    expect(s.grab).toEqual({ x: 1126, y: 125, w: 193, h: 52 });
    expect(s.captions).toEqual({ x: 1319, y: 126, w: 173, h: 49 });
  });

  it('a narrower browser keeps the measured controls and shrinks the tabs', () => {
    const s = probeStrip({ left: 1123, top: 113, right: 1123 + 772, bottom: 113 + 1048 }, false);
    expect(s.captions!.w).toBe(173);
    expect(s.newTab!.w).toBe(40);
    expect(s.grab!.w).toBeGreaterThanOrEqual(60);
    expect(s.grab!.x + s.grab!.w).toBe(s.captions!.x);
    expect(s.tabs[0]!.w).toBeLessThan(320);
  });

  it('the screen and floor are the user’s (1920x1200 at 125 %, 4 DIP floor inset)', () => {
    expect(SCREEN).toEqual({ x: 0, y: 0, width: 1920, height: 1200 });
    expect(FLOOR_Y).toBe(1195);
  });

  it('runs the real classification: a maximized browser offers nothing, the cat’s own windows are never surfaces', async () => {
    const p = new Pipeline({
      windows: [
        appWindow('500', 'msedge.exe', [0, 0, 1920, 1200], { rect: [-9, -9, 1938, 1218], zoomed: true }),
        appWindow('501', 'self.exe', [400, 300, 600, 500], { own: true }),
      ],
      seed: 1,
    });
    open.push(p);
    await p.run(3000);
    expect(p.surfaces.filter((s) => s.kind !== 'taskbar')).toEqual([]);
    const d = p.diagnostics().diagnostics;
    expect(d.provider.windowsConsidered).toBe(1);
    expect(d.provider.skipped.maximized).toBe(1);
    expect(d.provider.frontMaximized).toBe(true);
    // A maximized browser is never measured (no headroom above its strip).
    expect(p.helper.stripReads).toEqual([]);
  });
});
