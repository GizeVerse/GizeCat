// Living Companion 1.5.0 reconciliation: the personality flags that the engine acts on (shy watches
// before it approaches and keeps a larger stand-off, lazy lets minor events pass) and novelty (per-event
// counts tilt the pick and the notice delay). SIMULATED: seeded engine on a fixture stage. Written
// without being run; they pin behaviour the code is meant to have.
import { describe, expect, it } from 'vitest';
import { ALL_EVENT_IDS, type AnyEventId } from '../../../../src/shared/companion';
import { WORLD_COUNT_MAX } from '../../../../src/shared/catState';
import { mulberry32 } from '../../../../src/core/behavior';
import {
  EVENT_CATALOG,
  LAZY_IGNORE_PROBABILITY,
  NOTICE_FACTOR_MAX,
  NOTICE_FACTOR_MIN,
  NOVELTY_MAX,
  NOVELTY_MIN,
  SHY_STANDOFF_FACTOR,
  SHY_WATCH_FRACTION,
  SHY_WATCH_MIN_MS,
  chooseEvent,
  createWorldEventEngine,
  noticeNoveltyFactor,
  noveltyFactor,
  noveltyWeight,
  type EventEngineMemory,
  type EventIntent,
  type EventTemperament,
  type EventTickOutput,
  type OfferContext,
} from '../../../../src/core/events';
import { BODY_W, Driver, STAGE, WALL0, makeInput } from './helpers';

const OTHER_THAN = (keep: AnyEventId): AnyEventId[] => ALL_EVENT_IDS.filter((id) => id !== keep);
const DELAYED = new Set(['approach', 'sneak', 'chase', 'play', 'inspect', 'settle']);

interface Trace {
  outs: EventTickOutput[];
  intents: Array<{ intent: EventIntent; age: number; noticeAt: number; mainMs: number; outcome: string }>;
}

/** Forces `id` (a forced event is never ignored) and ticks to its end, recording each intent with the engine's clocks. */
function playForced(id: AnyEventId, seed: number, temperament: Partial<EventTemperament>, memory?: EventEngineMemory): Trace {
  const engine = createWorldEventEngine({ now: 0, random: mulberry32(seed), ...(memory ? { memory } : {}) });
  const d = new Driver(engine, seed + 1000, { temperament });
  expect(engine.trigger(id, d.input({ dt: 0 }))).toBe(true);
  const trace: Trace = { outs: [], intents: [] };
  for (let i = 0; i < 8000; i++) {
    const o = d.step({ dt: 50 });
    trace.outs.push(o);
    if (o.intent) {
      const info = engine.debugInfo().active as { age: number; noticeAt: number; mainMs: number; outcome: string };
      trace.intents.push({ intent: o.intent, age: info.age, noticeAt: info.noticeAt, mainMs: info.mainMs, outcome: info.outcome });
    }
    if (o.finished) break;
  }
  return trace;
}

/** Lets the schedule start the only enabled event (`id`) by itself and plays it out. */
function playNatural(id: AnyEventId, seed: number, temperament: Partial<EventTemperament>): Trace {
  const engine = createWorldEventEngine({ now: 0, random: mulberry32(seed) });
  const d = new Driver(engine, seed + 1000, { temperament, choices: { disabled: OTHER_THAN(id), rare: false, pace: 4 } });
  const trace: Trace = { outs: [], intents: [] };
  let started = false;
  for (let i = 0; i < 40_000; i++) {
    const o = d.step({ dt: started ? 50 : 1000 });
    if (!started && o.active) started = true;
    if (!started) continue;
    trace.outs.push(o);
    if (o.intent) trace.intents.push({ intent: o.intent, age: 0, noticeAt: 0, mainMs: 0, outcome: '' });
    if (o.finished) break;
  }
  expect(started).toBe(true);
  return trace;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('flags false: nothing changes', () => {
  it('leaves an identical output sequence for equal seeds (forced and scheduled)', () => {
    for (const id of ['fallingLeaf', 'magicSparkles', 'thunderstorm'] as const) {
      for (const seed of SEEDS.slice(0, 15)) {
        const plain = playForced(id, seed, {});
        const explicit = playForced(id, seed, { watchFirst: false, ignoreMinor: false });
        expect(JSON.stringify(explicit.outs), `${id} #${seed}`).toBe(JSON.stringify(plain.outs));
      }
    }
    for (const seed of SEEDS.slice(0, 5)) {
      const plain = playNatural('fallingLeaf', seed, {});
      const explicit = playNatural('fallingLeaf', seed, { watchFirst: false, ignoreMinor: false });
      expect(JSON.stringify(explicit.outs)).toBe(JSON.stringify(plain.outs));
    }
  });

  it('draws nothing extra from the random source when no flag is set', () => {
    const draws = (flags: Partial<EventTemperament>): number => {
      let n = 0;
      const base = mulberry32(7);
      const counted = (): number => {
        n++;
        return base();
      };
      const engine = createWorldEventEngine({ now: 0, random: mulberry32(7) });
      const d = new Driver(engine, 7, { temperament: flags });
      const inp = { ...d.input({ dt: 0 }), random: counted };
      engine.trigger('magicSparkles', inp);
      return n;
    };
    expect(draws({ watchFirst: false, ignoreMinor: false })).toBe(draws({}));
    // A shy cat draws its watching period (one extra draw) whenever it will notice the event at all.
    expect(draws({ watchFirst: true })).toBeGreaterThanOrEqual(draws({}));
    expect(draws({ watchFirst: true })).toBeLessThanOrEqual(draws({}) + 1);
  });
});

describe('shy: watches first, approaches from further away', () => {
  it('never performs an approach, play or inspect before the watching period is over, and watches instead', () => {
    let watchedInstead = 0;
    let approaches = 0;
    for (const seed of SEEDS) {
      const t = playForced('magicSparkles', seed, { watchFirst: true });
      for (const rec of t.intents) {
        const floor = Math.min(SHY_WATCH_MIN_MS, SHY_WATCH_FRACTION * (rec.mainMs - rec.noticeAt));
        if (DELAYED.has(rec.intent.kind)) {
          approaches++;
          expect(rec.age - rec.noticeAt, `#${seed} ${rec.intent.kind}`).toBeGreaterThanOrEqual(floor - 60);
        }
      }
      // The first beats after noticing would be an approach for the outcomes that move; shy watches.
      if (t.intents.length > 0 && t.intents[0]!.intent.kind === 'watch') watchedInstead++;
    }
    expect(watchedInstead).toBeGreaterThan(0);
    expect(approaches).toBeGreaterThan(0); // the event still completes: it does approach later
  });

  it('approaches later than a bold cat with the same event and keeps the larger stand-off', () => {
    const firstApproach = (seed: number, flags: Partial<EventTemperament>): { at: number; standoff: number } | null => {
      const t = playForced('magicSparkles', seed, { boldness: 0.5, ...flags });
      const hit = t.intents.find((i) => i.intent.kind === 'approach');
      return hit ? { at: hit.age - hit.noticeAt, standoff: hit.intent.standoffPx ?? NaN } : null;
    };
    let shyTotal = 0;
    let boldTotal = 0;
    let pairs = 0;
    for (const seed of SEEDS) {
      const shy = firstApproach(seed, { watchFirst: true });
      const bold = firstApproach(seed, {});
      if (shy) {
        // magicSparkles names a stand-off of 0.6..0.7 body widths; boldness 0.5 gives x1.0; shy x1.5.
        expect(shy.standoff).toBeGreaterThanOrEqual(0.6 * BODY_W * SHY_STANDOFF_FACTOR - 1e-6);
      }
      if (bold) expect(bold.standoff).toBeLessThan(0.7 * BODY_W * 1.0001 + 1e-6);
      if (shy && bold) {
        shyTotal += shy.at;
        boldTotal += bold.at;
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(3);
    expect(shyTotal / pairs).toBeGreaterThan(boldTotal / pairs);
  });

  it('does not delay urgent intents (thunder, waves)', () => {
    for (const id of ['thunderstorm', 'miniTsunami'] as const) {
      for (const seed of SEEDS.slice(0, 10)) {
        const bold = playForced(id, seed, {});
        const shy = playForced(id, seed, { watchFirst: true });
        const urgent = (t: Trace): number => t.intents.filter((i) => i.intent.urgency >= 0.5 && i.intent.kind !== 'watch').length;
        expect(urgent(shy), `${id} #${seed}`).toBeGreaterThan(0);
        expect(bold.intents.length, `${id} #${seed}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('lazy: lets minor events pass', () => {
  it('marks only gentle, missable events as minor', () => {
    const minor = ALL_EVENT_IDS.filter((id) => EVENT_CATALOG[id].minor === true);
    expect(minor.sort()).toEqual(['bubbleParty', 'fallingLeaf', 'fallingStar', 'magicSparkles', 'paperPlane']);
    for (const id of minor) {
      const def = EVENT_CATALOG[id];
      expect(def.canMiss, id).toBe(true);
      for (const o of def.outcomes) for (const bt of o.beats) expect(bt.urgency ?? 0.15, `${id}/${o.id}`).toBeLessThan(0.5);
    }
  });

  it('ignores a minor event with the stated probability: no intent, props still play, ends unnoticed, nothing journaled', () => {
    const seeds = Array.from({ length: 160 }, (_, i) => i + 1);
    let ignored = 0;
    for (const seed of seeds) {
      const t = playNatural('fallingLeaf', seed, { ignoreMinor: true });
      const last = t.outs[t.outs.length - 1]!;
      expect(last.finished).not.toBeNull();
      expect(last.props).toHaveLength(0);
      if (t.intents.length === 0) {
        ignored++;
        expect(last.finished!.history.outcome).toBe('unnoticed');
        expect(last.finished!.journal).toBeNull();
        expect(t.outs.some((o) => o.props.length > 0)).toBe(true);
      }
    }
    const rate = ignored / seeds.length;
    expect(rate).toBeGreaterThan(LAZY_IGNORE_PROBABILITY - 0.12);
    expect(rate).toBeLessThan(LAZY_IGNORE_PROBABILITY + 0.2); // a few more can be missed the ordinary way
  });

  it('never ignores a non-minor or an urgent event', () => {
    for (const id of ['thunderstorm', 'miniTsunami'] as const) {
      for (const seed of SEEDS.slice(0, 15)) {
        const t = playNatural(id, seed, { ignoreMinor: true });
        expect(t.intents.length, `${id} #${seed}`).toBeGreaterThan(0);
        expect(t.outs[t.outs.length - 1]!.finished!.history.outcome).not.toBe('unnoticed');
      }
    }
  });

  it('a forced event (dev menu, play one now) is always engaged with', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const t = playForced('fallingLeaf', seed, { ignoreMinor: true });
      expect(t.outs.some((o) => o.props.length > 0)).toBe(true);
    }
  });
});

describe('novelty: factors', () => {
  it('runs from 1.25 for an unseen event down towards 0.75, strictly decreasing', () => {
    expect(noveltyFactor(0)).toBe(NOVELTY_MAX);
    let prev = Infinity;
    for (const c of [0, 1, 2, 5, 10, 50, 500, 50_000, WORLD_COUNT_MAX]) {
      const f = noveltyFactor(c);
      expect(f).toBeLessThanOrEqual(NOVELTY_MAX);
      expect(f).toBeGreaterThan(NOVELTY_MIN);
      expect(f).toBeLessThan(prev);
      prev = f;
    }
    expect(noveltyFactor(5)).toBeCloseTo(1, 12);
  });

  it('is total: junk counts read as unseen', () => {
    for (const junk of [undefined, Number.NaN, -3, -Infinity, Infinity]) expect(noveltyFactor(junk)).toBe(NOVELTY_MAX);
    expect(noveltyWeight(undefined)).toBe(1);
    expect(noveltyWeight(0)).toBe(1);
  });

  it('scales the notice delay within 0.85x..1.2x, faster for the unfamiliar and monotonic', () => {
    expect(noticeNoveltyFactor(0)).toBeCloseTo(NOTICE_FACTOR_MIN, 12);
    let prev = 0;
    for (const c of [0, 1, 5, 20, 200, WORLD_COUNT_MAX, Number.NaN]) {
      const f = noticeNoveltyFactor(c);
      expect(f).toBeGreaterThanOrEqual(NOTICE_FACTOR_MIN - 1e-12);
      expect(f).toBeLessThanOrEqual(NOTICE_FACTOR_MAX);
      if (Number.isFinite(c)) {
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });
});

describe('novelty: selection', () => {
  const ctx = (): OfferContext => ({ stage: { ...STAGE }, bodyW: BODY_W, localHour: 14, reducedMotion: false, rare: true, disabled: [], ignoreHours: false });
  const pick = (seed: number, counts?: Partial<Record<AnyEventId, number>>): AnyEventId | null => chooseEvent(mulberry32(seed), ctx(), [], WALL0, counts);

  it('selects exactly as before for a cat with no or all-zero counts, for equal seeds', () => {
    const zeros = Object.fromEntries(ALL_EVENT_IDS.map((id) => [id, 0])) as Partial<Record<AnyEventId, number>>;
    for (let seed = 1; seed <= 300; seed++) {
      const base = pick(seed);
      expect(pick(seed, {})).toBe(base);
      expect(pick(seed, zeros)).toBe(base);
    }
  });

  it('draws a familiar event less often and unseen ones more often', () => {
    const familiar: Partial<Record<AnyEventId, number>> = { fallingLeaf: 400 };
    let leafPlain = 0;
    let leafFamiliar = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      if (pick(seed) === 'fallingLeaf') leafPlain++;
      if (pick(seed, familiar) === 'fallingLeaf') leafFamiliar++;
    }
    expect(leafPlain).toBeGreaterThan(50);
    expect(leafFamiliar).toBeLessThan(leafPlain);
  });
});

describe('novelty: the engine keeps and restores counts', () => {
  const memory = (counts: unknown): EventEngineMemory => ({ history: [], counts: counts as EventEngineMemory['counts'] });

  it('raises its own counts when an event finishes, and snapshot returns them', () => {
    const engine = createWorldEventEngine({ now: 0, random: mulberry32(2) });
    expect(engine.snapshot().counts).toEqual({});
    const d = new Driver(engine, 5);
    expect(engine.trigger('fallingLeaf', d.input({ dt: 0 }))).toBe(true);
    d.run(8000, {}, (o) => o.finished !== null);
    expect(engine.snapshot().counts).toEqual({ fallingLeaf: 1 });
    expect(engine.trigger('fallingLeaf', d.input({ dt: 0 }))).toBe(true);
    d.run(8000, {}, (o) => o.finished !== null);
    expect(engine.snapshot().counts).toEqual({ fallingLeaf: 2 });
  });

  it('restores counts, and a restore without counts (a cleared world) starts novelty over', () => {
    const engine = createWorldEventEngine({ now: 0, random: mulberry32(2), memory: memory({ boxAppears: 4 }) });
    expect(engine.snapshot().counts).toEqual({ boxAppears: 4 });
    engine.restore(memory({ yarnTrouble: 9 }));
    expect(engine.snapshot().counts).toEqual({ yarnTrouble: 9 });
    engine.restore({ history: [], counts: {} });
    expect(engine.snapshot().counts).toEqual({});
    engine.restore(memory({ boxAppears: 4 }));
    engine.restore({ history: [] });
    expect(engine.snapshot().counts).toEqual({});
  });

  it('sanitises counts: unknown ids, negatives, NaN, junk shapes and huge values', () => {
    const engine = createWorldEventEngine({
      now: 0,
      random: mulberry32(2),
      memory: memory({ bogus: 5, fallingLeaf: -3, boxAppears: Number.NaN, mysteriousBall: 1e12, yarnTrouble: 2.7, thunderstorm: '4', paperPlane: Infinity }),
    });
    expect(engine.snapshot().counts).toEqual({ mysteriousBall: WORLD_COUNT_MAX, yarnTrouble: 2 });
    for (const junk of [null, 7, 'x', [1, 2], undefined]) {
      engine.restore(memory(junk));
      expect(engine.snapshot().counts).toEqual({});
    }
  });

  it('a familiar event is noticed later than an unseen one (same seed), an urgent one never changes', () => {
    const noticeAt = (id: AnyEventId, seed: number, count: number): number => {
      const engine = createWorldEventEngine({ now: 0, random: mulberry32(seed), memory: memory({ [id]: count }) });
      const d = new Driver(engine, seed + 9);
      expect(engine.trigger(id, d.input({ dt: 0 }))).toBe(true);
      return (engine.debugInfo().active as { noticeAt: number }).noticeAt;
    };
    let compared = 0;
    for (const seed of SEEDS) {
      const unseen = noticeAt('magicSparkles', seed, 0);
      const familiar = noticeAt('magicSparkles', seed, 1000);
      if (Number.isFinite(unseen) && Number.isFinite(familiar)) {
        compared++;
        expect(familiar / unseen).toBeCloseTo(noticeNoveltyFactor(1000) / noticeNoveltyFactor(0), 6);
      }
      expect(noticeAt('thunderstorm', seed, 1000)).toBe(noticeAt('thunderstorm', seed, 0));
    }
    expect(compared).toBeGreaterThan(5);
  });
});

describe('the temperament carries the flags', () => {
  it('makeInput keeps absent flags absent (the engine reads absent as false)', () => {
    const inp = makeInput();
    expect(inp.temperament.watchFirst).toBeUndefined();
    expect(inp.temperament.ignoreMinor).toBeUndefined();
  });
});
