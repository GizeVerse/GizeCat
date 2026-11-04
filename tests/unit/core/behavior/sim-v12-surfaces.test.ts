// BEH-b on the real Mover (ADR 0003 §2-§3, §6): the settings mapped onto the Mover's flags, screen edges
// and their guard, the leave intent, the bail-out with the resume token, slips, landing clips, render hints
// and what the cat does up there. SIMULATED: the real sim and Mover with an injected environment.
import { describe, expect, it } from 'vitest';
import type { EdgeVisitRecord, ExcursionRecord, SlipRecord } from '../../../../src/shared/behaviorProfile';
import { PHYSICS_ERROR_CAUSES } from '../../../../src/shared/behaviorProfile';
import type { Traits } from '../../../../src/shared/catState';
import type { ScreenEdgeBand } from '../../../../src/shared/surfaces';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { STAY_OVERDUE_MS } from '../../../../src/core/behavior/stay';
import { callCat, Harness, ledge, onWindowTop, settingsWith, stripId, tabStrip, WAKE_MS } from './fixtures';

const MIN = 60_000;
const WALL = 1_800_000_000_000;
const BW = 84;
const BH = 64;
const FLOOR = 1040;
const clearBands = (): ScreenEdgeBand[] => [
  { displayId: '1', side: 'left', clearSpans: [{ y0: 0, y1: 1080 }] },
  { displayId: '1', side: 'right', clearSpans: [{ y0: 0, y1: 1080 }] },
];
const catWith = (seed: number, traits: Partial<Traits> = {}) => {
  const cat = newPersistedCat(mulberry32(seed), WALL - 3600_000);
  Object.assign(cat.traits, traits);
  return cat;
};
const onEdge = (h: Harness): boolean => {
  const s = h.last!.support;
  return s.kind === 'surface' && s.surfaceKind === 'screenEdge';
};
/** Keeps the user around without the cursor near the band. */
const present = (h: Harness, i: number, x = 960): void => {
  h.env.userIdleMs = i % 50 === 0 ? 0 : (h.env.userIdleMs ?? 0) + 100;
  h.env.cursor = { x, y: 300, speed: 0 };
};

describe('screen edges (ADR 0003 §6.1)', () => {
  function run(seed: number, ms: number, bands: ScreenEdgeBand[] | undefined, opts: { disabledExtras?: string[]; cursorX?: number } = {}): { visits: EdgeVisitRecord[]; h: Harness; samples: Array<{ t: number; y: number }> } {
    const visits: EdgeVisitRecord[] = [];
    const h = new Harness({ seed, persisted: catWith(seed), settings: settingsWith({ behavior: { disabledExtras: opts.disabledExtras ?? [] } }), hooks: { onEdgeVisit: (r) => visits.push(r) } });
    if (bands) h.env.edgeBands = bands;
    const samples: Array<{ t: number; y: number }> = [];
    h.run(ms, 100, (hh, i) => {
      present(hh, i, opts.cursorX);
      if (onEdge(hh)) samples.push({ t: hh.now, y: hh.last!.y });
    });
    return { visits, h, samples };
  }

  it('fail closed: without env.edgeBands, or a band for that edge, or with the setting off: never on an edge', () => {
    for (const seed of [1, 2]) {
      expect(run(seed, 40 * MIN, undefined).samples).toEqual([]);
      expect(run(seed, 40 * MIN, clearBands(), { disabledExtras: ['screenEdges'] }).samples).toEqual([]);
      expect(run(seed, 40 * MIN, []).samples).toEqual([]);
    }
  }, 120_000);

  it('over a visible desktop: full climbs up the right edge with a top hold of 3-12 s, a low peek on the left', () => {
    const visits: EdgeVisitRecord[] = [];
    for (const seed of [1, 2, 3]) visits.push(...run(seed, 60 * MIN, clearBands()).visits);
    const full = visits.filter((v) => v.side === 'right');
    expect(full.length).toBeGreaterThanOrEqual(3);
    for (const v of full) {
      expect(v.covered).toBe(false);
      if (v.leave === 'drag') continue;
      expect(v.topReached).toBe(true);
      expect(v.holdMs).toBeGreaterThanOrEqual(2500);
      expect(v.holdMs).toBeLessThanOrEqual(20_000);
    }
    for (const v of visits.filter((x) => x.side === 'left')) expect(v.topReached).toBe(false);
  }, 120_000);

  it('a covered band gets peeks only: at most 2 body heights high, at most 8 s, at most 4 per hour', () => {
    const covered: ScreenEdgeBand[] = [
      { displayId: '1', side: 'left', clearSpans: [] },
      { displayId: '1', side: 'right', clearSpans: [] },
    ];
    let peeks = 0;
    for (const seed of [1, 2, 3, 4]) {
      const r = run(seed, 60 * MIN, covered);
      expect(r.visits.length).toBeLessThanOrEqual(4);
      peeks += r.visits.length;
      for (const v of r.visits) {
        expect(v.covered).toBe(true);
        expect(v.topReached).toBe(false);
      }
      let start = -1;
      let prev = -1;
      for (const s of r.samples) {
        if (s.t - prev > 500) start = s.t;
        prev = s.t;
        expect(FLOOR - s.y).toBeLessThanOrEqual(2 * BH * 1.05);
        expect(s.t - start).toBeLessThanOrEqual(8000);
      }
    }
    expect(peeks).toBeGreaterThan(0);
  }, 120_000);

  it('with a maximized window in front the left edge is preferred (scrollbars are on the right)', () => {
    const covered: ScreenEdgeBand[] = [
      { displayId: '1', side: 'left', clearSpans: [] },
      { displayId: '1', side: 'right', clearSpans: [] },
    ];
    const sides: string[] = [];
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, persisted: catWith(seed), hooks: { onEdgeVisit: (r) => sides.push(r.side) } });
      h.env.edgeBands = covered;
      h.env.foreground = { id: 'max', rect: { x: 0, y: 0, width: 1920, height: 1040 }, processName: 'app.exe', category: 'code', minimized: false, maximized: true, fullscreen: false, excluded: false };
      h.run(60 * MIN, 100, (hh, i) => present(hh, i));
    }
    expect(sides.length).toBeGreaterThan(0);
    expect(new Set(sides)).toEqual(new Set(['left']));
  }, 120_000);

  it('no peek with the cursor within 6 bw of the band (the only band offered)', () => {
    const left: ScreenEdgeBand[] = [{ displayId: '1', side: 'left', clearSpans: [] }];
    for (const seed of [1, 2, 3]) expect(run(seed, 40 * MIN, left, { cursorX: 4 * BW }).samples).toEqual([]);
  }, 120_000);

  it.each([
    ['removed', (h: Harness): void => void delete h.env.edgeBands],
    ['emptied', (h: Harness): void => void (h.env.edgeBands = [])],
    ['the setting off', (h: Harness): void => h.sim.updateSettings(settingsWith({ behavior: { disabledExtras: ['screenEdges'] } }))],
  ] as const)('edge bands %s mid-climb: the cat comes down by itself, no physics fall, no stuck reset', (_name, vanish) => {
    let tested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const falls: string[] = [];
      const resets: string[] = [];
      const h = new Harness({ seed, persisted: catWith(seed), hooks: { onFall: (r) => falls.push(r.cause), onDecision: (r) => void (r.cause === 'watchdog' && resets.push(r.state)) } });
      h.env.edgeBands = clearBands();
      let i = 0;
      const up = h.runUntil(() => {
        present(h, i++);
        return onEdge(h) && FLOOR - h.last!.y > BH;
      }, 60 * MIN, 100);
      if (!up) continue;
      tested++;
      vanish(h);
      // Everything that could leave it hanging: the hold's cap, the climb down, a grace for what it does next.
      const down = h.runUntil(() => {
        present(h, i++);
        return !onEdge(h) && h.last!.support.kind === 'floor';
      }, 40_000, 100);
      expect(down, `seed ${seed}: back on the floor`).toBe(true);
      // ... and it does not go back up.
      h.run(3 * MIN, 100, (hh) => {
        present(hh, i++);
        expect(onEdge(hh), `seed ${seed}: on the edge again`).toBe(false);
      });
      expect(falls.filter((c) => PHYSICS_ERROR_CAUSES.has(c as never))).toEqual([]);
      expect(resets).toEqual([]);
    }
    expect(tested).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('the cat climbs down when the cursor comes within 2 bw', () => {
    let tested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, persisted: catWith(seed) });
      h.env.edgeBands = clearBands();
      let i = 0;
      const up = h.runUntil(() => {
        present(h, i++);
        return onEdge(h) && h.last!.y < FLOOR - 4 * BH;
      }, 60 * MIN, 100);
      if (!up) continue;
      tested++;
      const y0 = h.last!.y;
      h.env.cursor = { x: h.last!.x - BW, y: y0, speed: 0 };
      h.run(4000, 100);
      expect(onEdge(h)).toBe(true);
      expect(h.last!.y).toBeGreaterThan(y0 + 20);
    }
    expect(tested).toBeGreaterThanOrEqual(3);
  }, 120_000);

  // REAL E2E (INT-b): a cursor arriving during the 320 ms mount found no way off yet (leave options exist only
  // once the cat clings), so the cat went on up and sat out the 20 s hold cap: 24.4 s on the wall in 2 runs of 6.
  it('a cursor that comes close while the cat is still mounting the wall does not leave it hanging there', () => {
    let tested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, persisted: catWith(seed) });
      h.env.edgeBands = clearBands();
      let i = 0;
      const mounting = h.runUntil(() => {
        present(h, i++);
        return onEdge(h);
      }, 60 * MIN, 33);
      if (!mounting) continue;
      expect(FLOOR - h.last!.y, `seed ${seed}: the first tick on the wall is still at its foot`).toBeLessThan(BH);
      tested++;
      h.env.cursor = { x: h.last!.x - BW, y: h.last!.y, speed: 0 };
      const off = h.runUntil(() => !onEdge(h), 6000, 33);
      expect(off, `seed ${seed}: off the wall within 6 s`).toBe(true);
    }
    expect(tested).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('typing that starts during the mount lets it down as well', () => {
    let tested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, persisted: catWith(seed) });
      h.env.edgeBands = clearBands();
      let i = 0;
      const mounting = h.runUntil(() => {
        present(h, i++);
        return onEdge(h);
      }, 60 * MIN, 33);
      if (!mounting) continue;
      tested++;
      h.env.typing = true;
      const off = h.runUntil(() => !onEdge(h), 6000, 33);
      expect(off, `seed ${seed}: off the wall within 6 s`).toBe(true);
    }
    expect(tested).toBeGreaterThanOrEqual(3);
  }, 120_000);
});

describe('the leave intent (ADR 0003 §2.3)', () => {
  /** Two floating windows the floor and each other can reach: climbs, jumps and hops are all possible. */
  const WINDOWS = { a: { x: 400, y: 700, width: 400, height: 340 }, b: { x: 880, y: 620, width: 500, height: 420 } };

  it('every own stay ends through one decision over the Mover options; the departures vary', () => {
    const ends: ExcursionRecord[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, persisted: catWith(seed), hooks: { onExcursion: (r) => void (r.phase === 'end' && ends.push(r)) } });
      h.env.windows = WINDOWS;
      h.run(90 * MIN, 100, (hh, i) => present(hh, i));
    }
    const own = ends.filter((e) => e.endReason === 'leave');
    expect(own.length).toBeGreaterThanOrEqual(15);
    for (const e of own) {
      expect(e.leaveKind).not.toBeNull();
      expect(e.dwellMs).toBeGreaterThanOrEqual(e.plannedMs - 2000);
    }
    const kinds = new Map<string, number>();
    for (const e of own) kinds.set(e.leaveKind as string, (kinds.get(e.leaveKind as string) ?? 0) + 1);
    expect(kinds.size).toBeGreaterThanOrEqual(3);
    for (const n of kinds.values()) expect(n / own.length).toBeLessThanOrEqual(0.75);
  }, 180_000);

  it('a hop to another window needs surfaceHops', () => {
    const ends: ExcursionRecord[] = [];
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, persisted: catWith(seed), settings: settingsWith({ behavior: { disabledExtras: ['surfaceHops'] } }), hooks: { onExcursion: (r) => void (r.phase === 'end' && ends.push(r)) } });
      h.env.windows = WINDOWS;
      h.run(60 * MIN, 100, (hh, i) => present(hh, i));
    }
    expect(ends.filter((e) => e.endReason === 'leave').length).toBeGreaterThan(0);
    expect(ends.some((e) => e.leaveKind === 'hop')).toBe(false);
  }, 120_000);

  it('a strong social need ends a stay early, at least 60 s in, as a stimulus (imposed, so censored in B3)', () => {
    const ends: ExcursionRecord[] = [];
    const h = new Harness({ seed: 8, persisted: catWith(8), settings: settingsWith({ behavior: { stayLength: 1 } }), hooks: { onExcursion: (r) => void (r.phase === 'end' && ends.push(r)) } });
    h.env.windows = { w: { x: 600, y: 760, width: 700, height: 280 } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w'), 40_000)).toBe(true);
    // The need rose by itself over hours in real life: set here (protected state), kept up as the stay goes on.
    const drives = (h.sim as unknown as { cat: { drives: { socialNeed: number } } }).cat.drives;
    expect(h.runUntil(() => {
      drives.socialNeed = 0.97;
      return ends.length > 0;
    }, 5 * MIN, 100)).toBe(true);
    expect(ends[0]!.dwellMs).toBeGreaterThanOrEqual(58_000);
    if (ends[0]!.dwellMs < ends[0]!.plannedMs - 2000) expect(ends[0]!.endReason).toBe('stimulus');
  });

  it('a stay is deferred while the cat is being petted', () => {
    const h = new Harness({ seed: 3, persisted: catWith(3, { laziness: 0.1 }), hooks: {} });
    h.env.windows = { w: { x: 600, y: 760, width: 700, height: 280 } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    h.run(45 * MIN, 100, (hh) => {
      const o = hh.last!;
      if (onWindowTop(o.support, 'w')) return [{ type: 'pointer.pet' as const, at: { x: o.x, y: o.y - 30 }, strength: 1 }];
      return [];
    });
    // Stroked all along: never away for good, the leave keeps being put off.
    expect(onWindowTop(h.last!.support, 'w')).toBe(true);
  }, 120_000);
});

describe('covered and vanished supports (ADR 0003 §2.4, §3)', () => {
  const RECT = { x: 600, y: 760, width: 700, height: 280 };
  function perched(seed: number, records: ExcursionRecord[]): Harness {
    const h = new Harness({ seed, persisted: catWith(seed), hooks: { onExcursion: (r) => records.push(r) } });
    h.env.windows = { w: { ...RECT } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    return h;
  }

  it('a vanished window: the stay ends gone with its bail-out, calm, and no fall is recorded', () => {
    const falls: unknown[] = [];
    const records: ExcursionRecord[] = [];
    const h = new Harness({ seed: 5, persisted: catWith(5), hooks: { onExcursion: (r) => records.push(r), onFall: (f) => falls.push(f) } });
    h.env.windows = { w: { ...RECT } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    const fear0 = h.sim.serialize().stats.fear;
    h.env.windows = {};
    h.run(4000);
    const end = records.find((r) => r.phase === 'end');
    expect(end).toMatchObject({ endReason: 'gone', leaveKind: null });
    expect(end?.bailOut).toBeTruthy();
    expect(falls).toEqual([]);
    expect(h.sim.serialize().stats.fear).toBeLessThanOrEqual(fear0 + 1e-6);
    expect(h.last!.support.kind).toBe('floor');
  });

  it('flight with no room up there: it leaves within the safe height, the stay ends stimulus (ADR 0003 §5.2)', () => {
    const records: ExcursionRecord[] = [];
    const falls: unknown[] = [];
    const h = new Harness({ seed: 5, persisted: catWith(5), hooks: { onExcursion: (r) => records.push(r), onFall: (f) => falls.push(f) } });
    // A window top barely wider than the cat, low enough to get down from: nowhere to run along it.
    h.env.windows = { w: { x: 900, y: 800, width: 2.2 * BW, height: 240 } };
    h.run(WAKE_MS);
    callCat(h, { x: 900 + 1.1 * BW, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    const inner = h.sim as unknown as { reactionFollowUp(kind: 'flight'): { state: string; init: { variant?: string } }; finish(next: unknown): void; leaveHistory: unknown[] };
    h.env.cursor = { x: 900 + 1.1 * BW, y: 780, speed: 0 };
    const next = inner.reactionFollowUp('flight');
    expect(next).toMatchObject({ state: 'walking', init: { variant: 'leave' } });
    inner.finish(next);
    expect(h.runUntil((o) => !onWindowTop(o.support, 'w') && o.support.kind === 'floor', 15_000)).toBe(true);
    const end = records.find((r) => r.phase === 'end');
    expect(end).toMatchObject({ endReason: 'stimulus' });
    expect(falls).toEqual([]);
  });

  it('a stay long past its plan says so when it ends; one that kept to it does not', () => {
    const ends = (lateMs: number): ExcursionRecord | undefined => {
      const records: ExcursionRecord[] = [];
      const h = new Harness({ seed: 6, persisted: catWith(6), hooks: { onExcursion: (r) => records.push(r) } });
      h.env.windows = { w: { x: 700, y: 700, width: 6 * BW, height: 340 } };
      h.run(WAKE_MS);
      callCat(h, { x: 700 + 3 * BW, y: 600 });
      expect(h.runUntil((o) => onWindowTop(o.support, 'w'), 30_000)).toBe(true);
      // A plan already used up and a leave put off for as long as the test wants.
      const st = (h.sim as unknown as { stay: { plannedMs: number; since: number; nextLeaveAt: number } }).stay;
      st.plannedMs = 1000;
      st.nextLeaveAt = h.now + lateMs + 1000;
      h.run(lateMs, 100, (hh) => present(hh, 1));
      h.env.windows = {};
      h.run(3000);
      return records.find((r) => r.phase === 'end');
    };
    expect(ends(STAY_OVERDUE_MS + 5000)?.overdue).toBe(true);
    expect(ends(5000)?.overdue).toBeUndefined();
  });

  it('flight with room: it runs along the surface, the stay goes on', () => {
    const h = new Harness({ seed: 5, persisted: catWith(5) });
    h.env.windows = { w: { ...RECT } };
    h.run(WAKE_MS);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w') && o.state === 'idle', 30_000)).toBe(true);
    const inner = h.sim as unknown as { reactionFollowUp(kind: 'flight'): { state: string; init: { variant?: string } } };
    expect(inner.reactionFollowUp('flight')).toMatchObject({ state: 'running', init: { variant: 'flight' } });
  });

  it('the resume token: the surface back within 3 min gets the rest of the planned time (at least 60 s), marked resumed', () => {
    const records: ExcursionRecord[] = [];
    const h = perched(6, records);
    const planned = records[0]!.plannedMs;
    h.env.windows = {};
    h.run(4000);
    h.env.windows = { w: { ...RECT } };
    h.run(1000);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w'), 30_000)).toBe(true);
    h.step();
    const again = records.filter((r) => r.phase === 'arrive')[1]!;
    expect(again.resumed).toBe(true);
    expect(again.plannedMs).toBeGreaterThanOrEqual(Math.min(60_000, planned));
  });

  it('after 3 min the token is gone', () => {
    const records: ExcursionRecord[] = [];
    const h = perched(6, records);
    h.env.windows = {};
    h.run(4 * MIN, 100);
    h.env.windows = { w: { ...RECT } };
    h.run(1000);
    callCat(h, { x: 950, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support, 'w'), 30_000)).toBe(true);
    h.step();
    expect(records.filter((r) => r.phase === 'arrive')[1]!.resumed).toBeUndefined();
  });
});

describe('deliberate slips (ADR 0003 §6.6)', () => {
  const trips = (disabledExtras: string[]): { slips: SlipRecord[]; clips: Set<string> } => {
    const slips: SlipRecord[] = [];
    const clips = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, persisted: catWith(seed, { confidence: 0.12, curiosity: 0.9, laziness: 0.12 }), settings: settingsWith({ behavior: { stayLength: 0, disabledExtras } }), hooks: { onSlip: (r) => slips.push(r) } });
      h.env.windows = { a: { x: 400, y: 700, width: 400, height: 340 }, b: { x: 880, y: 620, width: 500, height: 420 } };
      h.run(60 * MIN, 66, (hh, i) => {
        present(hh, i);
        clips.add(hh.last!.clip);
      });
    }
    return { slips, clips };
  };

  it('a timid cat slips now and then, and recovers; the scramble plays its clip; the switch turns them off', () => {
    const on = trips([]);
    expect(on.slips.length).toBeGreaterThan(0);
    for (const s of on.slips) {
      expect(s.risk).toBeGreaterThanOrEqual(0);
      expect(s.risk).toBeLessThanOrEqual(1);
    }
    if (on.slips.some((s) => s.kind === 'scramble')) expect(on.clips.has('slip')).toBe(true);
    expect(trips(['slips']).slips).toEqual([]);
  }, 180_000);
});

describe('landings and render hints (ADR 0003 §6.2, §6.4)', () => {
  function drop(y: number): { clips: string[]; impact: number; sounds: string[] } {
    const h = new Harness({ seed: 4, settings: settingsWith({ sound: { enabled: true } }) });
    h.run(WAKE_MS);
    const o0 = h.last!;
    h.step([{ type: 'pointer.dragStart', at: { x: o0.x, y: o0.y - 30 } }]);
    h.env.dragCursor = { x: 900, y };
    h.step();
    h.step([{ type: 'pointer.dragEnd', at: { x: 900, y }, velocity: { x: 0, y: 0 } }]);
    h.env.dragCursor = null;
    const clips: string[] = [];
    let impact = 0;
    const sounds: string[] = [];
    h.run(4000, 33, (hh) => {
      if (clips.at(-1) !== hh.last!.clip) clips.push(hh.last!.clip);
      impact = Math.max(impact, hh.last!.impact ?? 0);
      if (hh.last!.sound) sounds.push(hh.last!.sound.kind);
    });
    return { clips, impact, sounds };
  }

  it('a low drop lands softly; a high one plays the impact, then the recovery', () => {
    const low = drop(950);
    expect(low.clips).toContain('land');
    expect(low.clips).not.toContain('impact');
    expect(low.sounds).not.toContain('thud');
    const high = drop(100);
    expect(high.clips.indexOf('impact')).toBeGreaterThanOrEqual(0);
    expect(high.clips.indexOf('landRecover')).toBeGreaterThan(high.clips.indexOf('impact'));
    expect(high.impact).toBeGreaterThan(low.impact);
    expect(high.sounds).toContain('thud');
  });

  it('jumps report their kind in the air; a narrow ledge reports balance', () => {
    const kinds = new Set<string>();
    let balance = 0;
    for (const seed of [1, 2]) {
      const h = new Harness({ seed, persisted: catWith(seed) });
      h.env.extraSurfaces = [ledge('windowTop:n', 'windowTop', 'n', 960, 900, 900 + 0.5 * BW)];
      h.run(WAKE_MS);
      callCat(h, { x: 900 + 0.25 * BW, y: 950 });
      h.run(30_000, 33, (hh) => {
        const o = hh.last!;
        if (o.jumpKind) kinds.add(o.jumpKind);
        balance = Math.max(balance, o.balance ?? 0);
      });
    }
    expect(kinds.size).toBeGreaterThan(0);
    expect(balance).toBeGreaterThan(0);
  });
});

describe('on a tab strip (ADR 0003 §2.2, §7.4, §1.8)', () => {
  const STRIP = tabStrip('b', 700, 600, 1500, { x0: 700, x1: 1400 }, 1000);

  it('walks along it at most once per 45 s, watches the active tab and sits at its end', () => {
    const seen = new Set<string>();
    const patrols: number[] = [];
    for (const seed of [1, 2, 3, 4]) {
      const gaps: number[] = [];
      const h = new Harness({ seed, persisted: catWith(seed), settings: settingsWith({ behavior: { stayLength: 1 } }) });
      h.env.extraSurfaces = [STRIP];
      h.run(WAKE_MS);
      callCat(h, { x: 900, y: 650 });
      expect(h.runUntil((o) => o.support.kind === 'surface' && o.support.surfaceId === stripId('b'), 40_000)).toBe(true);
      let wasPatrol = false;
      h.run(5 * MIN, 100, (hh) => {
        const d = hh.sim.debugInfo();
        const key = `${d.state as string}:${(d.variant as string | null) ?? ''}`;
        seen.add(key);
        const p = key === 'walking:patrol';
        if (p && !wasPatrol) {
          gaps.push(hh.now);
          patrols.push(hh.now);
        }
        wasPatrol = p;
      });
      for (let i = 1; i < gaps.length; i++) expect((gaps[i] as number) - (gaps[i - 1] as number)).toBeGreaterThanOrEqual(45_000 - 200);
    }
    expect(seen).toContain('walking:patrol');
    expect(seen).toContain('idle:watchTab');
    expect(seen).toContain('inspectingWindow:edge');
    expect(patrols.length).toBeGreaterThan(3);
  }, 120_000);

  it('a removed tab right next to it is a small surprise; geometry changes get nothing; the switch turns reactions off', () => {
    const react = (disabledExtras: string[], change: 'removed' | 'geometry'): boolean => {
      const h = new Harness({ seed: 7, persisted: catWith(7), settings: settingsWith({ behavior: { disabledExtras } }) });
      h.env.extraSurfaces = [STRIP];
      h.run(WAKE_MS);
      callCat(h, { x: 900, y: 650 });
      expect(h.runUntil((o) => o.support.kind === 'surface' && o.support.surfaceId === stripId('b') && o.state === 'idle', 30_000)).toBe(true);
      const from = h.transitions.length;
      const x = h.last!.x;
      h.step([{ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change, focusX: x + 0.5 * BW }]);
      h.run(500);
      return h.transitions.slice(from).some((t) => t.to === 'startled');
    };
    expect(react([], 'removed')).toBe(true);
    expect(react([], 'geometry')).toBe(false);
    expect(react(['tabReactions'], 'removed')).toBe(false);
  });
});

describe('determinism and bounds', () => {
  it('33 ms and 66 ms host ticks give the same hunt starts within 1 (accumulators, ADR 0003 §1.2)', () => {
    const hunts = (dt: number): number => {
      let n = 0;
      const h = new Harness({ seed: 9, settings: settingsWith({ behavior: { cursorPlay: 1 } }), hooks: { onHunt: () => void n++ } });
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      let t = 0;
      h.run(20 * MIN, dt, (hh) => {
        t += dt;
        hh.env.userIdleMs = 0;
        hh.env.cursor = { x: x0 + 280 * Math.sin(t / 700), y: FLOOR - 40, speed: 500 };
      });
      return n;
    };
    const a = hunts(33);
    const b = hunts(66);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(1, Math.ceil(0.25 * a)));
  }, 120_000);
});
