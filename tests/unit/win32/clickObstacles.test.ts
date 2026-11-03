// v1.2 click-guard obstacle source (ADR 0003 §6.1 (a), §15.1; PRV) over FakeNative (MOCKED native):
// which windows are obstacles, the WinEvent-invalidated cache, its age bound and every fail-closed path.
import { describe, expect, it } from 'vitest';
import { createClickObstacleSource } from '../../../src/main/win32/clickObstacles';
import { EVENT_OBJECT_CREATE, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, OBSTACLE_EVENT_RANGES } from '../../../src/main/win32/constants';
import { createKoffiWin32Api } from '../../../src/main/win32/win32Api';
import { createTestLogger, FakeNative, raw } from './fakes';

const OWN = 4242;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_TOPMOST = 0x8;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_LAYERED = 0x80000;
const OVERLAY_EX = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST;

function rig() {
  const native = new FakeNative(OWN);
  let t = 1000;
  const src = createClickObstacleSource(native, createTestLogger(), { now: () => t });
  return {
    native,
    src,
    advance: (ms: number) => (t += ms),
    /** A window event as the OS delivers it to every registered proc. */
    fire: (event: number, h: bigint, idObject = 0) => native.fire(event, h, idObject, 0),
  };
}

describe('click obstacles: which windows count', () => {
  it("lists app windows, this app's Settings window and dialogs, tool, topmost and click-through windows; not its overlays, the desktop, hidden, cloaked or minimized windows", () => {
    const r = rig();
    const n = r.native;
    n.add(1n, { pid: OWN, exStyle: OVERLAY_EX, frame: raw(0, 0, 1920, 1160) }); // our overlay
    n.add(2n, { pid: OWN, exStyle: 0, frame: raw(500, 200, 800, 600) }); // our Settings window
    n.add(3n, { pid: 90, exStyle: WS_EX_TOOLWINDOW | WS_EX_TOPMOST, frame: raw(1500, 800, 400, 225) }); // picture-in-picture
    n.add(4n, { pid: 91, exStyle: WS_EX_TRANSPARENT, frame: raw(0, 0, 300, 300) }); // another app's click-through overlay
    n.add(5n, { pid: 92, frame: raw(10, 10, 300, 300), visible: false });
    n.add(6n, { pid: 93, frame: raw(20, 20, 300, 300), cloaked: 2 });
    n.add(7n, { pid: 94, frame: raw(30, 30, 300, 300), iconic: true });
    n.add(8n, { pid: 95, frame: raw(0, 0, 1920, 1200), className: 'Progman' });
    n.add(9n, { pid: 96, frame: raw(-8, -8, 1936, 1168), windowRect: raw(-8, -8, 1936, 1168) }); // a maximized private app: still an obstacle
    r.src.setArmed(true);
    const got = r.src.get();
    expect(got.fresh).toBe(true);
    expect(got.rects).toEqual([
      { x: 500, y: 200, width: 800, height: 600 },
      { x: 1500, y: 800, width: 400, height: 225 },
      { x: 0, y: 0, width: 300, height: 300 },
      { x: -8, y: -8, width: 1936, height: 1168 },
    ]);
  });

  it('uses GetWindowRect (resize borders included) over the visible frame', () => {
    const r = rig();
    r.native.add(1n, { pid: 50, frame: raw(100, 100, 800, 600), windowRect: raw(93, 100, 814, 607) });
    r.src.setArmed(true);
    expect(r.src.get().rects).toEqual([{ x: 93, y: 100, width: 814, height: 607 }]);
  });
});

describe('click obstacles: cache, invalidation, fail closed', () => {
  function armedWithOne() {
    const r = rig();
    r.native.add(1n, { pid: 50, frame: raw(100, 100, 800, 600) });
    r.src.setArmed(true);
    return r;
  }

  it('arming installs every invalidation hook (location change included); disarming removes them', () => {
    const r = rig();
    r.src.setArmed(true);
    const ranges = [...r.native.hooks.values()].map((h) => [h.min, h.max]);
    expect(ranges).toEqual(OBSTACLE_EVENT_RANGES.map(([a, b]) => [a, b]));
    expect(ranges).toContainEqual([EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE]);
    // Our own Settings window counts: the hooks do not skip this process.
    expect([...r.native.hooks.values()].every((h) => (h.flags & 0x2) === 0)).toBe(true);
    r.src.setArmed(false);
    expect(r.native.hooks.size).toBe(0);
    expect(r.native.procs.size).toBe(0);
  });

  it('enumerates once and serves the cache until a window event invalidates it', () => {
    const r = armedWithOne();
    const enumerations = () => r.src.stats().enumerations;
    r.src.get();
    r.advance(50);
    r.src.get();
    expect(enumerations()).toBe(1);
    // A cursor move (OBJID_CURSOR) and a child window change do not invalidate.
    r.fire(EVENT_OBJECT_LOCATIONCHANGE, 1n, -9);
    r.native.add(2n, { pid: 50, root: 1n, frame: raw(0, 0, 10, 10) });
    // A child window is not a top-level window (EnumWindows does not list it).
    r.native.zOrder = r.native.zOrder.filter((h) => h !== 2n);
    r.fire(EVENT_OBJECT_LOCATIONCHANGE, 2n);
    r.src.get();
    expect(enumerations()).toBe(1);
    // A top-level window moved: re-read on the next ask.
    r.native.windows.get(1n)!.frame = raw(300, 100, 800, 600);
    r.fire(EVENT_OBJECT_LOCATIONCHANGE, 1n);
    r.advance(60);
    expect(r.src.get()).toMatchObject({ fresh: true, rects: [{ x: 300, y: 100, width: 800, height: 600 }] });
    expect(enumerations()).toBe(2);
  });

  it('a new window appears in the list after its create event (a popup shown next to the cat)', () => {
    const r = armedWithOne();
    r.src.get();
    r.native.add(3n, { pid: 60, exStyle: WS_EX_TOOLWINDOW, frame: raw(0, 400, 200, 100) });
    r.fire(EVENT_OBJECT_CREATE, 3n);
    r.advance(60);
    expect(r.src.get().rects).toContainEqual({ x: 0, y: 400, width: 200, height: 100 });
  });

  it('a cache older than 250 ms is re-read even without events', () => {
    const r = armedWithOne();
    r.src.get();
    r.advance(251);
    r.src.get();
    expect(r.src.stats().enumerations).toBe(2);
  });

  it('stale (fail closed) while invalid inside the enumeration gap, then fresh again', () => {
    const r = armedWithOne();
    r.src.get();
    r.advance(10);
    r.fire(EVENT_SYSTEM_FOREGROUND, 1n);
    expect(r.src.get().fresh).toBe(false);
    r.advance(50);
    expect(r.src.get().fresh).toBe(true);
  });

  it('a failing enumeration or a window that cannot be located is stale (fail closed)', () => {
    const r = armedWithOne();
    r.native.throwOn.add('enumTopLevelWindows');
    expect(r.src.get().fresh).toBe(false);
    r.native.throwOn.delete('enumTopLevelWindows');
    r.advance(60);
    r.native.add(4n, { pid: 70, frame: null, windowRect: null });
    r.fire(EVENT_OBJECT_CREATE, 4n);
    r.advance(60);
    expect(r.src.get().fresh).toBe(false);
  });

  it('without the hooks (not armed, or a hook failed) a list is never trusted beyond its own instant', () => {
    const r = rig();
    r.native.add(1n, { pid: 50, frame: raw(100, 100, 800, 600) });
    expect(r.src.get().fresh).toBe(true);
    r.advance(10);
    expect(r.src.get().fresh).toBe(false);
    const f = rig();
    f.native.failHooks.add(EVENT_OBJECT_LOCATIONCHANGE);
    f.native.add(1n, { pid: 50, frame: raw(100, 100, 800, 600) });
    f.src.setArmed(true);
    f.src.get();
    f.advance(10);
    expect(f.src.get().fresh).toBe(false);
  });

  it('the koffi facade exposes the same source (clickObstaclesPx, setObstacleWatch) and disposes its hooks', () => {
    const native = new FakeNative(OWN);
    native.add(1n, { pid: 50, frame: raw(100, 100, 800, 600) });
    const api = createKoffiWin32Api(native, createTestLogger(), { now: () => 5000 });
    api.setObstacleWatch(true);
    expect(api.clickObstaclesPx()).toEqual({ rects: [{ x: 100, y: 100, width: 800, height: 600 }], fresh: true });
    expect(api.obstacleStats()?.armed).toBe(true);
    api.dispose();
    expect(native.hooks.size).toBe(0);
  });
});
