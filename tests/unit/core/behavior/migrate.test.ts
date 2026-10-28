import { describe, expect, it } from 'vitest';
import { PersistedCatSchema } from '../../../../src/shared/catState';
import { migrateCatState, mulberry32, newPersistedCat, summarizeCat } from '../../../../src/core/behavior';
import { DUAL_MIXED, Harness, SINGLE } from './fixtures';

const NOW = 1_800_000_000_000;

describe('migrateCatState', () => {
  it.each([null, undefined, 42, 'cat', [], {}, { schemaVersion: 'v9' }, { schemaVersion: 1 }, { schemaVersion: 0, catId: 'cat-1234567890' }, { schemaVersion: 1.5, catId: 'cat-1234567890', bornAt: 1 }])(
    'creates a new cat for unusable input %#',
    (raw) => {
      const r = migrateCatState(raw, mulberry32(1), NOW);
      expect(r.recovered).toBe(true);
      expect(PersistedCatSchema.safeParse(r.cat).success).toBe(true);
      expect(r.cat.bornAt).toBe(NOW);
    },
  );

  it('keeps the identity and defaults corrupt fields one by one', () => {
    const cat = newPersistedCat(mulberry32(5), NOW - 1000);
    const raw = JSON.parse(JSON.stringify(cat)) as Record<string, unknown>;
    (raw.stats as Record<string, unknown>).energy = 'high';
    (raw.memory as Record<string, unknown>).favoriteSpots = 'nope';
    raw.lastPosition = { displayKey: 7 };
    const r = migrateCatState(raw, mulberry32(1), NOW);
    expect(r.recovered).toBe(false);
    expect(r.cat.catId).toBe(cat.catId);
    expect(r.cat.traits).toEqual(cat.traits);
    expect(r.cat.stats.energy).toBe(0.8);
    expect(r.cat.memory.favoriteSpots).toEqual([]);
    expect(r.cat.lastPosition).toBeNull();
  });

  it('reads newer schema versions best-effort', () => {
    const cat = newPersistedCat(mulberry32(5), NOW - 1000);
    const raw = { ...JSON.parse(JSON.stringify(cat)), schemaVersion: 7, futureField: { a: 1 } };
    const r = migrateCatState(raw, mulberry32(1), NOW);
    expect(r.recovered).toBe(false);
    expect(r.cat.schemaVersion).toBe(1);
    expect(r.cat.catId).toBe(cat.catId);
    expect('futureField' in r.cat).toBe(false);
  });

  it('caps timestamps from the future and drops memory entries that are not known tokens', () => {
    const cat = newPersistedCat(mulberry32(5), NOW);
    cat.bornAt = NOW + 1e9;
    cat.memory.recent = [
      { at: NOW + 5e9, kind: 'pet' },
      { at: NOW - 10, kind: 'Inbox - Outlook' },
      { at: NOW - 20, kind: 'nap', detail: 'secret.docx' },
    ];
    const r = migrateCatState(cat, mulberry32(1), NOW);
    expect(r.cat.bornAt).toBe(NOW);
    expect(r.cat.memory.recent.map((e) => e.kind)).toEqual(['nap', 'pet']);
    expect(r.cat.memory.recent.every((e) => e.detail === undefined)).toBe(true);
    expect(r.cat.memory.recent.every((e) => e.at <= NOW)).toBe(true);
  });
});

describe('persistence round-trip', () => {
  it('serialize -> JSON -> migrate -> new sim restores identity, memory and position', () => {
    const a = new Harness({ seed: 3, world: DUAL_MIXED });
    a.run(5000, 50, (_h, i) => (i % 20 === 0 ? [{ type: 'pointer.pet', at: { x: 0, y: 0 }, strength: 0.8 }] : []));
    const saved = a.sim.serialize();
    expect(PersistedCatSchema.safeParse(saved).success).toBe(true);
    expect(saved.memory.counters.pets).toBeGreaterThan(0);
    expect(saved.lastPosition?.displayKey).toBe(a.last?.displayId);
    const restored = migrateCatState(JSON.parse(JSON.stringify(saved)), mulberry32(9), NOW);
    expect(restored.recovered).toBe(false);
    expect(restored.cat.catId).toBe(saved.catId);
    expect(restored.cat.memory.counters).toEqual(saved.memory.counters);

    const b = new Harness({ seed: 4, world: DUAL_MIXED, persisted: restored.cat });
    const first = b.step();
    expect(first.state).toBe('sleeping');
    expect(first.displayId).toBe(saved.lastPosition?.displayKey);
    const d = DUAL_MIXED.displays.find((x) => x.id === first.displayId)!;
    const xFrac = (first.x - d.workAreaPx.x) / d.workAreaPx.width;
    expect(Math.abs(xFrac - (saved.lastPosition?.xFrac ?? 0))).toBeLessThan(0.05);
    expect(first.snap).toBe(true);
    expect(b.runUntil((o) => o.state === 'wakingUp', 2000)).toBe(true);
    expect(b.last?.clip).toBe('wake');
    expect(b.sim.serialize().memory.counters.sessions).toBe(saved.memory.counters.sessions + 1);
  });

  it('falls back to the primary display when the saved display is gone', () => {
    const cat = newPersistedCat(mulberry32(5), NOW);
    cat.lastPosition = { displayKey: 'gone', xFrac: 0.25, support: 'window' };
    const h = new Harness({ persisted: cat, world: SINGLE });
    const o = h.step();
    expect(o.displayId).toBe('1');
    expect(o.support).toEqual({ kind: 'floor', displayId: '1' });
    expect(o.x).toBeCloseTo(0.25 * 1920, 0);
    expect(o.y).toBe(1040);
  });

  it('summarizes without sensitive data', () => {
    const h = new Harness({ seed: 2 });
    h.run(2000);
    const s = summarizeCat(h.sim, 'Miso');
    expect(s.name).toBe('Miso');
    expect(s.state).toBe(h.sim.state);
    expect(s.favoriteSpotCount).toBe(0);
    expect(Object.keys(s).sort()).toEqual(['bornAt', 'catId', 'counters', 'favoriteSpotCount', 'name', 'preferences', 'recent', 'state', 'stats', 'traits']);
  });
});
