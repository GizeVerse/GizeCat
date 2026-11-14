import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { mapRenderState } from '../../../src/main/overlay/renderMapping';
import { createSecretName } from '../../../src/main/secretName';
import type { EggMatcher, EggState } from '../../../src/shared/secretEgg';

const rnd = (): string => 'q' + randomBytes(6).toString('hex');

function fakeStore(name: string) {
  let current: Settings = { ...defaultSettings(), general: { ...defaultSettings().general, catName: name } };
  const listeners = new Set<(n: Settings, p: Settings) => void>();
  return {
    get: () => current,
    onChange(cb: (n: Settings, p: Settings) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    rename(next: string) {
      const prev = current;
      current = { ...current, general: { ...current.general, catName: next } };
      for (const cb of [...listeners]) cb(current, prev);
    },
    count: () => listeners.size,
  };
}

/** Matches exactly one throwaway name; the message is another throwaway string. */
function stubMatcher(trigger: string, message: string): EggMatcher {
  return {
    available: true,
    evaluate: (name: string): Promise<EggState> => Promise.resolve(name.trim().toLowerCase() === trigger ? { active: true, message } : { active: false }),
  };
}

describe('createSecretName', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the name at start, on every settings change, and drops synchronously', async () => {
    const trigger = rnd();
    const store = fakeStore(trigger);
    const flips: boolean[] = [];
    const s = createSecretName({ settings: store, matcher: stubMatcher(trigger, rnd()), onChange: (a) => flips.push(a), delayMs: 10 });
    expect(s.accessory()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    expect(s.accessory()).toBe('heartPendant');
    store.rename(rnd());
    expect(s.accessory()).toBeUndefined();
    store.rename(trigger);
    await vi.advanceTimersByTimeAsync(20);
    expect(s.accessory()).toBe('heartPendant');
    expect(flips).toEqual([true, false, true]);
    s.dispose();
    expect(s.accessory()).toBeUndefined();
    expect(store.count()).toBe(0);
  });

  it('stays off without an available matcher', async () => {
    const store = fakeStore(rnd());
    const s = createSecretName({ settings: store, matcher: { available: false, evaluate: () => Promise.resolve<EggState>({ active: false }) }, delayMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.accessory()).toBeUndefined();
    s.dispose();
  });

  it('defaults to the embedded payload (none in tests): never active', async () => {
    const s = createSecretName({ settings: fakeStore(rnd()), delayMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(s.accessory()).toBeUndefined();
    s.dispose();
  });
});

describe('mapRenderState accessory', () => {
  const out = {
    x: 10, y: 10, facing: 1, state: 'idle', clip: 'idle', clipStartedAt: 0, speed: 0, vy: 0, look: null, arousal: 0, contentment: 0,
    emote: null, emoteStartedAt: 0, opacity: 1, visible: true, snap: false, displayId: 'A', support: { kind: 'floor', displayId: 'A' },
    boundsPx: { x: 0, y: 0, width: 10, height: 10 }, nextTickMs: 33, requests: [],
  } as unknown as SimOutput;
  const base = { seq: 1, toLocalDip: (p: { x: number; y: number }) => p, scaleFactor: 1, forceSnap: false, hidden: false, simNow: 1 };
  const appearance = defaultSettings().appearance;

  it('carries the accessory only when set', () => {
    expect(mapRenderState(out, appearance, { ...base, accessory: 'heartPendant' }).accessory).toBe('heartPendant');
    const none = mapRenderState(out, appearance, base);
    expect('accessory' in none).toBe(false);
  });
});
