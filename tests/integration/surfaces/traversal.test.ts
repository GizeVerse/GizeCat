// Surface traversal end to end (v1.1.1): a cat on the floor gets onto a typical floating window
// and lives there; the window is dragged, resized, closed or minimized under it; the user grabs
// and throws it mid-leap and mid-climb. SIMULATED geometry through the REAL composition (see
// pipeline.ts): win32 layer, window tracker, surface provider, sim, mover, host. Deterministic.
import { afterEach, describe, expect, it } from 'vitest';
import {
  appWindow,
  BODY_PX,
  FALL_MAX_SPEED,
  FLOOR_Y,
  freshCat,
  motion,
  onFloor,
  onTopOf,
  Pipeline,
  RUN_SPEED,
  sideOf,
  stays,
  userCat,
  type Sample,
} from './pipeline';

const MIN = 60_000;
const W = '70000';
/**
 * A typical floating window (about 65 % of the screen): its top is ~1075 px above the floor, far
 * beyond a jump (420 DIP = 525 px), and its sides end 240 px above the floor, beyond a step (48 px).
 */
const TYPICAL: [number, number, number, number] = [300, 120, 1000, 840];
const typical = () => appWindow(W, 'app.exe', TYPICAL);
const TOP = `windowTop:${W}`;

const open: Pipeline[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.dispose();
});

function pipeline(seed: number, cat = freshCat(seed)): Pipeline {
  const p = new Pipeline({ windows: [typical()], seed, cat });
  open.push(p);
  return p;
}

const settledOnTop = (s: Sample): boolean => onTopOf(W)(s) && ['idle', 'walking', 'sitting', 'inspectingWindow'].includes(s.state);

describe('a cat on the floor gets onto a typical floating window by itself', () => {
  // Measured (seeds 1-6, fresh cats): first arrival on the top at 156-242 sim-s. The bound leaves 2.5x.
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`fresh cat, seed ${seed}: leaps onto a side, climbs, pulls up, stays >= 10 s and walks >= 3 body lengths; motion stays continuous`, async () => {
      const p = pipeline(seed);
      await p.run(10 * MIN);
      const first = p.samples.find(onTopOf(W));
      expect(first, 'reached the window top within 10 sim-min').toBeDefined();
      // The only way up is a side (RC1): it clung to a side before it stood on the top.
      const side = p.samples.find(sideOf(W));
      expect(side!.t).toBeLessThan(first!.t);
      const climbs = p.surfaceDiagnostics().nav.climbs;
      expect(climbs.leaps).toBeGreaterThanOrEqual(1);
      expect(climbs.pulledUp).toBeGreaterThanOrEqual(1);
      expect(climbs.reversed).toBe(0);
      const stay = stays(p.samples).find((s) => s.surfaceId === TOP)!;
      expect(stay.from).toBe(first!.t);
      expect(stay.to - stay.from, 'attached to the top').toBeGreaterThanOrEqual(10_000);
      expect(stay.pathPx, 'walked along the top').toBeGreaterThanOrEqual(3 * BODY_PX);
      // Continuous motion: no position jumps, nothing faster than a free fall from the screen top.
      const m = motion(p.samples);
      expect(m.snaps).toBe(0);
      expect(m.maxStepPx).toBeLessThan(BODY_PX);
      expect(m.maxSpeed).toBeLessThanOrEqual(FALL_MAX_SPEED * 1.02);
      expect(p.host.debug().tickErrors).toBe(0);
      // While it walked along the top it stood on it: never outside the window's top edge.
      for (const s of p.samples.filter(onTopOf(W))) {
        expect(s.y).toBe(TYPICAL[1]);
        expect(s.x).toBeGreaterThan(TYPICAL[0]);
        expect(s.x).toBeLessThan(TYPICAL[0] + TYPICAL[2]);
      }
    });
  }

  // The reporting user's own cat (boredom 0.02 after 23 min, busy profile): measured 127-267 sim-s.
  for (const seed of [1, 2, 3]) {
    it(`the user's cat, seed ${seed}: gets up within 10 sim-min`, async () => {
      const p = pipeline(seed, userCat(seed));
      const s = await p.runUntil(onTopOf(W), 10 * MIN);
      expect(s).not.toBeNull();
      expect(p.surfaceDiagnostics().decision.excursions).toBe(1);
    });
  }
});

describe('the window moves under the cat', () => {
  it('a drag carries the cat along: it stays on the top, at the live top height, with no jolt relative to the window', async () => {
    const p = pipeline(1);
    expect(await p.runUntil(settledOnTop, 10 * MIN)).not.toBeNull();
    const f0 = p.frame(W);
    const i0 = p.samples.length;
    const to = { left: f0.left + 200, top: f0.top + 80, right: f0.right + 200, bottom: f0.bottom + 80 };
    await p.moveSize(W, to, 1200);
    await p.run(500);
    const during = p.samples.slice(i0);
    expect(during.length).toBeGreaterThan(30);
    let prevRel: number | null = null;
    let prevT = 0;
    for (const s of during) {
      expect(s.surfaceId, `at ${s.t}`).toBe(TOP);
      const f = p.frameAt(W, s.t) ?? f0;
      // Feet on the window's top edge as it moves (one 16 ms drag step of lag at most).
      expect(Math.abs(s.y - f.top)).toBeLessThanOrEqual(2);
      // Relative to the window, it only moves at its own walking/running pace.
      const rel = s.x - f.left;
      if (prevRel !== null) expect(Math.abs(rel - prevRel)).toBeLessThanOrEqual((RUN_SPEED * (s.t - prevT)) / 1000 + 4);
      prevRel = rel;
      prevT = s.t;
    }
    expect(p.last.y).toBe(to.top);
  });

  it('a resize that keeps the top keeps the cat attached; one that cuts the top away under it sets it down calmly', async () => {
    const p = pipeline(1);
    expect(await p.runUntil(settledOnTop, 10 * MIN)).not.toBeNull();
    const f0 = p.frame(W);
    let i = p.samples.length;
    await p.moveSize(W, { ...f0, bottom: f0.bottom - 250 }, 800);
    await p.run(500);
    for (const s of p.samples.slice(i)) {
      expect(s.surfaceId).toBe(TOP);
      expect(s.y).toBe(f0.top);
    }
    // Narrow the window from the right to well left of the cat.
    const catX = p.last.x;
    const right = Math.round(Math.max(f0.left + 300, catX - 150));
    i = p.samples.length;
    await p.moveSize(W, { ...p.frame(W), right }, 800);
    const resizedAt = p.now;
    // Within the moving grace (2.5 s) + the perch grace (0.45 s) + a fall, it is safe: on the
    // floor, or on what is left of the top.
    await p.run(5000);
    const after = p.samples.slice(i);
    const end = p.last;
    expect(onFloor(end) || (end.surfaceId === TOP && end.x >= f0.left && end.x <= right)).toBe(true);
    // Calm: no startle for a surface that was cut away, no position jump.
    expect(after.map((s) => s.state)).not.toContain('startled');
    expect(motion(after).snaps).toBe(0);
    // Never left hanging off the window for longer than the graces.
    const offEdge = after.filter((s) => s.t > resizedAt && s.surfaceId === TOP && s.x > right + BODY_PX / 2);
    if (offEdge.length > 0) expect(offEdge[offEdge.length - 1]!.t - resizedAt).toBeLessThanOrEqual(2500 + 450 + 100);
    expect(p.host.debug().tickErrors).toBe(0);
  });
});

describe('the window goes away under the cat', () => {
  for (const what of ['close', 'minimize'] as const) {
    for (const where of ['top', 'side'] as const) {
      it(`${what} while it is on the ${where === 'top' ? 'top' : 'side (climbing)'}: a controlled fall to the floor, then life goes on`, async () => {
        const p = pipeline(2);
        const at = await p.runUntil(where === 'top' ? settledOnTop : (s) => sideOf(W)(s) && s.clip === 'climb' && s.y < 800, 10 * MIN);
        expect(at).not.toBeNull();
        const i0 = p.samples.length;
        const t0 = p.now;
        if (what === 'close') p.close(W);
        else p.minimize(W);
        await p.run(4000);
        const after = p.samples.slice(i0);
        const landed = after.find(onFloor);
        expect(landed, 'landed on the floor').toBeDefined();
        expect(landed!.t - t0).toBeLessThanOrEqual(2000);
        expect(landed!.y).toBe(FLOOR_Y);
        // Controlled: continuous, never faster than a free fall, never attached to the gone window again.
        const m = motion([p.samples[i0 - 1]!, ...after]);
        expect(m.snaps).toBe(0);
        expect(m.maxSpeed).toBeLessThanOrEqual(FALL_MAX_SPEED * 1.02);
        expect(after.filter((s) => s.t > landed!.t && s.surfaceId !== null)).toEqual([]);
        // No stuck state: on the floor in the diagnostics, behaviour moves on, the host never failed.
        await p.run(60_000);
        const d = p.surfaceDiagnostics();
        expect(d.decision.support).toBe('floor');
        expect(d.nav.reachable.windowTop + d.nav.reachable.windowSide).toBe(0);
        expect(new Set(p.samples.slice(i0).map((s) => s.state)).size).toBeGreaterThanOrEqual(3);
        expect(p.samples.slice(i0).every((s) => s.visible)).toBe(true);
        expect(p.host.debug().tickErrors).toBe(0);
      });
    }
  }
});

describe('the user grabs the cat mid-leap and mid-climb', () => {
  it('a grab in mid-leap holds it; the drop lands it on the floor; it climbs again later', async () => {
    const p = pipeline(3);
    let leaps = p.surfaceDiagnostics().nav.climbs.leaps;
    const inLeap = await p.runUntil((s) => {
      if (s.state !== 'jumping') return false;
      const d = p.surfaceDiagnostics();
      return d.nav.climbs.leaps > leaps && d.decision.support === 'air';
    }, 10 * MIN);
    expect(inLeap, 'caught the cat in the air on its way to a side').not.toBeNull();
    leaps = p.surfaceDiagnostics().nav.climbs.leaps;
    const i0 = p.samples.length;
    p.grab();
    await p.run(100);
    expect(p.last.support).toBe('held');
    expect(p.surfaceDiagnostics().decision.support).toBe('held');
    await p.carry({ x: 900, y: 600 }, 400);
    expect(p.last.support).toBe('held');
    p.release({ x: 0, y: 0 });
    await p.run(3000);
    const after = p.samples.slice(i0);
    // It never caught the side after the grab, and came down on the floor.
    expect(after.some(sideOf(W))).toBe(false);
    expect(onFloor(p.last)).toBe(true);
    expect(p.last.y).toBe(FLOOR_Y);
    expect(p.surfaceDiagnostics().decision.support).toBe('floor');
    // Not stuck: a later trip up still works.
    expect(await p.runUntil(onTopOf(W), 15 * MIN)).not.toBeNull();
    expect(p.host.debug().tickErrors).toBe(0);
  });

  it('a grab mid-climb takes it off the side; a throw flies it to the floor; it climbs again later', async () => {
    const p = pipeline(3);
    const climbing = await p.runUntil((s) => sideOf(W)(s) && s.clip === 'climb' && s.y < 900, 10 * MIN);
    expect(climbing).not.toBeNull();
    const i0 = p.samples.length;
    p.grab();
    await p.run(100);
    expect(p.last.support).toBe('held');
    await p.carry({ x: 900, y: 600 }, 400);
    p.release({ x: 1400, y: -500 });
    await p.run(200);
    expect(p.last.support).toBe('air');
    await p.run(3000);
    const after = p.samples.slice(i0);
    expect(after.some(sideOf(W))).toBe(false);
    expect(onFloor(p.last)).toBe(true);
    expect(p.last.y).toBe(FLOOR_Y);
    // The throw kept it on screen.
    for (const s of after) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(1920);
    }
    expect(p.surfaceDiagnostics().decision.support).toBe('floor');
    expect(await p.runUntil(onTopOf(W), 15 * MIN)).not.toBeNull();
    expect(p.host.debug().tickErrors).toBe(0);
  });
});
