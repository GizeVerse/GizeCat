// The Mover on the provider's real geometry: window tops and sides are OPEN SPANS, cut by the
// windows in front and clipped to the work areas (src/main/surfaces/windowSurfaces.ts), not
// the window's frame. Riding and climbing must follow the window, not the ends of whatever
// part of an edge is open: a window hanging off the screen or straddling two displays, a
// window brought in front over part of an edge or over the cat's spot, a tab strip that
// shrinks under the cat, more surfaces in front than the per-kind list cap.
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../../../src/shared/geometry';
import type { LedgeSurface, Surface, WallSurface } from '../../../../src/shared/surfaces';
import type { WorldGeometry } from '../../../../src/shared/world';
import type { MoverConfig, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT, Mover } from '../../../../src/core/movement';
import { computeOpenSpans, pickSpan, type WindowSurfaceOptions } from '../../../../src/main/surfaces/windowSurfaces';
import { DUAL_FLAT, ledge, sideId, SINGLE, tabStrip, topId, wall } from '../behavior/fixtures';
import { SurfaceDriver } from './surfaceDriver';

const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };
const BW = 84;
const TICK = 33;
/** The provider's defaults (provider.ts), Windows 11 corners. */
const OPTS: WindowSurfaceOptions = { cornerRadiusDip: 8, minLedgeWidthPx: 80, minWallHeightDip: 96, wallClearanceDip: 40, climbWindows: true };
const ATTACH_TOLERANCE_PX = 12;
const CORNER_REACH_PX = 2;

interface Win {
  id: string;
  rect: Rect;
  /** Frame velocity the provider reports (px/s). */
  vx?: number;
  vy?: number;
}

/**
 * The host's window surfaces as the provider builds them: open spans of each window's top and
 * sides against the windows in front, one span per edge (the cat's part for the surface it is
 * attached to, carried with the window's frame since the last tick, else the longest), and
 * the bare edge for the attached surface when nothing of it is open.
 */
class SpanHost {
  /** Front to back. */
  windows: Win[] = [];
  now = 0;
  log: MoverStep[] = [];
  private spot: { surfaceId: string; ownerId: string; x: number; y: number; frame: Rect } | null = null;

  constructor(
    public m: Mover,
    public w: WorldGeometry,
    public opts: WindowSurfaceOptions = OPTS,
  ) {}

  private attachment(win: Win): { surfaceId: string; x: number; y: number; reported: { x: number; y: number } | null } | null {
    const s = this.spot;
    if (!s || s.ownerId !== win.id) return null;
    const dx = win.rect.width === s.frame.width ? win.rect.x - s.frame.x : 0;
    const dy = win.rect.height === s.frame.height ? win.rect.y - s.frame.y : 0;
    return { surfaceId: s.surfaceId, x: s.x + dx, y: s.y + dy, reported: dx !== 0 || dy !== 0 ? { x: s.x, y: s.y } : null };
  }

  private build(win: Win): { top: LedgeSurface | null; left: WallSurface | null; right: WallSurface | null; inset: number } {
    const idx = this.windows.indexOf(win);
    const above = this.windows.slice(0, idx).map((o) => o.rect);
    const spans = computeOpenSpans(win.rect, above, this.w.displays, this.opts);
    const att = this.attachment(win);
    const r = win.rect;
    const right = r.x + r.width;
    const motion = { vx: win.vx ?? 0, vy: win.vy ?? 0 };
    const onTop = att?.surfaceId === topId(win.id) ? att : null;
    const topSpan = pickSpan(spans.top, onTop?.x ?? null, ATTACH_TOLERANCE_PX, onTop?.reported?.x ?? null);
    const top = topSpan ? ledge(topId(win.id), 'windowTop', win.id, r.y, topSpan[0], topSpan[1], motion) : null;
    const cornerTop = r.y + spans.inset;
    const side = (s: 'left' | 'right'): WallSurface | null => {
      const on = att?.surfaceId === sideId(win.id, s) ? att : null;
      const sideSpans = spans[s];
      const atCorner = on ? null : (sideSpans.find((p) => p[0] <= cornerTop + CORNER_REACH_PX) ?? null);
      const chosen = atCorner ?? pickSpan(sideSpans, on?.y ?? null, ATTACH_TOLERANCE_PX * 2, on?.reported?.y ?? null);
      if (!chosen) return null;
      const fromCorner = top !== null && (s === 'left' ? top.x0 <= r.x + spans.inset + CORNER_REACH_PX : top.x1 >= right - spans.inset - CORNER_REACH_PX);
      const reaches = chosen[0] <= cornerTop + CORNER_REACH_PX && fromCorner;
      return wall(win.id, s, s === 'left' ? r.x : right, chosen[0], chosen[1], { ...motion, topLedgeId: reaches ? topId(win.id) : null });
    };
    return { top, left: side('left'), right: side('right'), inset: spans.inset };
  }

  list(): Surface[] {
    const out: Surface[] = [];
    for (const win of this.windows) {
      const b = this.build(win);
      for (const s of [b.top, b.left, b.right]) if (s) out.push(s);
    }
    return out;
  }

  live(id: string): Surface | null {
    for (const win of this.windows) {
      const b = this.build(win);
      const s = [b.top, b.left, b.right].find((x) => x?.id === id);
      if (s) return s;
      if (this.spot?.surfaceId !== id) continue;
      // Nothing of it open while the window is there: the bare edge, never listed.
      const r = win.rect;
      if (id === topId(win.id)) return ledge(id, 'windowTop', win.id, r.y, r.x + b.inset, r.x + r.width - b.inset, { vx: win.vx ?? 0, vy: win.vy ?? 0 });
      for (const side of ['left', 'right'] as const) {
        if (id === sideId(win.id, side)) return wall(win.id, side, side === 'left' ? r.x : r.x + r.width, r.y + b.inset, r.y + r.height - b.inset, { vx: win.vx ?? 0, vy: win.vy ?? 0, topLedgeId: null });
      }
    }
    return null;
  }

  step(dt = TICK): MoverStep {
    this.now += dt;
    this.m.sense(this.list());
    const r = this.m.step({ now: this.now, dtMs: dt, dragCursor: null, getSurface: (id) => this.live(id) });
    this.log.push(r);
    // The host notes where the cat is (and on which frame) for the next tick's lookups.
    const a = this.m.attachedSurface;
    const owner = a ? this.windows.find((o) => o.id === a.ownerId) : undefined;
    this.spot = a && owner ? { surfaceId: a.surfaceId, ownerId: owner.id, x: this.m.x, y: this.m.y, frame: { ...owner.rect } } : null;
    return r;
  }

  until(pred: (r: MoverStep) => boolean, maxMs: number): boolean {
    const end = this.now + maxMs;
    while (this.now < end) if (pred(this.step())) return true;
    return false;
  }

  win(id: string): Win {
    const w = this.windows.find((o) => o.id === id);
    if (!w) throw new Error(`no window ${id}`);
    return w;
  }
}

function host(w: WorldGeometry, xFrac: number, windows: Win[], opts: Partial<WindowSurfaceOptions> = {}): SpanHost {
  const h = new SpanHost(new Mover(w, CFG, { displayId: '1', xFrac }), w, { ...OPTS, ...opts });
  h.windows = windows;
  h.step();
  return h;
}

/** Walks/jumps the cat onto window `id`'s top at x. */
function perch(h: SpanHost, id: string, x: number): void {
  h.m.setGoal({ x, y: h.win(id).rect.y - 1, pace: 'walk', allowJump: true });
  expect(h.until((r) => r.goal === 'arrived', 30_000)).toBe(true);
  h.m.setGoal(null);
  expect(h.m.attachedSurface?.surfaceId).toBe(topId(id));
  expect(h.m.x).toBeCloseTo(x, 0);
}

/** Drags window `id` by (dx, dy) per tick for n ticks, reporting the matching frame velocity. */
function drag(h: SpanHost, id: string, dx: number, dy: number, n: number, each: (i: number, r: MoverStep) => void): void {
  const win = h.win(id);
  for (let i = 1; i <= n; i++) {
    win.rect = { ...win.rect, x: win.rect.x + dx, y: win.rect.y + dy };
    win.vx = (dx * 1000) / TICK;
    win.vy = (dy * 1000) / TICK;
    each(i, h.step());
  }
  win.vx = 0;
  win.vy = 0;
}

describe('Mover on clipped spans: riding a dragged window (physics#0)', () => {
  it('a window hanging off the right screen edge carries the cat when dragged left', () => {
    // Top edge 1508..2392, clipped to the screen: 1508..1920 (the right end stays at 1920 while the window moves).
    const h = host(SINGLE, 0.8, [{ id: 'a', rect: { x: 1500, y: 700, width: 900, height: 300 } }], { climbWindows: false });
    perch(h, 'a', 1700);
    const x0 = h.m.x;
    drag(h, 'a', -20, 0, 20, (i, r) => {
      expect(r.supportLost).toBeNull();
      expect(h.m.attachedSurface?.surfaceId).toBe(topId('a'));
      expect(h.m.x).toBeCloseTo(x0 - 20 * i, 6);
    });
  });

  it('a window straddling two displays carries the cat at 30 px per tick, without losing it', () => {
    // Top edge 1408..2292: display 1 holds 1408..1920 (the cat's part), display 2 the rest.
    const h = host(DUAL_FLAT, 0.7, [{ id: 'a', rect: { x: 1400, y: 700, width: 900, height: 300 } }], { climbWindows: false });
    perch(h, 'a', 1600);
    const x0 = h.m.x;
    drag(h, 'a', 30, 0, 8, (i, r) => {
      expect(r.supportLost).toBeNull();
      expect(r.perchLost).toBe(false);
      expect(h.m.x).toBeCloseTo(x0 + 30 * i, 6);
    });
  });

  it('a window sent at once to the other display (same size, another height) carries the cat along', () => {
    const h = host(DUAL_FLAT, 0.3, [{ id: 'a', rect: { x: 400, y: 700, width: 600, height: 300 } }], { climbWindows: false });
    perch(h, 'a', 700);
    // Win+Shift+Arrow style: one tick, no velocity reported (the provider sees a jump).
    h.win('a').rect = { x: 2320, y: 650, width: 600, height: 300 };
    const r = h.step();
    expect(r.supportLost).toBeNull();
    expect(h.m.attachedSurface?.surfaceId).toBe(topId('a'));
    expect(h.m.x).toBeCloseTo(2620, 6);
    expect(h.m.y).toBe(650);
  });

  it('a window brought in front over the free end of a clipped edge does not move the cat', () => {
    const h = host(SINGLE, 0.8, [{ id: 'a', rect: { x: 1500, y: 700, width: 900, height: 300 } }], { climbWindows: false });
    perch(h, 'a', 1800);
    const x0 = h.m.x;
    // B covers 1400..1650 of A's top: its open part now starts at 1650, the window did not move.
    h.windows = [{ id: 'b', rect: { x: 1400, y: 600, width: 250, height: 300 } }, ...h.windows];
    for (let i = 0; i < 30; i++) {
      const r = h.step();
      expect(r.supportLost).toBeNull();
      expect(h.m.x).toBe(x0);
    }
  });
});

describe('Mover on cut spans: climbing a side partly covered by a window in front (physics#1)', () => {
  // A: 800..1300 x 300..1040 (standing on the floor), its left side open 308..1032.
  const A: Win = { id: 'a', rect: { x: 800, y: 300, width: 500, height: 740 } };

  function climbingAt(y: number): SpanHost {
    const h = host(SINGLE, 0.25, [{ ...A, rect: { ...A.rect } }]);
    h.m.setGoal({ x: 1000, y: 299, pace: 'walk', allowJump: true, route: 'climb' });
    expect(h.until(() => h.m.onWall && h.m.climbPhase === 'climb' && h.m.y <= y, 30_000)).toBe(true);
    expect(h.m.wall?.key).toBe(sideId('a', 'left'));
    return h;
  }

  function steadyOnWall(h: SpanHost, ms: number): { minY: number; maxStep: number } {
    let prev = h.m.y;
    let minY = Infinity;
    let maxStep = 0;
    const end = h.now + ms;
    while (h.now < end) {
      const r = h.step();
      expect(r.snapped).toBe(false);
      expect(r.supportLost).toBeNull();
      if (!h.m.onWall) break;
      maxStep = Math.max(maxStep, Math.abs(h.m.y - prev));
      minY = Math.min(minY, h.m.y);
      prev = h.m.y;
    }
    return { minY, maxStep };
  }

  it('covering the upper part of the side above the cat neither moves it nor lets it pull up into the cover', () => {
    const h = climbingAt(750);
    // B covers the side from 200 to 520: the open part now starts at 520 (y0 308 -> 520), A did not move.
    h.windows = [{ id: 'b', rect: { x: 600, y: 200, width: 300, height: 320 } }, ...h.windows];
    const climbStep = (MOVEMENT.climbDownDip * TICK) / 1000 + 1e-6;
    // Long enough to climb up to the new highest grip (3.8 s) and turn back down.
    const covered = steadyOnWall(h, 6000);
    expect(covered.maxStep).toBeLessThanOrEqual(climbStep);
    // Highest grip on the open part: its start plus 0.73 body lengths; it climbs back down from there.
    expect(covered.minY).toBeGreaterThanOrEqual(520 + 0.73 * BW - 1e-6);
    expect(h.m.onWall).toBe(true);
    // B goes away: the side is open up to 308 again, still nothing jumps.
    h.windows = h.windows.filter((o) => o.id !== 'b');
    expect(steadyOnWall(h, 1000).maxStep).toBeLessThanOrEqual(climbStep);
  });

  it('a cover just over the grip makes it climb down onto the open part and carry on', () => {
    const h = climbingAt(750);
    // Open part 720..1032: the highest grip is 781.3, a few px below the cat.
    h.windows = [{ id: 'b', rect: { x: 600, y: 200, width: 300, height: 520 } }, ...h.windows];
    const res = steadyOnWall(h, 2000);
    expect(res.maxStep).toBeLessThanOrEqual((MOVEMENT.climbDownDip * TICK) / 1000 + 1e-6);
    expect(h.m.onWall).toBe(true);
  });

  it('a cover over far more of the side than it can climb in the grace makes it let go calmly', () => {
    const h = climbingAt(750);
    // Open part 800..1032: the highest grip is 861, too far below to reach in perchGraceMs.
    h.windows = [{ id: 'b', rect: { x: 600, y: 200, width: 300, height: 600 } }, ...h.windows];
    const t0 = h.now;
    let prev = h.m.y;
    let lost: MoverStep['supportLost'] = null;
    while (!lost && h.now - t0 < 2000) {
      const r = h.step();
      lost = r.supportLost;
      if (!lost) expect(Math.abs(h.m.y - prev)).toBeLessThanOrEqual((MOVEMENT.climbDownDip * TICK) / 1000 + 1e-6);
      prev = h.m.y;
    }
    expect(lost).toEqual({ reason: 'occluded', surfaceId: sideId('a', 'left'), surfaceKind: 'windowSide', fell: true });
    expect(h.now - t0).toBeGreaterThanOrEqual(MOVEMENT.perchGraceMs);
  });

  it('a side dragged up and down carries the cat with it, also with its bottom end clipped at the floor', () => {
    const h = climbingAt(750);
    let y0 = h.m.y;
    drag(h, 'a', 0, -6, 10, (_i, r) => {
      expect(r.supportLost).toBeNull();
      // Its own climbing (up at climbUpDip) on top of the window's motion.
      expect(h.m.y).toBeCloseTo(y0 - 6 - (MOVEMENT.climbUpDip * TICK) / 1000, 6);
      y0 = h.m.y;
    });
    // Down past the floor: the side's open part now ends at the work-area bottom (pinned) while the window moves.
    drag(h, 'a', 0, 8, 12, (_i, r) => {
      expect(r.supportLost).toBeNull();
      expect(h.m.y).toBeCloseTo(y0 + 8 - (MOVEMENT.climbUpDip * TICK) / 1000, 6);
      y0 = h.m.y;
    });
  });
});

describe('Mover: a window brought in front over the cat spot (physics#6)', () => {
  it('drops it calmly after the grace, without moving it onto the part of the top left open', () => {
    const h = host(SINGLE, 0.5, [{ id: 'a', rect: { x: 600, y: 800, width: 800, height: 240 } }], { climbWindows: false });
    perch(h, 'a', 1000);
    const x0 = h.m.x;
    // B covers 900..1200 of A's top: the provider serves the longest open part (608..900), not holding the cat.
    h.windows = [{ id: 'b', rect: { x: 900, y: 500, width: 300, height: 500 } }, ...h.windows];
    const t0 = h.now;
    expect(h.until((r) => r.supportLost !== null || h.m.x !== x0, 2000)).toBe(true);
    expect(h.log[h.log.length - 1]?.supportLost).toEqual({ reason: 'occluded', surfaceId: topId('a'), surfaceKind: 'windowTop', fell: true });
    expect(h.now - t0).toBeGreaterThanOrEqual(MOVEMENT.perchGraceMs);
  });

  it('an open part as long as the covered one, elsewhere on the edge, is not the window moving', () => {
    // C in front cuts A's top into two parts of 392 px: 408..800 and 1000..1392.
    const h = host(SINGLE, 0.3, [{ id: 'c', rect: { x: 800, y: 600, width: 200, height: 400 } }, { id: 'a', rect: { x: 400, y: 800, width: 1000, height: 240 } }], { climbWindows: false });
    perch(h, 'a', 600);
    const x0 = h.m.x;
    // D covers the cat's part entirely: the provider now serves 1000..1392 (both ends 592 px further right).
    h.windows = [{ id: 'd', rect: { x: 350, y: 700, width: 500, height: 200 } }, ...h.windows];
    const r = h.step();
    expect(h.m.x).toBe(x0);
    expect(r.snapped).toBe(false);
    expect(h.until((s) => s.supportLost !== null, 2000)).toBe(true);
    expect(h.log[h.log.length - 1]?.supportLost?.reason).toBe('occluded');
  });
});

describe('Mover: a tab strip that shrinks under the cat (physics#3)', () => {
  const sameLookup = (): void => undefined;

  function onStrip(): SurfaceDriver {
    const d = new SurfaceDriver(new Mover(SINGLE, CFG, { displayId: '1', xFrac: 0.7 }), SINGLE);
    d.walls = false;
    d.extra = [tabStrip('b', 700, 356, 1414, null, null)];
    d.step();
    d.goal({ x: 1400, y: 700 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.m.setGoal(null);
    expect(d.m.attachedSurface?.surfaceId).toBe('tabStrip:b');
    return d;
  }

  it.each([
    ['the live strip shrank too', sameLookup],
    [
      'the live lookup still has the window top under the strip id',
      (d: SurfaceDriver): void => {
        d.liveOverride = (id) => (id === 'tabStrip:b' ? ledge('tabStrip:b', 'tabStrip', 'b', 700, 308, 1592, { confidence: 0.5 }) : null);
      },
    ],
  ])('tabs closed (%s): no jump to the new end, a calm drop after the grace', (_label, live) => {
    const d = onStrip();
    const x0 = d.m.x;
    // Five tabs closed: the strip now ends at 900, 500 px left of the cat.
    d.extra = [tabStrip('b', 700, 356, 900, null, null)];
    live(d);
    const t0 = d.now;
    let lost: MoverStep['supportLost'] = null;
    while (!lost && d.now - t0 < 2000) {
      const r = d.step();
      lost = r.supportLost;
      if (!lost) {
        expect(d.m.x).toBe(x0);
        expect(r.snapped).toBe(false);
      }
    }
    expect(lost).toEqual({ reason: 'occluded', surfaceId: 'tabStrip:b', surfaceKind: 'tabStrip', fell: true });
    expect(d.now - t0).toBeGreaterThanOrEqual(MOVEMENT.perchGraceMs);
  });
});

describe('Mover: the per-kind list cap never drops what the cat is on (physics#7)', () => {
  /** 18 small windows per row (listed in front of the one the cat is on, as the host lists them front to back). */
  function crowd(rows: readonly number[], height: number): Record<string, Rect> {
    const out: Record<string, Rect> = {};
    for (const y of rows) for (let col = 0; col < 18; col++) out[`s${y}-${col}`] = { x: 10 + col * 105, y, width: 95, height };
    return out;
  }

  it('perched on a window behind more than 64 others, it stays', () => {
    const d = new SurfaceDriver(new Mover(SINGLE, CFG, { displayId: '1', xFrac: 0.5 }), SINGLE);
    d.walls = false;
    const A = { x: 600, y: 800, width: 800, height: 240 };
    d.windows = { a: A };
    d.goal({ x: 1000, y: 799 });
    expect(d.until((r) => r.goal === 'arrived', 20_000)).toBe(true);
    d.m.setGoal(null);
    // 72 usable tops in front.
    d.windows = { ...crowd([100, 200, 300, 400], 60), a: A };
    d.log = [];
    d.until(() => false, 2000);
    expect(d.log.some((r) => r.supportLost !== null)).toBe(false);
    expect(d.m.attachedSurface?.surfaceId).toBe(topId('a'));
    expect(d.m.ledgeSurfaces.length).toBeLessThanOrEqual(64);
    expect(d.m.ledgeById(topId('a'))).not.toBeNull();
  });

  it('climbing a side behind more than 32 windows (64 sides), it keeps climbing', () => {
    const d = new SurfaceDriver(new Mover(SINGLE, CFG, { displayId: '1', xFrac: 0.25 }), SINGLE);
    const W = { x: 800, y: 500, width: 500, height: 540 };
    d.windows = { w: W };
    d.goal({ x: 1000, y: 499, route: 'climb' });
    expect(d.until(() => d.m.climbPhase === 'climb', 20_000)).toBe(true);
    // 68 usable sides in front (the outermost two have no room beside them).
    d.windows = { ...crowd([60, 230], 150), w: W };
    d.log = [];
    d.until(() => false, 1500);
    expect(d.log.some((r) => r.supportLost !== null)).toBe(false);
    expect(d.m.onWall).toBe(true);
    expect(d.m.wallTracks.length).toBeLessThanOrEqual(64);
    expect(d.m.wallTracks.some((t) => t.key === sideId('w', 'left'))).toBe(true);
  });
});
