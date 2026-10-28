import { describe, expect, it } from 'vitest';
import { MEMORY_DETAILS, MEMORY_KINDS } from '../../../../src/core/behavior/memory';
import {
  behaviorStateLabel,
  formatAge,
  formatCount,
  formatDuration,
  formatElapsed,
  formatLatency,
  formatMegabytes,
  formatMinutes,
  formatMultiplier,
  formatPercent,
  formatPercentValue,
  formatPerHour,
  formatRelativeTime,
  formatSampleAge,
  formatShortcut,
  humanizeId,
  memoryDetailLabel,
  memoryKindLabel,
} from '../../../../src/renderer/settings/format';
import { S as STRINGS } from '../../../../src/renderer/settings/strings';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DAY = 24 * H;

describe('number formatting', () => {
  it('groups thousands and rounds', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(-12345.6)).toBe('-12,346');
    expect(formatCount(Number.NaN)).toBe('0');
  });

  it('formats fractions, percentages and multipliers', () => {
    expect(formatPercent(0.6)).toBe('60%');
    expect(formatPercent(0.356)).toBe('36%');
    expect(formatPercent(2.5)).toBe('250%');
    expect(formatPercentValue(1.234)).toBe('1.2%');
    expect(formatPercentValue(12.6)).toBe('13%');
    expect(formatPercentValue(-3)).toBe('0.0%');
    expect(formatMultiplier(1)).toBe('1.0×');
    expect(formatMultiplier(1.25)).toBe('1.25×');
    expect(formatMultiplier(0.5)).toBe('0.5×');
    expect(formatMultiplier(0.30000000000000004)).toBe('0.3×');
    expect(formatMegabytes(207.4)).toBe('207 MB');
    expect(formatMegabytes(1234.4)).toBe('1,234 MB');
    expect(formatMegabytes(42.25)).toBe('42.3 MB');
    expect(formatPerHour(12)).toBe('12 per hour');
  });
});

describe('durations', () => {
  it('formats seconds into compact durations', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(20)).toBe('20 s');
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(90)).toBe('1 min 30 s');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(5400)).toBe('1 h 30 min');
    expect(formatDuration(7199)).toBe('2 h');
    expect(formatDuration(86400)).toBe('1 day');
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe('2 days 3 h');
    expect(formatDuration(-5)).toBe('0 s');
    expect(formatMinutes(5)).toBe('5 min');
    expect(formatMinutes(120)).toBe('2 h');
  });

  it('formats latency', () => {
    expect(formatLatency(350.4)).toBe('350 ms');
    expect(formatLatency(1240)).toBe('1.2 s');
    expect(formatLatency(125000)).toBe('2 min 5 s');
  });
});

describe('relative time', () => {
  it('describes past timestamps against an injected clock', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 9 * S, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 45 * S, NOW)).toBe('45 s ago');
    expect(formatRelativeTime(NOW - 6 * MIN, NOW)).toBe('6 min ago');
    expect(formatRelativeTime(NOW - 2 * H - 59 * MIN, NOW)).toBe('2 h ago');
    expect(formatRelativeTime(NOW - 26 * H, NOW)).toBe('yesterday');
    expect(formatRelativeTime(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });

  it('treats future timestamps (clock skew) as just now', () => {
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
  });

  it('formats sample ages, uptime and age', () => {
    expect(formatSampleAge(NOW, NOW)).toBe('now');
    expect(formatSampleAge(NOW - 30 * S, NOW)).toBe('30 s ago');
    expect(formatSampleAge(NOW - 90 * S, NOW)).toBe('1 min 30 s ago');
    expect(formatElapsed(NOW - 3 * H - 12 * MIN, NOW)).toBe('3 h 12 min');
    expect(formatAge(NOW - 5 * H, NOW)).toBe('less than a day');
    expect(formatAge(NOW - 12 * DAY - H, NOW)).toBe('12 days');
    expect(formatAge(NOW - DAY, NOW)).toBe('1 day');
  });
});

describe('labels', () => {
  it('spaces accelerators for reading', () => {
    expect(formatShortcut('Control+Alt+Shift+C')).toBe('Control + Alt + Shift + C');
    expect(formatShortcut(' Alt + F13 ')).toBe('Alt + F13');
  });

  it('humanizes unknown identifiers', () => {
    expect(humanizeId('windowInspected')).toBe('Window inspected');
    expect(humanizeId('chase_engaged')).toBe('Chase engaged');
    expect(humanizeId('ai-reaction')).toBe('Ai reaction');
    expect(humanizeId('')).toBe('');
  });

  it('maps known memory kinds and behaviour states, falling back to humanized ids', () => {
    expect(memoryKindLabel('pet')).toBe('Was petted');
    expect(memoryKindLabel('somethingNew')).toBe('Something new');
    expect(memoryKindLabel('constructor')).toBe('Constructor');
    expect(memoryDetailLabel('somethingNew')).toBe('something new');
    expect(behaviorStateLabel('chasingCursor')).toBe('Chasing your pointer');
    expect(behaviorStateLabel('dreamingOfFish')).toBe('Dreaming of fish');
  });

  it('labels exactly the memory kinds and details the simulation records', () => {
    const P = STRINGS.personality;
    expect(Object.keys(P.memoryKinds).sort()).toEqual([...MEMORY_KINDS].sort());
    expect(Object.keys(P.memoryDetails).sort()).toEqual([...MEMORY_DETAILS].sort());
    for (const kind of MEMORY_KINDS) {
      expect(memoryKindLabel(kind), kind).toBe(P.memoryKinds[kind]);
      expect(memoryKindLabel(kind), kind).not.toBe(humanizeId(kind));
    }
    for (const detail of MEMORY_DETAILS) {
      expect(memoryDetailLabel(detail), detail).toBe(P.memoryDetails[detail]);
      expect(memoryDetailLabel(detail), detail).not.toBe(detail);
    }
  });
});
