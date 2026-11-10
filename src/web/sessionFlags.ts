// Two session-only choices of the Android app's panel: Laser Mode and "pause world events". They are
// never part of the settings (never exported in a profile, never a default) and are OFF at every app
// start. The floating cat runs in a second WebView of this app, so the panel hands them over through one
// small localStorage record that the floating page re-reads when native says "settings changed". The
// app page clears the record when it starts, so a stale one from an earlier session is never honoured.
// The record holds two booleans: no cat, no position, no user data.
//
// Pure: storage is injected, and every access is wrapped (blocked or corrupt storage means "off").
import type { StorageLike } from './storage';

export const SESSION_FLAGS_KEY = 'gizecat.web.session.v1';

export interface SessionFlags {
  /** Laser Mode: the cat chases a light that follows a pointer it can legitimately see. */
  laser: boolean;
  /** World events are paused for this session. */
  eventsPaused: boolean;
}

export const NO_SESSION_FLAGS: SessionFlags = Object.freeze({ laser: false, eventsPaused: false });

export function parseSessionFlags(text: string | null | undefined): SessionFlags {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256) return NO_SESSION_FLAGS;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return NO_SESSION_FLAGS;
    const o = v as Record<string, unknown>;
    return { laser: o.laser === true, eventsPaused: o.eventsPaused === true };
  } catch {
    return NO_SESSION_FLAGS;
  }
}

export function readSessionFlags(access: () => StorageLike | null | undefined): SessionFlags {
  try {
    return parseSessionFlags(access()?.getItem(SESSION_FLAGS_KEY));
  } catch {
    return NO_SESSION_FLAGS;
  }
}

/** True when the record was written (false without storage; the flags then live in this page only). */
export function writeSessionFlags(access: () => StorageLike | null | undefined, flags: SessionFlags): boolean {
  try {
    const store = access();
    if (!store) return false;
    store.setItem(SESSION_FLAGS_KEY, JSON.stringify({ laser: flags.laser === true, eventsPaused: flags.eventsPaused === true }));
    return true;
  } catch {
    return false;
  }
}
