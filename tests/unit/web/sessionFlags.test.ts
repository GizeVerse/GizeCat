// Laser mode and the events pause are session-only (src/web/sessionFlags.ts): off unless a record says
// otherwise, never throwing on blocked or corrupt storage. Written for the Living Companion sprint and
// NOT RUN by the agent that wrote it (owner rule: no tests).
import { describe, expect, it } from 'vitest';
import { NO_SESSION_FLAGS, parseSessionFlags, readSessionFlags, SESSION_FLAGS_KEY, writeSessionFlags } from '../../../src/web/sessionFlags';
import type { StorageLike } from '../../../src/web/storage';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('session flags', () => {
  it('are off by default, for missing, empty, oversized and corrupt records', () => {
    expect(parseSessionFlags(null)).toEqual(NO_SESSION_FLAGS);
    expect(parseSessionFlags('')).toEqual(NO_SESSION_FLAGS);
    expect(parseSessionFlags('not json')).toEqual(NO_SESSION_FLAGS);
    expect(parseSessionFlags('[1,2]')).toEqual(NO_SESSION_FLAGS);
    expect(parseSessionFlags(`{"laser":true,"pad":"${'x'.repeat(300)}"}`)).toEqual(NO_SESSION_FLAGS);
  });

  it('read only strict booleans', () => {
    expect(parseSessionFlags('{"laser":true,"eventsPaused":false}')).toEqual({ laser: true, eventsPaused: false });
    expect(parseSessionFlags('{"laser":"yes","eventsPaused":1}')).toEqual(NO_SESSION_FLAGS);
  });

  it('round trip through storage, holding two booleans and nothing else', () => {
    const store = memory();
    expect(writeSessionFlags(() => store, { laser: true, eventsPaused: true })).toBe(true);
    expect(JSON.parse(store.data.get(SESSION_FLAGS_KEY) ?? '{}')).toEqual({ laser: true, eventsPaused: true });
    expect(readSessionFlags(() => store)).toEqual({ laser: true, eventsPaused: true });
    writeSessionFlags(() => store, NO_SESSION_FLAGS);
    expect(readSessionFlags(() => store)).toEqual(NO_SESSION_FLAGS);
  });

  it('survive blocked storage', () => {
    const blocked = (): StorageLike => {
      throw new Error('SecurityError');
    };
    expect(readSessionFlags(blocked)).toEqual(NO_SESSION_FLAGS);
    expect(writeSessionFlags(blocked, { laser: true, eventsPaused: false })).toBe(false);
    expect(writeSessionFlags(() => null, { laser: true, eventsPaused: false })).toBe(false);
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(readSessionFlags(() => throwing)).toEqual(NO_SESSION_FLAGS);
    expect(writeSessionFlags(() => throwing, { laser: false, eventsPaused: true })).toBe(false);
  });
});
