import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonStore, quarantineName } from '../../../src/main/store/jsonStore';
import { memoryLogger, removeDir, tempDir } from './helpers';

describe('jsonStore', () => {
  let dir: string;
  let file: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'settings.json');
    clock = Date.UTC(2026, 9, 28, 12, 0, 0);
  });
  afterEach(() => removeDir(dir));

  it('reports a missing file without creating anything', () => {
    const store = createJsonStore({ filePath: file, now });
    expect(store.read()).toEqual({ status: 'missing', value: null, quarantinedTo: null });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writes atomically and keeps the previous version as .bak', () => {
    const store = createJsonStore({ filePath: file, now });
    expect(store.writeSync({ v: 1 })).toBe(true);
    expect(fs.existsSync(store.backupPath)).toBe(false);
    expect(store.writeSync({ v: 2 })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 2 });
    expect(JSON.parse(fs.readFileSync(store.backupPath, 'utf8'))).toEqual({ v: 1 });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(store.read()).toEqual({ status: 'ok', value: { v: 2 }, quarantinedTo: null });
  });

  it('quarantines an unparseable file and recovers from the backup', () => {
    const log = memoryLogger();
    const store = createJsonStore({ filePath: file, now, logger: log });
    store.writeSync({ v: 1 });
    store.writeSync({ v: 2 });
    fs.writeFileSync(file, '{"v": 3,,,');
    const r = store.read();
    expect(r.status).toBe('recovered-backup');
    expect(r.value).toEqual({ v: 1 });
    expect(r.quarantinedTo).toBe(quarantineName(file, clock));
    expect(fs.readFileSync(r.quarantinedTo!, 'utf8')).toBe('{"v": 3,,,');
    expect(fs.existsSync(file)).toBe(false);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg.includes('recovered from backup'))).toBe(true);
  });

  it('reports corrupt when neither file nor backup parse', () => {
    const store = createJsonStore({ filePath: file, now });
    fs.writeFileSync(file, '');
    const r = store.read();
    expect(r.status).toBe('corrupt');
    expect(r.value).toBeNull();
    expect(r.quarantinedTo).not.toBeNull();
  });

  it('keeps at most three quarantined files', () => {
    const store = createJsonStore({ filePath: file, now, maxQuarantined: 3 });
    for (let i = 0; i < 5; i++) {
      clock += 1000;
      fs.writeFileSync(file, `garbage ${i}`);
      store.read();
    }
    const q = fs.readdirSync(dir).filter((n) => n.startsWith('settings.corrupt-')).sort();
    expect(q).toHaveLength(3);
    expect(fs.readFileSync(path.join(dir, q[2]!), 'utf8')).toBe('garbage 4');
    expect(fs.readFileSync(path.join(dir, q[0]!), 'utf8')).toBe('garbage 2');
  });

  it('accepts a UTF-8 BOM and removes stale temp files on read', () => {
    const store = createJsonStore({ filePath: file, now });
    fs.writeFileSync(file, '﻿{"a":1}');
    fs.writeFileSync(`${file}.999.1.tmp`, 'partial');
    expect(store.read()).toMatchObject({ status: 'ok', value: { a: 1 } });
    expect(fs.existsSync(`${file}.999.1.tmp`)).toBe(false);
  });

  it('async writes commit, and an older write never overwrites a newer one', async () => {
    const store = createJsonStore({ filePath: file, now });
    const first = store.write({ v: 'async-old' });
    expect(store.writeSync({ v: 'sync-new' })).toBe(true);
    expect(await first).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 'sync-new' });
    expect(await store.write({ v: 'async-newest' })).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ v: 'async-newest' });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the parent directory on first write', () => {
    const nested = path.join(dir, 'a', 'b', 'cat-state.json');
    const store = createJsonStore({ filePath: nested, now });
    expect(store.writeSync({ ok: true })).toBe(true);
    expect(store.read().value).toEqual({ ok: true });
  });

  it('readBackup and quarantine work independently', () => {
    const store = createJsonStore({ filePath: file, now });
    expect(store.readBackup()).toEqual({ ok: false });
    expect(store.quarantine()).toBeNull();
    store.writeSync({ v: 1 });
    store.writeSync({ v: 2 });
    expect(store.readBackup()).toEqual({ ok: true, value: { v: 1 } });
    const q = store.quarantine();
    expect(q).not.toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });
});
