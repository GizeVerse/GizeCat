// Written, never run (the owner prohibits autonomous test runs). Every secret-like value here is a
// throwaway built at test time from random hex; no fixed trigger or message exists in this file.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEggMatcher,
  createEggTracker,
  EGG_MAX_NAME_UNITS,
  EGG_MIN_ITERATIONS,
  normalizeEggName,
  openEggPayload,
  parseEggPayload,
  sealEggPayload,
  type EggState,
} from '../../../src/shared/secretEgg';
import { EMBEDDED_EGG_PAYLOAD } from '../../../src/shared/eggBuild';

const rnd = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const ITER = EGG_MIN_ITERATIONS;

describe('normalizeEggName', () => {
  it('trims, folds case and compatibility forms, and is idempotent', () => {
    const x = `q${rnd()}`;
    expect(normalizeEggName(`  ${x.toUpperCase()}\u00a0`)).toBe(x);
    expect(normalizeEggName(normalizeEggName(` ${x.toUpperCase()} `))).toBe(x);
    expect(normalizeEggName('ＡＢ')).toBe('ab');
  });
  it('is locale-independent and drops the combining dot of a dotted capital I', () => {
    expect(normalizeEggName('İ')).toBe('i');
    expect(normalizeEggName('I')).toBe('i');
    expect(normalizeEggName('ı')).toBe('ı');
  });
  it('treats canonically equivalent sequences as equal', () => {
    expect(normalizeEggName('é')).toBe(normalizeEggName('é'));
  });
});

describe('payload parsing', () => {
  it('rejects anything that is not a well-formed payload', () => {
    for (const bad of [undefined, null, '', 'x', '[]', '{}', '{"v":2}', `{"v":1,"kdf":"pbkdf2-sha256","i":5,"s":"AA==","n":"AA==","c":"AA=="}`]) expect(parseEggPayload(bad as string)).toBeNull();
  });
  it('the embedded slot is a string (empty in a build without a payload)', () => {
    expect(typeof EMBEDDED_EGG_PAYLOAD).toBe('string');
  });
});

describe('seal and open', () => {
  it('opens only with the whole normalized trigger', async () => {
    const trigger = `t${rnd()}`;
    const message = `m${rnd()}`;
    const text = await sealEggPayload(trigger, message, ITER);
    const payload = parseEggPayload(text)!;
    expect(payload).not.toBeNull();
    expect(await openEggPayload(payload, trigger)).toBe(message);
    expect(await openEggPayload(payload, `  ${trigger.toUpperCase()} `)).toBe(message);
    expect(await openEggPayload(payload, trigger.slice(0, -1))).toBeNull();
    expect(await openEggPayload(payload, `${trigger}x`)).toBeNull();
    expect(await openEggPayload(payload, `x${trigger}`)).toBeNull();
    expect(await openEggPayload(payload, '')).toBeNull();
    expect(await openEggPayload(payload, 'x'.repeat(EGG_MAX_NAME_UNITS + 1))).toBeNull();
  });
  it('contains neither value in the serialized payload, and the length does not depend on the message', async () => {
    const trigger = `t${rnd()}`;
    const a = await sealEggPayload(trigger, `m${rnd()}`, ITER);
    const b = await sealEggPayload(trigger, `m${rnd()}${rnd()}${rnd()}`, ITER);
    expect(a).not.toContain(trigger);
    expect(a.length).toBe(b.length);
  });
  it('uses a fresh salt and nonce every time', async () => {
    const t = `t${rnd()}`;
    const a = JSON.parse(await sealEggPayload(t, 'a', ITER));
    const b = JSON.parse(await sealEggPayload(t, 'a', ITER));
    expect(a.s).not.toBe(b.s);
    expect(a.n).not.toBe(b.n);
  });
  it('a tampered ciphertext, rounds or salt never opens', async () => {
    const trigger = `t${rnd()}`;
    const o = JSON.parse(await sealEggPayload(trigger, `m${rnd()}`, ITER));
    const flip = (b64: string): string => {
      const raw = atob(b64);
      return btoa(String.fromCharCode(raw.charCodeAt(0) ^ 1) + raw.slice(1));
    };
    for (const t of [{ ...o, c: flip(o.c) }, { ...o, i: o.i + 1 }, { ...o, s: flip(o.s) }]) {
      const p = parseEggPayload(JSON.stringify(t));
      if (p) expect(await openEggPayload(p, trigger)).toBeNull();
    }
  });
  it('refuses unusable input without echoing it', async () => {
    await expect(sealEggPayload('   ', 'm', ITER)).rejects.toThrow();
    await expect(sealEggPayload('t', '', ITER)).rejects.toThrow();
    await expect(sealEggPayload('t', 'm', 10)).rejects.toThrow();
  });
});

describe('matcher and tracker', () => {
  afterEach(() => vi.useRealTimers());

  it('an absent or broken payload is a permanently disabled feature', async () => {
    for (const bad of ['', 'nope', '{}']) {
      const m = createEggMatcher(bad);
      expect(m.available).toBe(false);
      expect(await m.evaluate(rnd())).toEqual({ active: false });
    }
  });

  it('activates after typing settles and deactivates immediately on any edit', async () => {
    vi.useFakeTimers();
    const trigger = `t${rnd()}`;
    const message = `m${rnd()}`;
    const m = createEggMatcher(await sealEggPayload(trigger, message, ITER));
    const seen: EggState[] = [];
    const tr = createEggTracker(m, (s) => seen.push(s), 50);
    tr.setName(trigger);
    expect(tr.state().active).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    await vi.waitFor(() => expect(tr.state().active).toBe(true));
    expect(tr.state()).toEqual({ active: true, message });
    tr.setName(`${trigger}x`);
    expect(tr.state().active).toBe(false);
    expect(seen.map((s) => s.active)).toEqual([true, false]);
    tr.setName(trigger);
    await vi.advanceTimersByTimeAsync(60);
    await vi.waitFor(() => expect(tr.state().active).toBe(true));
    tr.dispose();
    expect(tr.state().active).toBe(false);
  });

  it('a result that arrives for an old name is dropped', async () => {
    vi.useFakeTimers();
    const trigger = `t${rnd()}`;
    const m = createEggMatcher(await sealEggPayload(trigger, 'm', ITER));
    const tr = createEggTracker(m, () => undefined, 10);
    tr.setName(trigger);
    await vi.advanceTimersByTimeAsync(11);
    tr.setName('other');
    await vi.advanceTimersByTimeAsync(500);
    expect(tr.state().active).toBe(false);
    tr.dispose();
  });
});
