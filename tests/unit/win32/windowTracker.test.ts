import { describe, expect, it } from 'vitest';
import type { SimEvent } from '../../../src/shared/sim';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { createWindowTracker, type WindowChange } from '../../../src/main/win32/windowTracker';
import { createUnavailableWin32Api } from '../../../src/main/win32/win32Api';
import { createTestLogger, FakeExtendedWin32Api, FakeWin32Api, rect, win } from './fakes';

function setup(api: FakeWin32Api = new FakeWin32Api(), opts: Parameters<typeof createWindowTracker>[2] = {}) {
  let t = 1000;
  const logger = createTestLogger();
  const tracker = createWindowTracker(api, logger, { now: () => t, ...opts });
  const at = (ms: number) => {
    t = ms;
  };
  const advance = (ms: number) => {
    t += ms;
  };
  /** Advances in host-tick steps and collects every drained event. */
  const run = (ms: number, step = 33): SimEvent[] => {
    const out: SimEvent[] = [];
    const end = t + ms;
    while (t < end) {
      t = Math.min(end, t + step);
      out.push(...tracker.drainEvents());
    }
    return out;
  };
  return { api, tracker, logger, at, advance, run, now: () => t };
}

const types = (events: SimEvent[]) => events.map((e) => e.type);

describe('lifecycle and modes', () => {
  it('starts in event-hook mode and populates silently', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(50, 50, 800, 600)));
    api.foregroundId = '2';
    const { tracker, run } = setup(api);
    tracker.start();
    expect(tracker.mode).toBe('event-hooks');
    expect(run(3000)).toEqual([]);
    expect(tracker.getForeground()?.id).toBe('2');
    expect(tracker.debugInfo().knownWindows).toBe(2);
  });

  it('falls back to polling when hooks are unavailable', () => {
    const api = new FakeWin32Api();
    api.hooksAvailable = false;
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.mode).toBe('polling');
  });

  it('is unavailable and fail-closed without Win32', () => {
    const tracker = createWindowTracker(createUnavailableWin32Api(), createTestLogger());
    tracker.start();
    expect(tracker.mode).toBe('unavailable');
    expect(tracker.drainEvents()).toEqual([]);
    expect(tracker.getPlatforms(0)).toEqual([]);
    expect(tracker.getForeground()).toBeNull();
    expect(tracker.isExcludedAt({ x: 1, y: 1 })).toBe(true);
    expect(tracker.getFullscreenDisplayIds({ version: 1, displays: [] })).toEqual([]);
  });

  it('stop unsubscribes and halts processing', () => {
    const api = new FakeWin32Api();
    const { tracker, run } = setup(api);
    tracker.start();
    tracker.stop();
    expect(api.unsubscribed).toBe(1);
    api.add(win('9', rect(0, 0, 500, 500)));
    expect(run(5000)).toEqual([]);
  });
});

describe('event coalescing', () => {
  it('emits window.shown once a burst has been quiet for 150 ms', () => {
    const { api, tracker, run } = setup();
    tracker.start();
    api.add(win('5', rect(10, 10, 600, 400)));
    api.fire('show', '5');
    expect(run(100)).toEqual([]);
    const events = run(100);
    expect(events).toEqual([{ type: 'window.shown', window: win('5', rect(10, 10, 600, 400)) }]);
  });

  it('collapses show/hide/show bursts into a single event', () => {
    const { api, tracker, run, advance } = setup();
    tracker.start();
    api.add(win('5', rect(10, 10, 600, 400)));
    api.fire('show', '5');
    advance(40);
    api.fire('hide', '5');
    advance(40);
    api.fire('show', '5');
    advance(40);
    api.fire('uncloaked', '5');
    expect(types(run(400))).toEqual(['window.shown']);
  });

  it('settles a never-ending burst after maxSettleMs', () => {
    const { api, tracker, advance, now } = setup();
    tracker.start();
    api.add(win('5', rect(10, 10, 600, 400)));
    const start = now();
    const seen: SimEvent[] = [];
    while (now() - start < 700) {
      api.fire('show', '5');
      advance(50);
      seen.push(...tracker.drainEvents());
    }
    expect(types(seen)).toEqual(['window.shown']);
  });

  it('ignores bursts of windows that were never app windows', () => {
    const { api, tracker, run } = setup();
    tracker.start();
    api.fire('show', '77');
    api.fire('hide', '77');
    expect(run(500)).toEqual([]);
  });

  it('reports closed windows with their last rect and category', () => {
    const api = new FakeWin32Api().add(win('3', rect(1, 2, 300, 200), { category: 'browser' }));
    const { tracker, run } = setup(api);
    tracker.start();
    api.remove('3');
    api.fire('destroy', '3');
    expect(run(300)).toEqual([{ type: 'window.closed', id: '3', rect: rect(1, 2, 300, 200), category: 'browser', excluded: false }]);
  });

  it('reports minimize and restore from state diffs', () => {
    const api = new FakeWin32Api().add(win('3', rect(1, 2, 300, 200)));
    const { tracker, run } = setup(api);
    tracker.start();
    api.update('3', { minimized: true });
    api.fire('minimizeStart', '3');
    expect(run(300)).toEqual([{ type: 'window.minimized', id: '3' }]);
    api.update('3', { minimized: false, rect: rect(5, 5, 300, 200) });
    api.fire('minimizeEnd', '3');
    expect(run(300)).toEqual([{ type: 'window.restored', window: win('3', rect(5, 5, 300, 200)) }]);
  });

  it('reports a drag as moveStart then moveEnd with the fresh rect', () => {
    const api = new FakeWin32Api().add(win('3', rect(0, 0, 300, 200)));
    const { tracker, run } = setup(api);
    tracker.start();
    api.fire('moveStart', '3');
    expect(run(300)).toEqual([{ type: 'window.moveStart', id: '3', excluded: false }]);
    expect(run(2000)).toEqual([]);
    api.update('3', { rect: rect(400, 300, 300, 200) });
    api.fire('moveEnd', '3');
    expect(run(300)).toEqual([{ type: 'window.moveEnd', id: '3', rect: rect(400, 300, 300, 200), excluded: false }]);
  });

  it('drops a click on the title bar (start+end within one burst, no movement)', () => {
    const api = new FakeWin32Api().add(win('3', rect(0, 0, 300, 200)));
    const { tracker, run, advance } = setup(api);
    tracker.start();
    api.fire('moveStart', '3');
    advance(60);
    api.fire('moveEnd', '3');
    expect(run(300)).toEqual([]);
    api.fire('moveStart', '3');
    advance(60);
    api.update('3', { rect: rect(50, 0, 300, 200) });
    api.fire('moveEnd', '3');
    expect(types(run(300))).toEqual(['window.moveStart', 'window.moveEnd']);
  });

  it('bounds the raw queue and counts drops', () => {
    const { api, tracker } = setup(new FakeWin32Api(), { rawQueueCapacity: 16 });
    tracker.start();
    for (let i = 0; i < 40; i++) api.fire('show', String(1000 + i));
    tracker.drainEvents();
    expect(tracker.debugInfo().rawDropped).toBe(24);
  });

  it('bounds the event queue and counts drops', () => {
    const { api, tracker, run } = setup(new FakeWin32Api(), { eventQueueCapacity: 4 });
    tracker.start();
    for (let i = 0; i < 10; i++) {
      api.add(win(String(i + 10), rect(i, i, 300, 300)));
      api.fire('show', String(i + 10));
    }
    // All ten bursts settle in the same drain; only the newest four fit.
    expect(run(300)).toHaveLength(4);
    expect(tracker.debugInfo().eventsDropped).toBe(6);
  });
});

describe('foreground', () => {
  it('emits window.foreground with the switch rate', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run } = setup(api);
    tracker.start();
    api.foregroundId = '2';
    api.fire('foreground', '2');
    const ev = run(200);
    expect(ev).toEqual([{ type: 'window.foreground', window: win('2', rect(0, 0, 800, 600)), switchesPerMinute: 1 }]);
    expect(tracker.getForeground()?.id).toBe('2');
  });

  it('ignores A -> B -> A flapping inside one burst', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run, advance } = setup(api);
    tracker.start();
    api.foregroundId = '2';
    api.fire('foreground', '2');
    advance(50);
    api.foregroundId = '1';
    api.fire('foreground', '1');
    expect(run(400)).toEqual([]);
  });

  it('catches a missed foreground change with the safety-net poll', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run } = setup(api);
    tracker.start();
    api.foregroundId = '2';
    const ev = run(1000);
    expect(types(ev)).toEqual(['window.foreground']);
  });

  it('announces a new foreground window as shown first', () => {
    const { api, tracker, run } = setup();
    tracker.start();
    api.add(win('8', rect(0, 0, 800, 600)));
    api.foregroundId = '8';
    api.fire('foreground', '8');
    expect(types(run(300))).toEqual(['window.shown', 'window.foreground']);
  });

  it('reports a switch to a non-app window (desktop) as window: null', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run } = setup(api);
    tracker.start();
    api.foregroundId = '65552';
    api.fire('foreground', '65552');
    expect(run(300)).toEqual([{ type: 'window.foreground', window: null, switchesPerMinute: 1 }]);
  });

  it('counts switches over the last minute only', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run } = setup(api);
    tracker.start();
    let last: SimEvent | undefined;
    for (let i = 0; i < 5; i++) {
      api.foregroundId = i % 2 === 0 ? '2' : '1';
      api.fire('foreground', api.foregroundId);
      last = run(1000).at(-1);
    }
    expect(last).toMatchObject({ type: 'window.foreground', switchesPerMinute: 5 });
    run(61_000);
    expect(api.foregroundId).toBe('2');
    api.foregroundId = '1';
    api.fire('foreground', '1');
    expect(run(300).at(-1)).toMatchObject({ switchesPerMinute: 1 });
  });

  it('refreshes foreground details (e.g. rect) without emitting events', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    api.foregroundId = '1';
    const { tracker, run } = setup(api);
    tracker.start();
    api.update('1', { rect: rect(10, 10, 900, 700) });
    expect(run(1600)).toEqual([]);
    expect(tracker.getForeground()?.rect).toEqual(rect(10, 10, 900, 700));
  });
});

describe('reconcile', () => {
  it('catches missed shown/closed/minimized events in hook mode', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(0, 0, 800, 600)));
    const { tracker, run } = setup(api);
    tracker.start();
    api.remove('1');
    api.update('2', { minimized: true });
    api.add(win('3', rect(5, 5, 400, 300)));
    const ev = run(3000);
    expect(ev).toEqual(
      expect.arrayContaining([
        { type: 'window.shown', window: win('3', rect(5, 5, 400, 300)) },
        { type: 'window.closed', id: '1', rect: rect(0, 0, 800, 600), category: 'other', excluded: false },
        { type: 'window.minimized', id: '2' },
      ]),
    );
    expect(ev).toHaveLength(3);
  });

  it('synthesises moves from rect diffs in polling mode only', () => {
    const polling = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    polling.hooksAvailable = false;
    const p = setup(polling);
    p.tracker.start();
    polling.update('1', { rect: rect(300, 0, 800, 600) });
    expect(p.run(3000)).toEqual([
      { type: 'window.moveStart', id: '1', excluded: false },
      { type: 'window.moveEnd', id: '1', rect: rect(300, 0, 800, 600), excluded: false },
    ]);

    const hooked = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    const h = setup(hooked);
    h.tracker.start();
    hooked.update('1', { rect: rect(300, 0, 800, 600) });
    expect(h.run(3000)).toEqual([]);
  });

  it('detects new windows in polling mode', () => {
    const api = new FakeWin32Api();
    api.hooksAvailable = false;
    const { tracker, run } = setup(api);
    tracker.start();
    api.add(win('4', rect(0, 0, 500, 500)));
    expect(types(run(3000))).toEqual(['window.shown']);
  });

  it('closes a move that never reported its end', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    const { tracker, run } = setup(api);
    tracker.start();
    api.fire('moveStart', '1');
    expect(types(run(300))).toEqual(['window.moveStart']);
    expect(types(run(63_000))).toEqual(['window.moveEnd']);
  });
});

describe('platforms and fullscreen', () => {
  it('computes occlusion-aware platforms and caches them for maxAgeMs', () => {
    const api = new FakeWin32Api().add(win('below', rect(100, 300, 500, 400))).add(win('top', rect(250, 200, 100, 300)));
    const { tracker, advance } = setup(api);
    tracker.start();
    const calls = api.listCalls;
    const p1 = tracker.getPlatforms(500);
    expect(p1.filter((p) => p.windowId === 'below').map((p) => [p.x0, p.x1])).toEqual([
      [100, 250],
      [350, 600],
    ]);
    advance(200);
    expect(tracker.getPlatforms(500)).toBe(p1);
    advance(400);
    tracker.getPlatforms(500);
    // The first call reused the reconcile's fresh list; only the expired one re-listed.
    expect(api.listCalls - calls).toBe(1);
  });

  it('invalidates platforms when a window event settles', () => {
    const api = new FakeWin32Api().add(win('a', rect(100, 300, 500, 400)));
    const { tracker, run } = setup(api);
    tracker.start();
    expect(tracker.getPlatforms(60_000)[0]?.y).toBe(300);
    api.fire('moveStart', 'a');
    run(300);
    api.update('a', { rect: rect(100, 500, 500, 400) });
    api.fire('moveEnd', 'a');
    run(300);
    expect(tracker.getPlatforms(60_000)[0]?.y).toBe(500);
  });

  const d = (id: string, x: number, w: number, primary = false): DisplayGeometry => {
    const r = { x, y: 0, width: w, height: 1080 };
    return { id, primary, scaleFactor: 1, boundsDip: r, workAreaDip: r, boundsPx: r, workAreaPx: r };
  };
  const world: WorldGeometry = { version: 1, displays: [d('1', 0, 1920, true), d('2', 1920, 1920)] };

  it('reports the display with a fullscreen foreground window', () => {
    const api = new FakeWin32Api().add(win('v', rect(1920, 0, 1920, 1080), { fullscreen: true }));
    api.foregroundId = 'v';
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.getFullscreenDisplayIds(world)).toEqual(['2']);
  });

  it('uses QUNS d3d-fullscreen with the raw foreground rect when it is not an app window', () => {
    const api = new FakeWin32Api();
    api.foregroundId = '999';
    api.extraRects.set('999', rect(1920, 0, 1920, 1080));
    api.notification = 'd3d-fullscreen';
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.getFullscreenDisplayIds(world)).toEqual(['2']);
    api.notification = 'busy';
    const b = setup(api);
    b.tracker.start();
    expect(b.tracker.getFullscreenDisplayIds(world)).toEqual([]);
  });
});

describe('privacy exclusions', () => {
  it('fails closed when the point cannot be resolved', () => {
    const { tracker } = setup(new FakeExtendedWin32Api());
    tracker.start();
    expect(tracker.isExcludedAt({ x: 5000, y: 5000 })).toBe(true);
  });

  it('delegates to the fresh title-aware check and fails closed on null', () => {
    const api = new FakeExtendedWin32Api().add(win('1', rect(0, 0, 500, 500))).add(win('2', rect(1000, 0, 500, 500))).add(win('3', rect(2000, 0, 500, 500)));
    api.excludedIds.set('2', true);
    api.excludedIds.set('3', null);
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.isExcludedAt({ x: 10, y: 10 })).toBe(false);
    expect(tracker.isExcludedAt({ x: 1010, y: 10 })).toBe(true);
    expect(tracker.isExcludedAt({ x: 2010, y: 10 })).toBe(true);
  });

  it('checks the raw foreground through the extension and fails closed on null', () => {
    const api = new FakeExtendedWin32Api();
    const { tracker } = setup(api);
    expect(tracker.isForegroundExcluded()).toBe(false);
    api.foregroundExcluded = true;
    expect(tracker.isForegroundExcluded()).toBe(true);
    api.foregroundExcluded = null;
    expect(tracker.isForegroundExcluded()).toBe(true);
    expect(createWindowTracker(createUnavailableWin32Api(), createTestLogger()).isForegroundExcluded()).toBe(true);
  });

  it('masks the extension’s private-window rects, or everything when they are unknown', () => {
    const api = new FakeExtendedWin32Api().add(win('1', rect(0, 0, 500, 500)));
    api.excludedRects = [rect(10, 20, 30, 40)];
    const { tracker } = setup(api);
    expect(tracker.getExcludedRects()).toEqual([rect(10, 20, 30, 40)]);
    api.excludedRects = null;
    const [all] = tracker.getExcludedRects();
    expect(all!.x <= -1e9 && all!.y <= -1e9 && all!.x + all!.width >= 1e9 && all!.y + all!.height >= 1e9).toBe(true);
  });

  it('cuts platforms with the full z-order when the extension provides it', () => {
    const api = new FakeExtendedWin32Api().add(win('b', rect(100, 300, 500, 400)));
    const { tracker, advance } = setup(api);
    tracker.start();
    expect(tracker.getPlatforms(0)).toEqual([{ windowId: 'b', y: 300, x0: 100, x1: 600 }]);
    advance(1);
    api.occluders = [
      { id: 'dialog', rect: rect(250, 200, 100, 300) },
      { id: 'b', rect: rect(100, 300, 500, 400) },
    ];
    expect(tracker.getPlatforms(0)).toEqual([
      { windowId: 'b', y: 300, x0: 100, x1: 250 },
      { windowId: 'b', y: 300, x0: 350, x1: 600 },
    ]);
  });

  it('forwards exclusion lists to the API extension', () => {
    const api = new FakeExtendedWin32Api();
    const { tracker } = setup(api);
    tracker.setExclusions(['keepass.exe'], ['bank']);
    expect(api.exclusionCalls).toEqual([[['keepass.exe'], ['bank']]]);
  });

  it('applies process exclusions itself for APIs without the extension', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 500, 500), { processName: 'keepass.exe' })).add(win('2', rect(600, 0, 500, 500)));
    api.foregroundId = '1';
    const { tracker } = setup(api);
    tracker.setExclusions(['KeePass'], []);
    tracker.start();
    expect(tracker.isExcludedAt({ x: 10, y: 10 })).toBe(true);
    expect(tracker.isExcludedAt({ x: 610, y: 10 })).toBe(false);
    expect(tracker.getForeground()?.excluded).toBe(true);
  });
});

describe('private windows in window events and platforms', () => {
  it('move and close events carry the tracked excluded flag (hook mode)', () => {
    const api = new FakeWin32Api()
      .add(win('pm', rect(0, 0, 300, 200), { processName: 'keepassxc.exe', excluded: true }))
      .add(win('ed', rect(400, 0, 300, 200)));
    const { tracker, run } = setup(api);
    tracker.start();
    api.fire('moveStart', 'pm');
    api.fire('moveStart', 'ed');
    expect(run(300)).toEqual([
      { type: 'window.moveStart', id: 'pm', excluded: true },
      { type: 'window.moveStart', id: 'ed', excluded: false },
    ]);
    api.update('pm', { rect: rect(50, 50, 300, 200) });
    api.fire('moveEnd', 'pm');
    expect(run(300)).toEqual([{ type: 'window.moveEnd', id: 'pm', rect: rect(50, 50, 300, 200), excluded: true }]);
    api.remove('pm');
    api.fire('destroy', 'pm');
    expect(run(300)).toEqual([{ type: 'window.closed', id: 'pm', rect: rect(50, 50, 300, 200), category: 'other', excluded: true }]);
  });

  it('synthesised moves, stuck-move ends and reconciled closes carry it too', () => {
    const polling = new FakeWin32Api().add(win('pm', rect(0, 0, 800, 600), { excluded: true }));
    polling.hooksAvailable = false;
    const p = setup(polling);
    p.tracker.start();
    polling.update('pm', { rect: rect(300, 0, 800, 600) });
    expect(p.run(3000)).toEqual([
      { type: 'window.moveStart', id: 'pm', excluded: true },
      { type: 'window.moveEnd', id: 'pm', rect: rect(300, 0, 800, 600), excluded: true },
    ]);
    polling.remove('pm');
    expect(p.run(3000)).toEqual([{ type: 'window.closed', id: 'pm', rect: rect(300, 0, 800, 600), category: 'other', excluded: true }]);

    const hooked = new FakeWin32Api().add(win('pm', rect(0, 0, 800, 600), { excluded: true }));
    const h = setup(hooked);
    h.tracker.start();
    hooked.fire('moveStart', 'pm');
    h.run(300);
    expect(h.run(63_000)).toEqual([{ type: 'window.moveEnd', id: 'pm', rect: rect(0, 0, 800, 600), excluded: true }]);
  });

  it('a window that becomes private through new exclusions is reported as such from the next drain', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 500, 500), { processName: 'keepass.exe' }));
    const { tracker, run } = setup(api);
    tracker.start();
    tracker.setExclusions(['keepass.exe'], []);
    run(33);
    api.remove('1');
    api.fire('destroy', '1');
    expect(run(300)).toEqual([{ type: 'window.closed', id: '1', rect: rect(0, 0, 500, 500), category: 'other', excluded: true }]);
  });

  it('private windows offer no perch platform but still hide the edges below them', () => {
    const api = new FakeWin32Api()
      .add(win('below', rect(100, 300, 500, 400)))
      .add(win('pm', rect(250, 200, 200, 300), { processName: 'bitwarden.exe', excluded: true }));
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.getPlatforms(0)).toEqual([
      { windowId: 'below', y: 300, x0: 100, x1: 250 },
      { windowId: 'below', y: 300, x0: 450, x1: 600 },
    ]);
  });

  it('the same holds with the full z-order of the extended API', () => {
    const api = new FakeExtendedWin32Api().add(win('b', rect(100, 300, 500, 400))).add(win('bank', rect(300, 100, 600, 400), { excluded: true }));
    api.occluders = [
      { id: 'bank', rect: rect(300, 100, 600, 400) },
      { id: 'b', rect: rect(100, 300, 500, 400) },
    ];
    const { tracker } = setup(api);
    tracker.start();
    expect(tracker.getPlatforms(0)).toEqual([{ windowId: 'b', y: 300, x0: 100, x1: 300 }]);
  });
});

describe('change notices for incremental consumers (surface provider)', () => {
  const label = (c: WindowChange): string => (c.kind === 'window' ? `${c.id}:${c.change}` : c.kind);

  it('notices raw events at once, settled window changes, z-order changes and start/stop', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600))).add(win('2', rect(900, 0, 800, 600)));
    const { tracker, run } = setup(api);
    const seen: WindowChange[] = [];
    const off = tracker.onChange((c) => seen.push(c));
    tracker.start();
    expect(tracker.running).toBe(true);
    expect(seen.map(label)).toEqual(['all']);
    seen.length = 0;

    api.fire('moveStart', '1', 5);
    tracker.drainEvents();
    // Stamped with the tracker's clock when ingested.
    expect(seen).toEqual([{ kind: 'raw', id: '1', raw: 'moveStart', at: 1000 }]);
    expect(tracker.isMoving('1')).toBe(true);
    expect(tracker.isMoving('2')).toBe(false);
    api.update('1', { rect: rect(40, 30, 800, 600) });
    api.fire('moveEnd', '1', 6);
    run(300);
    expect(tracker.isMoving('1')).toBe(false);
    expect(seen.filter((c) => c.kind === 'window').map(label)).toEqual(['1:updated']);
    expect(tracker.windowInfo('1')?.rect).toEqual(rect(40, 30, 800, 600));
    seen.length = 0;

    api.update('2', { minimized: true });
    api.fire('minimizeStart', '2', 7);
    run(300);
    expect(seen.map(label)).toEqual(['raw', '2:minimized']);
    seen.length = 0;

    api.foregroundId = '1';
    api.fire('foreground', '1', 8);
    // The safety-net foreground poll may extend the coalescing window once.
    run(500);
    expect(seen.filter((c) => c.kind === 'zorder')).toEqual([expect.objectContaining({ kind: 'zorder', id: '1' })]);
    seen.length = 0;

    api.remove('1');
    api.fire('destroy', '1', 9);
    run(300);
    expect(seen.map(label)).toEqual(['raw', '1:closed']);
    expect(tracker.windowInfo('1')).toBeNull();

    seen.length = 0;
    tracker.setExclusions(['x.exe'], []);
    expect(seen.map(label)).toEqual(['all']);
    tracker.stop();
    expect(tracker.running).toBe(false);
    expect(seen.map(label)).toEqual(['all', 'all']);
    expect(tracker.listWindows(0)).toEqual([]);
    off();
    tracker.start();
    expect(seen).toHaveLength(2);
  });

  it('notices a shown window and a restored one, and lists windows in z-order', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    const { tracker, run } = setup(api);
    tracker.start();
    const seen: WindowChange[] = [];
    tracker.onChange((c) => seen.push(c));
    api.add(win('5', rect(100, 100, 400, 300)));
    api.fire('show', '5', 1);
    run(300);
    expect(seen.filter((c) => c.kind === 'window').map(label)).toEqual(['5:shown']);
    expect(tracker.listWindows(0).map((w) => w.id)).toEqual(['5', '1']);
    api.update('5', { minimized: true });
    api.fire('minimizeStart', '5', 2);
    run(300);
    seen.length = 0;
    api.update('5', { minimized: false });
    api.fire('minimizeEnd', '5', 3);
    run(300);
    expect(seen.filter((c) => c.kind === 'window').map(label)).toEqual(['5:restored']);
  });

  it('a throwing listener is reported and does not break tracking', () => {
    const api = new FakeWin32Api().add(win('1', rect(0, 0, 800, 600)));
    const { tracker, run, logger } = setup(api);
    tracker.onChange(() => {
      throw new Error('listener bug');
    });
    tracker.start();
    api.update('1', { rect: rect(10, 10, 800, 600) });
    api.fire('moveStart', '1');
    api.fire('moveEnd', '1');
    expect(types(run(300))).toEqual(['window.moveStart', 'window.moveEnd']);
    expect(logger.entries.some((e) => e.level === 'warn' || e.level === 'error')).toBe(true);
  });
});
