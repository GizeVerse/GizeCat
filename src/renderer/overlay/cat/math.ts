// Small numeric helpers for the rig. Pure, allocation-free.

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite smoothstep of an already-normalised t. */
export const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const easeOut = (t: number): number => {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x) * (1 - x);
};

export const easeIn = (t: number): number => {
  const x = clamp01(t);
  return x * x * x;
};

/** Overshooting ease-out (pop-in). */
export const easeOutBack = (t: number): number => {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/** Normalised position of t inside [t0, t1], clamped. */
export const seg = (t: number, t0: number, t1: number): number => clamp01((t - t0) / (t1 - t0));

/** Smoothed segment: 0 before t0, 1 after t1. */
export const sseg = (t: number, t0: number, t1: number): number => smooth(seg(t, t0, t1));

/** Rises over [a,b] and falls over [c,d]; 0 outside. */
export const pulse = (t: number, a: number, b: number, c: number, d: number): number => sseg(t, a, b) * (1 - sseg(t, c, d));

/** Frame-rate independent exponential approach. `rate` is 1/s. */
export const damp = (current: number, target: number, rate: number, dtSec: number): number =>
  target + (current - target) * Math.exp(-rate * dtSec);

export const wrap01 = (x: number): number => x - Math.floor(x);

export const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Smooth 1-D value noise in [-1, 1]; deterministic for a given seed. */
export function noise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash(i, seed);
  const b = hash(i + 1, seed);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

function hash(i: number, seed: number): number {
  let h = (i * 374761393 + seed * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Seeded uniform [0,1) generator (mulberry32) for deterministic previews and tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
