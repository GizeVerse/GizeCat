import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('dispose flushes pending lines', async () => {
    const log = createLogger({ dir, flushIntervalMs: 60_000 });
    log.error('fatal', { code: 7 });
    await log.dispose();
    expect(lines(log.logFile!)[0]).toMatchObject({ l: 'error', m: 'fatal', d: { code: 7 } });
  });
});
