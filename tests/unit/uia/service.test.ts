// TabStripService against the fake helper process (MOCKED helper; real child processes and pipes).
// Every decision uses the injected clock; tests advance it and pump through setInterest.
import { afterEach, describe, expect, it } from 'vitest';
import { createTabStripService, type TabStripServiceImpl, type TabStripServiceOptions } from '../../../src/main/uia';
import type { TabStripService } from '../../../src/main/contracts';
import type { SimEvent } from '../../../src/shared/sim';
import { wireStrip } from './fixtures';
import { eventually, FakeWindows, fakeHelperHarness, ManualClock, memoryLogger, settingsWith, type FakeHelperHarness } from './harness';
import type { FakeHelperState } from './fakeHelper';

const A = '65552';
const B = '131090';
const E = '262200';

interface Rig {
  h: FakeHelperHarness;
  clock: ManualClock;
  wins: FakeWindows;
  svc: TabStripServiceImpl;
  log: ReturnType<typeof memoryLogger>;
}

const rigs: Rig[] = [];

function rig(state: FakeHelperState, o: { tabStrips?: boolean; helperPath?: string | null; options?: Partial<TabStripServiceOptions> } = {}): Rig {
  const h = fakeHelperHarness(state);
  const clock = new ManualClock();
  const wins = new FakeWindows();
  const log = memoryLogger();
  const svc = createTabStripService({
    logger: log,
    settings: settingsWith({ tabStrips: o.tabStrips ?? true }),
    helperPath: o.helperPath === undefined ? 'C:\\fake\\DesktopCatUia.exe' : o.helperPath,
    describeWindow: wins.describe,
    now: clock.now,
    spawnHelper: h.spawnHelper,
    options: { autoPumpMs: 0, ...o.options },
  });
  const r = { h, clock, wins, svc, log };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.svc.dispose();
    await r.h.cleanup();
  }
});

const stripOps = (r: Rig, hwnd: string): number => r.h.ops('strip').filter((q) => q.hwnd === hwnd).length;

async function waitForStrip(r: Rig, hwnd: string): Promise<void> {
  await eventually(() => expect(r.svc.surfaces().some((s) => s.ownerId === hwnd)).toBe(true));
}

async function waitStopped(r: Rig): Promise<void> {
  await eventually(() => expect(r.svc.debugInfo().helper.running).toBe(false));
}

/** Drains until `n` events arrived (waiting for the helper's responses). */
async function drain(r: Rig, n: number): Promise<SimEvent[]> {
  const got: SimEvent[] = [];
  await eventually(
    () => {
      got.push(...r.svc.drainEvents());
      expect(got.length).toBeGreaterThanOrEqual(n);
    },
  );
  return got;
}

describe('TabStripService: lazy start and surfaces', () => {
  it('spawns nothing while off, for non-browsers, excluded, minimized or maximized windows', () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } }, { tabStrips: false });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    expect(r.svc.status).toBe('off');
    expect(r.h.children).toHaveLength(0);

    r.svc.updateSettings(settingsWith({ tabStrips: true }));
    expect(r.svc.status).toBe('idle');
    r.wins.set(A, { processName: 'code.exe', category: 'code' });
    r.svc.setInterest([A], r.clock.advance(100));
    r.wins.set(A, { processName: 'msedge.exe', category: 'browser', excluded: true });
    r.svc.setInterest([A], r.clock.advance(1000));
    r.wins.set(A, { excluded: false, minimized: true });
    r.svc.setInterest([A], r.clock.advance(1000));
    r.wins.set(A, { minimized: false, maximized: true });
    r.svc.setInterest([A], r.clock.advance(1000));
    r.svc.setInterest(['not-a-hwnd', '0123'], r.clock.advance(1000));
    expect(r.h.children).toHaveLength(0);
    expect(r.svc.status).toBe('idle');
    expect(r.svc.surfaces()).toEqual([]);
  });

  it('starts for an interesting Edge window and reports its strip as a tabStrip ledge', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    expect(r.h.children).toHaveLength(1);
    expect(r.svc.status).toBe('active');
    await waitForStrip(r, A);
    const [s] = r.svc.surfaces();
    expect(s).toEqual({
      id: `tabStrip:${A}`,
      kind: 'tabStrip',
      ownerId: A,
      displayId: null,
      phase: 'stable',
      vx: 0,
      vy: 0,
      confidence: 1,
      validatedAt: r.clock.now(),
      excluded: false,
      orientation: 'ledge',
      y: 125,
      x0: 239.5,
      x1: 1025.5,
      rest: { x0: 836.5, x1: 1025.5 },
      focusX: 931,
    });
    // Unchanged geometry keeps its identity (the surface provider compares by reference).
    expect(r.svc.surfaces()).toBe(r.svc.surfaces());
    expect(r.h.ops('ping')).toHaveLength(1);
    await eventually(() => expect(r.h.ops('watch').at(-1)?.hwnds).toEqual([A]));
    expect(r.svc.debugInfo()).toMatchObject({ status: 'active', windows: 1, withStrip: 1, helper: { ready: true, dpiMode: 'permonitorv2', spawns: 1 } });
    // The implementation satisfies the main-process contract.
    const contract: TabStripService = r.svc;
    expect(contract.status).toBe('active');
  });

  it('follows a moved window between reads (and changes identity then)', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    const before = r.svc.surfaces();
    r.wins.set(A, { rect: { x: 233, y: 145, width: 1359, height: 867 } });
    r.clock.advance(100);
    const after = r.svc.surfaces();
    expect(after).not.toBe(before);
    expect(after[0]).toMatchObject({ x0: 339.5, x1: 1125.5, y: 145, vx: 1000, vy: 200, validatedAt: r.clock.now() });
  });

  it('a strip disabled by the geometry (vertical tabs, maximized) is not listed', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge', vertical: true }), [B]: wireStrip({ browser: 'chrome' }) } });
    r.svc.start();
    r.wins.set(A);
    r.wins.set(B, { processName: 'chrome.exe' });
    r.svc.setInterest([A, B], r.clock.now());
    await waitForStrip(r, B);
    await eventually(() => expect(r.svc.debugInfo().withStrip).toBe(2));
    expect(r.svc.surfaces().map((s) => s.ownerId)).toEqual([B]);
    r.wins.set(B, { maximized: true });
    r.clock.advance(1000);
    expect(r.svc.surfaces()).toEqual([]);
  });

  it('is unavailable with a reason when the helper is not installed', () => {
    const r = rig({}, { helperPath: null });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    expect(r.svc.status).toBe('unavailable');
    expect(r.svc.statusReason).toBe('UI Automation helper not installed');
    expect(r.h.children).toHaveLength(0);
    expect(r.svc.surfaces()).toEqual([]);
  });

  it('turning the toggle off stops the helper and clears the strips', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    r.svc.updateSettings(settingsWith({ tabStrips: false }));
    expect(r.svc.status).toBe('off');
    expect(r.svc.surfaces()).toEqual([]);
    await waitStopped(r);
    expect(r.h.requests().some((q) => q.line === '{"op":"quit"}')).toBe(true);
  });

  it('a different cat size changes the span', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge', at: { x: 133, y: 400 } }) } });
    r.svc.start();
    r.wins.set(A, { rect: { x: 133, y: 400, width: 1359, height: 867 } });
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    expect(r.svc.surfaces()[0]?.x0).toBe(239.5);
    r.svc.updateSettings(settingsWith({ size: 2 }));
    expect(r.svc.surfaces()[0]?.x0).toBe(292);
  });
});

describe('TabStripService: refresh policy and privacy', () => {
  it('polls windows of interest at 1 Hz and other known windows only on helper events', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }), [B]: wireStrip({ browser: 'chrome' }) } });
    r.svc.start();
    r.wins.set(A);
    r.wins.set(B, { processName: 'chrome.exe' });
    r.svc.setInterest([A, B], r.clock.now());
    await waitForStrip(r, A);
    await waitForStrip(r, B);
    expect([stripOps(r, A), stripOps(r, B)]).toEqual([1, 1]);

    r.svc.setInterest([A], r.clock.advance(500));
    expect([stripOps(r, A), stripOps(r, B)]).toEqual([1, 1]);
    r.svc.setInterest([A], r.clock.advance(600));
    await eventually(() => expect(stripOps(r, A)).toBe(2));
    r.svc.setInterest([A], r.clock.advance(1100));
    await eventually(() => expect(stripOps(r, A)).toBe(3));
    expect(stripOps(r, B)).toBe(1);

    // B is no longer of interest: only a helper event makes it re-read.
    r.h.emit('structure', B);
    await eventually(() => expect(stripOps(r, B)).toBe(2));
    expect(r.svc.debugInfo().eventsIn.structure).toBe(1);
    // Retained windows are listed (shifted with their window) until they idle out.
    expect(r.svc.surfaces().map((s) => s.ownerId).sort()).toEqual([B, A].sort());
  });

  it('never queries excluded windows and drops a window that becomes excluded', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }), [E]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(E, { excluded: true });
    r.wins.set(A);
    r.svc.setInterest([E, A], r.clock.now());
    await waitForStrip(r, A);
    expect(stripOps(r, E)).toBe(0);

    r.wins.set(A, { excluded: true });
    // The listing re-checks the verdict before reporting.
    r.clock.advance(100);
    expect(r.svc.surfaces()).toEqual([]);
    r.svc.setInterest([A, E], r.clock.advance(2000));
    r.svc.setInterest([A, E], r.clock.advance(2000));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stripOps(r, A)).toBe(1);
    expect(stripOps(r, E)).toBe(0);
    // Events for a dropped window are ignored.
    r.h.emit('selected', A);
    await eventually(() => expect(r.svc.debugInfo().eventsIn.selected).toBe(1));
    expect(stripOps(r, A)).toBe(1);
    expect(r.h.ops('strip').every((q) => q.hwnd !== E)).toBe(true);
  });

  it('a window the helper rejects is not asked again for 10 minutes; a gone window is dropped', async () => {
    const r = rig({ strips: { [A]: { error: 'rejected' }, [B]: { error: 'gone' } } });
    r.svc.start();
    r.wins.set(A);
    r.wins.set(B);
    r.svc.setInterest([A, B], r.clock.now());
    await eventually(() => expect(r.svc.debugInfo().readErrors).toBe(2));
    expect(r.svc.debugInfo().windows).toBe(0);
    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge' }), [B]: wireStrip({ browser: 'edge' }) } });
    r.svc.setInterest([A, B], r.clock.advance(5 * 60_000));
    await waitForStrip(r, B);
    expect(stripOps(r, A)).toBe(1);
    r.svc.setInterest([A, B], r.clock.advance(5 * 60_000));
    await waitForStrip(r, A);
  });

  it('retries a window without a strip with backoff', async () => {
    const r = rig({ strips: {} });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await eventually(() => expect(stripOps(r, A)).toBe(1));
    await eventually(() => expect(r.svc.debugInfo().readErrors).toBe(1));
    r.svc.setInterest([A], r.clock.advance(1999));
    expect(stripOps(r, A)).toBe(1);
    r.svc.setInterest([A], r.clock.advance(1));
    await eventually(() => expect(stripOps(r, A)).toBe(2));
    await eventually(() => expect(r.svc.debugInfo().readErrors).toBe(2));
    // second failure: 4 s
    r.svc.setInterest([A], r.clock.advance(3999));
    expect(stripOps(r, A)).toBe(2);
    r.svc.setInterest([A], r.clock.advance(1));
    await eventually(() => expect(stripOps(r, A)).toBe(3));
  });
});

describe('TabStripService: tabs.changed events', () => {
  it('reports added, removed, selected and geometry changes (no event for the first read)', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    expect(r.svc.drainEvents()).toEqual([]);
    const ev = (change: string, focusX: number | null) => ({ type: 'tabs.changed', surfaceId: `tabStrip:${A}`, ownerId: A, change, focusX });

    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge', tabs: 24 }) } });
    r.svc.setInterest([A], r.clock.advance(1000));
    expect(await drain(r, 1)).toEqual([ev('added', 1198)]);

    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.setInterest([A], r.clock.advance(1000));
    expect(await drain(r, 1)).toEqual([ev('removed', 931)]);

    // Selection: the helper's ElementSelected event triggers a read at once (no 1 s wait).
    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge', selected: 0 }) } });
    r.clock.advance(400);
    r.h.emit('selected', A);
    expect(await drain(r, 1)).toEqual([ev('selected', 334)]);

    // Same tabs, different controls (Chrome-like layout): the walkable span moved.
    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'chrome', selected: 0 }) } });
    r.svc.setInterest([A], r.clock.advance(1000));
    const got = await drain(r, 1);
    expect(got).toEqual([ev('geometry', 169 + 160)]);
    expect(r.svc.debugInfo().eventsOut).toBe(4);
  });

  it('debounces: at most one event per window per 300 ms, keeping the most important change', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);

    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge', tabs: 24 }) } });
    r.svc.setInterest([A], r.clock.advance(1000));
    expect((await drain(r, 1)).map((e) => (e.type === 'tabs.changed' ? e.change : e.type))).toEqual(['added']);

    // 150 ms later: selection changes, then a tab is closed; both inside the debounce window.
    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge', tabs: 24, selected: 0 }) } });
    r.clock.advance(150);
    r.h.emit('selected', A);
    await eventually(() => expect(r.svc.debugInfo().readsDone).toBe(3));
    expect(r.svc.drainEvents()).toEqual([]);
    r.h.patchState({ strips: { [A]: wireStrip({ browser: 'edge', selected: 0 }) } });
    r.clock.advance(120);
    r.h.emit('structure', A);
    await eventually(() => expect(r.svc.debugInfo().readsDone).toBe(4));
    expect(stripOps(r, A)).toBe(4);
    expect(r.svc.drainEvents()).toEqual([]);
    r.clock.advance(30);
    const got = r.svc.drainEvents();
    expect(got).toEqual([{ type: 'tabs.changed', surfaceId: `tabStrip:${A}`, ownerId: A, change: 'removed', focusX: 334 }]);
  });
});

describe('TabStripService: helper failures', () => {
  it('kills a hung helper, restarts it with exponential backoff and gives up after 5 restarts', async () => {
    const r = rig({ hang: ['strip'] });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i <= delays.length; i++) {
      await eventually(() => expect(r.h.ops('strip').length).toBe(i + 1));
      r.svc.setInterest([A], r.clock.advance(1499));
      expect(r.svc.debugInfo().helper.timeouts).toBe(i);
      r.svc.setInterest([A], r.clock.advance(1));
      expect(r.svc.debugInfo().helper.timeouts).toBe(i + 1);
      await waitStopped(r);
      const delay = delays[i];
      if (delay === undefined) break;
      expect(r.svc.status).toBe('idle');
      expect(r.svc.debugInfo().helper.nextStartInMs).toBe(delay);
      r.svc.setInterest([A], r.clock.advance(delay - 1));
      expect(r.h.children).toHaveLength(i + 1);
      r.svc.setInterest([A], r.clock.advance(1));
      expect(r.h.children).toHaveLength(i + 2);
    }
    expect(r.svc.status).toBe('unavailable');
    expect(r.svc.statusReason).toMatch(/^helper failed 6 times in 10 min \(last: request timed out/);
    r.svc.setInterest([A], r.clock.advance(60_000));
    expect(r.h.children).toHaveLength(6);
    expect(r.svc.surfaces()).toEqual([]);

    // Switching the feature off and on is an explicit retry.
    r.svc.updateSettings(settingsWith({ tabStrips: false }));
    r.svc.updateSettings(settingsWith({ tabStrips: true }));
    expect(r.svc.status).toBe('idle');
    expect(r.svc.statusReason).toBeNull();
    r.svc.setInterest([A], r.clock.advance(10));
    expect(r.h.children).toHaveLength(7);
  });

  it('a helper that crashes on start is retried with backoff, then reported unavailable', async () => {
    const r = rig({ exitOnStart: 2 });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    const delays = [1000, 2000, 4000, 8000, 16000];
    for (const delay of delays) {
      await waitStopped(r);
      await eventually(() => expect(r.svc.debugInfo().helper.nextStartInMs).toBe(delay));
      r.svc.setInterest([A], r.clock.advance(delay));
    }
    await eventually(() => expect(r.svc.status).toBe('unavailable'));
    expect(r.svc.statusReason).toBe('helper failed 6 times in 10 min (last: exited (code 2))');
    expect(r.h.children).toHaveLength(6);
  });

  it('a protocol version mismatch makes the feature unavailable at once', async () => {
    const r = rig({ version: 2 });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await eventually(() => expect(r.svc.status).toBe('unavailable'));
    expect(r.svc.statusReason).toBe('helper protocol 2 != 1');
    await waitStopped(r);
  });

  it('survives malformed and oversized lines from the helper', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) }, garbageBefore: true, oversizeBefore: 70 * 1024 });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    const d = r.svc.debugInfo().helper;
    expect(d.malformed).toBeGreaterThanOrEqual(2);
    expect(d.oversized).toBeGreaterThanOrEqual(2);
    expect(r.svc.status).toBe('active');
  });
});

describe('TabStripService: idle shutdown', () => {
  it('stops the helper 60 s after the last interest (internal timer) and restarts on demand', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } }, { options: { autoPumpMs: 20 } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    r.svc.setInterest([], r.clock.advance(1000));
    r.clock.advance(58_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.svc.status).toBe('active');
    r.clock.advance(1000);
    await waitStopped(r);
    expect(r.svc.status).toBe('idle');
    expect(r.svc.surfaces()).toEqual([]);
    expect(r.svc.debugInfo().windows).toBe(0);

    r.svc.setInterest([A], r.clock.advance(5000));
    expect(r.h.children).toHaveLength(2);
    await waitForStrip(r, A);
  });

  it('dispose stops the helper', async () => {
    const r = rig({ strips: { [A]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(A);
    r.svc.setInterest([A], r.clock.now());
    await waitForStrip(r, A);
    await r.svc.dispose();
    expect(r.svc.debugInfo().helper.running).toBe(false);
    expect(r.svc.status).toBe('off');
  });
});
