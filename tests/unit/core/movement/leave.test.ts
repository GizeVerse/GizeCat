// v1.2 leave options (ADR 0003 §2.3, §6.3): Mover.leaveOptions lists the ways off an elevated
// surface (jumpDown within H_max, climbDown, climbLeap with wall jumps, hop, walkOff) and offers
// the emergency hang-and-drop only when nothing else exists; Mover.leaveBy executes one.
import { describe, expect, it } from 'vitest';
import type { LeaveOption, MoverStep } from '../../../../src/core/movement';
import { MOVEMENT } from '../../../../src/core/movement';
import { BH, DEFAULT_LIMITS, env, FLOOR_Y, ledge, SINGLE, taskbar, topId } from './v12Fixtures';

const CFG = { ...DEFAULT_LIMITS, wallJumps: true } as const;

/** Window w (x 600..1400, top y) with sides; a joined top j on its left (same height); a top v just right of it. */
function onW(y = 600, cfg: object = CFG, opts: { walls?: boolean; neighbours?: boolean } = {}): ReturnType<typeof env> {
  const e = env(SINGLE, cfg, 0.45);
  e.walls = opts.walls ?? true;
  e.windows = { w: { x: 600, y, width: 800, height: FLOOR_Y - y } };
  if (opts.neighbours ?? true) e.extra = [ledge('windowTop:j', 'windowTop', 'j', y, 300, 600), ledge('windowTop:v', 'windowTop', 'v', y + 20, 1500, 1800)];
  e.step();
  e.placeOn(topId('w'), 1000, y);
  e.m.setGoal(null);
  e.step();
  return e;
}

function byKind(opts: LeaveOption[]): Record<string, LeaveOption[]> {
  const out: Record<string, LeaveOption[]> = {};
  for (const o of opts) (out[o.kind] ??= []).push(o);
  return out;
}

function run(e: ReturnType<typeof env>, maxMs = 40_000): MoverStep[] {
  const steps: MoverStep[] = [];
  e.until((r) => {
    steps.push(r);
    return r.goal === 'arrived' || r.goal === 'unreachable';
  }, maxMs);
  return steps;
}

describe('Mover.leaveOptions', () => {
  it('[] on the floor, on a taskbar and while not standing', () => {
    const e = env(SINGLE, CFG);
    expect(e.m.leaveOptions()).toEqual([]);
    const tb = env(SINGLE, CFG, 0.5);
    tb.extra = [taskbar('t', SINGLE.displays[0] as never, 900)];
    tb.step();
    tb.placeOn('taskbar:t', 900, 899);
    expect(tb.m.leaveOptions()).toEqual([]);
    const w = onW();
    expect(w.m.hop(w.now)).toBe(true);
    expect(w.m.leaveOptions()).toEqual([]);
  });

  it('lists every kind on a window top with sides, a joined top and a nearby top', () => {
    const e = onW();
    const k = byKind(e.m.leaveOptions());
    expect(Object.keys(k).sort()).toEqual(['climbDown', 'climbLeap', 'hop', 'jumpDown', 'walkOff']);
    for (const o of k.jumpDown ?? []) {
      expect(o).toMatchObject({ toKind: 'floor', toSurfaceId: null, emergency: false, impact: 'medium' });
      expect(o.dropDip).toBeCloseTo(FLOOR_Y - 600, 6);
      expect(o.risk).toBe(0);
    }
    expect(k.jumpDown).toHaveLength(2);
    expect(k.climbDown).toHaveLength(2);
    for (const o of k.climbDown ?? []) expect(o).toMatchObject({ toKind: 'floor', impact: null, risk: 0 });
    // climbLeap lands no harder than medium (its grip is at most min(H_safe, 0.8 h_hard) up, see leaveBy).
    for (const o of k.climbLeap ?? []) expect(o).toMatchObject({ toKind: 'floor', emergency: false, risk: 0 });
    for (const o of k.climbLeap ?? []) expect(o.impact).not.toBe('hard');
    expect(k.hop?.[0]).toMatchObject({ toKind: 'windowTop', toSurfaceId: 'windowTop:v', emergency: false });
    expect(k.walkOff?.[0]).toMatchObject({ toKind: 'windowTop', toSurfaceId: 'windowTop:j', impact: null, dropDip: 0 });
    for (const o of Object.values(k).flat()) {
      expect(o.effort).toBeGreaterThan(0);
      expect(o.risk).toBeGreaterThanOrEqual(0);
      expect(o.risk).toBeLessThanOrEqual(1);
      expect(o.emergency).toBe(false);
    }
  });

  it('no wall jumps without the flag; legs beyond H_max are left out (a side to climb down remains)', () => {
    const plain = onW(600, DEFAULT_LIMITS);
    expect(plain.m.leaveOptions().some((o) => o.kind === 'climbLeap')).toBe(false);
    const high = onW(300, CFG, { neighbours: false });
    const k = byKind(high.m.leaveOptions());
    expect(k.jumpDown).toBeUndefined();
    expect(k.climbDown?.length).toBe(2);
    for (const o of Object.values(k).flat()) expect(o.emergency).toBe(false);
  });

  it('a jump down between H_safe and H_max carries risk; within H_safe none', () => {
    const e = onW(FLOOR_Y - 560, CFG, { walls: false, neighbours: false });
    const o = e.m.leaveOptions().find((x) => x.kind === 'jumpDown');
    expect(o?.risk).toBeCloseTo((560 - 477) / (644 - 477), 6);
    expect(o?.impact).toBe('hard');
  });

  it('the emergency option only when nothing else exists: hang from the nearer end, then drop', () => {
    const e = onW(300, CFG, { walls: false, neighbours: false });
    const opts = e.m.leaveOptions();
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ kind: 'jumpDown', emergency: true, risk: 1, toKind: 'floor' });
    expect(opts[0]?.dropDip).toBeGreaterThan(MOVEMENT.jumpDownAbsoluteMaxDip - 200);
  });
});

describe('Mover.leaveBy', () => {
  it('jumpDown: walks to the end, jumps (jumpKind down) and lands on the floor as planned', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'jumpDown') as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    const steps = run(e);
    const landed = steps.find((s) => s.landed)?.landed;
    expect(landed).toMatchObject({ jumpKind: 'down', plannedOutcome: 'landed', intentional: true });
    expect(e.log.at(-1)?.goal).toBe('arrived');
    expect(e.m.y).toBe(FLOOR_Y);
    expect(Math.abs(e.m.x - o.target.x)).toBeLessThanOrEqual(3);
  });

  it('climbDown: swings onto the side and climbs to the floor', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'climbDown') as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    const steps = run(e);
    expect(steps.some((s) => s.climbStarted)).toBe(true);
    expect(steps.some((s) => s.tookOff)).toBe(false);
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('climbLeap: climbs part-way down the side, then a wall jump onto the floor', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'climbLeap') as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    const jump = { y: Number.NaN };
    const steps: MoverStep[] = [];
    e.until((r) => {
      steps.push(r);
      if (r.tookOff) jump.y = e.m.y;
      return r.goal === 'arrived';
    }, 60_000);
    expect(steps.some((s) => s.climbStarted)).toBe(true);
    expect(steps.find((s) => s.landed)?.landed).toMatchObject({ jumpKind: 'wallJump', plannedOutcome: 'landed' });
    expect(Number.isFinite(jump.y)).toBe(true);
    expect(FLOOR_Y - jump.y).toBeLessThanOrEqual(Math.min(477, 0.8 * 492.3) + 1);
    expect(FLOOR_Y - jump.y).toBeGreaterThan(0.5 * BH);
  });

  it('hop: jumps onto the nearby top', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'hop') as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    run(e);
    expect(e.m.support).toMatchObject({ surfaceId: 'windowTop:v' });
  });

  it('walkOff: walks across onto the joined top, no take-off', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'walkOff') as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    const steps = run(e);
    expect(steps.some((s) => s.tookOff || s.steppedOff)).toBe(false);
    expect(e.m.support).toMatchObject({ surfaceId: 'windowTop:j' });
  });

  it('emergency: hangs from the end (about one body height lower) and drops to the floor', () => {
    const e = onW(300, CFG, { walls: false, neighbours: false });
    const o = e.m.leaveOptions()[0] as LeaveOption;
    expect(e.m.leaveBy(o, 'walk')).toBe(true);
    let hangY = -Infinity;
    const steps: MoverStep[] = [];
    e.until((r) => {
      steps.push(r);
      if (e.m.mode === 'crouch') hangY = Math.max(hangY, e.m.y);
      return r.landed !== null;
    }, 30_000);
    expect(hangY).toBeGreaterThan(300 - 1 + 0.8 * BH);
    expect(steps.some((s) => s.steppedOff)).toBe(true);
    expect(e.m.y).toBe(FLOOR_Y);
  });

  it('false once the option no longer applies (its target gone)', () => {
    const e = onW();
    const o = e.m.leaveOptions().find((x) => x.kind === 'hop') as LeaveOption;
    e.extra = e.extra.filter((s) => s.id !== 'windowTop:v');
    e.step();
    expect(e.m.leaveBy(o, 'walk')).toBe(false);
    expect(e.m.leaveBy(null as never, 'walk')).toBe(false);
  });
});
