import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/main/diagnostics/logger';
import { removeDir, tempDir } from './helpers';

describe('logger', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  const lines = (file: string) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { l: string; s: string; m: string; d?: Record<string, unknown> });

  it('filters by level and scopes child loggers', async () => {
    const log = createLogger({ dir, level: 'info', now: () => 0 });
    log.debug('hidden');
    log.info('shown');
    log.child('overlay').child('win').warn('scoped', { n: 1 });
    await log.flush();
    const out = lines(log.logFile!);
    expect(out.map((l) => l.m)).toEqual(['shown', 'scoped']);
    expect(out[1]).toMatchObject({ l: 'warn', s: 'app.overlay.win', d: { n: 1 } });
    log.setLevel('debug');
    log.debug('now visible');
    log.flushSync();
    expect(lines(log.logFile!).map((l) => l.m)).toContain('now visible');
    expect(log.problemCount).toEqual({ warn: 1, error: 0 });
  });

  it('redacts secrets and window titles before buffering or writing', async () => {
    const log = createLogger({ dir, level: 'debug' });
    log.info('calling provider with sk-ant-api03-SECRETSECRETSECRET', { title: 'My Bank - Statement', headers: { 'x-api-key': 'k-123' } });
    await log.flush();
    const raw = fs.readFileSync(log.logFile!, 'utf8');
    expect(raw).not.toMatch(/SECRETSECRET|My Bank|k-123/);
    expect(JSON.stringify(log.recent())).not.toMatch(/SECRETSECRET|My Bank|k-123/);
  });

  it('keeps a bounded ring buffer of the most recent entries', () => {
    const log = createLogger({ dir: null, ringSize: 5 });
    for (let i = 0; i < 12; i++) log.info(`m${i}`);
    expect(log.recent().map((e) => e.msg)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(log.recent(2).map((e) => e.msg)).toEqual(['m10', 'm11']);
    expect(log.logFile).toBeNull();
  });

  it('batches writes asynchronously', async () => {
    const log = createLogger({ dir, flushIntervalMs: 10_000 });
    log.info('one');
    log.info('two');
    expect(fs.existsSync(log.logFile!)).toBe(false);
    await log.flush();
    expect(lines(log.logFile!).map((l) => l.m)).toEqual(['one', 'two']);
  });

  it('rotates at the size limit keeping three files', async () => {
    const log = createLogger({ dir, maxFileBytes: 400, maxFiles: 3 });
    for (let i = 0; i < 40; i++) {
      log.info(`line ${i} ${'x'.repeat(40)}`);
      await log.flush();
    }
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['main.1.log', 'main.2.log', 'main.log']);
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(400);
    const newest = lines(path.join(dir, 'main.log')).map((l) => l.m);
    expect(newest.at(-1)).toContain('line 39');
  });

  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

  it('a failed append does not end file logging: the lines are kept and written once the file is free', async () => {
    let clock = 0;
    const log = createLogger({ dir, flushIntervalMs: 60_000, now: () => clock });
    const append = vi.spyOn(fs.promises, 'appendFile').mockRejectedValueOnce(busy());
    log.info('during the lock');
    await log.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(log.logFile!)).toBe(false);
    clock += 1_000;
    log.info('after the lock');
    await log.flush();
    const msgs = lines(log.logFile!).map((l) => l.m);
    expect(msgs.slice(0, 2)).toEqual(['during the lock', 'after the lock']);
    expect(log.recent().some((e) => e.msg.includes('resumed') && (e.data as { failedAttempts: number }).failedAttempts === 1)).toBe(true);
    await log.dispose();
  });

  it('a failed synchronous append is retried by the next flush', async () => {
    const log = createLogger({ dir, flushIntervalMs: 60_000 });
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw busy();
    });
    log.error('at shutdown');
    log.flushSync();
    log.flushSync();
    expect(lines(log.logFile!)[0]).toMatchObject({ l: 'error', m: 'at shutdown' });
    await log.dispose();
  });

  it('recreates the logs folder when it was deleted while running', async () => {
    const log = createLogger({ dir: path.join(dir, 'logs') });
    log.info('one');
    await log.flush();
    removeDir(path.join(dir, 'logs'));
    log.info('two');
    await log.flush();
    expect(lines(log.logFile!).map((l) => l.m)).toEqual(['two']);
  });

  /** Another program keeps main.log open without delete sharing: it cannot be renamed. */
  function holdMainLog() {
    const original = fs.renameSync;
    return vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (path.basename(String(from)) === 'main.log') throw busy();
      original(from, to);
    });
  }

  it('keeps the size cap when main.log cannot be renamed (copies it aside and truncates it)', async () => {
    holdMainLog();
    const log = createLogger({ dir, maxFileBytes: 400, maxFiles: 3 });
    for (let i = 0; i < 40; i++) {
      log.info(`line ${i} ${'x'.repeat(40)}`);
      await log.flush();
    }
    const files = fs.readdirSync(dir).sort();
    expect(files).toContain('main.1.log');
    for (const f of files) expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(400);
    expect(lines(path.join(dir, 'main.log')).at(-1)?.m).toContain('line 39');
  });

  it('stops growing at twice the cap when main.log can be neither renamed nor truncated', async () => {
    holdMainLog();
    vi.spyOn(fs, 'truncateSync').mockImplementation(() => {
      throw busy();
    });
    const log = createLogger({ dir, maxFileBytes: 400, maxFiles: 3 });
    for (let i = 0; i < 40; i++) {
      log.info(`line ${i} ${'x'.repeat(40)}`);
      await log.flush();
    }
    expect(fs.statSync(path.join(dir, 'main.log')).size).toBeLessThanOrEqual(800);
    const total = fs.readdirSync(dir).reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThanOrEqual(3 * 400);
    await log.dispose();
  });

  it('dispose flushes pending lines', async () => {
    const log = createLogger({ dir, flushIntervalMs: 60_000 });
    log.error('fatal', { code: 7 });
    await log.dispose();
    expect(lines(log.logFile!)[0]).toMatchObject({ l: 'error', m: 'fatal', d: { code: 7 } });
  });
});
