// v1.2 uia-health.json (ADR 0003 §7.2; PRV): the Explorer kill switch's strike counter. Real files in a
// temp directory; no other state.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUiaHealth, EXPLORER_STRIKE_LIMIT, parseUiaHealth } from '../../../src/main/uia/health';
import { memoryLogger, removeDir, tempDir } from '../main/helpers';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});
function file(): string {
  const d = tempDir('dcat-health-');
  dirs.push(d);
  return path.join(d, 'uia-health.json');
}

describe('uia health (Explorer kill switch memory)', () => {
  it('starts healthy without a file, counts strikes, and disables Explorer for the version at the limit', () => {
    const f = file();
    const h = createUiaHealth({ filePath: f, appVersion: '1.2.0', logger: memoryLogger() });
    expect(h.explorerAllowed()).toBe(true);
    expect(h.recordExplorerStrike()).toEqual({ strikes: 1, disabledForVersion: false });
    expect(h.explorerAllowed()).toBe(true);
    expect(EXPLORER_STRIKE_LIMIT).toBe(2);
    expect(h.recordExplorerStrike()).toEqual({ strikes: 2, disabledForVersion: true });
    expect(h.explorerAllowed()).toBe(false);
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ schema: 1, appVersion: '1.2.0', explorerStrikes: 2, explorerDisabled: true });
  });

  it('a later launch of the same version remembers; another version starts over', () => {
    const f = file();
    const a = createUiaHealth({ filePath: f, appVersion: '1.2.0', logger: memoryLogger() });
    a.recordExplorerStrike();
    a.recordExplorerStrike();
    expect(createUiaHealth({ filePath: f, appVersion: '1.2.0', logger: memoryLogger() }).explorerAllowed()).toBe(false);
    const b = createUiaHealth({ filePath: f, appVersion: '1.2.1', logger: memoryLogger() });
    expect(b.explorerAllowed()).toBe(true);
    expect(b.strikes()).toBe(0);
  });

  it('a malformed, foreign or unreadable file counts as healthy (it only ever switches a feature off)', () => {
    for (const content of ['not json', '[]', '{"schema":2}', JSON.stringify({ schema: 1, appVersion: '1.2.0', explorerStrikes: -1, explorerDisabled: true })]) {
      const f = file();
      fs.writeFileSync(f, content);
      expect(createUiaHealth({ filePath: f, appVersion: '1.2.0', logger: memoryLogger() }).explorerAllowed(), content).toBe(true);
    }
    expect(parseUiaHealth({ schema: 1, appVersion: '1.2.0', explorerStrikes: 1, explorerDisabled: false, extra: 'x' })).toEqual({ schema: 1, appVersion: '1.2.0', explorerStrikes: 1, explorerDisabled: false });
    expect(parseUiaHealth({ schema: 1, appVersion: '../x', explorerStrikes: 1, explorerDisabled: false })).toBeNull();
  });

  it('without a file (no userData) it counts in memory; a failed write is logged and the count still holds', () => {
    const h = createUiaHealth({ filePath: null, appVersion: '1.2.0', logger: memoryLogger() });
    h.recordExplorerStrike();
    h.recordExplorerStrike();
    expect(h.explorerAllowed()).toBe(false);
    const log = memoryLogger();
    const failing = createUiaHealth({
      filePath: 'C:\\nowhere\\uia-health.json',
      appVersion: '1.2.0',
      logger: log,
      fs: {
        readFileSync: () => {
          throw new Error('ENOENT');
        },
        writeFileSync: () => {
          throw new Error('EACCES');
        },
        renameSync: () => undefined,
        mkdirSync: () => undefined,
        rmSync: () => undefined,
      },
    });
    expect(failing.recordExplorerStrike().strikes).toBe(1);
    expect(log.entries.some((e) => e.level === 'warn' && e.msg === 'uia health file not written')).toBe(true);
  });
});
