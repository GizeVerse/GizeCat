// Regression tests for the v1.2 review findings on the behaviour side (SIMULATED: the real Sim and
// Mover through the Harness on the user's screen, synthetic input, OS mocked).
import { describe, expect, it } from 'vitest';
import { applyImpulse } from '../../../../src/core/behavior/drives';
import { STAY_LONELY_MIN_GAP_MS } from '../../../../src/core/behavior/stay';
import type { Drives } from '../../../../src/shared/catState';
import { defaultSettings, type Settings } from '../../../../src/shared/settings';
import type { CatSim } from '../../../../src/shared/sim';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import type { LeaveOption } from '../../../../src/core/movement';
import type { Rect } from '../../../../src/shared/geometry';
import type { Surface } from '../../../../src/shared/surfaces';
import type { DisplayGeometry } from '../../../../src/shared/world';
import type { ExcursionRecord } from '../../../../src/shared/behaviorProfile';
import { HOUR, MIN, runCell } from './bands';
import { callCat, Harness, onWindowTop, settingsWith, taskbar, WAKE_MS } from './fixtures';
import { USER_SCREEN } from './liveness';

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] as number) : -1;
};
const behavior = (b: Partial<Settings['behavior']>): Settings => settingsWith({ behavior: { ...defaultSettings().behavior, ...b } });
/** Holds a drive where a scenario wants it (white box: the drives are the sim's own). */
const drivesOf = (sim: CatSim): Drives => (sim as unknown as { cat: { drives: Drives } }).cat.drives;

describe('review BEH-1: the lonely leave is one-shot, not a cap on every stay (ADR 0003 §2.4)', () => {
  it('a need nobody relieves leaves stays their planned length: at most one cut per 20 min', () => {
    for (const seed of [11, 12]) {
      const r = runCell({ seed, hours: 2, layout: 'L1', user: 'active', drives: { socialNeed: 1 } });
      const ends = r.excursions.filter((e) => e.phase === 'end');
      const cut = ends.filter((e) => e.endReason === 'stimulus');
      expect(ends.length, `seed ${seed}: stays ended`).toBeGreaterThanOrEqual(4);
      expect(cut.length, `seed ${seed}: stays cut short`).toBeLessThanOrEqual(1 + r.simMs / STAY_LONELY_MIN_GAP_MS);
      // Saturated, the old rule cut every one of them at about 60 s (median 63-71 s against a planned 163-381 s).
      expect(median(ends.map((e) => e.dwellMs)), `seed ${seed}: median stay`).toBeGreaterThanOrEqual(90_000);
    }
  });

  it('fires once until the need has fallen below 0.7, then again', () => {
    const cuts = (rearm: boolean): number[] => {
      let first = -1;
      const r = runCell({ seed: 5, hours: 1.6, layout: 'L1', user: 'active', drives: { socialNeed: 1 } }, (h) => {
        if (first < 0) first = h.sim.behaviorProfile().recentStays.find((s) => s.endReason === 'stimulus')?.at ?? -1;
        // Saturated on a stay, high but not asking much down on the floor, and for a moment (a pet) 25 min after the first cut when `rearm`.
        const up = h.last?.support.kind === 'surface' && (h.last.support.surfaceKind === 'windowTop' || h.last.support.surfaceKind === 'tabStrip');
        drivesOf(h.sim).socialNeed = rearm && first >= 0 && h.now > first + 25 * MIN && h.now < first + 25 * MIN + 5000 ? 0.6 : up ? 1 : 0.75;
      });
      expect(r.excursions.filter((e) => e.phase === 'arrive').length).toBeGreaterThanOrEqual(4);
      return r.excursions.filter((e) => e.phase === 'end' && e.endReason === 'stimulus').map((e) => e.at);
    };
    expect(cuts(false)).toHaveLength(1);
    const again = cuts(true);
    expect(again.length).toBeGreaterThanOrEqual(2);
    expect((again[1] as number) - (again[0] as number)).toBeGreaterThanOrEqual(STAY_LONELY_MIN_GAP_MS);
  });

  it('the cut-short stay ends in asking for attention, and an unanswered request relieves the need', () => {
    const r = runCell({ seed: 11, hours: 1, layout: 'L1', user: 'active', drives: { socialNeed: 1 } });
    const cut = r.excursions.find((e) => e.phase === 'end' && e.endReason === 'stimulus');
    expect(cut, 'one stay cut short').toBeDefined();
    const at = (cut as { at: number }).at;
    expect(r.harness.transitions.filter((t) => t.at >= at && t.at <= at + 30_000).map((t) => t.to)).toContain('seekingAttention');
    const d = { socialNeed: 1, mischief: 0.3 } as Drives;
    applyImpulse(d, 'attentionIgnored');
    expect(d.socialNeed).toBeCloseTo(0.8, 6);
    expect(d.mischief).toBeCloseTo(0.45, 6);
  });

  it("'Attention seeking' at 0 is an exit: no stay is cut short for company", () => {
    const r = runCell({ seed: 11, hours: 1.5, layout: 'L1', user: 'active', drives: { socialNeed: 1 }, settings: behavior({ attentionSeeking: 0 }) });
    const ends = r.excursions.filter((e) => e.phase === 'end');
    expect(ends.length).toBeGreaterThanOrEqual(3);
    expect(ends.filter((e) => e.endReason === 'stimulus')).toEqual([]);
  });
});

const WALL = 1_800_000_000_000;

/** The cat on window a's top (a call gets it there), with the given windows and settings. */
function perched(seed: number, windows: Record<string, Rect>, settings?: Settings, extra: Surface[] = []): { h: Harness; ex: ExcursionRecord[] } {
  const ex: ExcursionRecord[] = [];
  const cat = newPersistedCat(mulberry32(seed), WALL - HOUR);
  Object.assign(cat.traits, { confidence: 0.5, laziness: 0.4 });
  const h = new Harness({ seed, world: USER_SCREEN, persisted: cat, wall: WALL, ...(settings ? { settings } : {}), hooks: { onExcursion: (r) => ex.push(r) } });
  h.env.windows = windows;
  h.env.extraSurfaces = extra;
  h.env.cursor = { x: 1880, y: 100, speed: 0 };
  h.run(WAKE_MS, 50);
  const a = windows.a as Rect;
  callCat(h, { x: a.x + a.width / 2, y: a.y - 60 }, 50);
  h.runUntil((o) => onWindowTop(o.support), 60_000, 50);
  return { h, ex };
}
const run = (h: Harness, ms: number, each?: (t: number) => void): void => {
  let t = 0;
  h.run(ms, 50, (hh) => {
    t += 50;
    hh.env.userIdleMs = t % 5000;
    each?.(t);
    return [];
  });
};

describe('review BEH-2: a top whose only listed way off is switched off', () => {
  const windows = { a: { x: 300, y: 760, width: 600, height: 400 }, b: { x: 960, y: 760, width: 540, height: 400 } };
  const endsWithin = (seed: number, s: Settings, w: Record<string, Rect>, extra: Surface[], listed: (o: LeaveOption[]) => void): void => {
    const { h, ex } = perched(seed, w, s, extra);
    expect(ex.filter((e) => e.phase === 'arrive').length, `seed ${seed}: up there`).toBeGreaterThanOrEqual(1);
    // A real list, as the Mover gives it (never hand-built): what it holds is the point of the scenario.
    listed((h.sim as unknown as { mover: { leaveOptions(): LeaveOption[] } }).mover.leaveOptions());
    run(h, 35 * MIN);
    const end = ex.find((e) => e.phase === 'end');
    expect(end, `seed ${seed}: stay ended`).toMatchObject({ endReason: 'leave', leaveKind: 'jumpDown' });
    expect((end as ExcursionRecord).dwellMs).toBeLessThanOrEqual(30 * MIN + 60_000);
  };

  it('hops off and a drop above H_max: the Mover has nothing else to list, the stay ends by the emergency drop', () => {
    for (const seed of [1, 2, 3]) {
      endsWithin(seed, behavior({ heights: 0, disabledBehaviors: ['climbWindows'], disabledExtras: ['surfaceHops'] }), windows, [], (o) => {
        expect(o.map((x) => x.emergency)).toEqual([true]);
      });
    }
  });

  it('only a landing on the taskbar listed, Taskbar play off: the opt-out rules it out after the listing, and the rescue still gets it off', () => {
    // The taskbar within H_max (about 370 px down at heights 0), the floor just beyond it.
    const bar = taskbar('t', USER_SCREEN.displays[0] as DisplayGeometry, 1150);
    const low = { a: { x: 300, y: 789, width: 600, height: 360 } };
    for (const seed of [1, 2]) {
      endsWithin(seed, behavior({ heights: 0, disabledBehaviors: ['climbWindows', 'taskbarPlay'] }), low, [bar], (o) => {
        expect(o.length).toBeGreaterThan(0);
        for (const x of o) expect(x).toMatchObject({ emergency: false, toKind: 'taskbar' });
      });
    }
  });
});

describe('review BEH-3: Jump between windows off', () => {
  it('the cat goes from one window top to another neither directly nor by a route', () => {
    const noHops = behavior({ disabledBehaviors: ['climbWindows'], disabledExtras: ['surfaceHops'], exploration: 1 });
    for (const seed of [1, 2]) {
      const cat = newPersistedCat(mulberry32(seed), WALL - HOUR);
      cat.drives.exploreNeed = 0.9;
      const h = new Harness({ seed, world: USER_SCREEN, settings: noHops, persisted: cat, wall: WALL });
      // a is a jump up from the floor, b a jump up from a (and a jump down onto it).
      h.env.windows = { b: { x: 550, y: 750, width: 950, height: 400 }, a: { x: 100, y: 1000, width: 500, height: 190 } };
      const seq: string[] = [];
      h.env.cursor = { x: 1800, y: 100, speed: 0 };
      run(h, HOUR, () => {
        const sup = h.last?.support;
        const k = sup?.kind === 'surface' ? sup.surfaceId : (sup?.kind ?? '?');
        if (k !== 'air' && seq[seq.length - 1] !== k) seq.push(k);
      });
      for (let i = 0; i + 1 < seq.length; i++) expect(`${seq[i]}>${seq[i + 1]}`, `seed ${seed}`).not.toMatch(/^windowTop:\w+>windowTop:/);
      expect(seq.some((k) => k.startsWith('windowTop:')), `seed ${seed}: it still goes up`).toBe(true);
    }
  });
});

describe('review BEH-8, PHYS-5: failed leaves (ADR 0003 §2.3)', () => {
  const stubLeave = (h: Harness, refuse: (o: LeaveOption) => boolean): { refused: () => number } => {
    const m = (h.sim as unknown as { mover: { leaveBy(o: LeaveOption, p: string): boolean } }).mover;
    const real = m.leaveBy.bind(m);
    let n = 0;
    m.leaveBy = (o, p) => {
      if (refuse(o)) {
        n++;
        return false;
      }
      return real(o, p);
    };
    return { refused: () => n };
  };
  const stayOf = (h: Harness): { plannedMs: number } | null => (h.sim as unknown as { stay: { plannedMs: number } | null }).stay;

  it('three refusals: the next attempt uses the working options at once, with no lock-out and no emergency drop', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { h, ex } = perched(seed, { a: { x: 500, y: 760, width: 800, height: 400 } });
      (stayOf(h) as { plannedMs: number }).plannedMs = 0;
      let count = 0;
      const s = stubLeave(h, () => ++count <= 3);
      let refusalsDone = -1;
      let left = -1;
      run(h, 3 * MIN, (t) => {
        if (s.refused() >= 3 && refusalsDone < 0) refusalsDone = t;
        if (left < 0 && stayOf(h) === null) left = t;
      });
      expect(left, `seed ${seed}: left`).toBeGreaterThan(0);
      // The old lock-out cost 26-38 s after the last refusal: now the backoff at most, the walk to the take-off and a short dwell.
      expect(left - refusalsDone, `seed ${seed}: ms from the last refusal`).toBeLessThan(25_000);
      const end = ex.find((e) => e.phase === 'end');
      expect(end?.endReason, `seed ${seed}`).toBe('leave');
      expect(end?.overdue, `seed ${seed}`).toBeUndefined();
    }
  });

  it('the listed ways keep failing: once overdue, the emergency option is the safety net', () => {
    for (const seed of [1, 2]) {
      const { h, ex } = perched(seed, { a: { x: 500, y: 760, width: 800, height: 400 } });
      (stayOf(h) as { plannedMs: number }).plannedMs = 0;
      const taken: boolean[] = [];
      stubLeave(h, (o) => {
        taken.push(o.emergency);
        return !o.emergency;
      });
      run(h, 5 * MIN);
      expect(taken, `seed ${seed}`).toContain(false);
      expect(taken, `seed ${seed}`).toContain(true);
      const end = ex.find((e) => e.phase === 'end');
      expect(end, `seed ${seed}: left`).toMatchObject({ endReason: 'leave', leaveKind: 'jumpDown', overdue: true });
    }
  });
});

describe('review BEH-4 (band B16): the Attention seeking slider bounds the requests', () => {
  const requests = (att: number): number => {
    let n = 0;
    for (const seed of [31, 32, 33]) {
      const r = runCell({ seed, hours: 1.5, layout: 'L1', user: 'active', drives: { socialNeed: 1 }, settings: behavior({ attentionSeeking: att }) }, (h) => {
        // Saturated all along: the slider, not the need, has to tell them apart.
        drivesOf(h.sim).socialNeed = 1;
      });
      n += r.decisions.filter((d) => d.state === 'seekingAttention' && d.variant !== 'greet').length;
    }
    return n;
  };

  it('requests per hour rise with the slider with the need saturated, and stop at 0', () => {
    const low = requests(0.05);
    const mid = requests(0.35);
    const high = requests(1);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(requests(0)).toBe(0);
    // At 5 % it rarely asks: at most the quiet gap's 2.4 an hour, over 3 x 1.5 sim-h.
    expect(low).toBeLessThanOrEqual(11);
  });

  it('ignoring it teaches it: a cat whose requests went unanswered asks less', () => {
    const count = (acceptance: number): number => {
      let n = 0;
      for (const seed of [31, 32, 33]) {
        const r = runCell({ seed, hours: 1.5, layout: 'L1', user: 'active', drives: { socialNeed: 1 } }, (h) => {
          const c = h.sim as unknown as { cat: { drives: Drives; memory: { preferences: { attentionAcceptance: number } } } };
          c.cat.drives.socialNeed = 1;
          c.cat.memory.preferences.attentionAcceptance = acceptance;
        });
        n += r.decisions.filter((d) => d.state === 'seekingAttention' && d.variant !== 'greet').length;
      }
      return n;
    };
    expect(count(0)).toBeLessThan(count(1));
  });
});
