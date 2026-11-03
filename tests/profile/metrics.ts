// Pure statistics for the behaviour profile (ADR 0003 §14): distributions, Kaplan-Meier stay
// survival with right-censoring, rates, and the widening used by the short band subset.

export const MIN = 60_000;
export const HOUR = 3_600_000;

export interface Dist {
  n: number;
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

/** Interpolation-free summary of `values` (rounded to 0.1), as in the v1.2 diagnosis tables. */
export function dist(values: readonly number[]): Dist {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number): number => (v.length === 0 ? 0 : v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!);
  const r = (x: number): number => Math.round(x * 10) / 10;
  return { n: v.length, min: r(v[0] ?? 0), median: r(q(0.5)), p90: r(q(0.9)), max: r(v[v.length - 1] ?? 0), mean: r(v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0) };
}

/** Nearest-rank quantile of an ascending, finite array (null when empty). */
export function quantileOf(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))]!;
}

export const perHour = (n: number, ms: number): number => (ms > 0 ? Math.round(((n * HOUR) / ms) * 100) / 100 : 0);
export const share = (n: number, d: number): number => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);
export const ratio = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : 0);
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** One observed duration: `event` true = the end of interest happened, false = right-censored. */
export interface SurvivalSample {
  t: number;
  event: boolean;
}

export interface KaplanMeier {
  /** Samples and how many ended by the event (the rest are censored). */
  n: number;
  events: number;
  /** Step function: S(t) just after each distinct event time, ascending. */
  steps: ReadonlyArray<{ t: number; s: number }>;
}

/**
 * Product-limit estimator. Ties: events at a time count before censorings at the same time
 * (the usual convention: a stay censored at t was still at risk at t).
 */
export function kaplanMeier(samples: readonly SurvivalSample[]): KaplanMeier {
  const v = samples.filter((x) => Number.isFinite(x.t) && x.t >= 0).sort((a, b) => a.t - b.t || Number(b.event) - Number(a.event));
  const steps: Array<{ t: number; s: number }> = [];
  let atRisk = v.length;
  let s = 1;
  let events = 0;
  for (let i = 0; i < v.length; ) {
    const t = v[i]!.t;
    let d = 0;
    let c = 0;
    while (i < v.length && v[i]!.t === t) {
      if (v[i]!.event) d++;
      else c++;
      i++;
    }
    if (d > 0) {
      s *= 1 - d / atRisk;
      steps.push({ t, s });
      events += d;
    }
    atRisk -= d + c;
  }
  return { n: v.length, events, steps };
}

/** S(t): probability a stay lasts longer than `t`. */
export function survivalAt(km: KaplanMeier, t: number): number {
  let s = 1;
  for (const st of km.steps) {
    if (st.t > t) break;
    s = st.s;
  }
  return s;
}

/** Smallest event time with S(t) <= 1 - p (the p-quantile of the duration); null if S never gets there (too much censoring). */
export function kmQuantile(km: KaplanMeier, p: number): number | null {
  const target = 1 - p + 1e-12;
  for (const st of km.steps) if (st.s <= target) return st.t;
  return null;
}

/**
 * The short subset's acceptance for a rate band [lo, hi] per hour measured over `hours`: the
 * observed count may fall up to ~2 sigma (Poisson) outside the band's expected counts. Returns the
 * widened band in per-hour units.
 */
export function widenRate(lo: number, hi: number, hours: number): { lo: number; hi: number } {
  const h = Math.max(1e-6, hours);
  const l = lo * h;
  const u = hi * h;
  return { lo: Math.max(0, (l - 2 * Math.sqrt(l)) / h), hi: (u + 2 * Math.sqrt(Math.max(1, u))) / h };
}

/**
 * The same for a share band measured from `n` (roughly independent) observations: ~2 sigma of a
 * binomial at the band edges. Time shares are autocorrelated, so callers pass an effective n
 * (episodes, not ticks).
 */
export function widenShare(lo: number, hi: number, n: number): { lo: number; hi: number } {
  const m = Math.max(1, n);
  const sl = Math.sqrt(Math.max(lo * (1 - lo), 0.01) / m);
  const sh = Math.sqrt(Math.max(hi * (1 - hi), 0.01) / m);
  return { lo: Math.max(0, lo - 2 * sl), hi: Math.min(1, hi + 2 * sh) };
}

/**
 * min / mean / max / last of a sampled series (rounded to 0.001). A loop, not Math.min(...v): a
 * long scenario (the 1000-throw Monte Carlo) samples >100k values, beyond the argument limit.
 */
export function seriesSummary(values: readonly number[]): { min: number; mean: number; max: number; end: number } {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const n = values.length;
  return { min: round3(n ? min : 0), mean: round3(n ? sum / n : 0), max: round3(n ? max : 0), end: round3(values[n - 1] ?? 0) };
}

/** Smallest gap between consecutive values (ascending order not required); null with fewer than two. */
export function minGap(values: readonly number[]): number | null {
  const v = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  let g: number | null = null;
  for (let i = 1; i < v.length; i++) g = g === null ? v[i]! - v[i - 1]! : Math.min(g, v[i]! - v[i - 1]!);
  return g;
}

/** Largest share of one key in a count table, and how many keys have a positive count. */
export function concentration(c: Readonly<Record<string, number>>): { total: number; kinds: number; maxShare: number; maxKind: string | null } {
  let total = 0;
  let max = 0;
  let maxKind: string | null = null;
  let kinds = 0;
  for (const [k, v] of Object.entries(c)) {
    if (!(v > 0)) continue;
    total += v;
    kinds++;
    if (v > max) {
      max = v;
      maxKind = k;
    }
  }
  return { total, kinds, maxShare: total > 0 ? max / total : 0, maxKind };
}
