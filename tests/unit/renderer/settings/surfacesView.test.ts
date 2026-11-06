// The Diagnostics page's Surfaces section (v1.1.1), DOM-free: the labelled rows built from
// a SurfaceDiagnostics, the 1 Hz poll that reads only while the page is shown, and the
// session-only outline switch's action. SIMULATED diagnostics.
import { describe, expect, it } from 'vitest';
import type { SurfaceDiagnostics } from '../../../../src/shared/surfaceDiagnostics';
import { outlineAction, SURFACES_REFRESH_MS, surfacesPoll } from '../../../../src/renderer/settings/pages/diagnostics';
import type { Timers } from '../../../../src/renderer/settings/store';
import { S } from '../../../../src/renderer/settings/strings';
import { catEntries, coordinateEntries, countRows, errorItems, reasonList, seenEntries, tabStripEntries } from '../../../../src/renderer/settings/surfacesView';

const V = S.diagnostics.surfaces;

function diagnostics(): SurfaceDiagnostics {
  return {
    at: 100_000,
    coordinates: {
      dpiAwareness: 'per-monitor',
      displays: [
        {
          id: '1',
          primary: true,
          scale: 1.25,
          boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
          workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
          workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
        },
        {
          id: '2',
          primary: false,
          scale: 1,
          boundsPx: { x: -1280, y: 0, width: 1280, height: 1024 },
          workAreaPx: { x: -1280, y: 0, width: 1280, height: 984 },
          workAreaDip: { x: -1280, y: 0, width: 1280, height: 984.5 },
        },
      ],
      cat: { displayId: '1', xPx: 812, yPx: 1195, floorYPx: 1195 },
    },
    provider: {
      windowsConsidered: 6,
      windowsWithSurfaces: 3,
      skipped: { minimized: 1, maximized: 2 },
      listed: { taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 },
      lastRefreshAt: 99_000,
      frontMaximized: true,
      tabStrips: { state: 'idle', helperRunning: false, interest: 0, strips: 0, reads: 1234, errors: 2, lastReadAt: 0, lastRejection: 'noHeadroom' },
      recentErrors: [
        { at: 40_000, source: 'uia', kind: 'timeout' },
        { at: 95_000, source: 'tracker', kind: 'enumFailed' },
      ],
    },
    nav: {
      received: { taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 },
      accepted: { taskbar: 1, windowTop: 2, windowSide: 4, tabStrip: 1 },
      rejected: { nearFloor: 1, noRoomBeside: 2 },
      reachable: { taskbar: 1, windowTop: 1, windowSide: 2, tabStrip: 0 },
      graph: { nodes: 14, edges: 22, updates: 40, rebuilds: 3 },
      climbs: { leaps: 1, mounts: 2, pulledUp: 3, reversed: 1, letGo: 0, topReResolved: 0 },
    },
    decision: {
      state: 'walking',
      support: 'floor',
      targetKind: 'windowTop',
      targets: { perch: 'available', climb: 'cooldown', tabStrip: 'unreachable' },
      exploreUrge: 0.35,
      lastElevatedAt: 90_000,
      excursions: 2,
    },
    verdict: 'The cat can reach 1 window top and 2 window sides from where it is; its urge to explore is 35%.',
  };
}

const lookup = (entries: ReadonlyArray<readonly [string, string]>, label: string): string | undefined => entries.find(([k]) => k === label)?.[1];

describe('Surfaces section: rows', () => {
  it('counts listed, usable and reachable surfaces by kind, window tops first', () => {
    expect(countRows(diagnostics())).toEqual([
      { kind: 'windowTop', label: 'Window tops', listed: '3', accepted: '2', reachable: '1' },
      { kind: 'windowSide', label: 'Window sides', listed: '6', accepted: '4', reachable: '2' },
      { kind: 'tabStrip', label: 'Tab strips', listed: '1', accepted: '1', reachable: '0' },
      { kind: 'taskbar', label: 'Taskbars', listed: '1', accepted: '1', reachable: '1' },
    ]);
  });

  it('lists skipped and rejected reasons, largest first, and says None when there are none', () => {
    const seen = seenEntries(diagnostics());
    expect(lookup(seen, V.skipped)).toBe('Maximized 2 · Minimized 1');
    expect(lookup(seen, V.rejected)).toBe('No room beside 2 · Too close to the floor 1');
    expect(lookup(seen, V.frontMaximized)).toBe(S.common.yes);
    expect(lookup(seen, V.lastScan)).toBe(S.format.justNow);
    expect(reasonList({}, V.skipReasons)).toBe(V.none);
    // Unknown keys (never sent by main, which validates) are not shown.
    expect(reasonList({ bogus: 3 } as never, V.skipReasons)).toBe(V.none);
  });

  it('describes the tab-strip helper', () => {
    expect(tabStripEntries(diagnostics())).toEqual([
      [V.tabState, 'Idle'],
      [V.helper, V.stopped],
      [V.interest, '0'],
      [V.strips, '0'],
      [V.reads, '1,234'],
      [V.readErrors, '2'],
      [V.lastRead, S.common.never],
      [V.lastRejection, 'noHeadroom'],
    ]);
  });

  it('describes the cat, its destinations and its exploring', () => {
    const cat = catEntries(diagnostics());
    expect(lookup(cat, V.state)).toBe(S.states.walking);
    expect(lookup(cat, V.support)).toBe('The floor');
    expect(lookup(cat, V.target)).toBe('A window top');
    expect(lookup(cat, V.targets.perch)).toBe('Available');
    expect(lookup(cat, V.targets.climb)).toBe('Taking a break');
    expect(lookup(cat, V.targets.tabStrip)).toBe('Out of reach');
    expect(lookup(cat, V.urge)).toBe('35%');
    expect(lookup(cat, V.excursions)).toBe('2');
    expect(lookup(cat, V.lastElevated)).toBe('1 min 30 s after start');
    expect(lookup(cat, V.climbs)).toBe('1 leap · 2 steps on · 3 pulled up · 1 turned back');
    const d = diagnostics();
    d.decision.targetKind = null;
    d.decision.lastElevatedAt = 0;
    expect(lookup(catEntries(d), V.target)).toBe(V.noTarget);
    expect(lookup(catEntries(d), V.lastElevated)).toBe(S.common.never);
  });

  it('shows the coordinates: DPI awareness, each display’s scale and work area in px and DIP, the cat and its floor', () => {
    expect(coordinateEntries(diagnostics())).toEqual([
      [V.dpi, 'per-monitor'],
      ['Display 1 (primary)', '1.25× · work area 1,920 × 1,200 at 0, 0 px · 1,536 × 960 at 0, 0 DIP'],
      ['Display 2', '1.0× · work area 1,280 × 984 at -1,280, 0 px · 1,280 × 984.5 at -1,280, 0 DIP'],
      [V.catPosition, '812, 1,195 px'],
      [V.floor, 'y 1,195 px'],
    ]);
    const d = diagnostics();
    d.coordinates.cat = { displayId: null, xPx: 0, yPx: 0, floorYPx: null };
    expect(coordinateEntries(d).slice(-2)).toEqual([
      [V.catPosition, S.format.missing],
      [V.floor, S.format.missing],
    ]);
  });

  it('lists recent problems newest first, relative to the snapshot', () => {
    expect(errorItems(diagnostics())).toEqual([`enumFailed (tracker) · ${S.format.justNow}`, 'timeout (uia) · 1 min ago']);
  });
});

function fakeTimers() {
  let now = 0;
  let id = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      pending.set(id, { at: now + ms, fn });
      return id++;
    },
    clearTimeout: (h) => {
      pending.delete(h);
    },
  };
  return {
    timers,
    get size() {
      return pending.size;
    },
    /** Runs due timers in order, letting each refresh settle (microtasks) before the next. */
    async advance(ms: number) {
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
      };
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = end;
    },
  };
}

describe('Surfaces section: refresh', () => {
  it('reads at most once per second, only while the page is shown and the window is visible', async () => {
    const t = fakeTimers();
    const page = { hidden: false };
    const doc = { visibilityState: 'visible' as DocumentVisibilityState };
    let calls = 0;
    const results: Array<SurfaceDiagnostics | null> = [];
    const poll = surfacesPoll(
      {
        getSurfaceDiagnostics: () => {
          calls++;
          return Promise.resolve(diagnostics());
        },
      },
      t.timers,
      page,
      (d) => results.push(d),
      doc,
    );
    expect(SURFACES_REFRESH_MS).toBe(1000);
    poll.start();
    await t.advance(0);
    expect(calls).toBe(1);
    await t.advance(999);
    expect(calls).toBe(1);
    await t.advance(1);
    expect(calls).toBe(2);
    await t.advance(3000);
    expect(calls).toBe(5);
    page.hidden = true;
    await t.advance(5000);
    expect(calls).toBe(5);
    page.hidden = false;
    doc.visibilityState = 'hidden';
    await t.advance(5000);
    expect(calls).toBe(5);
    doc.visibilityState = 'visible';
    await t.advance(1000);
    expect(calls).toBe(6);
    poll.stop();
    expect(t.size).toBe(0);
    await t.advance(10_000);
    expect(calls).toBe(6);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it('reports a failed read as unavailable', async () => {
    const t = fakeTimers();
    const results: Array<SurfaceDiagnostics | null> = [];
    const poll = surfacesPoll({ getSurfaceDiagnostics: () => Promise.reject(new Error('Too many requests')) }, t.timers, { hidden: false }, (d) => results.push(d), {
      visibilityState: 'visible',
    });
    poll.start();
    await t.advance(0);
    expect(results).toEqual([null]);
    poll.stop();
  });

  it('switches the outlines with session actions, never a settings patch', () => {
    expect(outlineAction(true)).toBe('showSurfaceOutlines');
    expect(outlineAction(false)).toBe('hideSurfaceOutlines');
    expect(V.outlinesDesc).toMatch(/never captures the screen/);
    expect(V.outlinesDesc).toMatch(/turns off when GizeCat restarts/);
  });

  it('the Behaviour page says maximized windows have no edges to climb', () => {
    expect(S.behavior.maximizedNote).toMatch(/^Maximized windows have no edges to climb/);
  });
});
