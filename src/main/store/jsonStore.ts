// Crash-safe JSON file: write to a temp file, fsync, keep a copy of the previous
// good file as .bak, then rename over the target. Unparseable files are moved
// aside (quarantined) so a bad file is never silently overwritten; a file that
// exists but cannot be read (locked, access denied) is never overwritten at all:
// writes stay refused until a later read succeeds. Electron-free.
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts';

/**
 * - ok / missing: the file parsed, or does not exist.
 * - recovered-backup: the file did not parse (quarantined); value comes from the .bak copy.
 * - corrupt: the file did not parse and there is no usable .bak copy.
 * - unreadable: the file exists but could not be read (I/O error). Nothing was moved,
 *   writes are refused until a later read() succeeds, and value is the .bak copy
 *   (for this session only) or null.
 */
export type JsonReadStatus = 'ok' | 'missing' | 'recovered-backup' | 'corrupt' | 'unreadable';

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
  /** Never throws. */
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
  /**
   * false for sensitive files (API keys): no .bak copy is written or ever read, and
   * every successful write deletes leftover .bak and quarantined copies, so data a
   * write removed cannot come back from a copy. Default true.
   */
  keepCopies?: boolean;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Reads retry longer than writes (about 0.4 s in total): giving up means running without the file. */
const READ_ATTEMPTS = 8;
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

type ParsedFile = { ok: true; value: unknown } | { ok: false; reason: 'missing' | 'io' | 'parse'; error: unknown };

export function createJsonStore(opts: JsonStoreOptions): JsonStore {
  const filePath = opts.filePath;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const backupPath = `${filePath}.bak`;
  const maxQuarantined = opts.maxQuarantined ?? 3;
  const now = opts.now ?? Date.now;
  const keepCopies = opts.keepCopies ?? true;
  const log = opts.logger;

  let seq = 0;
  let committedGen = 0;
  /** Why writes are refused (the file on disk could not be read or moved aside), or null. */
  let blockedReason: string | null = null;
  let blockReported = false;
  /** The bad file is still in place (only a copy was quarantined): it must not replace the .bak. */
  let mainKnownBad = false;

  const tmpPath = (gen: number): string => `${filePath}.${process.pid}.${gen}.tmp`;

  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  function block(reason: string): void {
    blockedReason = reason;
    blockReported = false;
  }

  function refuseWrite(): boolean {
    if (blockedReason === null) return false;
    if (!blockReported) {
      blockReported = true;
      log?.error('not saving: the existing file is kept untouched', { file: path.basename(filePath), reason: blockedReason });
    }
    return true;
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
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (err) {
        // A temp another program still holds is harmless: its pid-tagged name is never reused for reading.
        log?.warn('could not remove stale temp file', { file: name, error: err });
      }
    }
  }

  function quarantinedNames(): string[] {
    try {
      const prefix = `${base}.corrupt-`;
      return fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json'));
    } catch {
      return [];
    }
  }

  function pruneQuarantine(): void {
    const victims = quarantinedNames().sort();
    for (const name of victims.slice(0, Math.max(0, victims.length - maxQuarantined))) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch (err) {
        log?.warn('could not prune quarantined file', { file: name, error: err });
      }
    }
  }

  /** keepCopies:false — deletes every copy besides the file itself. */
  function discardCopies(includeQuarantined: boolean): void {
    const victims = [backupPath, ...(includeQuarantined ? quarantinedNames().map((n) => path.join(dir, n)) : [])];
    for (const p of victims) {
      try {
        withRetrySync(() => fs.rmSync(p, { force: true }));
      } catch (err) {
        log?.error('could not delete an old copy of a sensitive file', { file: path.basename(p), error: err });
      }
    }
  }

  function quarantine(): string | null {
    let target = quarantineName(filePath, now());
    for (let i = 1; fs.existsSync(target) && i < 100; i++) target = target.replace(/\.json$/, `-${i}.json`);
    try {
      withRetrySync(() => fs.renameSync(filePath, target));
      mainKnownBad = false;
      log?.warn('quarantined unreadable file', { file: path.basename(filePath), to: path.basename(target) });
      pruneQuarantine();
      return target;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return null;
      log?.error('could not quarantine unreadable file', { file: path.basename(filePath), error: err });
    }
    // Keep a copy instead, so the bad file survives the next write replacing it.
    try {
      withRetrySync(() => fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL));
      mainKnownBad = true;
      log?.warn('kept a copy of the unreadable file', { file: path.basename(filePath), to: path.basename(target) });
      pruneQuarantine();
      return target;
    } catch (err) {
      block('the unreadable file could not be moved or copied aside');
      log?.error('could not copy unreadable file aside; it will not be overwritten', { file: path.basename(filePath), error: err });
      return null;
    }
  }

  function parseFile(p: string): ParsedFile {
    let text: string;
    try {
      text = withRetrySync(() => fs.readFileSync(p, 'utf8'), READ_ATTEMPTS);
    } catch (err) {
      return { ok: false, reason: errCode(err) === 'ENOENT' ? 'missing' : 'io', error: err };
    }
    try {
      const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      return { ok: true, value: JSON.parse(trimmed) as unknown };
    } catch (err) {
      return { ok: false, reason: 'parse', error: err };
    }
  }

  function readBackup(): { ok: true; value: unknown } | { ok: false } {
    if (!keepCopies) return { ok: false };
    const b = parseFile(backupPath);
    return b.ok ? { ok: true, value: b.value } : { ok: false };
  }

  function read(): JsonReadResult {
    removeStaleTemps();
    // A .bak of a sensitive file can only be left over from an older version: it is never trusted.
    if (!keepCopies) discardCopies(false);
    const main = parseFile(filePath);
    if (main.ok || main.reason === 'missing') {
      blockedReason = null;
      mainKnownBad = false;
      return main.ok ? { status: 'ok', value: main.value, quarantinedTo: null } : { status: 'missing', value: null, quarantinedTo: null };
    }
    if (main.reason === 'io') {
      // The file may be perfectly good and only locked: never treat it as corrupt or replace it.
      block('the existing file could not be read');
      log?.error('stored file could not be read; it will not be overwritten this session', { file: path.basename(filePath), error: main.error });
      const bak = readBackup();
      return { status: 'unreadable', value: bak.ok ? bak.value : null, quarantinedTo: null };
    }
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
    if (keepCopies && !mainKnownBad && fs.existsSync(filePath)) {
      try {
        withRetrySync(() => fs.copyFileSync(filePath, backupPath));
      } catch (err) {
        log?.warn('could not refresh backup copy', { file: path.basename(filePath), error: err });
      }
    }
    withRetrySync(() => fs.renameSync(tmp, filePath));
    committedGen = gen;
    mainKnownBad = false;
    if (!keepCopies) discardCopies(true);
    return true;
  }

  function writeSync(value: unknown): boolean {
    if (refuseWrite()) return false;
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
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // A leftover temp is removed by the next read().
      }
      log?.error('atomic write failed', { file: path.basename(filePath), error: err });
      return false;
    }
  }

  async function write(value: unknown): Promise<boolean> {
    if (refuseWrite()) return false;
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
