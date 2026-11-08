// Pure value formatting for labels, tables and status lines.
import { S, type PlatformWording } from './strings';

const F = S.format;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Groups thousands with the localised separator: 12345 -> "12,345". */
export function formatCount(value: number): string {
  const n = Math.round(finiteOr(value, 0));
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += F.thousandsSeparator;
    out += digits[i] ?? '';
  }
  return sign + out;
}

/** Fixed decimals with the localised decimal separator. */
export function formatDecimal(value: number, decimals: number): string {
  return finiteOr(value, 0).toFixed(decimals).replace('.', F.decimalSeparator);
}

/** 0..1 -> "60%". */
export function formatPercent(fraction: number): string {
  return F.percent(Math.round(finiteOr(fraction, 0) * 100));
}

/** Already a percentage (e.g. CPU): 1.234 -> "1.2%", 12.6 -> "13%". */
export function formatPercentValue(percent: number): string {
  const v = Math.max(0, finiteOr(percent, 0));
  return v < 10 ? `${formatDecimal(v, 1)}%` : F.percent(Math.round(v));
}

/** 1 -> "1.0×", 1.25 -> "1.25×", 0.5 -> "0.5×". */
export function formatMultiplier(value: number): string {
  const v = finiteOr(value, 1);
  const fixed = v.toFixed(2);
  const trimmed = fixed.endsWith('0') ? fixed.slice(0, -1) : fixed;
  return F.multiplier(trimmed.replace('.', F.decimalSeparator));
}

/** Whole seconds -> "20 s", "1 min 30 s", "2 h", "1 day". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(finiteOr(totalSeconds, 0)));
  if (s < 60) return F.seconds(s);
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? F.minutes(m) : F.join(F.minutes(m), F.seconds(rest));
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (m === 60) return F.hours(h + 1);
    return m === 0 ? F.hours(h) : F.join(F.hours(h), F.minutes(m));
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h === 0 || h === 24 ? F.days(h === 24 ? d + 1 : d) : F.join(F.days(d), F.hours(h));
}

/** Seconds to one decimal, without a trailing ".0": 4.5 -> "4.5 s", 5 -> "5 s". */
export function formatSeconds(seconds: number): string {
  const tenths = Math.round(Math.max(0, finiteOr(seconds, 0)) * 10);
  return tenths % 10 === 0 ? F.seconds(tenths / 10) : F.secondsText(formatDecimal(tenths / 10, 1));
}

export function formatMinutes(minutes: number): string {
  return formatDuration(Math.round(finiteOr(minutes, 0)) * 60);
}

/** Milliseconds -> "350 ms" / "1.2 s" / "2 min". */
export function formatLatency(ms: number): string {
  const v = Math.max(0, finiteOr(ms, 0));
  if (v < 1000) return F.milliseconds(Math.round(v));
  if (v < 60000) return F.secondsText(formatDecimal(v / 1000, 1));
  return formatDuration(v / 1000);
}

/** Megabytes with no decimals above 100, one below. */
export function formatMegabytes(mb: number): string {
  const v = Math.max(0, finiteOr(mb, 0));
  return F.megabytes(v >= 100 ? formatCount(v) : formatDecimal(v, 1));
}

export function formatPerHour(n: number): string {
  return F.perHour(Math.round(finiteOr(n, 0)));
}

/**
 * Relative time of a past epoch-ms timestamp. Future timestamps (clock skew)
 * read as "just now".
 */
export function formatRelativeTime(at: number, now: number): string {
  const diffSec = Math.floor((finiteOr(now, 0) - finiteOr(at, 0)) / 1000);
  if (diffSec < 10) return F.justNow;
  if (diffSec < 60) return F.secondsAgo(diffSec);
  const min = Math.floor(diffSec / 60);
  if (min < 60) return F.minutesAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return F.hoursAgo(h);
  const d = Math.floor(h / 24);
  return d === 1 ? F.yesterday : F.daysAgo(d);
}

/** Age of a sample relative to the newest one: "now", "30 s ago", "1 min 30 s ago". */
export function formatSampleAge(at: number, latest: number): string {
  const diff = Math.round((finiteOr(latest, 0) - finiteOr(at, 0)) / 1000);
  return diff <= 0 ? F.now : F.ago(formatDuration(diff));
}

/** Elapsed time since `since` as a coarse duration ("3 days", "5 h 10 min"). */
export function formatElapsed(since: number, now: number): string {
  return formatDuration(Math.max(0, (finiteOr(now, 0) - finiteOr(since, 0)) / 1000));
}

/** Age of the cat: whole days, or "less than a day". */
export function formatAge(bornAt: number, now: number): string {
  const days = Math.floor(Math.max(0, finiteOr(now, 0) - finiteOr(bornAt, 0)) / 86_400_000);
  return days < 1 ? F.ageLessThanDay : F.days(days);
}

const MAC_MODIFIER_NAMES: ReadonlyMap<string, string> = new Map([
  ['Alt', 'Option'],
  ['Super', 'Command'],
  ['CommandOrControl', 'Command'],
]);

/** 1.4.0: what macOS calls a stored modifier (Alt is Option, Super is the Command key); other names unchanged. */
export function macModifierName(modifier: string): string {
  return MAC_MODIFIER_NAMES.get(modifier) ?? modifier;
}

/** 1.4.0: a stored accelerator as this platform names its keys; off macOS the stored text itself. */
export function displayAccelerator(accelerator: string, wording: PlatformWording): string {
  if (wording !== 'mac') return accelerator;
  return accelerator
    .split('+')
    .map((p) => macModifierName(p.trim()))
    .join('+');
}

/** "Control+Alt+Shift+C" -> "Control + Alt + Shift + C" for reading ("Control + Option + Shift + C" on macOS). */
export function formatShortcut(accelerator: string, wording: PlatformWording = 'windows'): string {
  return displayAccelerator(accelerator, wording)
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(S.shortcutKeys.separator);
}

/** camelCase / kebab / snake identifiers -> "Sentence case". */
export function humanizeId(id: string): string {
  const spaced = id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.length === 0 ? id : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function behaviorStateLabel(state: string): string {
  const known = (S.states as Readonly<Record<string, string>>)[state];
  return known ?? humanizeId(state);
}

/** Own keys only: kinds come from the persisted cat file, so "constructor" must not hit the prototype. */
function ownLabel(labels: Readonly<Record<string, string>>, id: string): string | undefined {
  return Object.hasOwn(labels, id) ? labels[id] : undefined;
}

export function memoryKindLabel(kind: string): string {
  return ownLabel(S.personality.memoryKinds, kind) ?? humanizeId(kind);
}

export function memoryDetailLabel(detail: string): string {
  return ownLabel(S.personality.memoryDetails, detail) ?? humanizeId(detail).toLowerCase();
}
