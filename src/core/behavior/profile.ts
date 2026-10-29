// v1.2 behaviour profile recorder (ADR 0003 §11): folds the sim's records (the same ones SimHooks
// receive) into a bounded, session-scoped snapshot of kinds, counts and durations. Pure; the sim
// owns one and CatSim.behaviorProfile() returns its snapshot. tests/profile computes the target
// bands from the same records, so the packaged diagnostics and the SIMULATED profile agree.
import type { BehaviorState } from '../../shared/cat';
import type {
  ActivityClass,
  ArrivalRoute,
  BehaviorProfileSnapshot,
  DecisionRecord,
  EdgeVisitRecord,
  ExcursionRecord,
  FallCause,
  FallRecord,
  HuntRecord,
  MoodExposure,
  ProfileContext,
  ReactionRecord,
  SlipRecord,
} from '../../shared/behaviorProfile';
import { activityClassOf, emptyBehaviorProfile, MAX_DWELL_SAMPLES, MAX_RECENT_STAYS, MOOD_EXPOSURE_THRESHOLDS, quantiles } from '../../shared/behaviorProfile';
import type { LandingInfo, SupportLossReason } from '../movement';

const inc = <K extends string>(rec: Partial<Record<K, number>>, key: K, by = 1): void => {
  rec[key] = (rec[key] ?? 0) + by;
};

/** Why the sim put the cat in the air (sim.ts FallReason). */
export type FlightReason = 'drop' | 'throw' | 'perch' | 'step' | 'jump' | 'retracted';

/**
 * Fall cause of a landing (null: a planned move that went to plan; not a fall). Review C2 fixes:
 * a deliberate 'miss' slip is 'slip' whatever the flight reason, and a planned jump that did not
 * land on the support it aimed at is 'gone' (that support vanished) or 'physics' (it still exists:
 * the plan went stale in the air), so B9 sees it.
 */
export function fallCauseOf(
  reason: FlightReason | null,
  lossReason: SupportLossReason | null,
  info: Pick<LandingInfo, 'slipped' | 'plannedOutcome' | 'forced'>,
): FallCause | null {
  if (info.slipped) return 'slip';
  switch (reason) {
    case 'throw':
      return 'thrown';
    case 'drop':
      return 'dropped';
    case 'perch':
      return 'gone';
    case 'retracted':
      return lossReason === 'occluded' ? 'covered' : lossReason === 'headroom' ? 'physics' : 'retracted';
    case 'jump':
    case 'step':
      if (info.plannedOutcome === 'missed') return 'physics';
      if (info.plannedOutcome === 'gone') return 'gone';
      return info.forced ? 'physics' : null;
    default:
      return info.forced ? 'physics' : null;
  }
}

/** How the cat got onto a stay's surface, from how it was attached the tick before and why it last flew. */
export function arrivalRouteOf(prev: 'ground' | 'wall' | 'air' | 'held', flight: FlightReason | null): ArrivalRoute {
  switch (prev) {
    case 'wall':
      return 'climb';
    case 'held':
      return 'carried';
    case 'ground':
      return 'walk';
    case 'air':
      if (flight === 'jump' || flight === 'step') return 'jump';
      if (flight === 'throw' || flight === 'drop') return 'carried';
      return 'other';
  }
}

export class BehaviorProfileRecorder {
  private snap: BehaviorProfileSnapshot;
  private readonly dwells: number[] = [];
  private lastClass: ActivityClass | null = null;

  constructor(now: number) {
    this.snap = emptyBehaviorProfile(now);
  }

  /** Time spent in `state` (running `variant`) this tick (ms), classified by activityClassOf. */
  addTime(state: BehaviorState, dtMs: number, variant: string | null = null): void {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return;
    const cls: ActivityClass = activityClassOf(state, variant);
    if (cls === 'asleep' && this.lastClass !== null && this.lastClass !== 'asleep') this.snap.sleeps++;
    this.lastClass = cls;
    this.snap.timeMs[cls] += dtMs;
  }

  /** Time (ms) a content-free context held this tick. */
  addContext(kind: ProfileContext, dtMs: number): void {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return;
    this.snap.context[kind] += dtMs;
  }

  /** Mood exposure this tick: each mood above its MOOD_EXPOSURE_THRESHOLDS value adds dtMs. */
  addMoods(moods: Readonly<Record<MoodExposure, number>>, dtMs: number): void {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return;
    for (const k of Object.keys(MOOD_EXPOSURE_THRESHOLDS) as MoodExposure[]) {
      const v = moods[k];
      if (Number.isFinite(v) && v > MOOD_EXPOSURE_THRESHOLDS[k]) this.snap.moodMs[k] += dtMs;
    }
  }

  decision(r: DecisionRecord): void {
    this.snap.decisions++;
    if (r.cause === 'watchdog') this.snap.stuckResets++;
  }

  excursion(r: ExcursionRecord): void {
    const e = this.snap.excursions;
    if (r.phase === 'arrive') {
      e.arrivals++;
      inc(e.byKind, r.surfaceKind);
      return;
    }
    if (r.endReason) inc(e.byEnd, r.endReason);
    if (r.leaveKind) inc(e.byLeave, r.leaveKind);
    this.dwells.push(Math.max(0, r.dwellMs) / 1000);
    if (this.dwells.length > MAX_DWELL_SAMPLES) this.dwells.splice(0, this.dwells.length - MAX_DWELL_SAMPLES);
    this.snap.recentStays.push({ ...r });
    if (this.snap.recentStays.length > MAX_RECENT_STAYS) this.snap.recentStays.splice(0, this.snap.recentStays.length - MAX_RECENT_STAYS);
  }

  fall(r: FallRecord): void {
    const f = this.snap.falls;
    f.count++;
    inc(f.byCause, r.cause);
    inc(f.byImpact, r.impact);
  }

  /** A deliberate slip of either kind (a 'miss' also reports its fall with cause 'slip'). */
  slip(r: SlipRecord): void {
    void r;
    this.snap.slips++;
  }

  reaction(r: ReactionRecord): void {
    inc(this.snap.reactions, r.kind);
  }

  hunt(r: HuntRecord): void {
    const h = this.snap.hunts;
    h.count++;
    h.pounces += Math.max(0, Math.floor(r.pounces));
    inc(h.byOutcome, r.outcome);
  }

  edgeVisit(r: EdgeVisitRecord): void {
    this.snap.screenEdgeVisits++;
    if (r.covered) this.snap.screenEdgePeeks++;
  }

  /** A copy of the current snapshot at sim time `now`. */
  snapshot(now: number): BehaviorProfileSnapshot {
    const s = this.snap;
    const t = s.timeMs;
    const awake = t.calm + t.active + t.interaction + t.reaction + t.physical;
    return {
      ...s,
      at: Number.isFinite(now) ? now : s.at,
      timeMs: { ...t },
      activeShare: awake > 0 ? t.active / awake : 0,
      excursions: { ...s.excursions, byKind: { ...s.excursions.byKind }, byEnd: { ...s.excursions.byEnd }, byLeave: { ...s.excursions.byLeave }, dwellS: quantiles(this.dwells) },
      hunts: { ...s.hunts, byOutcome: { ...s.hunts.byOutcome } },
      falls: { count: s.falls.count, byCause: { ...s.falls.byCause }, byImpact: { ...s.falls.byImpact } },
      reactions: { ...s.reactions },
      context: { ...s.context },
      moodMs: { ...s.moodMs },
      recentStays: s.recentStays.map((r) => ({ ...r })),
    };
  }
}
