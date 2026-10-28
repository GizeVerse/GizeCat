// Command-line / environment parsing for startup. Pure functions.
import path from 'node:path';

export const LAUNCHED_AT_LOGIN_FLAG = '--launched-at-login';

/** userData override for tests and portable runs: env DESKTOP_CAT_USER_DATA wins over --user-data-dir=. */
export function parseUserDataOverride(env: Record<string, string | undefined>, argv: readonly string[]): string | null {
  const fromEnv = env.DESKTOP_CAT_USER_DATA?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  for (const arg of argv) {
    if (arg.startsWith('--user-data-dir=')) {
      const v = arg.slice('--user-data-dir='.length).replace(/^"(.*)"$/, '$1').trim();
      if (v) return path.resolve(v);
    }
  }
  return null;
}

export function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

export function isTestMode(env: Record<string, string | undefined>): boolean {
  return env.DESKTOP_CAT_TEST === '1';
}

/** Simulation time multiplier for long-run tests; 1 unless DESKTOP_CAT_TIME_SCALE is a sane number. */
export function parseTimeScale(env: Record<string, string | undefined>): number {
  const raw = env.DESKTOP_CAT_TIME_SCALE;
  if (!raw) return 1;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0.1 && v <= 100 ? v : 1;
}
