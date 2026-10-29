// v1.1.1 surface diagnostics in main: assembly (contract fields only, never titles or ids),
// the floor under the cat, failing producers, the >= 500 ms cache, the rate-limited
// 'surfaces summary' log line, the boot DPI awareness tap and the diagnostics export.
// SIMULATED producers (plain objects); the real assembly, verdict, schema and report code.
import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport } from '../../../src/main/diagnostics/diagnosticsReport';
import { describeDpiAwareness, watchDpiAwareness } from '../../../src/main/diagnostics/dpiAwareness';
import {
  assembleSurfaceDiagnostics,
  createSurfaceDiagnosticsSource,
  createSurfaceSummaryLog,
  SURFACE_DIAGNOSTICS_CACHE_MS,
  SURFACE_SUMMARY_MIN_INTERVAL_MS,
  surfaceSummary,
  type SurfaceDiagnosticsInputs,
} from '../../../src/main/diagnostics/surfaceDiagnostics';
import type { AppStatus } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';
import type { ProviderDiagnostics } from '../../../src/shared/surfaceDiagnostics';
import { parseSurfaceDiagnostics } from '../../../src/shared/surfaceDiagnosticsSchema';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { decisionDiagnostics, navDiagnostics, providerDiagnostics } from './diagnosticsSurfaceFixture';
import { memoryLogger } from './helpers';

const TITLE = 'Secret Bank - Statement.pdf - Chrome';
const PROCESS = 'chrome.exe';
const HWND = '197482';

const display: DisplayGeometry = {
  id: '2528732444',
  primary: true,
  scaleFactor: 1.25,
  boundsDip: { x: 0, y: 0, width: 1536, height: 960 },
  workAreaDip: { x: 0, y: 0, width: 1536, height: 960 },
  boundsPx: { x: 0, y: 0, width: 1920, height: 1200 },
  workAreaPx: { x: 0, y: 0, width: 1920, height: 1200 },
};
const world: WorldGeometry = { version: 1, displays: [display] };

/** A producer that (wrongly) carries a title, a process name and window ids next to the contract fields. */
function leakyProvider(): ProviderDiagnostics {
  const p = providerDiagnostics() as ProviderDiagnostics & Record<string, unknown>;
  p.title = TITLE;
  p.processName = PROCESS;
  p.windows = [{ id: HWND, title: TITLE }];
  (p.tabStrips as unknown as Record<string, unknown>).tabName = TITLE;
  (p.recentErrors[0] as unknown as Record<string, unknown>).windowTitle = TITLE;
  return p;
}

function inputs(over: Partial<SurfaceDiagnosticsInputs> = {}): SurfaceDiagnosticsInputs {
  return {
    at: 10_000,
    dpiAwareness: 'per-monitor',
    world,
    output: { x: 812, y: 1195, displayId: display.id },
    observers: 'tracked',
    provider: () => leakyProvider(),
    sim: () => ({ nav: { ...navDiagnostics(), surfaceIds: [`windowTop:${HWND}`] } as never, decision: { ...decisionDiagnostics(), targetId: `windowTop:${HWND}` } as never }),
    ...over,
  };
}

describe('surface diagnostics assembly', () => {
  it('copies only contract fields: no title, process name or window id survives, and the result passes the strict schema', () => {
    const { diagnostics, code } = assembleSurfaceDiagnostics(inputs());
    const json = JSON.stringify(diagnostics);
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(PROCESS);
    expect(json).not.toContain(HWND);
    expect(parseSurfaceDiagnostics(diagnostics)).toEqual(diagnostics);
    expect(diagnostics.provider.listed).toEqual({ taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 });
    expect(diagnostics.provider.recentErrors).toEqual([
      { at: 4_000, source: 'uia', kind: 'timeout' },
      { at: 8_000, source: 'tracker', kind: 'enumFailed' },
    ]);
    expect(code).toBe('exploring');
    expect(diagnostics.verdict).toBe('The cat can reach 1 window top and 2 window sides from where it is; its urge to explore is 35%.');
  });

  it('reports the coordinates: DPI awareness, displays and the floor the sim uses under the cat (4 DIP inset at 125 %)', () => {
    const { diagnostics } = assembleSurfaceDiagnostics(inputs());
    expect(diagnostics.coordinates).toEqual({
      dpiAwareness: 'per-monitor',
      displays: [{ id: display.id, primary: true, scale: 1.25, boundsPx: display.boundsPx, workAreaPx: display.workAreaPx, workAreaDip: display.workAreaDip }],
      cat: { displayId: display.id, xPx: 812, yPx: 1195, floorYPx: 1195 },
    });
    const before = assembleSurfaceDiagnostics(inputs({ output: null })).diagnostics.coordinates.cat;
    expect(before).toEqual({ displayId: null, xPx: 0, yPx: 0, floorYPx: null });
  });

  it('survives failing producers with empty counts and a recent-errors entry', () => {
    const { diagnostics, code } = assembleSurfaceDiagnostics(
      inputs({
        provider: () => {
          throw new Error(`boom ${TITLE}`);
        },
        sim: () => {
          throw new Error('sim boom');
        },
      }),
    );
    expect(diagnostics.provider.listed).toEqual({ taskbar: 0, windowTop: 0, windowSide: 0, tabStrip: 0 });
    expect(diagnostics.provider.recentErrors.map((e) => e.kind)).toEqual(['providerFailed', 'simFailed']);
    expect(JSON.stringify(diagnostics)).not.toContain(TITLE);
    expect(code).toBe('nothingListed');
    expect(parseSurfaceDiagnostics(diagnostics)).not.toBeNull();
  });

  it('clamps and caps what producers report so the schema always holds', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ at: i, source: 'uia', kind: `k${i}` }));
    const { diagnostics } = assembleSurfaceDiagnostics(
      inputs({
        observers: 'unavailable',
        provider: () => providerDiagnostics({ windowsConsidered: -3, recentErrors: many, tabStrips: { ...providerDiagnostics().tabStrips, state: 'bogus' as never, lastRejection: 'x'.repeat(500) } }),
        sim: () => ({ nav: navDiagnostics({ rejected: { nearFloor: Number.NaN, bogus: 4 } as never }), decision: decisionDiagnostics({ exploreUrge: 7, support: 'ceiling' as never }) }),
      }),
    );
    expect(diagnostics.provider.recentErrors).toHaveLength(10);
    expect(diagnostics.provider.recentErrors.at(-1)?.kind).toBe('k24');
    expect(diagnostics.provider.windowsConsidered).toBe(0);
    expect(diagnostics.provider.tabStrips.state).toBe('unavailable');
    expect(diagnostics.provider.tabStrips.lastRejection).toHaveLength(64);
    expect(diagnostics.nav.rejected).toEqual({ nearFloor: 0 });
    expect(diagnostics.decision.exploreUrge).toBe(1);
    expect(diagnostics.decision.support).toBe('none');
    expect(parseSurfaceDiagnostics(diagnostics)).not.toBeNull();
  });
});

describe('surface diagnostics cache', () => {
  it('reuses one build for at least 500 ms, then rebuilds', () => {
    let now = 0;
    let builds = 0;
    const source = createSurfaceDiagnosticsSource({
      clock: () => now,
      build: (at) => {
        builds++;
        return assembleSurfaceDiagnostics(inputs({ at }));
      },
      // A shorter period is not honoured.
      cacheMs: 50,
    });
    expect(SURFACE_DIAGNOSTICS_CACHE_MS).toBeGreaterThanOrEqual(500);
    const first = source.get();
    now = 499;
    expect(source.get()).toBe(first);
    expect(builds).toBe(1);
    now = 500;
    expect(source.get()).not.toBe(first);
    expect(source.get().diagnostics.at).toBe(500);
    expect(builds).toBe(2);
  });
});

describe("'surfaces summary' log line", () => {
  const summaryOf = (over: Partial<SurfaceDiagnosticsInputs> = {}) => surfaceSummary(assembleSurfaceDiagnostics(inputs(over)));

  it('logs counts by kind, flags, the verdict code, the support kind and the trips up only (no titles, ids or process names)', () => {
    const log = memoryLogger();
    expect(createSurfaceSummaryLog({ logger: log }).note(summaryOf(), 0)).toBe(true);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ level: 'info', msg: 'surfaces summary' });
    expect(log.entries[0]!.data).toEqual({
      listed: { taskbar: 1, windowTop: 3, windowSide: 6, tabStrip: 1 },
      accepted: { taskbar: 1, windowTop: 2, windowSide: 4, tabStrip: 1 },
      reachable: { taskbar: 1, windowTop: 1, windowSide: 2, tabStrip: 0 },
      frontMaximized: false,
      tabStrips: 'active',
      verdict: 'exploring',
      support: 'floor',
      excursions: 2,
    });
    const json = JSON.stringify(log.entries);
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(PROCESS);
    expect(json).not.toContain(HWND);
  });

  it('logs on change only, at most once per 60 s, and catches up with the latest state after that', () => {
    const log = memoryLogger();
    const sl = createSurfaceSummaryLog({ logger: log });
    const a = summaryOf();
    const b = summaryOf({ observers: 'unavailable' });
    expect(SURFACE_SUMMARY_MIN_INTERVAL_MS).toBe(60_000);
    expect(sl.note(a, 0)).toBe(true);
    // Unchanged: never repeated, even long after.
    expect(sl.note(a, 10_000)).toBe(false);
    expect(sl.note(a, 120_000)).toBe(false);
    // Changed but within 60 s of the last line: held back.
    const c = summaryOf({ provider: () => providerDiagnostics({ frontMaximized: true, listed: { taskbar: 1, windowTop: 0, windowSide: 0, tabStrip: 0 } }) });
    expect(sl.note(a, 120_000)).toBe(false);
    expect(sl.note(b, 130_000)).toBe(true);
    expect(sl.note(c, 150_000)).toBe(false);
    expect(sl.note(c, 189_999)).toBe(false);
    expect(sl.note(c, 190_000)).toBe(true);
    expect(log.entries.map((e) => (e.data as { verdict: string }).verdict)).toEqual(['exploring', 'observersUnavailable', 'frontMaximized']);
  });

  it('a trip up shows in the log: a new support kind or excursion count is a change, still at most once per 60 s', () => {
    const log = memoryLogger();
    const sl = createSurfaceSummaryLog({ logger: log });
    const withDecision = (over: Partial<ReturnType<typeof decisionDiagnostics>>) => summaryOf({ sim: () => ({ nav: navDiagnostics(), decision: decisionDiagnostics(over) }) });
    const floor = withDecision({ support: 'floor', excursions: 0 });
    const side = withDecision({ support: 'windowSide', excursions: 0 });
    const top = withDecision({ support: 'windowTop', excursions: 1 });
    const back = withDecision({ support: 'floor', excursions: 1 });
    expect(sl.note(floor, 0)).toBe(true);
    // Climbing within the minute: held back, then logged once the interval has passed.
    expect(sl.note(side, 30_000)).toBe(false);
    expect(sl.note(top, 60_000)).toBe(true);
    expect(sl.note(top, 130_000)).toBe(false);
    expect(sl.note(back, 130_000)).toBe(true);
    // Only the excursion count changes (a trip up and down between two checks): a change.
    const again = withDecision({ support: 'floor', excursions: 2 });
    expect(sl.note(again, 200_000)).toBe(true);
    // Only the support kind changes (same counts, same verdict): a change.
    const onTaskbar = withDecision({ support: 'taskbar', excursions: 2 });
    expect(onTaskbar.verdict).toBe(again.verdict);
    expect(sl.note(onTaskbar, 260_000)).toBe(true);
    expect(sl.note(onTaskbar, 400_000)).toBe(false);
    expect(log.entries.map((e) => e.data as { support: string; excursions: number; verdict: string })).toMatchObject([
      { support: 'floor', excursions: 0, verdict: 'exploring' },
      { support: 'windowTop', excursions: 1, verdict: 'elevated' },
      { support: 'floor', excursions: 1, verdict: 'exploring' },
      { support: 'floor', excursions: 2, verdict: 'exploring' },
      { support: 'taskbar', excursions: 2, verdict: 'exploring' },
    ]);
    // A producer's out-of-contract support or a bogus count never reaches the log as is.
    const odd = withDecision({ support: 'ceiling' as never, excursions: Number.NaN });
    expect({ support: odd.support, excursions: odd.excursions }).toEqual({ support: 'none', excursions: 0 });
  });
});

describe('boot DPI awareness', () => {
  it('describes GetAwarenessFromDpiAwarenessContext values', () => {
    expect(describeDpiAwareness(2)).toBe('per-monitor');
    expect(describeDpiAwareness(1)).toBe('system');
    expect(describeDpiAwareness(0)).toBe('unaware');
    expect(describeDpiAwareness(-1)).toBe('unknown (-1)');
    expect(describeDpiAwareness(null)).toBe('unknown');
  });

  it('notes the line win32 logs at boot (any scope, any level) and forwards every line unchanged', () => {
    const log = memoryLogger('app');
    const seen: string[] = [];
    const tapped = watchDpiAwareness(log, (a) => seen.push(a));
    const win32 = tapped.child('win32');
    win32.debug('loading user32');
    win32.info('thread DPI awareness', { awareness: 2, perMonitor: true });
    win32.warn('thread is not per-monitor DPI aware; Win32 coordinates may be virtualised', { awareness: 1 });
    win32.error('other', { awareness: 0 });
    expect(seen).toEqual(['per-monitor', 'system']);
    expect(log.entries.map((e) => [e.level, e.scope, e.msg])).toEqual([
      ['debug', 'app.win32', 'loading user32'],
      ['info', 'app.win32', 'thread DPI awareness'],
      ['warn', 'app.win32', 'thread is not per-monitor DPI aware; Win32 coordinates may be virtualised'],
      ['error', 'app.win32', 'other'],
    ]);
  });
});

const status: AppStatus = {
  version: '1.1.1',
  visible: true,
  paused: false,
  interactionsEnabled: true,
  catState: 'idle',
  displayCount: 1,
  perception: { mode: 'off', paused: false, blockedReason: null, lastCaptureAt: null, capturesThisHour: 0, aiProviderLabel: null, lastError: null },
  windowAwareness: 'event-hooks',
  loginItem: { enabled: true, preference: 'unset', disabledBy: null, active: false, writable: false, reason: null, showNotice: false },
  surfaceOutlines: false,
  shortcutRegistered: true,
  startedAt: 0,
};

describe('diagnostics export: surfaces section', () => {
  it('contains the SurfaceDiagnostics object, intact, and no titles, process names or window ids', () => {
    const surfaces = assembleSurfaceDiagnostics(inputs()).diagnostics;
    const report = buildDiagnosticsReport({
      generatedAt: new Date('2026-10-29T12:00:00Z'),
      versions: { app: '1.1.1' },
      os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
      world,
      settings: defaultSettings(),
      apiKeysStored: { anthropic: false, openaiCompatible: false },
      status,
      cat: {},
      surfaces,
      services: {},
      resources: [],
      logs: [],
    });
    expect(report.surfaces).toEqual(surfaces);
    const json = JSON.stringify(report);
    expect(json).toContain('"verdict":"The cat can reach 1 window top and 2 window sides');
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(PROCESS);
    expect(json).not.toContain(HWND);
  });
});
