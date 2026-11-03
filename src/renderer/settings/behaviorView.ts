// DOM-free view model of the Diagnostics page's Behaviour section (v1.2, ADR 0003 §11): turns the
// behaviour profile main validated into labelled rows. Kinds, counts and durations only; every
// duration is the sim's own clock, every count this session's.
import { ACTIVITY_CLASSES, FALL_CAUSES, HUNT_OUTCOMES, LEAVE_KINDS, MOOD_EXPOSURES, PROFILE_CONTEXTS, STAY_END_REASONS, STAY_SURFACE_KINDS, THROW_REACTIONS, type ActivityClass, type BehaviorProfileSnapshot } from '../../shared/behaviorProfile';
import { LANDING_IMPACTS } from '../../shared/cat';
import { formatCount, formatDuration, formatPercent } from './format';
import { S } from './strings';

const V = S.diagnostics.behavior;

export type Entry = readonly [string, string];

/** Table order: what the bands are about first (active, calm, asleep), then the rest. */
export const CLASS_ORDER = ['active', 'calm', 'asleep', 'interaction', 'reaction', 'physical', 'away'] as const satisfies readonly ActivityClass[];

const ms = (v: number): string => formatDuration(Math.max(0, v) / 1000);
const n = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** "Label 3 · Other label 1", largest first, in `order` for ties; `none` when every count is 0. */
export function countList<K extends string>(counts: Partial<Record<K, number>>, order: readonly K[], labels: Record<K, string>, none: string): string {
  const items = order
    .map((k, i) => ({ k, i, v: n(counts[k]) }))
    .filter((e) => e.v > 0)
    .sort((a, b) => b.v - a.v || a.i - b.i);
  if (items.length === 0) return none;
  return items.map((e) => `${labels[e.k]} ${formatCount(e.v)}`).join(' · ');
}

export interface TimeRow {
  cls: ActivityClass;
  label: string;
  time: string;
  share: string;
}

/** One row per activity class with time and share of all counted time. */
export function timeRows(p: BehaviorProfileSnapshot): TimeRow[] {
  const total = ACTIVITY_CLASSES.reduce((sum, c) => sum + n(p.timeMs[c]), 0);
  return CLASS_ORDER.map((c) => ({ cls: c, label: V.classes[c], time: ms(n(p.timeMs[c])), share: total > 0 ? formatPercent(n(p.timeMs[c]) / total) : formatPercent(0) }));
}

export function summaryEntries(p: BehaviorProfileSnapshot): Entry[] {
  return [
    [V.span, ms(n(p.at) - n(p.since))],
    [V.activeShare, formatPercent(n(p.activeShare))],
    [V.decisions, formatCount(n(p.decisions))],
    [V.naps, formatCount(n(p.sleeps))],
    [V.stuckResets, formatCount(n(p.stuckResets))],
  ];
}

export function stayEntries(p: BehaviorProfileSnapshot): Entry[] {
  const x = p.excursions;
  const q = x.dwellS;
  const sec = (s: number): string => formatDuration(Math.max(0, s));
  return [
    [V.arrivals, formatCount(n(x.arrivals))],
    [V.where, countList(x.byKind, STAY_SURFACE_KINDS, V.stayKinds, S.common.notAvailable)],
    [V.dwell, q.n > 0 ? V.dwellValue(sec(q.p50), sec(q.p10), sec(q.p90), q.n) : V.noStays],
    [V.ends, countList(x.byEnd, STAY_END_REASONS, V.endReasons, V.noStays)],
    [V.leaves, countList(x.byLeave, LEAVE_KINDS, V.leaveKinds, V.noStays)],
  ];
}

export function huntEntries(p: BehaviorProfileSnapshot): Entry[] {
  return [
    [V.hunts, formatCount(n(p.hunts.count))],
    [V.pounces, formatCount(n(p.hunts.pounces))],
    [V.outcomes, countList(p.hunts.byOutcome, HUNT_OUTCOMES, V.huntOutcomes, V.none)],
  ];
}

export function physicsEntries(p: BehaviorProfileSnapshot): Entry[] {
  return [
    [V.falls, n(p.falls.count) > 0 ? `${formatCount(n(p.falls.count))} · ${countList(p.falls.byCause, FALL_CAUSES, V.fallCauses, V.none)}` : formatCount(0)],
    [V.impacts, countList(p.falls.byImpact, LANDING_IMPACTS, V.impactKinds, V.none)],
    [V.slips, formatCount(n(p.slips))],
    [V.edgeVisits, formatCount(n(p.screenEdgeVisits))],
    [V.edgePeeks, formatCount(n(p.screenEdgePeeks))],
  ];
}

export function reactionSummary(p: BehaviorProfileSnapshot): string {
  return countList(p.reactions, THROW_REACTIONS, V.reactionKinds, V.none);
}

/** Time with each mood above its threshold, then the content-free context durations. */
export function moodEntries(p: BehaviorProfileSnapshot): Entry[] {
  return [...MOOD_EXPOSURES.map((m): Entry => [V.moods[m], ms(n(p.moodMs[m]))]), ...PROFILE_CONTEXTS.map((c): Entry => [V.contexts[c], ms(n(p.context[c]))])];
}
