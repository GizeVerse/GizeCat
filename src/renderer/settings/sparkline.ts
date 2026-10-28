// Pure geometry for the small resource charts on the Diagnostics page.

export interface SparkGeometry {
  /** SVG path for the line ('' when there is no data). */
  line: string;
  /** Closed SVG path for the soft area under the line ('' when there is no data). */
  area: string;
  points: Array<{ x: number; y: number }>;
  min: number;
  max: number;
}

/** Rounds up to 1, 2 or 5 × 10^n (at least `floor`). */
export function niceCeil(value: number, floor = 1): number {
  const v = Math.max(floor, Number.isFinite(value) ? value : floor);
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    const candidate = m * base;
    if (candidate >= v - 1e-9) return Number(candidate.toPrecision(12));
  }
  return 10 * base;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * Maps values onto a width×height box (y grows downwards). `min`/`max` fix the
 * scale; otherwise it spans the data, and a flat series sits in the middle.
 */
export function sparkline(values: readonly number[], width: number, height: number, scale: { min?: number; max?: number } = {}, pad = 2): SparkGeometry {
  const clean = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (clean.length === 0) return { line: '', area: '', points: [], min: scale.min ?? 0, max: scale.max ?? 1 };
  let min = scale.min ?? Math.min(...clean);
  let max = scale.max ?? Math.max(...clean);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const innerH = Math.max(0, height - pad * 2);
  const y = (v: number): number => pad + (1 - (Math.min(max, Math.max(min, v)) - min) / (max - min)) * innerH;
  const points =
    clean.length === 1
      ? [
          { x: 0, y: y(clean[0] ?? 0) },
          { x: width, y: y(clean[0] ?? 0) },
        ]
      : clean.map((v, i) => ({ x: (i / (clean.length - 1)) * width, y: y(v) }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(p.x)} ${r1(p.y)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  const area = first && last ? `${line} L${r1(last.x)} ${r1(height)} L${r1(first.x)} ${r1(height)} Z` : '';
  return { line, area, points, min, max };
}
