// The world-event catalogue (src/core/events/catalog.ts) and its words (src/shared/worldText.ts):
// coverage of every id, internal consistency, and that the engine's outcomes and the journal's
// sentences line up. SIMULATED: pure data checks. Written in the Living Companion sprint, NOT executed there.
import { describe, expect, it } from 'vitest';
import { ALL_EVENT_IDS, PROP_KINDS, RARE_EVENT_IDS, WORLD_EVENT_IDS, isRareEvent } from '../../../../src/shared/companion';
import { EVENT_CATALOG, NORMAL_POOL, RARE_POOL, isJournalWorthy, outcomeWeights } from '../../../../src/core/events';
import { EVENT_OUTCOME_TOKENS, EVENT_TEXT, eventDescription, eventName, formatJournalDate, journalText } from '../../../../src/shared/worldText';
import { TEMPERAMENT } from './helpers';

describe('catalogue', () => {
  it('has exactly one entry per event id, 20 normal and 6 rare', () => {
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual([...ALL_EVENT_IDS].sort());
    expect(WORLD_EVENT_IDS).toHaveLength(20);
    expect(RARE_EVENT_IDS).toHaveLength(6);
    expect(NORMAL_POOL).toHaveLength(20);
    expect(RARE_POOL).toHaveLength(6);
    for (const id of ALL_EVENT_IDS) {
      const def = EVENT_CATALOG[id];
      expect(def.id).toBe(id);
      expect(def.rare).toBe(isRareEvent(id));
    }
  });

  it('keeps every field sane', () => {
    for (const id of ALL_EVENT_IDS) {
      const d = EVENT_CATALOG[id];
      expect(d.weight, id).toBeGreaterThan(0);
      expect(d.durationS[0], id).toBeGreaterThan(0);
      expect(d.durationS[1], id).toBeGreaterThanOrEqual(d.durationS[0]);
      expect(d.noticeMs[1], id).toBeGreaterThanOrEqual(d.noticeMs[0]);
      expect(d.minFloorPx, id).toBeGreaterThan(0);
      expect(d.minHeightBody, id).toBeGreaterThan(0);
      expect(d.recoverMs, id).toBeGreaterThanOrEqual(0);
      expect(d.mood.strength, id).toBeGreaterThan(0);
      expect(d.mood.strength, id).toBeLessThanOrEqual(1);
      expect(d.props.length, id).toBeGreaterThan(0);
      for (const p of d.props) expect(PROP_KINDS as readonly string[], `${id}:${p}`).toContain(p);
      expect(d.outcomes.length, id).toBeGreaterThanOrEqual(3);
      expect(new Set(d.outcomes.map((o) => o.id)).size, id).toBe(d.outcomes.length);
    }
  });

  it('keeps the rare pool apart: lower weights, longer events, its own look', () => {
    const normalMax = Math.max(...NORMAL_POOL.map((id) => EVENT_CATALOG[id].weight));
    for (const id of RARE_POOL) {
      expect(EVENT_CATALOG[id].weight).toBeLessThan(normalMax);
    }
    expect(EVENT_CATALOG.goldenButterfly.durationS[0]).toBeGreaterThan(EVENT_CATALOG.butterflyEncounter.durationS[1]);
    expect(EVENT_CATALOG.midnightVisitor.time.strict).toEqual([22, 5]);
    expect(EVENT_CATALOG.meteorShower.skipReduced).toBe(true);
    expect(EVENT_CATALOG.goldenButterfly.props).toContain('goldenButterfly');
    expect(EVENT_CATALOG.tinyDragon.props).toContain('dragon');
    for (const id of RARE_POOL) for (const o of EVENT_CATALOG[id].outcomes) expect(o.journal, `${id}:${o.id}`).toBe(true);
  });

  it('gives every event its own beats, in order, starting at zero', () => {
    for (const id of ALL_EVENT_IDS) {
      for (const o of EVENT_CATALOG[id].outcomes) {
        expect(o.weight, `${id}:${o.id}`).toBeGreaterThan(0);
        expect(o.beats.length, `${id}:${o.id}`).toBeGreaterThan(0);
        expect(o.beats[0]!.from, `${id}:${o.id}`).toBe(0);
        let prev = -1;
        for (const b of o.beats) {
          expect(b.from).toBeGreaterThanOrEqual(0);
          expect(b.from).toBeLessThanOrEqual(1);
          expect(b.from).toBeGreaterThanOrEqual(prev);
          prev = b.from;
          if (b.urgency !== undefined) {
            expect(b.urgency).toBeGreaterThanOrEqual(0);
            expect(b.urgency).toBeLessThanOrEqual(1);
          }
          expect(b.kind).not.toBe('catch');
        }
      }
    }
  });

  it('declares every temperament axis an outcome leans on', () => {
    for (const id of ALL_EVENT_IDS) {
      const d = EVENT_CATALOG[id];
      for (const o of d.outcomes) {
        for (const k of Object.keys(o.bias ?? {})) expect(d.temperament as readonly string[], `${id}:${o.id}:${k}`).toContain(k);
      }
    }
  });

  it('is not 26 clones: mechanics, sizes of the stage they need and outcomes differ', () => {
    const mechanics = new Set(ALL_EVENT_IDS.map((id) => EVENT_CATALOG[id].mechanic));
    expect(mechanics.size).toBeGreaterThanOrEqual(8);
    const signatures = new Set(ALL_EVENT_IDS.map((id) => `${EVENT_CATALOG[id].outcomes.map((o) => o.id).join(',')}|${EVENT_CATALOG[id].props.join(',')}`));
    expect(signatures.size).toBeGreaterThanOrEqual(24);
  });

  it('tilts outcome weights with the temperament and keeps them positive', () => {
    const def = EVENT_CATALOG.thunderstorm;
    const jumpy = outcomeWeights(def, { ...TEMPERAMENT, startle: 1, calm: 0, boldness: 0 });
    const steady = outcomeWeights(def, { ...TEMPERAMENT, startle: 0, calm: 1, boldness: 1 });
    const w = (list: readonly { id: string; weight: number }[], id: string): number => list.find((x) => x.id === id)!.weight;
    expect(w(jumpy, 'hid')).toBeGreaterThan(w(steady, 'hid'));
    expect(w(steady, 'calm')).toBeGreaterThan(w(jumpy, 'calm'));
    for (const id of ALL_EVENT_IDS) for (const x of outcomeWeights(EVENT_CATALOG[id], TEMPERAMENT)) expect(x.weight).toBeGreaterThan(0);
  });

  it('knows which outcomes are journal-worthy; cut and unnoticed never are', () => {
    for (const id of ALL_EVENT_IDS) {
      const d = EVENT_CATALOG[id];
      expect(isJournalWorthy(d, 'cut')).toBe(false);
      expect(isJournalWorthy(d, 'unnoticed')).toBe(false);
      expect(d.outcomes.some((o) => o.journal), id).toBe(true);
    }
    expect(isJournalWorthy(EVENT_CATALOG.miniTsunami, 'wet')).toBe(true);
    expect(isJournalWorthy(EVENT_CATALOG.miniTsunami, 'moved')).toBe(false);
  });
});

describe('world text', () => {
  it('covers every event with a name, a description and a sentence for every engine outcome', () => {
    for (const id of ALL_EVENT_IDS) {
      const t = EVENT_TEXT[id];
      expect(eventName(id).length, id).toBeGreaterThan(2);
      expect(eventDescription(id).length, id).toBeGreaterThan(10);
      expect(t.fallback.length, id).toBeGreaterThan(10);
      const tokens = EVENT_CATALOG[id].outcomes.map((o) => o.id).sort();
      expect([...EVENT_OUTCOME_TOKENS[id]].sort(), id).toEqual(tokens);
      for (const tok of tokens) {
        expect(journalText(id, tok), `${id}:${tok}`).toBe(t.outcomes[tok]);
        expect(t.outcomes[tok]!.length).toBeGreaterThan(15);
      }
    }
  });

  it('keeps the tone: no exclamation marks, no streak or guilt wording, no emoji', () => {
    const banned = /(!|\bstreaks?\b|missed|you should|don't forget|\p{Extended_Pictographic})/iu;
    for (const id of ALL_EVENT_IDS) {
      const t = EVENT_TEXT[id];
      for (const s of [t.name, t.description, t.fallback, ...Object.values(t.outcomes)]) expect(s, `${id}: ${s}`).not.toMatch(banned);
    }
  });

  it('falls back sensibly for an unknown outcome or event', () => {
    expect(journalText('mouseEncounter', 'cut')).toBe(EVENT_TEXT.mouseEncounter.fallback);
    expect(journalText('mouseEncounter', 'unnoticed')).toBe(EVENT_TEXT.mouseEncounter.fallback);
    expect(journalText('mouseEncounter', 'something-new-from-a-later-build')).toBe(EVENT_TEXT.mouseEncounter.fallback);
    expect(journalText('nope' as never, 'x').length).toBeGreaterThan(5);
    expect(eventName('nope' as never)).toBe('nope');
  });

  it('formats a date without Intl: YYYY-MM-DD, empty for a bad time', () => {
    const at = new Date(2026, 10, 3, 14, 5).getTime();
    expect(formatJournalDate(at)).toBe('2026-11-03');
    expect(formatJournalDate(new Date(2027, 0, 9, 0, 1).getTime())).toBe('2027-01-09');
    expect(formatJournalDate(Number.NaN)).toBe('');
    expect(formatJournalDate(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatJournalDate(8.64e15 + 1)).toBe('');
  });
});
