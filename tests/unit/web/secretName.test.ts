// The web host's secret-name wrapper with a stub matcher: only throwaway strings built at test time.
// MOCKED matcher (the real one is covered with the shared module's own tests).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EggMatcher, EggState } from '../../../src/shared/secretEgg';
import { createWebSecretName } from '../../../src/web/secretName';

const rnd = (): string => 'q' + Math.random().toString(16).slice(2, 10);

function stub(trigger: string, message: string, available = true): EggMatcher {
  return {
    available,
    evaluate: (name: string): Promise<EggState> => Promise.resolve(available && name.trim().toLowerCase() === trigger ? { active: true, message } : { active: false }),
  };
}

describe('createWebSecretName', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the cat follows only committed names, the note also follows typing', async () => {
    const trigger = rnd();
    const message = rnd();
    const s = createWebSecretName(stub(trigger, message), 10);
    const note: boolean[] = [];
    const cat: boolean[] = [];
    s.subscribe((st) => note.push(st.active));
    s.onAccessoryChange((st) => cat.push(st.active));
    s.setTyped(trigger);
    await vi.advanceTimersByTimeAsync(20);
    expect(s.state()).toEqual({ active: true, message });
    expect(s.accessory()).toBeUndefined();
    s.setName(trigger);
    await vi.advanceTimersByTimeAsync(20);
    expect(s.accessory()).toBe('heartPendant');
    s.setName(rnd());
    expect(s.accessory()).toBeUndefined();
    expect(note).toEqual([true, false]);
    expect(cat).toEqual([true, false]);
  });

  it('a committed update leaves the note alone while a hold says the field is dirty', async () => {
    const trigger = rnd();
    const s = createWebSecretName(stub(trigger, rnd()), 10);
    const typed = rnd();
    const release = s.holdNote((committed) => committed !== typed);
    s.setTyped(trigger);
    await vi.advanceTimersByTimeAsync(20);
    s.setName(rnd());
    expect(s.state().active).toBe(true);
    s.setName(typed);
    expect(s.state().active).toBe(false);
    release();
    s.setTyped(trigger);
    await vi.advanceTimersByTimeAsync(20);
    s.setName(rnd());
    expect(s.state().active).toBe(false);
  });

  it('stays off and silent without a payload', async () => {
    const s = createWebSecretName(stub(rnd(), rnd(), false), 10);
    expect(s.available).toBe(false);
    s.setName(rnd());
    await vi.advanceTimersByTimeAsync(20);
    expect(s.state()).toEqual({ active: false });
    expect(s.accessory()).toBeUndefined();
  });

  it('unsubscribe stops notifications and dispose turns it off', async () => {
    const trigger = rnd();
    const s = createWebSecretName(stub(trigger, rnd()), 10);
    const cb = vi.fn();
    const off = s.subscribe(cb);
    off();
    s.setTyped(trigger);
    s.setName(trigger);
    await vi.advanceTimersByTimeAsync(20);
    expect(cb).not.toHaveBeenCalled();
    expect(s.accessory()).toBe('heartPendant');
    s.dispose();
    expect(s.accessory()).toBeUndefined();
  });
});
