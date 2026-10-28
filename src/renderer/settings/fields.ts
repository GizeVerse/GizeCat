// Numeric setting ranges as presented by the UI. They mirror the zod schema in
// src/shared/settings.ts; tests/unit/renderer/settings/fields.test.ts checks every
// bound against the real schema so the two cannot drift apart silently.
import type { Settings } from '../../shared/settings';
import { formatDuration, formatMinutes, formatMultiplier, formatPercent, formatPerHour, formatSeconds } from './format';

export type SectionKey = Exclude<keyof Settings, 'schemaVersion'>;
export type FieldKey<S extends SectionKey> = keyof Settings[S] & string;
export type FieldId = { [S in SectionKey]: `${S}.${FieldKey<S>}` }[SectionKey];

type KeysOfType<S extends SectionKey, T> = { [K in FieldKey<S>]: Settings[S][K] extends T ? K : never }[FieldKey<S>];
export type BoolKey<S extends SectionKey> = KeysOfType<S, boolean>;
export type NumKey<S extends SectionKey> = KeysOfType<S, number>;
export type StrKey<S extends SectionKey> = KeysOfType<S, string>;

export type ValueFormat = 'percent' | 'multiplier' | 'minutes' | 'duration' | 'perHour' | 'seconds';

export interface RangeSpec {
  min: number;
  max: number;
  step: number;
  format: ValueFormat;
}

export interface NumericField<S extends SectionKey = SectionKey> extends RangeSpec {
  section: S;
  key: NumKey<S>;
}

function spec<S extends SectionKey>(section: S, key: NumKey<S>, min: number, max: number, step: number, format: ValueFormat): NumericField<S> {
  return { section, key, min, max, step, format };
}

export const NUMERIC_FIELDS = {
  size: spec('appearance', 'size', 0.5, 2.5, 0.05, 'percent'),
  opacity: spec('appearance', 'opacity', 0.3, 1, 0.05, 'percent'),
  animationSpeed: spec('appearance', 'animationSpeed', 0.5, 1.5, 0.05, 'multiplier'),
  movementSpeed: spec('behavior', 'movementSpeed', 0.5, 2, 0.05, 'multiplier'),
  autonomy: spec('behavior', 'autonomy', 0, 1, 0.05, 'percent'),
  cursorPlay: spec('behavior', 'cursorPlay', 0, 1, 0.05, 'percent'),
  attentionSeeking: spec('behavior', 'attentionSeeking', 0, 1, 0.05, 'percent'),
  activitySensitivity: spec('behavior', 'activitySensitivity', 0, 1, 0.05, 'percent'),
  chaseDuration: spec('behavior', 'chaseDurationSec', 1, 20, 0.5, 'seconds'),
  sleepAfterIdleMinutes: spec('behavior', 'sleepAfterIdleMinutes', 1, 120, 1, 'minutes'),
  patience: spec('interaction', 'patience', 0, 1, 0.05, 'percent'),
  perceptionInterval: spec('perception', 'minIntervalSec', 5, 3600, 1, 'duration'),
  aiInterval: spec('ai', 'minIntervalSec', 30, 86400, 1, 'duration'),
  aiMaxPerHour: spec('ai', 'maxPerHour', 1, 60, 1, 'perHour'),
  aiTimeout: spec('ai', 'timeoutSec', 3, 120, 1, 'duration'),
} as const;

export function formatValue(format: ValueFormat, value: number): string {
  switch (format) {
    case 'percent':
      return formatPercent(value);
    case 'multiplier':
      return formatMultiplier(value);
    case 'minutes':
      return formatMinutes(value);
    case 'duration':
      return formatDuration(value);
    case 'perHour':
      return formatPerHour(value);
    case 'seconds':
      return formatSeconds(value);
  }
}

/** Snaps a value to the spec's step grid and clamps it into range (avoids 0.30000000000000004). */
export function snapToStep(spec: RangeSpec, value: number): number {
  if (!Number.isFinite(value)) return spec.min;
  const steps = Math.round((value - spec.min) / spec.step);
  const snapped = spec.min + steps * spec.step;
  const decimals = Math.max(0, Math.ceil(-Math.log10(spec.step)) + 1);
  const rounded = Number(snapped.toFixed(decimals));
  return Math.min(spec.max, Math.max(spec.min, rounded));
}

/** Pleasant stops for long interval ranges, in seconds. */
const INTERVAL_STOPS = [
  5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 21600, 43200, 86400,
] as const;

/** Stops within [min, max]; the bounds themselves are always included. */
export function intervalStops(min: number, max: number): number[] {
  const inner = INTERVAL_STOPS.filter((s) => s > min && s < max);
  return [min, ...inner, max];
}

/** Index of the stop closest to `value` (ties resolve to the lower stop). */
export function nearestStopIndex(stops: readonly number[], value: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  stops.forEach((s, i) => {
    const d = Math.abs(s - value);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}
