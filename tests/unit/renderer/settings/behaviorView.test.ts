// v1.2 Diagnostics -> Behaviour (ADR 0003 §11): the DOM-free view model turns the validated
// profile into labelled rows; the page polls it only while shown.
import { describe, expect, it } from 'vitest';
import { emptyBehaviorProfile, type BehaviorProfileSnapshot } from '../../../../src/shared/behaviorProfile';
import { CLASS_ORDER, countList, huntEntries, moodEntries, physicsEntries, reactionSummary, stayEntries, summaryEntries, timeRows } from '../../../../src/renderer/settings/behaviorView';
import { BEHAVIOR_REFRESH_MS, behaviorPoll } from '../../../../src/renderer/settings/pages/diagnostics';
import type { Timers } from '../../../../src/renderer/settings/store';
import { S } from '../../../../src/renderer/settings/strings';
import { previewBehaviorProfile } from './preview/fixture';

const V = S.diagnostics.behavior;
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const value = (entries: ReadonlyArray<readonly [string, string]>, label: string): string | undefined => entries.find(([l]) => l === label)?.[1];

describe('Behaviour section view model', () => {
  const p = previewBehaviorProfile(NOW);

  it('summarises the session: span, active share, decisions, naps, stuck resets', () => {
    const e = summaryEntries(p);
    expect(value(e, V.span)).toBe('1 h 40 min');
    expect(value(e, V.activeShare)).toBe('27%');
    expect(value(e, V.decisions)).toBe('412');
    expect(value(e, V.naps)).toBe('2');
    expect(value(e, V.stuckResets)).toBe('0');
  });

  it('lists time per activity class in a fixed order, with shares of all counted time', () => {
    const rows = timeRows(p);
    expect(rows.map((r) => r.cls)).toEqual([...CLASS_ORDER]);
    expect(rows[0]).toMatchObject({ label: 'Active', time: '22 min', share: '22%' });
    expect(rows.find((r) => r.cls === 'away')).toMatchObject({ time: '0 s', share: '0%' });
  });

  it('describes stays: arrivals, where, length quantiles, how they ended and how it got down', () => {
    const e = stayEntries(p);
    expect(value(e, V.arrivals)).toBe('11');
    expect(value(e, V.where)).toBe('Window tops 8 · Tab strips 3');
    expect(value(e, V.dwell)).toBe(V.dwellValue('2 min 22 s', '38 s', '6 min 45 s', 10));
    expect(value(e, V.ends)).toBe('It left on its own 7 · You picked it up 2 · A window covered it 1');
    expect(value(e, V.leaves)).toBe('Jumped down 3 · Climbed down 2 · Climbed part-way and leapt 1 · Hopped across 1');
  });

  it('describes hunts, falls, slips, edges, reactions, moods and context', () => {
    expect(value(huntEntries(p), V.outcomes)).toBe('Lost interest 4 · Caught it 2 · Missed 2 · Stopped (you were busy) 1');
    expect(value(physicsEntries(p), V.falls)).toBe('6 · Thrown 5 · Slipped 1');
    expect(value(physicsEntries(p), V.impacts)).toBe('Soft 3 · Medium 2 · Hard 1');
    expect(value(physicsEntries(p), V.edgePeeks)).toBe('1');
    // Ties keep the contract's order (startledJump before grumpy before playful).
    expect(reactionSummary(p)).toBe('Shrugged it off 2 · Jumped away 1 · Grumpy 1 · Made a game of it 1');
    const m = moodEntries(p);
    expect(value(m, V.moods.wary)).toBe('3 min');
    expect(value(m, V.contexts.typing)).toBe('31 min');
    expect(m).toHaveLength(6);
  });

  it('reads sensibly for a fresh session', () => {
    const empty = emptyBehaviorProfile(0);
    expect(value(stayEntries(empty), V.dwell)).toBe(V.noStays);
    expect(value(stayEntries(empty), V.ends)).toBe(V.noStays);
    expect(value(physicsEntries(empty), V.falls)).toBe('0');
    expect(reactionSummary(empty)).toBe(V.none);
    expect(timeRows(empty).every((r) => r.share === '0%')).toBe(true);
  });

  it('countList ignores zero, unknown and non-finite counts', () => {
    const labels = { a: 'A', b: 'B', c: 'C' };
    expect(countList({ a: 0, b: 2, c: Number.NaN }, ['a', 'b', 'c'], labels, '-')).toBe('B 2');
    expect(countList({ zzz: 5 } as Record<string, number>, ['a', 'b', 'c'], labels, '-')).toBe('-');
    expect(countList({ a: 1, b: 1 }, ['a', 'b', 'c'], labels, '-')).toBe('A 1 · B 1');
  });
});

describe('Behaviour section poll', () => {
  function timers(): Timers & { fire(): void } {
    let pending: (() => void) | null = null;
    return {
      setTimeout(fn) {
        pending = fn;
        return 1;
      },
      clearTimeout() {
        pending = null;
      },
      fire() {
        const fn = pending;
        pending = null;
        fn?.();
      },
    };
  }
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it('reads only while the page is shown and the window visible, and reports failures as unavailable', async () => {
    const results: Array<BehaviorProfileSnapshot | null> = [];
    let calls = 0;
    let fail = false;
    const api = {
      getBehaviorProfile: () => {
        calls++;
        return fail ? Promise.reject(new Error('Too many requests')) : Promise.resolve(emptyBehaviorProfile(0));
      },
    };
    const element = { hidden: false };
    const doc = { visibilityState: 'visible' as DocumentVisibilityState };
    const t = timers();
    const poll = behaviorPoll(api, t, element, (r) => results.push(r), doc);
    poll.start();
    await flush();
    expect(calls).toBe(1);
    element.hidden = true;
    t.fire();
    await flush();
    expect(calls).toBe(1);
    element.hidden = false;
    doc.visibilityState = 'hidden';
    t.fire();
    await flush();
    expect(calls).toBe(1);
    doc.visibilityState = 'visible';
    fail = true;
    t.fire();
    await flush();
    expect(calls).toBe(2);
    expect(results.at(-1)).toBeNull();
    poll.stop();
    expect(poll.running).toBe(false);
    expect(BEHAVIOR_REFRESH_MS).toBeGreaterThanOrEqual(1000);
  });
});
