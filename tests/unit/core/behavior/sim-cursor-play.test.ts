// Cursor play from the product brief: pawing (and its switch), chase length, pounces
// and the playful retreat from a pointer rushing at the cat.
import { describe, expect, it } from 'vitest';
import type { PersistedCat, Stats, Traits } from '../../../../src/shared/catState';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { MOVEMENT } from '../../../../src/core/movement';
import { PLAY_RETREAT_COOLDOWN_MS } from '../../../../src/core/behavior/sim';
import { Harness, settingsWith, WAKE_MS } from './fixtures';

const MIN = 60_000;
const BL = 84;
const FLOOR = 1040;

function catWith(seed: number, traits: Partial<Traits>, stats: Partial<Stats> = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), 1_800_000_000_000 - 3600_000);
  Object.assign(cat.traits, traits);
  Object.assign(cat.stats, stats);
  return cat;
}

/** A pointer resting on the floor `offset` px beside where the cat started, jiggling now and then, with flicks to start a chase. */
function pointerPlay(x0: number, offset: number): (h: Harness, i: number) => SimEvent[] {
  return (h, i) => {
    const x = x0 + offset + (i % 90 < 10 ? 20 * Math.sin(i) : 0);
    h.env.cursor = { x, y: FLOOR - 10, speed: i % 90 < 10 ? 600 : 0 };
    return i % 150 === 0 ? [{ type: 'cursor.flick', speed: 3000, at: { x, y: FLOOR - 10 } }] : [];
  };
}

const near = (a: { x: number; y: number } | null, b: { x: number; y: number } | null | undefined): boolean => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < 1;

describe('F4: "Paw at the pointer" is its own switch', () => {
  const run = (disabled: boolean): { pawAtCursor: number; sitWatch: number } => {
    let pawAtCursor = 0;
    let sitWatch = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1, disabledBehaviors: disabled ? ['pawAtCursor'] : [] } }) });
      h.run(WAKE_MS);
      const play = pointerPlay(h.last!.x, 4 * BL);
      h.run(3 * MIN, 33, (hh, i) => {
        const o = hh.last as SimOutput;
        const cursor = hh.env.cursor ?? null;
        if (o.clip === 'pawAt' && near(o.look, cursor)) pawAtCursor++;
        if (o.state === 'chasingCursor' && o.clip === 'sit' && near(o.look, cursor)) sitWatch++;
        return play(hh, i);
      });
    }
    return { pawAtCursor, sitWatch };
  };

  it('with only it off, a chase that reaches the pointer sits and watches it instead of batting at it', () => {
    const on = run(false);
    expect(on.pawAtCursor).toBeGreaterThan(0);
    const off = run(true);
    expect(off.pawAtCursor).toBe(0);
    expect(off.sitWatch).toBeGreaterThan(0);
  });
});

describe('F5: chase duration setting', () => {
  /** Dwell of the first chase a flick starts, and the longest chase segment seen. */
  function chase(chaseDurationSec: number): { dwells: number[]; longest: number } {
    const dwells: number[] = [];
    let longest = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1, chaseDurationSec } }) });
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      let since: number | null = null;
      h.run(2 * MIN, 33, (hh, i) => {
        const s = hh.last!.state;
        if (s === 'chasingCursor') {
          if (since === null) {
            since = hh.now;
            dwells.push(hh.sim.debugInfo().dwellMs as number);
          }
          longest = Math.max(longest, hh.now - since);
        } else if (s !== 'jumping' && s !== 'landing') since = null;
        // A lively pointer that keeps running along the floor ahead of the cat.
        const x = x0 + 500 * Math.sin(i / 40);
        hh.env.cursor = { x, y: FLOOR - 10, speed: 900 };
        return i % 120 === 0 ? [{ type: 'cursor.flick', speed: 3000, at: { x, y: FLOOR - 10 } }] : [];
      });
    }
    return { dwells, longest };
  }

  it('scales the chase around chaseDurationSec (default keeps the 2-7 s range)', () => {
    const def = chase(4.5);
    expect(def.dwells.length).toBeGreaterThan(0);
    for (const d of def.dwells) expect(d >= 2000 && d <= 7000).toBe(true);
    const short = chase(1);
    expect(short.dwells.length).toBeGreaterThan(0);
    for (const d of short.dwells) expect(d).toBeLessThanOrEqual((7000 * 1) / 4.5 + 1);
    const long = chase(20);
    expect(long.dwells.length).toBeGreaterThan(0);
    for (const d of long.dwells) expect(d).toBeGreaterThanOrEqual((2000 * 20) / 4.5 - 1);
    // Longer than the old fixed maximum of 7 s.
    expect(long.longest).toBeGreaterThan(9000);
    expect(short.longest).toBeLessThan(def.longest);
  });
});

describe('F6: pouncing at the pointer', () => {
  it('a chase that closes in can end in a short pounce toward the pointer, and the chase carries on after landing', () => {
    let pounces = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1 } }) });
      h.run(WAKE_MS);
      const play = pointerPlay(h.last!.x, 5 * BL);
      let jumpFrom: number | null = null;
      h.run(3 * MIN, 33, (hh, i) => {
        const o = hh.last as SimOutput;
        if (o.state === 'jumping' && jumpFrom === null) jumpFrom = o.x;
        if (o.state === 'landing' && jumpFrom !== null) {
          // A pounce, not a leap: within the hunting pounce's reach (ADR 0003 §4.2, at most 3.2 body widths).
          expect(Math.abs(o.x - jumpFrom)).toBeLessThanOrEqual(MOVEMENT.pounceReachBodyLengths * BL + 2);
          // Back on the floor (the work-area bottom less the app's floor inset).
          expect(o.y).toBe(hh.floorY());
          jumpFrom = null;
        }
        return play(hh, i);
      });
      const fromChase = h.transitions.filter((t) => t.from === 'chasingCursor' && t.to === 'jumping');
      pounces += fromChase.length;
      // Bounded: a pounce cooldown of several seconds.
      const at = fromChase.map((t) => t.at);
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(6000);
      // After landing the chase resumes.
      for (const t of fromChase) expect(h.transitions.some((u) => u.from === 'landing' && u.to === 'chasingCursor' && u.at > t.at && u.at < t.at + 3000)).toBe(true);
    }
    expect(pounces).toBeGreaterThan(0);
  });

  it('never pounces with "Chase the pointer" off', () => {
    for (const seed of [7, 8, 9]) {
      const h = new Harness({ seed, persisted: catWith(seed, { playfulness: 0.92 }, { energy: 1 }), settings: settingsWith({ behavior: { cursorPlay: 1, disabledBehaviors: ['chaseCursor'] } }) });
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      h.run(10 * MIN, 33, (hh, i) => {
        hh.env.cursor = { x: x0 + 2 * BL * Math.sin(i / 8), y: FLOOR - 10, speed: 900 };
        return i % 150 === 0 ? [{ type: 'cursor.flick', speed: 3000, at: { x: x0 + BL, y: FLOOR - 10 } }] : [];
      });
      expect(h.transitions.some((t) => (t.from === 'watchingCursor' || t.from === 'chasingCursor') && t.to === 'jumping')).toBe(false);
    }
  });
});

describe('F17: playful retreat', () => {
  /** Rushes the pointer along the floor at the cat from six body lengths away, every `everyMs`. */
  function rush(h: Harness, everyMs: number, ms: number, onTick?: (h: Harness) => void): void {
    let t0 = h.now;
    let side = 1;
    h.run(ms, 33, (hh) => {
      const age = hh.now - t0;
      if (age > everyMs) {
        t0 = hh.now;
        side = -side;
      }
      // 12 body lengths per second toward the cat, then it rests beside it.
      const d = Math.max(0.8, 6 - (12 * age) / 1000);
      hh.env.cursor = { x: hh.last!.x + side * d * BL, y: FLOOR - 30, speed: age < 500 ? 12 * BL : 0 };
      onTick?.(hh);
    });
  }

  it('a playful, energetic cat darts away from a pointer rushing at it, then turns back to it in a crouch', () => {
    let retreats = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, persisted: catWith(seed, { playfulness: 0.9, energyLevel: 0.8 }, { energy: 0.95 }), settings: settingsWith({ behavior: { cursorPlay: 0.8 } }) });
      h.run(WAKE_MS);
      if (!h.runUntil((o) => o.state === 'idle', 5 * MIN)) continue;
      let crouchedFacing = false;
      rush(h, 4000, 40_000, (hh) => {
        const info = hh.sim.debugInfo();
        if (info.state === 'watchingCursor' && info.variant === 'playful' && info.phase === 'crouch') {
          const c = hh.env.cursor!;
          if (Math.sign(c.x - hh.last!.x) === hh.last!.facing) crouchedFacing = true;
        }
      });
      const fled = h.transitions.filter((t) => t.to === 'running' && t.cause === 'stimulus');
      if (fled.length === 0) continue;
      retreats++;
      expect(fled.length).toBe(1);
      expect(h.transitions.some((t) => t.from === 'running' && t.to === 'watchingCursor')).toBe(true);
      expect(crouchedFacing).toBe(true);
    }
    expect(retreats).toBeGreaterThanOrEqual(2);
  });

  it('is rare: at most once per cooldown however often the pointer rushes at it', () => {
    for (const seed of [11, 12, 13]) {
      const h = new Harness({ seed, persisted: catWith(seed, { playfulness: 0.92, energyLevel: 0.9 }, { energy: 1 }), settings: settingsWith({ behavior: { cursorPlay: 1 } }) });
      h.run(WAKE_MS);
      rush(h, 3000, 20 * MIN);
      const at = h.transitions.filter((t) => t.to === 'running' && t.cause === 'stimulus').map((t) => t.at);
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(PLAY_RETREAT_COOLDOWN_MS);
      expect(at.length).toBeLessThanOrEqual((20 * MIN) / PLAY_RETREAT_COOLDOWN_MS + 1);
    }
  });

  it('a sleepy or unplayful cat does not dodge, and neither does any cat with Pointer play at 0 %', () => {
    const cases: Array<{ traits: Partial<Traits>; stats: Partial<Stats>; cursorPlay: number }> = [
      { traits: { playfulness: 0.2 }, stats: { energy: 1 }, cursorPlay: 1 },
      { traits: { playfulness: 0.9 }, stats: { energy: 0.3 }, cursorPlay: 1 },
      { traits: { playfulness: 0.9 }, stats: { energy: 1 }, cursorPlay: 0 },
    ];
    for (const c of cases) {
      const h = new Harness({ seed: 21, persisted: catWith(21, c.traits, c.stats), settings: settingsWith({ behavior: { cursorPlay: c.cursorPlay } }) });
      h.run(WAKE_MS);
      rush(h, 4000, 5 * MIN);
      expect(h.transitions.some((t) => t.to === 'running' && t.cause === 'stimulus')).toBe(false);
    }
  });
});
