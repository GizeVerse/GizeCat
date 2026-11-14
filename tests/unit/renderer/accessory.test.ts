import { describe, expect, it } from 'vitest';
import { computeNecklace, createNecklaceGeom, drawNecklace } from '../../../src/renderer/overlay/cat/accessory';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { createPose, type Pose } from '../../../src/renderer/overlay/cat/pose';
import { Rig } from '../../../src/renderer/overlay/cat/rig';
import { isRenderState } from '../../../src/renderer/overlay/validate';
import type { CatRenderState } from '../../../src/shared/cat';

function solved(mut: (p: Pose) => void): { rig: Rig; p: Pose } {
  const p = createPose();
  mut(p);
  const rig = new Rig();
  rig.solve(p);
  return { rig, p };
}

/** Distance from (x, y) to the neck segment. */
function neckDist(rig: Rig, x: number, y: number): number {
  const dx = rig.nx1 - rig.nx0;
  const dy = rig.ny1 - rig.ny0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.min(1, Math.max(0, ((x - rig.nx0) * dx + (y - rig.ny0) * dy) / l2)) : 0;
  return Math.hypot(x - (rig.nx0 + dx * t), y - (rig.ny0 + dy * t));
}

function assertSane(rig: Rig, p: Pose, label: string): void {
  const g = createNecklaceGeom();
  computeNecklace(rig, p, g);
  expect(g.ok, label).toBe(true);
  for (const k of ['ax', 'ay', 'bx', 'by', 'qx', 'qy', 'sx', 'sy', 'hx', 'hy', 'hw', 'ang', 'dx', 'dy'] as const) {
    expect(Number.isFinite(g[k]), `${label} ${k}`).toBe(true);
  }
  expect(g.hw, label).toBeGreaterThan(2);
  expect(g.hw, label).toBeLessThan(5);
  // The collar sits on the neck, the pendant stays a bounded distance away.
  expect(neckDist(rig, (g.ax + g.bx) / 2, (g.ay + g.by) / 2), `${label} collar`).toBeLessThan(6);
  expect(neckDist(rig, g.hx, g.hy), `${label} pendant`).toBeLessThan(32);
  expect(Math.hypot(g.dx, g.dy), `${label} unit`).toBeCloseTo(1, 5);
  // The chain is at least the minimum drop long (collar centre to meeting point).
  const drop = Math.hypot(g.sx - (g.ax + g.bx) / 2, g.sy - (g.ay + g.by) / 2);
  expect(drop, `${label} min drop`).toBeGreaterThanOrEqual(4 - 1e-6);
  // Belly side: the pendant hangs along the torso's v axis side, unless gravity wins (belly away
  // from the ground), where it must hang world-down instead.
  const belly = g.dx * rig.sin + g.dy * rig.cos;
  const m = rig.m;
  const worldY = m[1]! * g.dx + m[3]! * g.dy;
  const worldLen = Math.hypot(m[0]! * g.dx + m[2]! * g.dy, worldY);
  expect(belly > 0.25 || worldY > 0.2 * worldLen, `${label} belly side or gravity`).toBe(true);
}

/** Heart centre in head-local space (rotated by the head frame, y axis (sin r, cos r)). */
function headLocal(rig: Rig, x: number, y: number): { lx: number; ly: number } {
  const dx = x - rig.headX;
  const dy = y - rig.headY;
  const c = Math.cos(rig.headRot);
  const s = Math.sin(rig.headRot);
  return { lx: dx * c - dy * s, ly: dx * s + dy * c };
}

describe('heart pendant in the real resting poses', () => {
  // Pose values mirror clips.ts (stand = defaults, sit, loaf, sleep).
  const sit = (q: Pose): void => {
    q.tilt = 0.98;
    q.bodyLen = 0.86;
    q.bodyH = 1.06;
    q.haunch = 1;
    q.bodyX = -6;
    q.bodyY = -16.5;
    q.headX = 7.5;
    q.headY = -44.5;
  };
  const loaf = (q: Pose): void => {
    q.bodyX = -3;
    q.bodyY = -12.5;
    q.bodyH = 1.02;
    q.curl = 0.22;
    q.haunch = 0.15;
    q.headX = 17;
    q.headY = -27;
    q.headRot = -0.04;
  };
  const sleep = (q: Pose): void => {
    loaf(q);
    q.curl = 1;
    q.bodyX = -5;
    q.bodyY = -10.5;
    q.bodyLen = 0.98;
    q.bodyH = 0.92;
    q.haunch = 0.75;
    q.headX = 12;
    q.headY = -16.5;
    q.headRot = -0.32;
  };
  const cases: Array<[string, (q: Pose) => void]> = [
    ['stand', () => {}],
    ['sit', sit],
    ['loaf', loaf],
    ['sleep', sleep],
  ];
  for (const [name, mut] of cases) {
    it(`${name}: finite, min drop, and the heart clears the head silhouette`, () => {
      const { rig, p } = solved(mut);
      assertSane(rig, p, name);
      const g = createNecklaceGeom();
      computeNecklace(rig, p, g);
      const dBase = Math.hypot(g.hx - rig.nx0, g.hy - rig.ny0);
      expect(dBase, `${name} heart from neck base`).toBeLessThan(30);
      // Heart centre outside the head ellipse: the pendant is not hidden by the head.
      const { lx, ly } = headLocal(rig, g.hx, g.hy);
      expect((lx / 17.4) ** 2 + (ly / 13.6) ** 2, `${name} outside head`).toBeGreaterThan(1);
    });
  }
});

describe('heart pendant attachment', () => {
  it('hangs world-down when rolled over with the head flipped', () => {
    const { rig, p } = solved((q) => {
      q.rollY = -1;
      q.headFlip = -1;
    });
    const g = createNecklaceGeom();
    computeNecklace(rig, p, g);
    const m = rig.m;
    expect(m[1]! * g.dx + m[3]! * g.dy).toBeGreaterThan(0.8);
  });

  it('is finite and on the belly side (or gravity-led) across a sweep of pose values', () => {
    const rnd = seededRandom(7);
    for (let i = 0; i < 400; i++) {
      const { rig, p } = solved((q) => {
        q.curl = rnd();
        q.arch = rnd() * 1.4 - 0.2;
        q.haunch = rnd();
        q.tilt = (rnd() - 0.5) * 3;
        q.bodyLen = 0.6 + rnd();
        q.bodyH = 0.6 + rnd();
        q.headX = (rnd() - 0.3) * 60;
        q.headY = (rnd() - 0.8) * 60;
        q.headRot = (rnd() - 0.5) * 2;
        q.headFlip = rnd() < 0.2 ? -1 : 1;
        q.rot = (rnd() - 0.5) * 6;
        q.rollY = rnd() < 0.2 ? -1 : 1;
        q.turnX = rnd() * 2 - 1;
      });
      assertSane(rig, p, `sweep ${i}`);
    }
  });

  it('does not produce NaN when the neck is degenerate', () => {
    const { rig, p } = solved(() => {});
    // Head exactly on the shoulder point: the neck capsule has zero length.
    p.headX = rig.nx0;
    p.headY = rig.ny0;
    rig.solve(p);
    assertSane(rig, p, 'zero neck');
    const g = createNecklaceGeom();
    rig.nx1 = rig.nx0;
    rig.ny1 = rig.ny0;
    rig.headX = rig.nx0;
    rig.headY = rig.ny0;
    computeNecklace(rig, p, g);
    expect(g.ok).toBe(true);
  });

  it('shortens and shrinks when curled and when the neck is short', () => {
    const open = solved(() => {});
    const curled = solved((q) => {
      q.curl = 1;
    });
    const a = createNecklaceGeom();
    const b = createNecklaceGeom();
    computeNecklace(open.rig, open.p, a);
    computeNecklace(curled.rig, curled.p, b);
    const dropA = Math.hypot(a.sx - (a.ax + a.bx) / 2, a.sy - (a.ay + a.by) / 2);
    const dropB = Math.hypot(b.sx - (b.ax + b.bx) / 2, b.sy - (b.ay + b.by) / 2);
    expect(dropB).toBeLessThan(dropA);
    expect(b.hw).toBeLessThanOrEqual(a.hw);
  });

  it('draws only with finite geometry and stays balanced on the context', () => {
    const { rig, p } = solved(() => {});
    const g = createNecklaceGeom();
    computeNecklace(rig, p, g);
    let depth = 0;
    let calls = 0;
    const target = {
      save: () => void depth++,
      restore: () => void depth--,
    } as Record<string, unknown>;
    const ctx = new Proxy(target, {
      get: (t, k: string) => (k in t ? t[k] : (): void => void calls++),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    drawNecklace(ctx, g, '#000', 1.6, 2);
    drawNecklace(ctx, g, '#000', 1.6, 0.4);
    expect(depth).toBe(0);
    expect(calls).toBeGreaterThan(10);
    calls = 0;
    g.ok = false;
    drawNecklace(ctx, g, '#000', 1.6, 2);
    expect(calls).toBe(0);
  });
});

function baseState(): Record<string, unknown> {
  const s: Partial<CatRenderState> = {
    seq: 1,
    t: 10,
    x: 5,
    y: 6,
    snap: false,
    scale: 1,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
  };
  return { ...s };
}

describe('render state accessory validation', () => {
  it('accepts an absent accessory and the literal heartPendant', () => {
    expect(isRenderState(baseState())).toBe(true);
    const s = { ...baseState(), accessory: 'heartPendant' };
    expect(isRenderState(s)).toBe(true);
    expect(s.accessory).toBe('heartPendant');
  });

  it('drops anything else without rejecting the frame', () => {
    const rnd = seededRandom(11);
    const junk: unknown[] = [null, 1, true, {}, [], 'q' + Math.floor(rnd() * 1e9).toString(16), 'HeartPendant', ''];
    for (const v of junk) {
      const s = { ...baseState(), accessory: v } as Record<string, unknown>;
      expect(isRenderState(s)).toBe(true);
      expect(s.accessory).toBeUndefined();
    }
  });
});
