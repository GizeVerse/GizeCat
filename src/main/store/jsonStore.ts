// Crash-safe JSON file: write to a temp file, fsync, keep a copy of the previous
// good file as .bak, then rename over the target. Unparseable files are moved
// aside (quarantined) so a bad file is never silently overwritten. Electron-free.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts';

export type JsonReadStatus = 'ok' | 'missing' | 'recovered-backup' | 'corrupt';

export interface JsonReadResult {
  status: JsonReadStatus;
  /** Parsed JSON (unvalidated) or null. */
  value: unknown;
  /** Where an unreadable file was moved, if it was. */
  quarantinedTo: string | null;
}

export interface JsonStore {
  readonly filePath: string;
  readonly backupPath: string;
  read(): JsonReadResult;
  /** Parses the .bak copy, if there is one. */
  readBackup(): { ok: true; value: unknown } | { ok: false };
  /** Moves the current file aside as *.corrupt-<timestamp>.json; returns the new path. */
  quarantine(): string | null;
  /** Synchronous atomic write (shutdown/session-end paths). Never throws. */
  writeSync(value: unknown): boolean;
  /** Asynchronous atomic write. Never rejects. A newer write always wins over an older one. */
  write(value: unknown): Promise<boolean>;
}

export interface JsonStoreOptions {
  filePath: string;
  logger?: Logger;
  maxQuarantined?: number;
  now?: () => number;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function errCode(err: unknown): string | undefined {
  return err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/** Retries transient Windows sharing violations (antivirus, indexer) a few times. */
function withRetrySync<T>(fn: () => T, attempts = 4): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts || !RETRYABLE.has(errCode(err) ?? '')) throw err;
      sleepSync(15 * i);
    }
  }
}

export function quarantineName(filePath: string, at: number): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `${base}.corrupt-${stamp}.json`);
}

export function createJsonStore(opts: JsonStoreOptions): JsonStore {
  const filePath = opts.filePath;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const backupPath = `${filePath}.bak`;
  const maxQuarantined = opts.maxQuarantined ?? 3;
  const now = opts.now ?? Date.now;
  const log = opts.logger;

  let seq = 0;
  let committedGen = 0;

  const tmpPath = (gen: number): string => `${filePath}.${process.pid}.${gen}.tmp`;

  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  function removeStaleTemps(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const prefix = `${path.basename(filePath)}.`;
    for (const name of entries) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
    }
  }

  function pruneQuarantine(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const prefix = `${base}.corrupt-`;
    const victims = entries.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort();
    for (const name of victims.slice(0, Math.max(0, victims.length - maxQuarantined))) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (err) {
        log?.warn('could not prune quarantined file', { file: name, error: err });
      }
    }
  }

  function quarantine(): string | null {
    let target = quarantineName(filePath, now());
    for (let i = 1; fs.existsSync(target) && i < 100; i++) target = target.replace(/\.json$/, `-${i}.json`);
    try {
      withRetrySync(() => fs.renameSync(filePath, target));
      log?.warn('quarantined unreadable file', { file: path.basename(filePath), to: path.basename(target) });
      pruneQuarantine();
      return target;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      log?.error('could not quarantine unreadable file', { file: path.basename(filePath), error: err });
      return null;
    }
  }

  function parseFile(p: string): { ok: true; value: unknown } | { ok: false; missing: boolean; error: unknown } {
    let text: string;
    try {
      text = withRetrySync(() => fs.readFileSync(p, 'utf8'));
    } catch (err) {
      return { ok: false, missing: errCode(err) === 'ENOENT', error: err };
    }
    try {
      const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (err) {
      return { ok: false, missing: false, error: err };
    }
  }

  function readBackup(): { ok: true; value: unknown } | { ok: false } {
    const b = parseFile(backupPath);
    return b.ok ? { ok: true, value: b.value } : { ok: false };
  }

  function read(): JsonReadResult {
    removeStaleTemps();
    const main = parseFile(filePath);
    if (main.ok) return { status: 'ok', value: main.value, quarantinedTo: null };
    if (main.missing) return { status: 'missing', value: null, quarantinedTo: null };
    log?.warn('stored file is unreadable', { file: path.basename(filePath), error: main.error });
    const quarantinedTo = quarantine();
    const bak = readBackup();
    if (bak.ok) {
      log?.warn('recovered from backup copy', { file: path.basename(filePath) });
      return { status: 'recovered-backup', value: bak.value, quarantinedTo };
    }
    return { status: 'corrupt', value: null, quarantinedTo };
  }

  function serialize(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  /** The cheap, synchronous final step shared by both write paths. */
  function commit(tmp: string, gen: number): boolean {
    if (gen <= committedGen) {
      fs.rmSync(tmp, { force: true });
      return true;
    }
    if (fs.existsSync(filePath)) {
      try {
        withRetrySync(() => fs.copyFileSync(filePath, backupPath));
      } catch (err) {
        log?.warn('could not refresh backup copy', { file: path.basename(filePath), error: err });
      }
    }
    withRetrySync(() => fs.renameSync(tmp, filePath));
    committedGen = gen;
    return true;
  }

  function writeSync(value: unknown): boolean {
    const gen = ++seq;
    const tmp = tmpPath(gen);
    try {
      const data = serialize(value);
      ensureDir();
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return commit(tmp, gen);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      log?.error('atomic write failed', { file: path.basename(filePath), error: err });
      return false;
    }
  }

  async function write(value: unknown): Promise<boolean> {
    const gen = ++seq;
    const tmp = tmpPath(gen);
    try {
      const data = serialize(value);
      await fs.promises.mkdir(dir, { recursive: true });
      const fh = await fs.promises.open(tmp, 'w');
      try {
        await fh.writeFile(data, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      return commit(tmp, gen);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      log?.error('atomic write failed', { file: path.basename(filePath), error: err });
      return false;
    }
  }

  return { filePath, backupPath, read, readBackup, quarantine, writeSync, write };
}
