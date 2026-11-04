// Bounded randomness helpers. The simulation never calls Math.random directly:
// every draw goes through an injected source so runs are reproducible.

export type Random = () => number;

/** Small, fast seeded PRNG (mulberry32). */
export function mulberry32(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wraps a source so that out-of-range or non-finite values can never leak into the simulation. */
export function safeRandom(r: Random): Random {
  return () => {
    const v = r();
    if (!Number.isFinite(v) || v < 0) return 0;
    return v >= 1 ? 0.9999999 : v;
  };
}

export function range(r: Random, lo: number, hi: number): number {
  return lo + (hi - lo) * r();
}

export function chance(r: Random, p: number): boolean {
  return r() < p;
}

export function pick<T>(r: Random, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.min(items.length - 1, Math.floor(r() * items.length))];
}

export function pickWeighted<T>(r: Random, items: readonly T[], weight: (item: T) => number): T | undefined {
  let total = 0;
  for (const it of items) total += Math.max(0, weight(it));
  if (total <= 0) return undefined;
  let x = r() * total;
  for (const it of items) {
    x -= Math.max(0, weight(it));
    if (x < 0) return it;
  }
  return items[items.length - 1];
}

export interface Scored<T> {
  item: T;
  score: number;
}

/** Random hex string of `length` characters. */
export function randomHex(r: Random, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}
