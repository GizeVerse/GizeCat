// Best-effort evidence that a v1 user switched "Start with Windows" off: v1 logged
// {"s":"app.login-item","m":"login item updated","d":{"openAtLogin":false}} whenever the
// setting changed. v1 always saved launchAtLogin:false, so the settings file alone cannot
// tell a default from an opt-out (startup.md §4). Logs rotate (main.log, main.1.log,
// main.2.log, 1 MB each), so a missing line proves nothing. Read only during migration.
import fs from 'node:fs';
import path from 'node:path';

export const V1_LOGIN_LOG_MESSAGE = 'login item updated';
const LOG_FILE = /^main(?:\.\d+)?\.log$/;
const MAX_LOG_FILES = 8;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface EvidenceFs {
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
  statSync(file: string): { size: number; isFile(): boolean };
}

/** True when one log line records the v1 app switching its startup entry off. */
export function isV1OptOutLine(line: string): boolean {
  if (!line.includes(V1_LOGIN_LOG_MESSAGE)) return false;
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return false;
  }
  if (rec === null || typeof rec !== 'object') return false;
  const r = rec as { s?: unknown; m?: unknown; d?: unknown };
  if (r.m !== V1_LOGIN_LOG_MESSAGE || typeof r.s !== 'string' || !/(^|\.)login-item$/.test(r.s)) return false;
  return r.d !== null && typeof r.d === 'object' && (r.d as { openAtLogin?: unknown }).openAtLogin === false;
}

/** Scans logs/main.log* for a v1 opt-out. Never throws; unreadable files count as no evidence. */
export function findV1OptOutInLogs(logDir: string | null, fsApi: EvidenceFs = fs): boolean {
  if (!logDir) return false;
  let names: string[];
  try {
    names = fsApi.readdirSync(logDir).filter((n) => LOG_FILE.test(n)).slice(0, MAX_LOG_FILES);
  } catch {
    return false;
  }
  for (const name of names) {
    // Windows path semantics, like the rest of the login item (loginItem.ts): identical on win32;
    // the scan only matters there (ADR 0004 §7).
    const file = path.win32.join(logDir, name);
    try {
      const st = fsApi.statSync(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const text = fsApi.readFileSync(file, 'utf8');
      if (!text.includes(V1_LOGIN_LOG_MESSAGE)) continue;
      if (text.split('\n').some(isV1OptOutLine)) return true;
    } catch {
      /* rotated away or locked: no evidence from this file */
    }
  }
  return false;
}
