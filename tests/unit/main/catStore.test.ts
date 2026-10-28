import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PersistedCat } from '../../../src/shared/catState';
import { PersistedCatSchema } from '../../../src/shared/catState';
import { createCatStore, type MigrateCatState } from '../../../src/main/store/catStore';
import { createJsonStore } from '../../../src/main/store/jsonStore';
import { memoryLogger, removeDir, tempDir } from './helpers';

function cat(id: string, savedAt = 1): PersistedCat {
  return PersistedCatSchema.parse({ schemaVersion: 1, catId: id, bornAt: 1000, savedAt });
}

/** Mirrors the core contract: invalid identity => new cat with recovered=true. */
const migrate: MigrateCatState = (raw, random) => {
  const parsed = PersistedCatSchema.safeParse(raw);
  if (parsed.success) return { cat: parsed.data, recovered: false };
  return { cat: cat(`fresh-${Math.floor(random() * 1e6).toString().padStart(6, '0')}`), recovered: true };
};

describe('catStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'cat-state.json');
  });
  afterEach(() => removeDir(dir));

  function make(intervals: Array<() => void> = []) {
    return createCatStore({
      store: createJsonStore({ filePath: file }),
      migrate,
      logger: memoryLogger(),
      random: () => 0.5,
      wallClock: () => 5000,
      autosaveMs: 60_000,
      setInterval: (fn) => {
        intervals.push(fn);
        return intervals.length;
      },
      clearInterval: () => undefined,
    });
  }

  it('creates a new cat when nothing is stored (not reported as recovered)', () => {
    const r = make().load();
    expect(r).toMatchObject({ recovered: false, source: 'new' });
    expect(r.cat.catId).toBe('fresh-500000');
  });

  it('loads a valid stored cat', () => {
    fs.writeFileSync(file, JSON.stringify(cat('stored-cat-1')));
    expect(make().load()).toMatchObject({ recovered: false, source: 'file', cat: { catId: 'stored-cat-1' } });
  });

  it('recovers from an unparseable file via the backup', () => {
    const s = make();
    s.attach(() => cat('first-good-cat'));
    s.saveSync();
    s.attach(() => cat('second-good-cat'));
    s.saveSync();
    fs.writeFileSync(file, '{"schemaVersion":1, broken');
    const r = make().load();
    expect(r).toMatchObject({ recovered: true, source: 'backup', cat: { catId: 'first-good-cat' } });
    expect(fs.readdirSync(dir).some((n) => n.startsWith('cat-state.corrupt-'))).toBe(true);
  });

  it('prefers a valid backup when the main file parses but fails validation', () => {
    const s = make();
    s.attach(() => cat('backup-cat-ok'));
    s.saveSync();
    s.saveSync();
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, catId: 'x' }));
    const r = make().load();
    expect(r).toMatchObject({ recovered: true, source: 'backup', cat: { catId: 'backup-cat-ok' } });
  });

  it('starts a fresh cat when the file and backup are both unusable', () => {
    fs.writeFileSync(file, 'garbage');
    const store = make();
    const r = store.load();
    expect(r).toMatchObject({ recovered: true, source: 'new' });
    expect(store.dirty).toBe(true);
  });

  it('autosaves only while dirty and saves synchronously on demand', async () => {
    const intervals: Array<() => void> = [];
    const store = make(intervals);
    store.load();
    let n = 0;
    store.attach(() => cat(`snapshot-${String(++n).padStart(4, '0')}`));
    expect(intervals).toHaveLength(1);
    intervals[0]!();
    expect(fs.existsSync(file)).toBe(false);
    store.markDirty();
    intervals[0]!();
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).catId).toBe('snapshot-0001');
    expect(store.dirty).toBe(false);
    expect(store.saveSync()).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).catId).toBe('snapshot-0002');
  });

  it('save without a snapshot provider is a no-op', async () => {
    const store = make();
    expect(await store.save()).toBe(false);
    expect(store.saveSync()).toBe(false);
  });

  it('a throwing snapshot provider is contained', () => {
    const store = make();
    store.attach(() => {
      throw new Error('sim exploded');
    });
    expect(store.saveSync()).toBe(false);
  });
});
