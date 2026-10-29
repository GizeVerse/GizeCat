// TaskbarTracker over a scripted fake native (MOCKED Win32, SIMULATED taskbar motion):
// discovery, the per-taskbar state machine, debounced events, ledge surfaces, cadence,
// Explorer restarts, secondary/top/left/right taskbars, the click guard and unavailable APIs.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Point } from '../../../src/shared/geometry';
import type { SimEvent } from '../../../src/shared/sim';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import type { Hwnd, RawRect } from '../../../src/main/win32/native';
import { createTaskbarTracker, type TaskbarNative, type TaskbarTrackerHandle } from '../../../src/main/win32/taskbar';
import { createTestLogger, type LogEntry } from './fakes';

const P_MON: RawRect = { left: 0, top: 0, right: 1920, bottom: 1200 };
const S_MON: RawRect = { left: 1920, top: 0, right: 3840, bottom: 1080 };
/** A monitor directly below S (for the hidden-taskbar attribution trap). */
const T_MON: RawRect = { left: 1920, top: 1080, right: 3840, bottom: 2160 };

const bottomAt = (mon: RawRect, top: number, thickness = 60): RawRect => ({ left: mon.left, top, right: mon.right, bottom: top + thickness });
const P_SHOWN = bottomAt(P_MON, 1140);
const P_HIDDEN = bottomAt(P_MON, 1198);

interface FakeBar {
  className: string;
  rect: RawRect;
  visible: boolean;
  /** MonitorFromWindow answer; defaults to the monitor holding the rect centre. */
  monitor?: { monitor: RawRect; work: RawRect } | null;
  exStyle: number;
}

class FakeTaskbarNative implements TaskbarNative {
  bars = new Map<Hwnd, FakeBar>();
  order: Hwnd[] = [];
  monitors: Array<{ monitor: RawRect; work: RawRect }> = [{ monitor: P_MON, work: P_MON }];
  abmState = 1;
  abmPos: { edge: number; rect: RawRect } | null = { edge: 3, rect: P_SHOWN };
  throwOn = new Set<keyof TaskbarNative>();
  rectNull = new Set<Hwnd>();
  calls = new Map<keyof TaskbarNative, number>();

  add(h: Hwnd, bar: Partial<FakeBar> & { rect: RawRect }): this {
    this.bars.set(h, { className: 'Shell_TrayWnd', visible: true, exStyle: 0x88, ...bar });
    this.order.push(h);
    return this;
  }
  remove(h: Hwnd): void {
    this.bars.delete(h);
    this.order = this.order.filter((x) => x !== h);
  }
  move(h: Hwnd, rect: RawRect): void {
    const b = this.bars.get(h);
    if (b) b.rect = rect;
  }
  private hit(name: keyof TaskbarNative): void {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    if (this.throwOn.has(name)) throw new Error(`boom: ${name}`);
  }
  count(name: keyof TaskbarNative): number {
    return this.calls.get(name) ?? 0;
  }
  findWindow(cls: string): Hwnd | null {
    this.hit('findWindow');
    return this.order.find((h) => this.bars.get(h)?.className === cls) ?? null;
  }
  findNextWindow(cls: string, after: Hwnd | null): Hwnd | null {
    this.hit('findNextWindow');
    const list = this.order.filter((h) => this.bars.get(h)?.className === cls);
    if (after === null) return list[0] ?? null;
    const i = list.indexOf(after);
    return i < 0 ? null : (list[i + 1] ?? null);
  }
  isWindow(h: Hwnd): boolean {
    this.hit('isWindow');
    return this.bars.has(h);
  }
  isWindowVisible(h: Hwnd): boolean {
    this.hit('isWindowVisible');
    return this.bars.get(h)?.visible === true;
  }
  getWindowRect(h: Hwnd): RawRect | null {
    this.hit('getWindowRect');
    if (this.rectNull.has(h)) return null;
    const b = this.bars.get(h);
    return b ? { ...b.rect } : null;
  }
  getMonitorRects(h: Hwnd): { monitor: RawRect; work: RawRect } | null {
    this.hit('getMonitorRects');
    const b = this.bars.get(h);
    if (!b) return null;
    if (b.monitor !== undefined) return b.monitor;
    // MonitorFromWindow: largest intersection.
    let best: { monitor: RawRect; work: RawRect } | null = null;
    let area = 0;
    for (const m of this.monitors) {
      const w = Math.min(b.rect.right, m.monitor.right) - Math.max(b.rect.left, m.monitor.left);
      const hgt = Math.min(b.rect.bottom, m.monitor.bottom) - Math.max(b.rect.top, m.monitor.top);
      if (w > 0 && hgt > 0 && w * hgt > area) {
        area = w * hgt;
        best = m;
      }
    }
    return best ?? this.monitors[0] ?? null;
  }
  appBarState(): number {
    this.hit('appBarState');
    return this.abmState;
  }
  appBarTaskbarPos(): { edge: number; rect: RawRect } | null {
    this.hit('appBarTaskbarPos');
    return this.abmPos;
  }
  getExStyle(h: Hwnd): number {
    this.hit('getExStyle');
    return this.bars.get(h)?.exStyle ?? 0;
  }
}

const px = (r: RawRect) => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
function display(id: string, mon: RawRect, scale: number, work: RawRect = mon, primary = false): DisplayGeometry {
  const b = px(mon);
  const w = px(work);
  const dip = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  return { id, primary, scaleFactor: scale, boundsPx: b, workAreaPx: w, boundsDip: dip(b), workAreaDip: dip(w) };
}
const WORLD_P: WorldGeometry = { version: 1, displays: [display('P', P_MON, 1.25, P_MON, true)] };

interface Rig {
  native: FakeTaskbarNative;
  tracker: TaskbarTrackerHandle;
  log: ReturnType<typeof createTestLogger>;
  t: number;
  /** Samples at the current time, advances by the returned delay (or `stepMs`) and returns the delay. */
  sample(cursor?: Point | null, catNear?: boolean): number;
  at(ms: number, cursor?: Point | null, catNear?: boolean): number;
  events: SimEvent[];
}

function makeRig(native: FakeTaskbarNative, world: WorldGeometry | null = WORLD_P, start = true): Rig {
  const log = createTestLogger([] as LogEntry[]);
  const rig = {
    native,
    log,
    t: 1000,
    events: [] as SimEvent[],
    tracker: null as unknown as TaskbarTrackerHandle,
    sample(cursor: Point | null = null, catNear = false): number {
      const d = rig.tracker.sample(rig.t, cursor, catNear);
      rig.events.push(...rig.tracker.drainEvents());
      return d;
    },
    at(ms: number, cursor: Point | null = null, catNear = false): number {
      rig.t = ms;
      return rig.sample(cursor, catNear);
    },
  };
  rig.tracker = createTaskbarTracker(log, { now: () => rig.t, native, world });
  if (start) {
    rig.tracker.start();
    rig.events.push(...rig.tracker.drainEvents());
  }
  return rig;
}

const primaryHidden = (): FakeTaskbarNative => new FakeTaskbarNative().add(100n, { rect: P_HIDDEN });
const types = (evs: SimEvent[]): string[] => evs.map((e) => e.type);

describe('taskbar tracker: discovery', () => {
  it('finds the auto-hidden bottom primary taskbar and reports it hidden (probe-machine geometry)', () => {
    const r = makeRig(primaryHidden());
    const [tb] = r.tracker.taskbars();
    expect(r.tracker.available).toBe(true);
    expect(tb).toMatchObject({ id: '100', displayId: 'P', edge: 'bottom', autoHide: true, phase: 'hidden', speed: 0, validatedAt: 1000 });
    expect(tb!.shownFraction).toBeCloseTo(2 / 60, 6);
    expect(tb!.rect).toEqual(px(P_HIDDEN));
    expect(tb!.dockedRect).toEqual(px(P_SHOWN));
    expect(r.tracker.surfaces()).toEqual([]);
    expect(r.events).toEqual([]);
    const dbg = r.tracker.debugInfo() as { taskbars: Array<Record<string, unknown>>; appBar: Record<string, unknown> };
    expect(dbg.taskbars[0]).toMatchObject({ role: 'ledge', primary: true, thicknessSource: 'appbar', autoHideBy: 'both', topmost: true, monitorSource: 'window', scale: 1.25 });
    expect(dbg.appBar).toMatchObject({ state: 1, edge: 'bottom' });
    expect(r.log.entries.some((e) => e.msg === 'taskbars discovered')).toBe(true);
  });

  it('rediscovers on the 10 s reconcile without calling SHAppBarMessage, reusing the cached answer', () => {
    const r = makeRig(primaryHidden());
    const dbg = () =>
      r.tracker.debugInfo() as { lastDiscovery: { reason: string }; discoveries: number; taskbars: Array<{ thicknessSource: string; autoHideBy: string }> };
    expect(r.native.count('appBarState')).toBe(1);
    expect(r.native.count('appBarTaskbarPos')).toBe(1);
    // One simulated hour at the idle cadence: 360 reconciles, no cross-process call.
    for (let t = 1250; t <= 3_601_000; t += 250) r.at(t);
    expect(dbg().lastDiscovery.reason).toBe('reconcile');
    expect(dbg().discoveries).toBe(361);
    expect(r.native.count('appBarState')).toBe(1);
    expect(r.native.count('appBarTaskbarPos')).toBe(1);
    // ... and the reconciled taskbar still carries the cached cross-check.
    expect(dbg().taskbars[0]).toMatchObject({ thicknessSource: 'appbar', autoHideBy: 'both' });
    expect(r.tracker.taskbars()[0]!.dockedRect).toEqual(px(P_SHOWN));
  });

  it('queries SHAppBarMessage again on the discoveries that can change its answer', () => {
    const r = makeRig(primaryHidden());
    const calls = () => [r.native.count('appBarState'), r.native.count('appBarTaskbarPos')];
    expect(calls()).toEqual([1, 1]); // start
    r.tracker.rediscover('taskbar-created');
    r.at(1100);
    expect(calls()).toEqual([2, 2]);
    r.at(3100); // the follow-up 2 s later
    expect(calls()).toEqual([3, 3]);
    r.tracker.setWorld(WORLD_P);
    r.at(3200);
    expect(calls()).toEqual([4, 4]);
    // Explorer restarted without a TaskbarCreated broadcast reaching us: a new primary window.
    r.native.remove(100n);
    r.native.add(200n, { rect: P_HIDDEN });
    r.at(3300);
    expect((r.tracker.debugInfo() as { lastDiscovery: { reason: string } }).lastDiscovery.reason).toBe('window-gone');
    expect(calls()).toEqual([5, 5]);
    // Repeated read failures force a rediscovery, which reuses the answer for the same window.
    r.native.rectNull.add(200n);
    for (const t of [3400, 3500, 4600]) r.at(t);
    expect((r.tracker.debugInfo() as { lastDiscovery: { reason: string } }).lastDiscovery.reason).toBe('read-failure');
    expect(calls()).toEqual([5, 5]);
  });

  it('detects auto-hide from the work area alone when ABM_GETSTATE is clear, and a docked taskbar as a floor', () => {
    const n = new FakeTaskbarNative().add(100n, { rect: P_HIDDEN });
    n.abmState = 0;
    const r = makeRig(n);
    expect(r.tracker.taskbars()[0]!.autoHide).toBe(true);
    expect((r.tracker.debugInfo() as { taskbars: Array<{ autoHideBy: string }> }).taskbars[0]!.autoHideBy).toBe('work-area');

    // Always shown: the work area stops at its top, ABM_GETSTATE clear.
    const docked = new FakeTaskbarNative().add(100n, { rect: P_SHOWN });
    docked.abmState = 0;
    docked.monitors = [{ monitor: P_MON, work: { ...P_MON, bottom: 1140 } }];
    const world: WorldGeometry = { version: 1, displays: [display('P', P_MON, 1.25, { ...P_MON, bottom: 1140 }, true)] };
    const d = makeRig(docked, world);
    expect(d.tracker.taskbars()[0]).toMatchObject({ autoHide: false, phase: 'shown', shownFraction: 1 });
    // The work-area floor already sits on its top: it is not a ledge, and no events fire.
    expect(d.tracker.surfaces()).toEqual([]);
    expect(d.events).toEqual([]);
    expect((d.tracker.debugInfo() as { taskbars: Array<{ role: string }> }).taskbars[0]!.role).toBe('floor');
    expect(d.at(1250, { x: 900, y: 1199 })).toBe(250); // no cursor bursts for a docked taskbar
  });

  it('warns once when no taskbar exists (Explorer not running) and keeps idling', () => {
    const r = makeRig(new FakeTaskbarNative());
    expect(r.tracker.taskbars()).toEqual([]);
    expect(r.at(1250, { x: 5, y: 1199 }, true)).toBe(250);
    expect(r.log.entries.filter((e) => e.msg === 'no taskbar window found')).toHaveLength(1);
    expect(r.native.count('appBarState')).toBe(0); // nothing to cross-check
  });
});

describe('taskbar tracker: motion, events and ledges', () => {
  let r: Rig;
  beforeEach(() => {
    r = makeRig(primaryHidden());
  });

  /** Moves the primary's top edge and samples. */
  const step = (t: number, top: number, cursor: Point | null = null): number => {
    r.native.move(100n, bottomAt(P_MON, top));
    return r.at(t, cursor);
  };

  it('follows an observed slide-in and slide-out with intermediate positions', () => {
    // The user's cursor reaches the reveal strip: burst sampling starts.
    expect(r.at(1250, { x: 900, y: 1199 })).toBe(16);
    let t = 1250;
    const phases: string[] = [];
    const ledgePhases: string[] = [];
    for (let top = 1192; top >= 1140; top -= 4) {
      t += 16;
      expect(step(t, top, { x: 900, y: 1199 })).toBe(16);
      const tb = r.tracker.taskbars()[0]!;
      phases.push(tb.phase);
      // 6 px in the first 16 ms, then 4 px per sample; up = negative.
      if (top > 1140) expect(tb.speed).toBeCloseTo(((top === 1192 ? -6 : -4) / 16) * 1000, 6);
      const s = r.tracker.surfaces();
      expect(s.length).toBe(tb.shownFraction >= 0.5 ? 1 : 0);
      if (s[0]) {
        ledgePhases.push(s[0].phase);
        expect(s[0]).toMatchObject({ id: 'taskbar:100', kind: 'taskbar', orientation: 'ledge', ownerId: '100', displayId: 'P', edge: 'bottom', x0: 0, x1: 1920, excluded: false, rest: null, focusX: null, vx: 0 });
        expect(s[0].y).toBe(top - 1);
        expect(s[0].confidence).toBe(1);
        expect(s[0].validatedAt).toBe(t);
      }
    }
    expect(phases.at(-1)).toBe('shown');
    expect(new Set(phases.slice(0, -1))).toEqual(new Set(['showing']));
    expect(ledgePhases.at(-1)).toBe('stable');
    expect(ledgePhases.slice(0, -1).every((p) => p === 'entering')).toBe(true);
    // One shown event, when 50 % of the thickness was first on screen (top <= 1170).
    expect(types(r.events)).toEqual(['taskbar.shown']);
    expect(r.events[0]).toEqual({ type: 'taskbar.shown', surfaceId: 'taskbar:100', displayId: 'P', edge: 'bottom' });

    // Cursor leaves; the bursts end 300 ms after the last change.
    t += 16;
    expect(r.at(t, { x: 900, y: 600 })).toBe(16);
    t += 300;
    expect(r.at(t, { x: 900, y: 600 })).toBe(250);

    // Slide out.
    r.events.length = 0;
    const out: string[] = [];
    for (let top = 1144; top <= 1192; top += 4) {
      t += 16;
      step(t, top);
      out.push(r.tracker.taskbars()[0]!.phase);
      const s = r.tracker.surfaces();
      if (s[0]) {
        expect(s[0].phase).toBe('leaving');
        expect(s[0].vy).toBeCloseTo((4 / 16) * 1000, 6);
      }
    }
    t += 16;
    step(t, 1198);
    expect(r.tracker.taskbars()[0]!.phase).toBe('hidden');
    expect(new Set(out)).toEqual(new Set(['hiding']));
    expect(r.tracker.surfaces()).toEqual([]);
    expect(types(r.events)).toEqual(['taskbar.hidden']);
  });

  it('eases an instant jump (missed animation) and lowers the confidence while inferred', () => {
    // Idle sampling: the whole reveal happened between two samples.
    expect(r.at(1250)).toBe(250);
    expect(step(1500, 1140)).toBe(16);
    expect(r.tracker.surfaces()).toEqual([]); // still where it was seen last...
    expect(r.tracker.taskbars()[0]!.phase).toBe('showing'); // ...but known to be coming in
    expect(step(1516, 1140)).toBe(16);
    expect(r.tracker.taskbars()[0]!.phase).toBe('showing');
    // 96 ms into the 150 ms ease: 2 + 58 * 0.64 = 39.12 px on screen.
    step(1596, 1140);
    const s = r.tracker.surfaces()[0]!;
    expect(s.phase).toBe('entering');
    expect(s.y).toBeCloseTo(1200 - 39.12 - 1, 6);
    expect(s.vy).toBeCloseTo((-58 / 150) * 1000, 6);
    expect(s.confidence).toBe(0.6);
    expect(types(r.events)).toEqual(['taskbar.shown']);
    step(1650, 1140);
    const done = r.tracker.surfaces()[0]!;
    expect(done).toMatchObject({ phase: 'stable', y: 1139, vy: 0, confidence: 1 });
    // Instant hide: eased down, then gone.
    step(2500, 1198);
    expect(r.tracker.surfaces()[0]).toMatchObject({ phase: 'leaving', confidence: 0.6 });
    expect(r.tracker.surfaces()[0]!.vy).toBeGreaterThan(0);
    step(2580, 1198);
    expect(r.tracker.surfaces()).toEqual([]);
    expect(types(r.events)).toEqual(['taskbar.shown', 'taskbar.hidden']);
  });

  it('debounces flapping around 50 %: at most one event per 250 ms, alternating, ending in the settled state', () => {
    let t = 1250;
    const stamped: Array<{ type: string; t: number }> = [];
    for (let i = 0; i < 64; i++) {
      t += 16;
      step(t, i % 2 === 0 ? 1168 : 1172); // 32 px / 28 px on screen
      for (const e of r.events.splice(0)) stamped.push({ type: e.type, t });
    }
    expect(stamped.length).toBeGreaterThanOrEqual(2);
    expect(stamped.length).toBeLessThanOrEqual(Math.floor((64 * 16) / 250) + 1);
    for (let i = 1; i < stamped.length; i++) {
      expect(stamped[i]!.t - stamped[i - 1]!.t).toBeGreaterThanOrEqual(250);
      expect(stamped[i]!.type).not.toBe(stamped[i - 1]!.type);
    }
    // Settles shown: the reported state follows within one debounce interval.
    for (let k = 0; k < 20; k++) {
      t += 16;
      step(t, 1140);
      for (const e of r.events.splice(0)) stamped.push({ type: e.type, t });
    }
    expect(stamped.at(-1)!.type).toBe('taskbar.shown');
  });

  it('emits nothing for a dip below 50 % that recovers within the debounce interval', () => {
    let t = 1000;
    for (let top = 1194; top >= 1168; top -= 2) step((t += 16), top);
    expect(types(r.events)).toEqual(['taskbar.shown']);
    step((t += 16), 1172); // 28 px: below half
    expect(r.tracker.surfaces()).toEqual([]); // the ledge itself follows the geometry at once
    step((t += 16), 1168);
    for (let k = 0; k < 40; k++) step((t += 16), 1160);
    expect(types(r.events)).toEqual(['taskbar.shown']);
  });

  it('treats an invisible taskbar window as hidden', () => {
    step(1266, 1140);
    step(1500, 1140);
    r.native.bars.get(100n)!.visible = false;
    r.at(1516);
    for (let t = 1532; t < 1800; t += 16) r.at(t);
    expect(r.tracker.taskbars()[0]!.phase).toBe('hidden');
    expect(types(r.events)).toEqual(['taskbar.shown', 'taskbar.hidden']);
  });

  it('bursts with the cursor at the scaled reveal edge, not for the cat being near a still taskbar', () => {
    expect(r.at(1250, null, true)).toBe(250);
    // 125 %: ceil(6 * 1.25) = 8 px from the bottom row (y = 1199).
    expect(r.at(1500, { x: 10, y: 1191 })).toBe(16);
    expect(r.at(1750, { x: 10, y: 1190 })).toBe(250);
    expect((r.tracker.debugInfo() as { cadence: { reason: string | null } }).cadence.reason).toBeNull();
  });

  it('samples a revealed taskbar held open for an hour at the idle rate, with the cat on or next to it', () => {
    // E.g. a flashing taskbar button keeps it revealed until clicked (scripts/taskbar-probe.mjs).
    let t = 1250;
    for (let top = 1190; top >= 1140; top -= 10) step((t += 16), top);
    let delay = step((t += 16), 1140);
    const delays = new Map<number, number>();
    const end = t + 3_600_000;
    let samples = 0;
    while (t < end) {
      t += delay;
      // The cat sleeps on it (catNear) and the user's cursor is parked over it.
      delay = r.at(t, { x: 900, y: 1170 }, true);
      delays.set(delay, (delays.get(delay) ?? 0) + 1);
      samples++;
    }
    expect(r.tracker.taskbars()[0]!.phase).toBe('shown');
    expect(r.tracker.surfaces()[0]).toMatchObject({ phase: 'stable', y: 1139 });
    // Bursts only for the 300 ms after the slide; ~14 400 samples instead of ~225 000 at 60 Hz.
    expect(delays.get(16) ?? 0).toBeLessThanOrEqual(Math.ceil(300 / 16));
    expect(samples).toBeLessThan(3_600_000 / 250 + 20);
    // The start of the hide is caught by the next idle sample and followed at 60 Hz.
    expect(step(t + delay, 1150)).toBe(16);
    expect(r.tracker.taskbars()[0]!.phase).toBe('hiding');
  });
});

describe('taskbar tracker: Explorer restarts and rediscovery', () => {
  it('drops a destroyed taskbar at once (hidden event) and finds the new window', () => {
    const r = makeRig(new FakeTaskbarNative().add(100n, { rect: P_SHOWN }));
    expect(types(r.events)).toEqual(['taskbar.shown']); // discovered while shown
    r.native.remove(100n);
    r.native.add(200n, { rect: P_HIDDEN });
    r.at(1250);
    expect(r.events.at(-1)).toEqual({ type: 'taskbar.hidden', surfaceId: 'taskbar:100', displayId: 'P', edge: 'bottom' });
    expect(r.tracker.taskbars().map((t) => t.id)).toEqual(['200']);
    expect((r.tracker.debugInfo() as { lastDiscovery: { reason: string } }).lastDiscovery.reason).toBe('window-gone');
  });

  it('rediscovers on TaskbarCreated at the next sample and once more after 2 s', () => {
    const r = makeRig(primaryHidden());
    r.native.remove(100n);
    r.native.add(300n, { rect: P_HIDDEN });
    r.tracker.rediscover('taskbar-created');
    r.at(1100);
    const dbg = () => r.tracker.debugInfo() as { lastDiscovery: { reason: string }; discoveries: number };
    expect(dbg().lastDiscovery.reason).toBe('taskbar-created');
    expect(r.tracker.taskbars().map((t) => t.id)).toEqual(['300']);
    // Explorer creates the secondary taskbars a little later.
    r.native.monitors.push({ monitor: S_MON, work: S_MON });
    r.native.add(301n, { className: 'Shell_SecondaryTrayWnd', rect: bottomAt(S_MON, 1078, 48) });
    r.at(2000);
    expect(r.tracker.taskbars()).toHaveLength(1);
    r.at(3000);
    expect(dbg().lastDiscovery.reason).toBe('follow-up');
    expect(r.tracker.taskbars().map((t) => t.id)).toEqual(['300', '301']);
  });

  it('re-attributes taskbars to displays after setWorld', () => {
    const r = makeRig(primaryHidden(), null);
    expect(r.tracker.taskbars()[0]!.displayId).toBeNull();
    r.tracker.setWorld(WORLD_P);
    r.at(1100);
    expect(r.tracker.taskbars()[0]!.displayId).toBe('P');
    expect((r.tracker.debugInfo() as { lastDiscovery: { reason: string } }).lastDiscovery.reason).toBe('display-change');
  });

  it('rediscovers after repeated read failures and lowers the confidence meanwhile', () => {
    const r = makeRig(new FakeTaskbarNative().add(100n, { rect: P_SHOWN }));
    r.native.rectNull.add(100n);
    r.at(1100);
    expect(r.tracker.surfaces()[0]!.confidence).toBe(0.4);
    const before = (r.tracker.debugInfo() as { discoveries: number }).discoveries;
    r.at(1200);
    r.at(2200); // third failure, past the forced-rediscovery gap
    expect((r.tracker.debugInfo() as { discoveries: number }).discoveries).toBe(before + 1);
    r.native.rectNull.clear();
    r.at(2300);
    expect(r.tracker.surfaces()[0]!.confidence).toBe(1);
  });

  it('a taskbar moved to the top edge loses its ledge under the old edge', () => {
    const r = makeRig(new FakeTaskbarNative().add(100n, { rect: P_SHOWN }));
    r.native.abmPos = { edge: 1, rect: { left: 0, top: 0, right: 1920, bottom: 60 } };
    r.native.move(100n, { left: 0, top: 0, right: 1920, bottom: 60 });
    r.at(1100);
    r.at(2200);
    expect(r.tracker.taskbars()[0]!.edge).toBe('top');
    expect(r.events).toEqual([
      { type: 'taskbar.shown', surfaceId: 'taskbar:100', displayId: 'P', edge: 'bottom' },
      { type: 'taskbar.hidden', surfaceId: 'taskbar:100', displayId: 'P', edge: 'bottom' },
    ]);
    expect(r.tracker.surfaces()).toEqual([]);
  });
});

describe('taskbar tracker: multiple monitors and other edges', () => {
  it('tracks a secondary taskbar on a second monitor without SHAppBarMessage (thickness from the window)', () => {
    const n = primaryHidden();
    n.monitors.push({ monitor: S_MON, work: S_MON });
    n.add(400n, { className: 'Shell_SecondaryTrayWnd', rect: bottomAt(S_MON, 1078, 48) });
    const world: WorldGeometry = { version: 2, displays: [...WORLD_P.displays, display('S', S_MON, 1)] };
    const r = makeRig(n, world);
    const sec = r.tracker.taskbars().find((t) => t.id === '400')!;
    expect(sec).toMatchObject({ displayId: 'S', edge: 'bottom', autoHide: true, phase: 'hidden', dockedRect: { x: 1920, y: 1032, width: 1920, height: 48 } });
    expect((r.tracker.debugInfo() as { taskbars: Array<{ id: string; thicknessSource: string; primary: boolean }> }).taskbars.find((t) => t.id === '400')).toMatchObject({
      thicknessSource: 'window',
      primary: false,
    });
    // Hidden: the cursor band on S is 6 px (scale 1 there; 8 px on the 125 % primary).
    expect(r.at(1250, { x: 2500, y: 1073 })).toBe(16);
    expect(r.at(1500, { x: 2500, y: 1072 })).toBe(250);
    n.move(400n, bottomAt(S_MON, 1032, 48));
    r.at(1750);
    r.at(1950);
    const s = r.tracker.surfaces();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 'taskbar:400', displayId: 'S', x0: 1920, x1: 3840, y: 1031, phase: 'stable' });
    expect(r.events).toEqual([{ type: 'taskbar.shown', surfaceId: 'taskbar:400', displayId: 'S', edge: 'bottom' }]);
    // Revealed and still: idle, also with the cursor on it (it can hold the taskbar open for hours).
    expect(r.at(2300, { x: 2500, y: 1075 })).toBe(250);
    expect(r.at(2600, { x: 2500, y: 1040 })).toBe(250);
  });

  it('keeps a hidden secondary taskbar on its monitor when MonitorFromWindow picks the monitor below', () => {
    const n = new FakeTaskbarNative();
    n.monitors = [
      { monitor: S_MON, work: S_MON },
      { monitor: T_MON, work: T_MON },
    ];
    n.abmPos = null;
    n.add(500n, { className: 'Shell_SecondaryTrayWnd', rect: bottomAt(S_MON, 1032, 48) });
    const world: WorldGeometry = { version: 3, displays: [display('S', S_MON, 1), display('T', T_MON, 1)] };
    const r = makeRig(n, world);
    expect(r.tracker.taskbars()[0]!.displayId).toBe('S');
    // Hidden: 46 of its 48 px now overlap T, so MonitorFromWindow answers T.
    n.move(500n, bottomAt(S_MON, 1078, 48));
    for (let t = 1016; t <= 11_500; t += 250) r.at(t);
    const tb = r.tracker.taskbars()[0]!;
    expect(tb).toMatchObject({ displayId: 'S', edge: 'bottom', phase: 'hidden' });
    expect((r.tracker.debugInfo() as { taskbars: Array<{ monitorSource: string }>; discoveries: number }).taskbars[0]!.monitorSource).toBe('kept');
  });

  it('attributes a secondary taskbar first seen hidden to its own monitor, not the one below that MonitorFromWindow picks', () => {
    const n = new FakeTaskbarNative();
    n.monitors = [
      { monitor: S_MON, work: S_MON },
      { monitor: T_MON, work: T_MON },
    ];
    n.abmPos = null;
    // Hidden: 2 px on S, 46 px over T (which therefore reads it as a 96 % shown TOP taskbar of T).
    n.add(510n, { className: 'Shell_SecondaryTrayWnd', rect: bottomAt(S_MON, 1078, 48) });
    const world: WorldGeometry = { version: 5, displays: [display('S', S_MON, 1), display('T', T_MON, 1)] };
    const r = makeRig(n, world);
    expect(r.tracker.taskbars()[0]).toMatchObject({ displayId: 'S', edge: 'bottom', phase: 'hidden', autoHide: true });
    expect((r.tracker.debugInfo() as { taskbars: Array<{ monitorSource: string; role: string }> }).taskbars[0]).toMatchObject({ monitorSource: 'geometry', role: 'ledge' });
    // Revealed on S: a ledge on S.
    n.move(510n, bottomAt(S_MON, 1032, 48));
    r.at(1250);
    r.at(1450);
    expect(r.tracker.surfaces()).toEqual([expect.objectContaining({ id: 'taskbar:510', displayId: 'S', y: 1031, x0: 1920, x1: 3840 })]);
    expect(types(r.events)).toEqual(['taskbar.shown']);
  });

  it('rediscovers a taskbar that moved fully onto another monitor', () => {
    const n = new FakeTaskbarNative();
    n.monitors.push({ monitor: S_MON, work: S_MON });
    n.abmPos = null;
    n.add(520n, { className: 'Shell_SecondaryTrayWnd', rect: bottomAt(P_MON, 1152, 48) });
    const world: WorldGeometry = { version: 6, displays: [...WORLD_P.displays, display('S', S_MON, 1)] };
    const r = makeRig(n, world);
    expect(r.tracker.taskbars()[0]!.displayId).toBe('P');
    n.move(520n, bottomAt(S_MON, 1032, 48));
    r.at(2500);
    expect((r.tracker.debugInfo() as { lastDiscovery: { reason: string } }).lastDiscovery.reason).toBe('geometry-changed');
    expect(r.tracker.taskbars()[0]).toMatchObject({ displayId: 'S', edge: 'bottom', phase: 'shown' });
  });

  it('attributes the hidden primary by its docked SHAppBarMessage rect even when MonitorFromWindow disagrees', () => {
    const n = primaryHidden();
    const below: RawRect = { left: 0, top: 1200, right: 1920, bottom: 2400 };
    n.monitors.push({ monitor: below, work: below });
    const world: WorldGeometry = { version: 4, displays: [...WORLD_P.displays, display('B', below, 1)] };
    const r = makeRig(n, world);
    expect(r.tracker.taskbars()[0]).toMatchObject({ displayId: 'P', edge: 'bottom', phase: 'hidden' });
    expect((r.tracker.debugInfo() as { taskbars: Array<{ monitorSource: string }> }).taskbars[0]!.monitorSource).toBe('appbar');
  });

  it('reports top (ceiling) and left/right (wall) taskbars without ledges or events', () => {
    const top = new FakeTaskbarNative().add(600n, { rect: { left: 0, top: -58, right: 1920, bottom: 2 } });
    top.abmPos = { edge: 1, rect: { left: 0, top: 0, right: 1920, bottom: 60 } };
    const rt = makeRig(top);
    expect(rt.tracker.taskbars()[0]).toMatchObject({ edge: 'top', autoHide: true, phase: 'hidden' });
    top.move(600n, { left: 0, top: -30, right: 1920, bottom: 30 });
    rt.at(1016);
    expect(rt.tracker.taskbars()[0]!.speed).toBeGreaterThan(0); // its visible (bottom) edge moves down
    top.move(600n, { left: 0, top: 0, right: 1920, bottom: 60 });
    rt.at(1032);
    rt.at(1300);
    expect(rt.tracker.taskbars()[0]).toMatchObject({ phase: 'shown', shownFraction: 1 });
    expect(rt.tracker.surfaces()).toEqual([]);
    expect(rt.events).toEqual([]);
    expect((rt.tracker.debugInfo() as { taskbars: Array<{ role: string }> }).taskbars[0]!.role).toBe('ceiling');
    expect(rt.at(1600, { x: 500, y: 3 })).toBe(250); // shown and still: idle, also with the cursor on it
    top.move(600n, { left: 0, top: -58, right: 1920, bottom: 2 });
    rt.at(1616);
    expect(rt.at(2000, { x: 500, y: 3 })).toBe(16); // hidden: the cursor at the top edge may reveal it

    for (const [edge, abe, rect] of [
      ['left', 0, { left: -58, top: 0, right: 2, bottom: 1200 }],
      ['right', 2, { left: 1918, top: 0, right: 1978, bottom: 1200 }],
    ] as const) {
      const n = new FakeTaskbarNative().add(700n, { rect });
      n.abmPos = { edge: abe, rect: edge === 'left' ? { left: 0, top: 0, right: 60, bottom: 1200 } : { left: 1860, top: 0, right: 1920, bottom: 1200 } };
      const rr = makeRig(n);
      expect(rr.tracker.taskbars()[0]).toMatchObject({ edge, autoHide: true, phase: 'hidden' });
      expect((rr.tracker.debugInfo() as { taskbars: Array<{ role: string; edgeMismatch: boolean }> }).taskbars[0]).toMatchObject({ role: 'wall', edgeMismatch: false });
      expect(rr.tracker.surfaces()).toEqual([]);
    }
  });

  it('flags an ABM edge that disagrees with the geometry and lowers the ledge confidence', () => {
    const n = new FakeTaskbarNative().add(100n, { rect: P_SHOWN });
    n.abmPos = { edge: 1, rect: { left: 0, top: 0, right: 1920, bottom: 60 } };
    const r = makeRig(n);
    expect(r.tracker.taskbars()[0]!.edge).toBe('bottom');
    expect(r.tracker.surfaces()[0]!.confidence).toBe(0.5);
    expect(r.log.entries.filter((e) => e.msg.startsWith('taskbar edge from geometry disagrees'))).toHaveLength(1);
    expect((r.tracker.debugInfo() as { taskbars: Array<{ thicknessSource: string }> }).taskbars[0]!.thicknessSource).toBe('window');
  });
});

describe('taskbar tracker: click guard (areas the overlays never take the mouse over)', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('guards the strip and the reveal band of a hidden auto-hide taskbar, then the whole taskbar as it slides in', () => {
    const r = makeRig(primaryHidden());
    // 125 %: the 2 px strip on screen (its window reaches below the monitor) and ceil(6 * 1.25) = 8 rows.
    expect(r.tracker.clickGuardRects()).toEqual([rect(0, 1198, 1920, 60), rect(0, 1192, 1920, 8)]);
    // Live geometry from the last sample, also while an unobserved jump is still eased.
    r.native.move(100n, bottomAt(P_MON, 1170));
    r.at(1016);
    expect(r.tracker.clickGuardRects()).toEqual([rect(0, 1170, 1920, 60), rect(0, 1192, 1920, 8)]);
    r.native.move(100n, P_SHOWN);
    r.at(1032);
    expect(r.tracker.taskbars()[0]!.phase).not.toBe('shown');
    expect(r.tracker.clickGuardRects()).toEqual([rect(0, 1140, 1920, 60), rect(0, 1192, 1920, 8)]);
    // An invisible window guards nothing but its reveal band.
    r.native.bars.get(100n)!.visible = false;
    r.at(1048);
    expect(r.tracker.clickGuardRects()).toEqual([rect(0, 1192, 1920, 8)]);
    r.tracker.stop();
    expect(r.tracker.clickGuardRects()).toEqual([]);
  });

  it('guards a docked taskbar without a band, and the reveal band of other edges and DPI scales', () => {
    const docked = new FakeTaskbarNative().add(100n, { rect: P_SHOWN });
    docked.abmState = 0;
    docked.monitors = [{ monitor: P_MON, work: { ...P_MON, bottom: 1140 } }];
    const d = makeRig(docked, { version: 1, displays: [display('P', P_MON, 1.25, { ...P_MON, bottom: 1140 }, true)] });
    expect(d.tracker.clickGuardRects()).toEqual([rect(0, 1140, 1920, 60)]);

    const left = new FakeTaskbarNative().add(700n, { rect: { left: -58, top: 0, right: 2, bottom: 1200 } });
    left.abmPos = { edge: 0, rect: { left: 0, top: 0, right: 60, bottom: 1200 } };
    expect(makeRig(left).tracker.clickGuardRects()).toEqual([rect(-58, 0, 60, 1200), rect(0, 0, 8, 1200)]);

    // A secondary at 150 % on the second monitor: ceil(6 * 1.5) = 9 rows along its span only.
    const n = new FakeTaskbarNative().add(100n, { rect: P_HIDDEN }).add(301n, { className: 'Shell_SecondaryTrayWnd', rect: { left: 2000, top: 1078, right: 3800, bottom: 1126 } });
    n.monitors.push({ monitor: S_MON, work: S_MON });
    const world: WorldGeometry = { version: 1, displays: [display('P', P_MON, 1.25, P_MON, true), display('S', S_MON, 1.5)] };
    const guard = makeRig(n, world).tracker.clickGuardRects();
    expect(guard).toContainEqual(rect(2000, 1071, 1800, 9));
    expect(guard).toContainEqual(rect(2000, 1078, 1800, 48));
  });

  it('is empty without Win32', () => {
    const t = createTaskbarTracker(createTestLogger(), { native: null });
    t.start();
    expect(t.clickGuardRects()).toEqual([]);
  });
});

describe('taskbar tracker: unavailable and failing APIs', () => {
  it('is inert without a native facade', () => {
    const log = createTestLogger();
    const t = createTaskbarTracker(log, { native: null });
    t.start();
    expect(t.available).toBe(false);
    expect(t.sample(0, { x: 0, y: 0 }, true)).toBe(250);
    expect(t.taskbars()).toEqual([]);
    expect(t.surfaces()).toEqual([]);
    expect(t.drainEvents()).toEqual([]);
    expect(t.debugInfo()).toEqual({ available: false, reason: 'win32 unavailable' });
    t.rediscover('manual');
    t.setWorld(WORLD_P);
    t.stop();
  });

  it('keeps tracking when SHAppBarMessage fails (geometry only)', () => {
    const n = primaryHidden();
    n.throwOn.add('appBarState');
    n.throwOn.add('appBarTaskbarPos');
    const r = makeRig(n);
    expect(r.tracker.taskbars()[0]).toMatchObject({ edge: 'bottom', autoHide: true, phase: 'hidden', dockedRect: px(P_SHOWN) });
    expect((r.tracker.debugInfo() as { taskbars: Array<{ thicknessSource: string; autoHideBy: string }> }).taskbars[0]).toMatchObject({
      thicknessSource: 'window',
      autoHideBy: 'work-area',
    });
    expect(r.log.entries.filter((e) => e.msg === 'taskbar native call failed').length).toBe(2);
  });

  it('never throws when every native call fails, and rate-limits the warnings', () => {
    const n = primaryHidden();
    for (const k of ['findWindow', 'findNextWindow', 'isWindow', 'isWindowVisible', 'getWindowRect', 'getMonitorRects', 'appBarState', 'appBarTaskbarPos', 'getExStyle'] as const) n.throwOn.add(k);
    const r = makeRig(n);
    for (let t = 1000; t < 60_000; t += 250) expect(r.at(t, { x: 1, y: 1199 }, false)).toBe(250);
    expect(r.tracker.taskbars()).toEqual([]);
    expect(r.tracker.surfaces()).toEqual([]);
    expect(() => r.tracker.debugInfo()).not.toThrow();
    const warns = r.log.entries.filter((e) => e.msg === 'taskbar native call failed');
    expect(warns.length).toBeLessThanOrEqual(3 * 2);
  });

  it('survives a taskbar whose calls start failing after discovery', () => {
    const r = makeRig(new FakeTaskbarNative().add(100n, { rect: P_SHOWN }));
    r.native.throwOn.add('isWindow');
    r.native.throwOn.add('getExStyle');
    expect(() => r.at(1100)).not.toThrow();
    expect(r.tracker.surfaces()[0]!.confidence).toBe(0.4);
    expect((r.tracker.debugInfo() as { taskbars: Array<{ topmost: boolean | null }> }).taskbars[0]!.topmost).toBeNull();
  });

  it('does nothing before start and after stop; ignores non-finite times', () => {
    const r = makeRig(primaryHidden(), WORLD_P, false);
    expect(r.native.count('findWindow')).toBe(0);
    expect(r.at(1000)).toBe(250);
    expect(r.tracker.taskbars()).toEqual([]);
    r.tracker.start();
    expect(r.tracker.taskbars()).toHaveLength(1);
    expect(r.tracker.sample(Number.NaN, null, false)).toBe(250);
    r.tracker.stop();
    expect(r.tracker.taskbars()).toEqual([]);
    expect(r.at(2000, { x: 5, y: 1199 })).toBe(250);
  });
});
