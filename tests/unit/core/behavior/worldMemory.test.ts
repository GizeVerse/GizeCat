import { describe, expect, it } from 'vitest';
import { CAT_STATE_SCHEMA_VERSION, OUTCOME_TOKEN_PATTERN, PersistedCatSchema, WORLD_COUNT_MAX, WorldMemorySchema, type WorldMemory } from '../../../../src/shared/catState';
import { ALL_EVENT_IDS, EVENT_HISTORY_MAX, JOURNAL_MAX, type AnyEventId } from '../../../../src/shared/companion';
import { migrateCatState, mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { appendEventHistory, appendJournal, boundedWorldMemory, clearJournal, clearWorldMemory, emptyWorldMemory, eventCount } from '../../../../src/core/behavior/worldMemory';

const NOW = 1_800_000_000_000;
const entry = (i: number, id: AnyEventId = ALL_EVENT_IDS[i % ALL_EVENT_IDS.length] as AnyEventId, outcome = 'watched') => ({ id, at: NOW - 1000 + i, outcome });

describe('world memory helpers', () => {
  it('starts empty', () => {
    expect(emptyWorldMemory()).toEqual({ events: [], counts: {}, lastEndedAt: 0, journal: [] });
    expect(clearWorldMemory()).toEqual(emptyWorldMemory());
  });

  it('appends history newest last, counts each event and moves lastEndedAt forward; the input is untouched', () => {
    const w0 = emptyWorldMemory();
    const w1 = appendEventHistory(w0, entry(1, 'tinyUfo'));
    const w2 = appendEventHistory(w1, entry(2, 'tinyUfo', 'chased'));
    expect(w0).toEqual(emptyWorldMemory());
    expect(w2.events.map((e) => e.outcome)).toEqual(['watched', 'chased']);
    expect(eventCount(w2, 'tinyUfo')).toBe(2);
    expect(eventCount(w2, 'windGust')).toBe(0);
    expect(w2.lastEndedAt).toBe(NOW - 1000 + 2);
    // An older event never moves the schedule time back.
    expect(appendEventHistory(w2, entry(-500, 'windGust')).lastEndedAt).toBe(w2.lastEndedAt);
  });

  it('bounds the history at EVENT_HISTORY_MAX, dropping the oldest, and the counters at WORLD_COUNT_MAX', () => {
    let w = emptyWorldMemory();
    for (let i = 0; i < EVENT_HISTORY_MAX * 3; i++) w = appendEventHistory(w, entry(i));
    expect(w.events).toHaveLength(EVENT_HISTORY_MAX);
    expect(w.events[w.events.length - 1]).toEqual(entry(EVENT_HISTORY_MAX * 3 - 1));
    expect(w.events[0]).toEqual(entry(EVENT_HISTORY_MAX * 2));
    const capped = appendEventHistory({ ...emptyWorldMemory(), counts: { tinyUfo: WORLD_COUNT_MAX } }, entry(1, 'tinyUfo'));
    expect(capped.counts.tinyUfo).toBe(WORLD_COUNT_MAX);
  });

  it('bounds the journal at JOURNAL_MAX (newest last) and clearJournal empties only the journal', () => {
    let w = emptyWorldMemory();
    for (let i = 0; i < JOURNAL_MAX + 25; i++) w = appendJournal(w, entry(i));
    expect(w.journal).toHaveLength(JOURNAL_MAX);
    expect(w.journal[JOURNAL_MAX - 1]).toEqual(entry(JOURNAL_MAX + 24));
    expect(w.journal[0]).toEqual(entry(25));
    w = appendEventHistory(w, entry(1, 'windGust'));
    const cleared = clearJournal(w);
    expect(cleared.journal).toEqual([]);
    expect(cleared.events).toEqual(w.events);
    expect(cleared.counts).toEqual(w.counts);
    expect(w.journal).toHaveLength(JOURNAL_MAX);
  });

  it('refuses entries that are not content-free tokens of this catalogue', () => {
    const w = emptyWorldMemory();
    for (const bad of [
      { id: 'notAnEvent', at: 1, outcome: 'watched' },
      { id: 'tinyUfo', at: 1, outcome: 'Watched It' },
      { id: 'tinyUfo', at: 1, outcome: 'x'.repeat(25) },
      { id: 'tinyUfo', at: 1, outcome: '' },
      { id: 'tinyUfo', at: -1, outcome: 'ok' },
      { id: 'tinyUfo', at: Number.NaN, outcome: 'ok' },
      { id: 'tinyUfo', at: 1, outcome: 7 },
      null,
    ]) {
      expect(appendEventHistory(w, bad as never), JSON.stringify(bad)).toEqual(w);
      expect(appendJournal(w, bad as never), JSON.stringify(bad)).toEqual(w);
    }
    expect(OUTCOME_TOKEN_PATTERN.test('watched_closely_2')).toBe(true);
    expect(OUTCOME_TOKEN_PATTERN.test('x'.repeat(24))).toBe(true);
  });

  it('re-bounds an over-long or foreign world memory on the way through', () => {
    const fat = {
      events: Array.from({ length: 100 }, (_, i) => entry(i)),
      counts: { tinyUfo: 5, bogus: 9 } as unknown as WorldMemory['counts'],
      lastEndedAt: Number.NaN,
      journal: Array.from({ length: 500 }, (_, i) => entry(i)),
    } satisfies WorldMemory;
    const b = boundedWorldMemory(fat);
    expect(b.events).toHaveLength(EVENT_HISTORY_MAX);
    expect(b.journal).toHaveLength(JOURNAL_MAX);
    expect(b.counts).toEqual({ tinyUfo: 5 });
    expect(b.lastEndedAt).toBe(0);
  });
});

describe('world memory in the persisted cat', () => {
  const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...(JSON.parse(JSON.stringify(newPersistedCat(mulberry32(3), NOW - 5000))) as Record<string, unknown>), ...over });

  it('an old cat file (no world) loads unchanged, with the empty world, and is not recovered', () => {
    const old = raw();
    delete old.world;
    const r = migrateCatState(old, mulberry32(1), NOW);
    expect(r.recovered).toBe(false);
    expect(r.cat.world).toEqual(emptyWorldMemory());
    const fresh = newPersistedCat(mulberry32(3), NOW - 5000);
    expect({ ...r.cat, world: undefined }).toEqual({ ...fresh, world: undefined });
    expect(CAT_STATE_SCHEMA_VERSION).toBe(1);
  });

  it('a new cat carries the empty world and the schema version is not bumped', () => {
    expect(newPersistedCat(mulberry32(3), NOW).world).toEqual(emptyWorldMemory());
    expect(PersistedCatSchema.parse(raw()).schemaVersion).toBe(1);
  });

  it('round-trips a valid world', () => {
    const world = { events: [entry(1, 'tinyUfo')], counts: { tinyUfo: 2, windGust: 1 }, lastEndedAt: NOW - 999, journal: [entry(1, 'tinyUfo')] };
    const r = migrateCatState(raw({ world }), mulberry32(1), NOW);
    expect(r.cat.world).toEqual(world);
    expect(PersistedCatSchema.parse(JSON.parse(JSON.stringify(r.cat))).world).toEqual(world);
  });

  it('strips unknown ids and bad entries one by one, bounds the lists on load, and never loses the cat', () => {
    const world = {
      events: [entry(1, 'tinyUfo'), { id: 'newerVersionEvent', at: 5, outcome: 'ok' }, { id: 'windGust', at: 1, outcome: 'Bad Token!' }, 'junk', null, entry(2, 'windGust')],
      counts: { tinyUfo: 3.9, bogus: 4, windGust: -2, thunderstorm: 'many', paperPlane: 1e12 },
      lastEndedAt: 'yesterday',
      journal: Array.from({ length: 300 }, (_, i) => entry(i)),
    };
    const r = migrateCatState(raw({ world }), mulberry32(1), NOW);
    expect(r.recovered).toBe(false);
    expect(r.cat.world.events.map((e) => e.id)).toEqual(['tinyUfo', 'windGust']);
    expect(r.cat.world.counts).toEqual({ tinyUfo: 3, paperPlane: WORLD_COUNT_MAX });
    expect(r.cat.world.lastEndedAt).toBe(0);
    expect(r.cat.world.journal).toHaveLength(JOURNAL_MAX);
    expect(r.cat.world.journal[JOURNAL_MAX - 1]).toEqual(entry(299));
  });

  it('survives garbage in the whole section', () => {
    for (const world of ['nope', 42, null, [], { events: 'x', counts: [], journal: { a: 1 } }]) {
      const r = migrateCatState(raw({ world }), mulberry32(1), NOW);
      expect(r.recovered).toBe(false);
      expect(r.cat.world).toEqual(emptyWorldMemory());
    }
    expect(WorldMemorySchema.parse({})).toEqual(emptyWorldMemory());
  });

  it('caps times from the future at the load clock, keeping the order', () => {
    const world = { events: [entry(1, 'tinyUfo')], counts: {}, lastEndedAt: NOW + 86_400_000, journal: [{ id: 'tinyUfo', at: NOW + 5000, outcome: 'watched' }] };
    const r = migrateCatState(raw({ world }), mulberry32(1), NOW);
    expect(r.cat.world.lastEndedAt).toBe(NOW);
    expect(r.cat.world.journal[0]?.at).toBe(NOW);
  });
});
