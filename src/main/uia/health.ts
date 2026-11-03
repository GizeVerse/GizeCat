// uia-health.json (userData): the File Explorer kill switch's memory across sessions (ADR 0003 §7.2).
//
// File Explorer is the shell's own process. When the shell restarts (TaskbarCreated) within 10 min
// of one of our Explorer reads, the tab-strip service turns Explorer off for the session and counts a
// strike here. A second strike turns it off until the app version changes (a new version may carry a
// fixed reader), so a reader that crashes the shell cannot do it a third time.
//
// Content-free: an app version, a strike count and a flag. No window, app or user data. A missing,
// unreadable or malformed file counts as healthy (it only ever switches a feature off). Writes are
// best effort and atomic (temp file + rename).
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../contracts';

export const UIA_HEALTH_FILE = 'uia-health.json';
/** Strikes (shell restarts right after Explorer reads) that turn Explorer off until the next app version. */
export const EXPLORER_STRIKE_LIMIT = 2;

export interface UiaHealth {
  schema: 1;
  /** App version the counters belong to; another version starts from zero. */
  appVersion: string;
  explorerStrikes: number;
  explorerDisabled: boolean;
}

export interface UiaHealthTracker {
  /** False when Explorer tab strips are off for this app version. */
  explorerAllowed(): boolean;
  strikes(): number;
  /** One shell restart right after an Explorer read: persisted; disabledForVersion once the limit is reached. */
  recordExplorerStrike(): { strikes: number; disabledForVersion: boolean };
  snapshot(): UiaHealth;
}

export interface UiaHealthOptions {
  /** Full path of uia-health.json, or null to keep the counters in memory only (tests, no userData). */
  filePath: string | null;
  appVersion: string;
  logger: Logger;
  /** File system seam (tests). */
  fs?: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'rmSync'>;
}

const fresh = (appVersion: string): UiaHealth => ({ schema: 1, appVersion, explorerStrikes: 0, explorerDisabled: false });

/** A stored record, or null when it is not one (wrong shape, other schema, out-of-range values). */
export function parseUiaHealth(raw: unknown): UiaHealth | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return null;
  if (typeof r.appVersion !== 'string' || r.appVersion.length === 0 || r.appVersion.length > 64 || !/^[0-9A-Za-z.+-]+$/.test(r.appVersion)) return null;
  if (typeof r.explorerStrikes !== 'number' || !Number.isInteger(r.explorerStrikes) || r.explorerStrikes < 0 || r.explorerStrikes > 1000) return null;
  if (typeof r.explorerDisabled !== 'boolean') return null;
  return { schema: 1, appVersion: r.appVersion, explorerStrikes: r.explorerStrikes, explorerDisabled: r.explorerDisabled };
}

export function createUiaHealth(opts: UiaHealthOptions): UiaHealthTracker {
  const io = opts.fs ?? fs;
  const log = opts.logger;
  const version = /^[0-9A-Za-z.+-]{1,64}$/.test(opts.appVersion) ? opts.appVersion : 'unknown';
  let state = fresh(version);
  if (opts.filePath !== null) {
    try {
      const stored = parseUiaHealth(JSON.parse(io.readFileSync(opts.filePath, 'utf8')));
      // Counters of another version do not carry over.
      if (stored !== null && stored.appVersion === version) state = stored;
    } catch {
      /* missing or unreadable: healthy */
    }
  }

  function persist(): void {
    if (opts.filePath === null) return;
    const tmp = `${opts.filePath}.${process.pid}.tmp`;
    try {
      io.mkdirSync(path.dirname(opts.filePath), { recursive: true });
      io.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
      io.renameSync(tmp, opts.filePath);
    } catch (e) {
      log.warn('uia health file not written', { error: e instanceof Error ? e.message : String(e) });
      try {
        io.rmSync(tmp, { force: true });
      } catch {
        /* nothing to clean */
      }
    }
  }

  return {
    explorerAllowed: () => !state.explorerDisabled,
    strikes: () => state.explorerStrikes,
    recordExplorerStrike() {
      const strikes = Math.min(1000, state.explorerStrikes + 1);
      state = { ...state, explorerStrikes: strikes, explorerDisabled: state.explorerDisabled || strikes >= EXPLORER_STRIKE_LIMIT };
      persist();
      return { strikes, disabledForVersion: state.explorerDisabled };
    },
    snapshot: () => ({ ...state }),
  };
}
