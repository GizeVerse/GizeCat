// The world-event engine (src/core/events): the scheduler, every one of the 26 events end to end, the
// invariants that keep the overlay safe (no overlap, no burst, never a prop left behind, the mouse never
// caught, the wave small), determinism and restore. SIMULATED: the engine driven with seeded randomness
// and a fixture stage; no display, no sim, no renderer. Written in the Living Companion sprint, NOT
// executed there (the owner's CI runs it).
import { describe, expect, it } from 'vitest';
import {
  ALL_EVENT_IDS,
  EVENT_DELAY_FLOOR_MS,
  EVENT_DELAY_MAX_MS,
  EVENT_DELAY_MIN_MS,
  EVENT_HISTORY_MAX,
  MAX_PROPS,
  RARE_EVENT_IDS,
  RARE_EVENT_PROBABILITY,
  type AnyEventId,
  type EventHistoryEntry,
} from '../../../../src/shared/companion';
import { mulberry32 } from '../../../../src/core/behavior';
import {
  EVENT_CATALOG,
  GRACE_MAX_MS,
  GRACE_MIN_MS,
  MAX_COUNTDOWN_STEP_MS,
  NORMAL_REPEAT_EXCLUDE,
  RARE_REPEAT_EXCLUDE,
  WAVE_HEIGHT_RATIO,
  WAVE_MAX_WIDTH_BODY,
  canOffer,
  chooseEvent,
  createWorldEventEngine,
  type EventTickOutput,
  type OfferContext,
} from '../../../../src/core/events';
import { BODY_W, Driver, STAGE, WALL0, makeInput } from './helpers';

const FLOOR_Y = STAGE.y + STAGE.height;
const CAT_H = (64 / 84) * BODY_W;
const OTHER_THAN = (keep: AnyEventId): AnyEventId[] => ALL_EVENT_IDS.filter((id) => id !== keep);

function engineFor(seed: number, memory?: { history: EventHistoryEntry[] }) {
  return createWorldEventEngine({ now: 0, random: mulberry32(seed), ...(memory ? { memory } : {}) });
}

/** Force `id` and tick until it finishes; returns every output (the finishing one last). */
function playEvent(id: AnyEventId, seed: number, over: Parameters<Driver['step']>[0] = {}, maxTicks = 8000): { outs: EventTickOutput[]; driver: Driver } {
  const engine = engineFor(seed);
  const driver = new Driver(engine, seed + 1000, over);
  expect(engine.trigger(id, driver.input({ dt: 0 }))).toBe(true);
  const outs = driver.run(maxTicks, {}, (o) => o.finished !== null);
  return { outs, driver };
}

describe('scheduler: delay', () => {
  it('draws the first delay in [5, 30] minutes divided by the pace, never below the floor', () => {
    for (const pace of [0.5, 1, 2]) {
      for (let seed = 1; seed <= 25; seed++) {
        const engine = engineFor(seed);
        const d = new Driver(engine, seed, { choices: { pace } });
        d.step({ dt: 0 });
        const ms = engine.msUntilNext(0);
        expect(ms).not.toBeNull();
        const lo = Math.max(EVENT_DELAY_FLOOR_MS, EVENT_DELAY_MIN_MS / pace);
        const hi = Math.max(EVENT_DELAY_FLOOR_MS, EVENT_DELAY_MAX_MS / pace);
        expect(ms!).toBeGreaterThanOrEqual(lo - 1);
        expect(ms!).toBeLessThanOrEqual(hi + 1);
      }
    }
  });

  it('never starts the first event before the shortest possible delay', () => {
    const engine = engineFor(3);
    const d = new Driver(engine, 3);
    let t = 0;
    while (t < EVENT_DELAY_MIN_MS - MAX_COUNTDOWN_STEP_MS) {
      const o = d.step({ dt: 1000 });
      t += 1000;
      expect(o.active).toBeNull();
    }
    expect(engine.active).toBe(false);
  });

  it('eventually starts one, and the next only after the floor, with no overlap and never two in one tick', () => {
    const engine = engineFor(11);
    const d = new Driver(engine, 11, { choices: { pace: 2 } });
    let starts = 0;
    let lastEnd = -Infinity;
    let wasActive = false;
    for (let i = 0; i < 90_000; i++) {
      const before = d.now;
      const o = d.step({ dt: i % 7 === 0 ? 1000 : 500 });
      if (o.finished) {
        expect(o.active).toBeNull();
        expect(o.props).toHaveLength(0);
        expect(engine.active).toBe(false);
        lastEnd = d.now;
        wasActive = false;
        continue;
      }
      if (o.active && !wasActive) {
        starts++;
        expect(d.now - lastEnd).toBeGreaterThanOrEqual(EVENT_DELAY_FLOOR_MS - 1500);
        wasActive = true;
        expect(before).toBeLessThanOrEqual(d.now);
      }
      if (o.active) expect(engine.active).toBe(true);
    }
    expect(starts).toBeGreaterThan(2);
  });

  it('freezes the countdown while not allowed, while the user is busy and while events are switched off', () => {
    const engine = engineFor(5);
    const d = new Driver(engine, 5);
    d.run(200, { dt: 1000 });
    const waited = (): number => engine.debugInfo().waitedMs as number;
    const w0 = waited();
    expect(w0).toBeGreaterThan(0);
    d.run(500, { dt: 1000, allowed: false });
    expect(waited()).toBe(w0);
    expect(engine.msUntilNext(0)).toBeNull();
    d.run(500, { dt: 1000, userBusy: true });
    expect(waited()).toBe(w0);
    d.run(500, { dt: 1000, choices: { enabled: false } });
    expect(waited()).toBe(w0);
    d.step({ dt: 1000 });
    expect(waited()).toBe(w0 + 1000);
    expect(engine.msUntilNext(0)).not.toBeNull();
  });

  it('makes no burst after a huge dt (a suspend or a clock jump)', () => {
    const engine = engineFor(7);
    const d = new Driver(engine, 7);
    const o = d.step({ dt: 3_600_000 * 10 });
    expect(o.active).toBeNull();
    expect(engine.active).toBe(false);
    expect(engine.debugInfo().waitedMs as number).toBeLessThanOrEqual(MAX_COUNTDOWN_STEP_MS);
    d.step({ dt: Number.NaN });
    d.step({ dt: -5000 });
    expect(engine.debugInfo().waitedMs as number).toBeLessThanOrEqual(MAX_COUNTDOWN_STEP_MS + 1);
  });

  it('reschedules from scratch on suspend, lock and display', () => {
    for (const reason of ['suspend', 'lock', 'display'] as const) {
      const engine = engineFor(9);
      const d = new Driver(engine, 9);
      d.run(120, { dt: 1000 });
      expect(engine.debugInfo().waitedMs as number).toBeGreaterThan(0);
      engine.interrupt(reason);
      expect(engine.debugInfo().waitedMs).toBe(0);
      const ms = engine.msUntilNext(0)!;
      expect(ms).toBeGreaterThanOrEqual(EVENT_DELAY_MIN_MS - 1);
      expect(ms).toBeLessThanOrEqual(EVENT_DELAY_MAX_MS + 1);
    }
  });

  it('applies the pace in force when the countdown is checked (never below the floor)', () => {
    const engine = engineFor(13);
    const d = new Driver(engine, 13);
    d.step({ dt: 0, choices: { pace: 0.5 } });
    const slow = engine.msUntilNext(0)!;
    d.step({ dt: 0, choices: { pace: 2 } });
    const fast = engine.msUntilNext(0)!;
    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThanOrEqual(EVENT_DELAY_FLOOR_MS - 1);
  });

  it('defers by a short grace when the due event needs an awake cat and the cat is asleep', () => {
    const only: AnyEventId[] = OTHER_THAN('mouseEncounter');
    const engine = engineFor(21);
    const d = new Driver(engine, 21, { cat: { asleep: true, state: 'sleeping' }, choices: { disabled: only, rare: false } });
    const outs = d.run(500, { dt: 5000 }, () => engine.debugInfo().fixedDelay === true);
    expect(outs.some((o) => o.active)).toBe(false);
    expect(engine.debugInfo().fixedDelay).toBe(true);
    const ms = engine.msUntilNext(0)!;
    expect(ms).toBeGreaterThanOrEqual(GRACE_MIN_MS - 1);
    expect(ms).toBeLessThanOrEqual(GRACE_MAX_MS + 1);
  });
});

describe('selection: recency, pools, eligibility', () => {
  const offer = (over: Partial<OfferContext> = {}): OfferContext => ({
    stage: { ...STAGE },
    bodyW: BODY_W,
    localHour: 14,
    reducedMotion: false,
    rare: false,
    disabled: [],
    ...over,
  });
  const entry = (id: AnyEventId, at = WALL0): EventHistoryEntry => ({ id, at, outcome: 'watched' });

  it('never repeats any of the previous three normal events', () => {
    const history = [entry('mouseEncounter'), entry('fallingLeaf'), entry('boxAppears')];
    const r = mulberry32(4);
    for (let i = 0; i < 400; i++) {
      const id = chooseEvent(r, offer(), history, WALL0 + 1000);
      expect(id).not.toBeNull();
      expect(history.slice(-NORMAL_REPEAT_EXCLUDE).map((h) => h.id)).not.toContain(id!);
    }
  });

  it('weights recent events lower than old ones (wall time)', () => {
    const r1 = mulberry32(8);
    const r2 = mulberry32(8);
    // The mouse comes first, so it is outside the last-three exclusion and only its recency counts.
    const ids: AnyEventId[] = ['mouseEncounter', 'butterflyEncounter', 'windGust', 'paperPlane'];
    const recent = ids.map((id) => entry(id, WALL0 - 60_000));
    const old = recent.map((h) => ({ ...h, at: WALL0 - 24 * 3_600_000 }));
    const countOf = (r: () => number, hist: EventHistoryEntry[]): number => {
      let n = 0;
      for (let i = 0; i < 3000; i++) if (chooseEvent(r, offer(), hist, WALL0) === 'mouseEncounter') n++;
      return n;
    };
    expect(countOf(r1, recent)).toBeLessThan(countOf(r2, old));
  });

  it('keeps the rare pool out unless rare events are on, and honours the probability when they are', () => {
    const r = mulberry32(2);
    for (let i = 0; i < 2000; i++) expect(RARE_EVENT_IDS as readonly string[]).not.toContain(chooseEvent(r, offer({ rare: false, localHour: 23 }), [], WALL0)!);
    let rare = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) if ((RARE_EVENT_IDS as readonly string[]).includes(chooseEvent(r, offer({ rare: true, localHour: 23 }), [], WALL0)!)) rare++;
    expect(rare / n).toBeGreaterThan(RARE_EVENT_PROBABILITY * 0.5);
    expect(rare / n).toBeLessThan(RARE_EVENT_PROBABILITY * 1.6);
  });

  it('excludes the last six rare events and never lets the rare pool block the normal one', () => {
    const history = RARE_EVENT_IDS.map((id) => entry(id));
    const r = mulberry32(6);
    for (let i = 0; i < 1500; i++) {
      const id = chooseEvent(r, offer({ rare: true, localHour: 23 }), history, WALL0 + 1);
      expect(id).not.toBeNull();
      expect(history.slice(-RARE_REPEAT_EXCLUDE).map((h) => h.id)).not.toContain(id!);
    }
    const allRareOff = offer({ rare: true, localHour: 23, disabled: [...RARE_EVENT_IDS] });
    for (let i = 0; i < 500; i++) expect(chooseEvent(r, allRareOff, [], WALL0)).not.toBeNull();
  });

  it('respects the per-event switches, the stage size, the hour window and reducedMotion', () => {
    const r = mulberry32(1);
    const disabled = OTHER_THAN('fallingLeaf');
    for (let i = 0; i < 50; i++) expect(chooseEvent(r, offer({ disabled }), [], WALL0)).toBe('fallingLeaf');
    expect(chooseEvent(r, offer({ stage: { x: 0, y: 0, width: 100, height: 700 } }), [], WALL0)).toBeNull();
    expect(canOffer(EVENT_CATALOG.midnightVisitor, offer({ rare: true, localHour: 14 }))).toBe(false);
    for (const h of [22, 23, 0, 3, 4.9]) expect(canOffer(EVENT_CATALOG.midnightVisitor, offer({ rare: true, localHour: h }))).toBe(true);
    expect(canOffer(EVENT_CATALOG.midnightVisitor, offer({ rare: true, localHour: 5 }))).toBe(false);
    expect(canOffer(EVENT_CATALOG.meteorShower, offer({ rare: true, reducedMotion: true }))).toBe(false);
    expect(canOffer(EVENT_CATALOG.meteorShower, offer({ rare: true }))).toBe(true);
  });

  it('relaxes the repeat rule only when nothing else is left', () => {
    const r = mulberry32(3);
    const disabled = OTHER_THAN('windGust');
    expect(chooseEvent(r, offer({ disabled }), [entry('windGust')], WALL0 + 1)).toBe('windGust');
  });
});

describe('every event, end to end', () => {
  for (const id of ALL_EVENT_IDS) {
    it(`${id}: starts, stays inside the stage and the prop budget, ends with no props left`, () => {
      const def = EVENT_CATALOG[id];
      for (let seed = 1; seed <= 5; seed++) {
        const hour = id === 'midnightVisitor' ? 23 : 14;
        const { outs, driver } = playEvent(id, seed * 17, { localHour: hour, cat: { x: 300 + seed * 220 } });
        const last = outs[outs.length - 1]!;
        expect(last.finished, `${id} seed ${seed} did not finish`).not.toBeNull();
        expect(last.props).toHaveLength(0);
        expect(last.intent).toBeNull();
        expect(last.active).toBeNull();
        expect(driver.engine.active).toBe(false);
        const known = [...def.outcomes.map((o) => o.id), 'cut', 'unnoticed'];
        expect(known).toContain(last.finished!.history.outcome);
        expect(last.finished!.history.id).toBe(id);
        expect(last.finished!.history.at).toBeGreaterThan(WALL0);
        let sawProp = false;
        const ids = new Map<number, string>();
        for (const o of outs) {
          expect(o.props.length).toBeLessThanOrEqual(MAX_PROPS);
          if (o.props.length > 0) sawProp = true;
          for (const p of o.props) {
            expect(p.x).toBeGreaterThanOrEqual(STAGE.x - 1e-6);
            expect(p.x).toBeLessThanOrEqual(STAGE.x + STAGE.width + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(STAGE.y - 1e-6);
            expect(p.y).toBeLessThanOrEqual(FLOOR_Y + 1e-6);
            expect(p.alpha).toBeGreaterThan(0);
            expect(p.alpha).toBeLessThanOrEqual(1);
            expect(Number.isFinite(p.x + p.y + p.size + p.rot + p.p)).toBe(true);
            expect(p.size).toBeGreaterThan(0);
            expect(p.variant).toBeGreaterThanOrEqual(0);
            expect(p.variant).toBeLessThanOrEqual(3);
            expect(def.props.map(String)).toContain(p.kind);
            // Stable ids: one id is always one kind.
            const prev = ids.get(p.id);
            if (prev) expect(prev).toBe(p.kind);
            ids.set(p.id, p.kind);
          }
          if (o.active) expect(o.active.id).toBe(id);
        }
        expect(sawProp).toBe(true);
      }
    });
  }

  it('gives rare events their own snapshot flag', () => {
    const engine = engineFor(2);
    const d = new Driver(engine, 2, { localHour: 23 });
    expect(engine.trigger('goldenButterfly', d.input({ dt: 0 }))).toBe(true);
    const o = d.step({ dt: 50 });
    expect(o.active).toEqual({ id: 'goldenButterfly', rare: true, startedAt: expect.any(Number) });
    const engine2 = engineFor(2);
    const d2 = new Driver(engine2, 2);
    engine2.trigger('fallingLeaf', d2.input({ dt: 0 }));
    expect(d2.step({ dt: 50 }).active?.rare).toBe(false);
  });

  it('refuses to trigger while one runs, for unknown ids, when paused and when the stage is too small', () => {
    const engine = engineFor(2);
    const d = new Driver(engine, 2);
    expect(engine.trigger('fallingLeaf', d.input({ dt: 0 }))).toBe(true);
    expect(engine.trigger('boxAppears', d.input({ dt: 0 }))).toBe(false);
    const e2 = engineFor(3);
    const d2 = new Driver(e2, 3);
    expect(e2.trigger('nope' as AnyEventId, d2.input({ dt: 0 }))).toBe(false);
    expect(e2.trigger('fallingLeaf', d2.input({ dt: 0, allowed: false }))).toBe(false);
    expect(e2.trigger('miniTsunami', d2.input({ dt: 0, stage: { x: 0, y: 0, width: 200, height: 700 } }))).toBe(false);
    expect(e2.trigger('meteorShower', d2.input({ dt: 0, choices: { reducedMotion: true } }))).toBe(false);
  });
});

describe('the mouse is never caught', () => {
  it('keeps every approach, sneak and chase at least 0.6 body widths away, and always escapes', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const engine = engineFor(seed);
      const d = new Driver(engine, seed + 500, { temperament: { boldness: 1, playfulness: 1, persistence: 1.6, energy: 1, interest: 1 } });
      expect(engine.trigger('mouseEncounter', d.input({ dt: 0 }))).toBe(true);
      let catX = 700 + (seed % 5) * 40;
      let finished: EventTickOutput | null = null;
      for (let i = 0; i < 4000 && !finished; i++) {
        const o = d.step({ cat: { x: catX } });
        if (o.intent) {
          const k = o.intent.kind;
          expect(['catch', 'pounce', 'bite']).not.toContain(k);
          if (k === 'approach' || k === 'sneak' || k === 'chase') {
            expect(o.intent.standoffPx ?? Infinity).toBeGreaterThanOrEqual(0.6 * BODY_W - 1e-6);
          }
          // The worst case: a cat that ignores the stand-off and runs straight at the mouse.
          if (o.intent.target && k !== 'watch') catX += Math.sign(o.intent.target.x - catX) * Math.min(8, Math.abs(o.intent.target.x - catX));
        }
        if (o.finished) finished = o;
      }
      expect(finished, `seed ${seed}`).not.toBeNull();
      expect(['watched', 'sneaked', 'chased', 'approached', 'unnoticed']).toContain(finished!.finished!.history.outcome);
      expect(finished!.props).toHaveLength(0);
    }
  });

  it('bolts when the cat gets close, away from the cat, and fades out at its destination', () => {
    const engine = engineFor(4);
    const d = new Driver(engine, 4);
    expect(engine.trigger('mouseEncounter', d.input({ dt: 0 }))).toBe(true);
    let first = d.step({ cat: { x: 800 } });
    while (first.props.length === 0) first = d.step({ cat: { x: 800 } });
    const mouseX = first.props[0]!.x;
    // Put the cat next to the mouse after the arrival grace.
    d.run(20, { cat: { x: 800 } });
    const outs = d.run(300, { cat: { x: mouseX + 40 } }, (o) => o.finished !== null);
    const xs = outs.flatMap((o) => o.props.filter((p) => p.kind === 'mouse').map((p) => p.x));
    expect(xs.length).toBeGreaterThan(3);
    const away = Math.sign(mouseX - (mouseX + 40)) || -1;
    const moved = (xs[xs.length - 1]! - xs[0]!) * away;
    expect(moved).toBeGreaterThan(0);
    const alphas = outs.flatMap((o) => o.props.map((p) => p.alpha));
    expect(Math.min(...alphas)).toBeLessThan(0.5);
  });

  it('is missed (outcome unnoticed) by a very drowsy cat that faces away', () => {
    let missed = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const { outs } = playEvent('mouseEncounter', seed, { cat: { facing: -1 }, temperament: { alertness: 0.05, interest: 0 } });
      if (outs[outs.length - 1]!.finished!.history.outcome === 'unnoticed') missed++;
    }
    expect(missed).toBeGreaterThan(0);
  });
});

describe('the mini tsunami stays small', () => {
  it('keeps the wave within ~0.9 cat heights and ~4 body widths, one wave at a time, on the floor', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { outs } = playEvent('miniTsunami', seed, { cat: { x: 400 + (seed % 7) * 150 } });
      let waveSeen = false;
      for (const o of outs) {
        const waves = o.props.filter((p) => p.kind === 'wave');
        expect(waves.length).toBeLessThanOrEqual(1);
        for (const w of waves) {
          waveSeen = true;
          expect(w.size).toBeLessThanOrEqual(WAVE_MAX_WIDTH_BODY * BODY_W + 1e-6);
          expect(w.size).toBeLessThanOrEqual(4 * BODY_W);
          expect(w.size * WAVE_HEIGHT_RATIO).toBeLessThanOrEqual(0.9 * CAT_H);
          expect(w.y).toBeCloseTo(FLOOR_Y, 6);
        }
        expect(o.props.filter((p) => p.kind === 'splash').length).toBeLessThanOrEqual(8);
      }
      expect(waveSeen).toBe(true);
    }
  });

  it('gets the cat wet only with the wet outcome, and then asks for a shake', () => {
    let wet = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { outs } = playEvent('miniTsunami', seed, { temperament: { playfulness: 0.8, startle: 0.1, calm: 0.9 } });
      const outcome = outs[outs.length - 1]!.finished!.history.outcome;
      const splashed = outs.some((o) => o.props.some((p) => p.kind === 'splash'));
      const shook = outs.some((o) => o.intent?.kind === 'shake');
      if (outcome === 'wet') {
        wet++;
        expect(splashed).toBe(true);
        expect(shook).toBe(true);
      } else if (outcome !== 'cut') {
        expect(shook).toBe(false);
      }
    }
    expect(wet).toBeGreaterThan(0);
  });

  it('asks for the climb only in the climbed outcome, with urgency, and lets the sim fall back', () => {
    let climbed = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { outs } = playEvent('miniTsunami', seed, { temperament: { boldness: 1, energy: 1, mischief: 1, playfulness: 0.2 } });
      const outcome = outs[outs.length - 1]!.finished!.history.outcome;
      const climb = outs.find((o) => o.intent?.kind === 'climb');
      if (outcome === 'climbed') {
        climbed++;
        expect(climb?.intent?.urgency).toBeGreaterThanOrEqual(0.6);
      } else expect(climb).toBeUndefined();
    }
    expect(climbed).toBeGreaterThan(0);
  });
});

describe('thunderstorm: no flash, a small localized bolt', () => {
  it('shows at most one small bolt, rumbles once per beat, and has no bolt under reducedMotion', () => {
    let bolts = 0;
    let rumbles = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const { outs } = playEvent('thunderstorm', seed);
      for (const o of outs) {
        const b = o.props.filter((p) => p.kind === 'bolt');
        expect(b.length).toBeLessThanOrEqual(1);
        for (const p of b) {
          bolts++;
          expect(p.size).toBeLessThanOrEqual(0.6 * BODY_W);
        }
        for (const p of o.props) if (p.kind === 'cloud') expect(p.size).toBeLessThanOrEqual(2.2 * BODY_W);
        if (o.intent?.sound === 'rumble') rumbles++;
      }
      const reduced = playEvent('thunderstorm', seed, { choices: { reducedMotion: true } });
      for (const o of reduced.outs) expect(o.props.some((p) => p.kind === 'bolt')).toBe(false);
    }
    expect(bolts).toBeGreaterThan(0);
    expect(rumbles).toBeGreaterThan(0);
  });

  it('sends a sound or an emote only on the tick a beat begins', () => {
    const { outs } = playEvent('thunderstorm', 3);
    const withSound = outs.filter((o) => o.intent?.sound);
    expect(withSound.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < outs.length; i++) {
      const a = outs[i - 1]!.intent;
      const b = outs[i]!.intent;
      expect(Boolean(a?.sound && b?.sound)).toBe(false);
    }
  });
});

describe('reduced motion', () => {
  it('uses fewer particles', () => {
    const maxProps = (id: AnyEventId, reduced: boolean): number => {
      let max = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const { outs } = playEvent(id, seed, { choices: { reducedMotion: reduced } });
        max = Math.max(max, ...outs.map((o) => o.props.length));
      }
      return max;
    };
    for (const id of ['bubbleParty', 'magicSparkles', 'thunderstorm'] as const) expect(maxProps(id, true)).toBeLessThanOrEqual(maxProps(id, false));
    expect(maxProps('thunderstorm', true)).toBeLessThan(maxProps('thunderstorm', false));
  });
});

describe('winding down and interrupts', () => {
  const startedEvent = (id: AnyEventId, seed: number) => {
    const engine = engineFor(seed);
    const d = new Driver(engine, seed + 77);
    expect(engine.trigger(id, d.input({ dt: 0 }))).toBe(true);
    // Run until the props are visible and the cat has noticed.
    d.run(3000, {}, (o) => o.props.length > 0 && o.intent !== null);
    return { engine, d };
  };

  it('winds down gracefully when allowed turns false: no intent, props fade out, outcome cut, no journal', () => {
    for (const id of ['mouseEncounter', 'butterflyEncounter', 'boxAppears', 'thunderstorm', 'bubbleParty'] as const) {
      const { engine, d } = startedEvent(id, 5);
      const o1 = d.step({ allowed: false, dt: 50 });
      expect(o1.intent).toBeNull();
      const outs = d.run(100, { allowed: false, dt: 50 }, (o) => o.finished !== null);
      const last = outs[outs.length - 1]!;
      expect(last.finished?.history.outcome, id).toBe('cut');
      expect(last.finished?.journal).toBeNull();
      expect(last.props).toHaveLength(0);
      expect(outs.length * 50).toBeLessThanOrEqual(1700);
      expect(engine.active).toBe(false);
    }
  });

  it('ends at once with a quick fade on a user or drag interrupt, and reschedules only afterwards', () => {
    for (const reason of ['user', 'drag'] as const) {
      const { engine, d } = startedEvent('butterflyEncounter', 6);
      engine.interrupt(reason);
      const outs = d.run(40, {}, (o) => o.finished !== null);
      expect(outs.length * 50).toBeLessThanOrEqual(350);
      const last = outs[outs.length - 1]!;
      expect(last.finished?.history.outcome).toBe('cut');
      expect(last.props).toHaveLength(0);
      expect(engine.active).toBe(false);
      const ms = engine.msUntilNext(0)!;
      expect(ms).toBeGreaterThanOrEqual(EVENT_DELAY_FLOOR_MS - 1);
    }
  });

  it('winds down on pause-like interrupts too, and a suspend interrupt ends a running event quickly', () => {
    for (const reason of ['pause', 'hidden', 'sleep', 'fullscreen', 'settings'] as const) {
      const { engine, d } = startedEvent('fallingLeaf', 8);
      engine.interrupt(reason);
      const outs = d.run(100, {}, (o) => o.finished !== null);
      expect(outs[outs.length - 1]!.finished).not.toBeNull();
      expect(outs.length * 50).toBeLessThanOrEqual(1700);
    }
    const { engine, d } = startedEvent('fallingLeaf', 9);
    engine.interrupt('suspend');
    const outs = d.run(40, {}, (o) => o.finished !== null);
    expect(outs.length * 50).toBeLessThanOrEqual(350);
  });

  it('winds down when events are switched off mid-event', () => {
    const { engine, d } = startedEvent('boxAppears', 3);
    const outs = d.run(100, { choices: { enabled: false } }, (o) => o.finished !== null);
    expect(outs[outs.length - 1]!.finished?.history.outcome).toBe('cut');
    expect(engine.active).toBe(false);
  });

  it('never leaves props behind on any path, for every event', () => {
    for (const id of ALL_EVENT_IDS) {
      for (const how of ['allowed', 'user', 'pause'] as const) {
        const engine = engineFor(31);
        const d = new Driver(engine, 31, { localHour: 23 });
        expect(engine.trigger(id, d.input({ dt: 0 }))).toBe(true);
        d.run(120 + (id.length % 7) * 40);
        if (how === 'user') engine.interrupt('user');
        if (how === 'pause') engine.interrupt('pause');
        const outs = d.run(300, how === 'allowed' ? { allowed: false } : {}, (o) => o.finished !== null);
        const last = outs[outs.length - 1]!;
        // Either finished early, or the event simply ended on its own meanwhile: either way nothing is left.
        expect(last.props, `${id}/${how}`).toHaveLength(0);
        expect(engine.active, `${id}/${how}`).toBe(false);
      }
    }
  });
});

describe('temperament', () => {
  const outcomes = (id: AnyEventId, temperament: Record<string, number>, n = 120): Map<string, number> => {
    const m = new Map<string, number>();
    for (let seed = 1; seed <= n; seed++) {
      const { outs } = playEvent(id, seed, { temperament });
      const o = outs[outs.length - 1]!.finished!.history.outcome;
      m.set(o, (m.get(o) ?? 0) + 1);
    }
    return m;
  };

  it('lets startle and calm decide between hiding and sitting through the storm', () => {
    const jumpy = outcomes('thunderstorm', { startle: 1, calm: 0, boldness: 0 });
    const steady = outcomes('thunderstorm', { startle: 0, calm: 1, boldness: 1 });
    expect(jumpy.get('hid') ?? 0).toBeGreaterThan(steady.get('hid') ?? 0);
    expect(steady.get('calm') ?? 0).toBeGreaterThan(jumpy.get('calm') ?? 0);
  });

  it('lets a shy cat hide from the midnight visitor and a bold one greet it', () => {
    const run = (t: Record<string, number>): Map<string, number> => {
      const m = new Map<string, number>();
      for (let seed = 1; seed <= 100; seed++) {
        const { outs } = playEvent('midnightVisitor', seed, { localHour: 23, temperament: t });
        const o = outs[outs.length - 1]!.finished!.history.outcome;
        m.set(o, (m.get(o) ?? 0) + 1);
      }
      return m;
    };
    const shy = run({ boldness: 0, startle: 1, interest: 0.2 });
    const bold = run({ boldness: 1, startle: 0, interest: 1 });
    expect(shy.get('hid') ?? 0).toBeGreaterThan(bold.get('hid') ?? 0);
    expect(bold.get('greeted') ?? 0).toBeGreaterThan(shy.get('greeted') ?? 0);
  });

  it('keeps the tiny treasure outcome equal to the object found (the prop variant)', () => {
    const variants = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const { outs } = playEvent('tinyTreasure', seed);
      const outcome = outs[outs.length - 1]!.finished!.history.outcome;
      const idx = EVENT_CATALOG.tinyTreasure.outcomes.findIndex((o) => o.id === outcome);
      if (idx < 0) continue;
      const item = outs.flatMap((o) => o.props).find((p) => p.kind === 'treasure');
      expect(item?.variant).toBe(idx);
      variants.add(idx);
    }
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe('history, journal and restore', () => {
  it('writes a history entry with the outcome token and wall time, and a journal entry only when worthy', () => {
    let worthy = 0;
    let plain = 0;
    for (const id of ALL_EVENT_IDS) {
      for (let seed = 1; seed <= 4; seed++) {
        const { outs } = playEvent(id, seed, { localHour: 23 });
        const fin = outs[outs.length - 1]!.finished!;
        const def = EVENT_CATALOG[id];
        const expectWorthy = def.outcomes.find((o) => o.id === fin.history.outcome)?.journal === true;
        if (expectWorthy) {
          worthy++;
          expect(fin.journal).toEqual({ id, at: fin.history.at, outcome: fin.history.outcome });
        } else {
          plain++;
          expect(fin.journal).toBeNull();
        }
      }
    }
    expect(worthy).toBeGreaterThan(20);
    expect(plain).toBeGreaterThan(0);
  });

  it('snapshots a bounded history and restores it, rescheduling from scratch and dropping a running event', () => {
    const engine = engineFor(10);
    const d = new Driver(engine, 10);
    for (let i = 0; i < EVENT_HISTORY_MAX + 5; i++) {
      engine.trigger('fallingLeaf', d.input({ dt: 0 }));
      d.run(4000, {}, (o) => o.finished !== null);
    }
    const snap = engine.snapshot();
    expect(snap.history).toHaveLength(EVENT_HISTORY_MAX);
    // The snapshot is a copy.
    snap.history[0]!.outcome = 'tampered';
    expect(engine.snapshot().history[0]!.outcome).not.toBe('tampered');

    const fresh = engineFor(99);
    fresh.restore(engine.snapshot());
    expect(fresh.snapshot()).toEqual(engine.snapshot());
    expect(fresh.active).toBe(false);
    const ms = fresh.msUntilNext(0)!;
    expect(ms).toBeGreaterThanOrEqual(EVENT_DELAY_MIN_MS - 1);

    // A running event is never resumed: restore drops it and the next tick shows nothing.
    const running = engineFor(12);
    const dr = new Driver(running, 12);
    running.trigger('boxAppears', dr.input({ dt: 0 }));
    dr.run(100);
    expect(running.active).toBe(true);
    running.restore({ history: [] });
    expect(running.active).toBe(false);
    expect(dr.step().props).toHaveLength(0);
  });

  it('ignores junk in a restored history', () => {
    const engine = engineFor(1);
    const junk = [
      { id: 'nope', at: 1, outcome: 'x' },
      { id: 'fallingLeaf', at: Number.NaN, outcome: 'x' },
      { id: 'fallingLeaf', at: 5, outcome: 7 },
      { id: 'boxAppears', at: 10, outcome: 'entered' },
      null,
    ] as unknown as EventHistoryEntry[];
    engine.restore({ history: junk });
    expect(engine.snapshot().history).toEqual([{ id: 'boxAppears', at: 10, outcome: 'entered' }]);
    const e2 = createWorldEventEngine({ now: 0, random: mulberry32(1), memory: { history: junk } });
    expect(e2.snapshot().history).toHaveLength(1);
  });
});

describe('determinism', () => {
  const trace = (seed: number): string => {
    const engine = engineFor(seed);
    const d = new Driver(engine, seed * 3, { choices: { pace: 2 } });
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const o = d.step({ dt: i % 3 === 0 ? 2000 : 250 });
      if (o.active || o.finished) lines.push(JSON.stringify(o));
    }
    lines.push(JSON.stringify(engine.snapshot()));
    return lines.join('\n');
  };

  it('replays the same schedule, props, intents and history for an equal seed', () => {
    expect(trace(5)).toBe(trace(5));
    expect(trace(5)).not.toBe(trace(6));
    expect(trace(5).length).toBeGreaterThan(200);
  });

  it('replays a forced event identically', () => {
    for (const id of ['mouseEncounter', 'miniTsunami', 'goldenButterfly', 'tinyDragon'] as const) {
      const a = playEvent(id, 3, { localHour: 23 }).outs.map((o) => JSON.stringify(o)).join('|');
      const b = playEvent(id, 3, { localHour: 23 }).outs.map((o) => JSON.stringify(o)).join('|');
      expect(a).toBe(b);
    }
  });

  it('copes with odd input without throwing', () => {
    const engine = engineFor(2);
    const d = new Driver(engine, 2);
    engine.trigger('windGust', d.input({ dt: 0 }));
    const odd = [
      { stage: { x: 0, y: 0, width: 0, height: 0 } },
      { cat: { x: Number.NaN, bodyW: 0 } },
      { stage: { x: Number.NaN, y: 10, width: 800, height: Number.POSITIVE_INFINITY } },
      { temperament: { calm: Number.NaN, persistence: 99 } },
      { dt: Number.NaN },
    ];
    for (const o of odd) {
      expect(() => d.step(o as never)).not.toThrow();
    }
    const inp = makeInput({ dt: 50 });
    expect(() => engine.tick({ ...inp, random: () => Number.NaN })).not.toThrow();
  });
});
