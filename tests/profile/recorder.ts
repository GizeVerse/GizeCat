// Hook-based recorder of the behaviour profile (ADR 0003 §11, §14): it sees the simulation only
// through SimHooks (onTransition, onDecision, onExcursion, onFall, onReaction, onHunt, onSlip,
// onEdgeVisit), each sub-step's SimEnv and SimOutput, and the public CatSim methods
// (behaviorProfile, serialize, surfaceDiagnostics). No private sim field is read or wrapped, so
// a refactor of the sim's internals cannot silently disable a metric.
import type { SimHooks, TransitionRecord } from '../../src/core/behavior';
import type { DecisionRecord, EdgeVisitRecord, ExcursionRecord, FallRecord, HuntRecord, ReactionRecord, SlipRecord } from '../../src/shared/behaviorProfile';
import { ACTIVITY_CLASS } from '../../src/shared/behaviorProfile';
import type { AnimClip, BehaviorState } from '../../src/shared/cat';
import type { Point } from '../../src/shared/geometry';
import type { CatSim, SimEnv, SimEvent, SimOutput } from '../../src/shared/sim';
import { BODY_H_PX, BODY_PX } from '../integration/surfaces/pipeline';
import { SCREEN_W, type Desktop } from './desktop';
import type { Release, User } from './user';

const BL = BODY_PX;
const BH = BODY_H_PX;

export type Counter = Record<string, number>;
export const inc = (c: Counter, k: string, by = 1): void => {
  c[k] = (c[k] ?? 0) + by;
};

const PHYSICAL = new Set<string>(['held', 'jumping', 'falling', 'landing']);
const UNSETTLED = new Set<string>(['held', 'jumping', 'falling', 'landing', 'startled', 'annoyed', 'hiding']);
const ASLEEP = new Set<string>(['sleeping', 'fallingAsleep', 'wakingUp']);
const ELEVATED = new Set<string>(['windowTop', 'tabStrip', 'windowSide']);
/** Clips whose start the recorder logs as a strike (v1.2 clips; v1.1.1 pounces are counted from transitions). */
export const STRIKE_CLIPS: ReadonlySet<AnimClip> = new Set<AnimClip>(['pounce', 'swat', 'pawAt']);
/** A typing burst still counts for the "never in the way" gates this long after it ended (ADR 0003 §4.3). */
export const TYPING_GRACE_MS = 3000;
/** A press counts against a pounce within this window before it (B5b: "within 2 s of a press"). */
export const PRESS_GAP_MS = 2000;
/** Press points within this window before a strike are compared with its landing (the button gate's 6 s). */
export const PRESS_POINT_WINDOW_MS = 6000;
/** Raw typing signal of the gates: env.typing || typingIntensity > 0.35 (ADR 0003 §4.3). */
export const typingRawOf = (env: SimEnv): boolean => env.typing || env.typingIntensity > 0.35;

export function supportKey(o: SimOutput): string {
  const s = o.support;
  return s.kind === 'surface' ? s.surfaceKind : s.kind;
}

/** A strike or pounce clip start, with the user's input around it (B5b, B5c, B6). */
export interface StrikeRecord {
  at: number;
  clip: AnimClip;
  state: BehaviorState;
  /** Cursor relative to the cat's anchor at the start, body widths / heights (null: no cursor). */
  cursorDxBw: number | null;
  cursorDyBh: number | null;
  typingNear: boolean;
  /** ms since the last button press before the start (null: none yet). */
  msSincePress: number | null;
  /** Where the anchor came down (first grounded tick after the start), px; null until then. */
  landX: number | null;
  landY: number | null;
  /** Nearest press point (within PRESS_POINT_WINDOW_MS before the start) to the landing, body widths. */
  pressNearBw: number | null;
}

/** A decision, with the cursor and the raw typing signal around it (B6). */
export interface DecisionSample {
  at: number;
  state: BehaviorState;
  variant: string | null;
  cause: DecisionRecord['cause'];
  activityClass: DecisionRecord['activityClass'];
  episode: DecisionRecord['episode'];
  standingOn: DecisionRecord['standingOn'];
  typingNear: boolean;
  cursorDistBw: number | null;
}

/** v1.1.1-style reaction to a release, read from transitions (the baseline has no onReaction). */
export interface ReleaseReaction {
  at: number;
  kind: 'drag' | 'throw';
  speedDip: number;
  thrown: boolean | null;
  first: string;
  states: string[];
  hid: boolean;
  recoveryMs: number | null;
}

/** One stay (pairs an 'arrive' with its 'end'; still open at the run's end = censored there). */
export interface StayRecord {
  at: number;
  surfaceKind: ExcursionRecord['surfaceKind'];
  arrivedBy: ExcursionRecord['arrivedBy'];
  plannedMs: number;
  dwellMs: number;
  endReason: ExcursionRecord['endReason'];
  leaveKind: ExcursionRecord['leaveKind'];
  bailOut: ExcursionRecord['bailOut'] | null;
  resumed: boolean;
  open: boolean;
}

export interface RunRecords {
  decisions: DecisionSample[];
  stays: StayRecord[];
  falls: FallRecord[];
  reactions: ReactionRecord[];
  hunts: HuntRecord[];
  slips: SlipRecord[];
  edgeVisits: EdgeVisitRecord[];
  strikes: StrikeRecord[];
  releases: ReleaseReaction[];
  /** Raw typing intervals [start, end] (sim ms). */
  typing: Array<[number, number]>;
  /** Sim ms of the user's button presses (the harness's ground truth). */
  pressTimes: number[];
}

export class Recorder {
  readonly stateMs: Counter = {};
  readonly clipMs: Counter = {};
  readonly supportMs: Counter = {};
  readonly classByStateMs: Counter = {};
  readonly frontMs: Counter = {};
  readonly frontElevatedMs: Counter = {};
  readonly transitions: Counter = {};
  readonly transitionCauses: Counter = {};
  readonly floorX: number[] = Array.from({ length: 10 }, () => 0);
  simMs = 0;
  movingMs = 0;
  floorMs = 0;
  edgeMs = 0;
  presentMs = 0;
  asleepPresentMs = 0;
  napsWhilePresent = 0;
  /** Present time with the cursor in the watch band of the cat (14 bw x -0.6..4.5 bh), and within 6 bw of it. */
  cursorWatchMs = 0;
  cursorNearMs = 0;
  /** U-play: time in the play mode, and the part of it with the cursor within 6 bw in the watch band. */
  playMs = 0;
  playNearMs = 0;
  chaseStarts = 0;
  legacyPounces = 0;
  watchStarts = 0;
  readonly hookCalls: Counter = {};
  readonly records: RunRecords = { decisions: [], stays: [], falls: [], reactions: [], hunts: [], slips: [], edgeVisits: [], strikes: [], releases: [], typing: [], pressTimes: [] };
  readonly series: Record<string, number[]> = {};

  private env: SimEnv | null = null;
  private last: SimOutput | null = null;
  private openStay: StayRecord | null = null;
  private typingSince: number | null = null;
  private typingEndedAt = -Infinity;
  private lastClip: AnimClip | null = null;
  private lastClipAt = -1;
  private pendingLand: StrikeRecord[] = [];
  private tracked: Array<{ r: ReleaseReaction; landedAt: number | null; until: number; throwsBefore: number }> = [];
  private nextSampleAt = 0;

  constructor(
    private readonly sim: CatSim,
    private readonly user: User,
    private readonly desk: Desktop,
  ) {}

  /** The SimHooks this recorder needs (wire them into createInstrumentedCatSim). */
  hooks(): SimHooks {
    return {
      onTransition: (r) => this.onTransition(r),
      onDecision: (r) => this.onDecision(r),
      onExcursion: (r) => this.onExcursion(r),
      onFall: (r) => this.hook('fall', () => this.records.falls.push({ ...r })),
      onReaction: (r) => this.hook('reaction', () => this.records.reactions.push({ ...r })),
      onHunt: (r) => this.hook('hunt', () => this.records.hunts.push({ ...r, ...(r.pounceTimes ? { pounceTimes: [...r.pounceTimes] } : {}) })),
      onSlip: (r) => this.hook('slip', () => this.records.slips.push({ ...r })),
      onEdgeVisit: (r) => this.hook('edgeVisit', () => this.records.edgeVisits.push({ ...r })),
    };
  }

  private hook(kind: string, fn: () => void): void {
    inc(this.hookCalls, kind);
    fn();
  }

  counters(): Record<string, number> {
    return { ...this.sim.serialize().memory.counters };
  }

  /** Whether `t` falls in a raw typing interval or within TYPING_GRACE_MS after one. */
  typingNear(t: number): boolean {
    if (this.typingSince !== null && t >= this.typingSince) return true;
    if (t - this.typingEndedAt <= TYPING_GRACE_MS) return true;
    for (let i = this.records.typing.length - 1; i >= 0; i--) {
      const [a, b] = this.records.typing[i]!;
      if (b + TYPING_GRACE_MS < t - 600_000) break;
      if (t >= a && t <= b + TYPING_GRACE_MS) return true;
    }
    return false;
  }

  private cursorRel(): { dx: number; dy: number } | null {
    const c = this.env?.cursor;
    const o = this.last;
    if (!c || !o) return null;
    return { dx: (c.x - o.x) / BL, dy: (o.y - c.y) / BH };
  }

  // ---- hooks

  private onTransition(r: TransitionRecord): void {
    inc(this.hookCalls, 'transition');
    inc(this.transitions, `${r.from}>${r.to}`);
    inc(this.transitionCauses, r.cause);
    if (r.to === 'jumping' && (r.from === 'chasingCursor' || r.from === 'watchingCursor')) this.legacyPounces++;
    // Starts only: a chase resumed after its own pounce (landing -> chasingCursor) is the same chase.
    if (r.to === 'chasingCursor' && !PHYSICAL.has(r.from)) this.chaseStarts++;
    if (r.to === 'watchingCursor' && !PHYSICAL.has(r.from)) this.watchStarts++;
    if ((r.to === 'fallingAsleep' || r.to === 'sleeping') && !ASLEEP.has(r.from) && r.from !== 'away' && this.user.present) this.napsWhilePresent++;
    for (const tr of this.tracked) {
      if (r.at > tr.until) continue;
      if (r.to === 'landing' && tr.landedAt === null) {
        tr.landedAt = r.at;
        tr.until = r.at + 30_000;
        continue;
      }
      if (tr.landedAt === null || PHYSICAL.has(r.to)) continue;
      if (tr.r.first === '-') tr.r.first = r.to;
      tr.r.states.push(r.to);
      if (r.to === 'hiding') tr.r.hid = true;
      if (tr.r.recoveryMs === null && !UNSETTLED.has(r.to)) tr.r.recoveryMs = r.at - tr.landedAt;
    }
  }

  private onDecision(r: DecisionRecord): void {
    inc(this.hookCalls, 'decision');
    const rel = this.cursorRel();
    this.records.decisions.push({
      at: r.at,
      state: r.state,
      variant: r.variant,
      cause: r.cause,
      activityClass: r.activityClass,
      episode: r.episode,
      standingOn: r.standingOn,
      typingNear: this.typingNear(r.at),
      cursorDistBw: rel ? Math.round(Math.hypot(rel.dx, (rel.dy * BH) / BL) * 100) / 100 : null,
    });
  }

  private onExcursion(r: ExcursionRecord): void {
    inc(this.hookCalls, `excursion:${r.phase}`);
    if (r.phase === 'arrive') {
      if (this.openStay) this.closeStay(r.at, null);
      this.openStay = { at: r.at, surfaceKind: r.surfaceKind, arrivedBy: r.arrivedBy, plannedMs: r.plannedMs, dwellMs: 0, endReason: null, leaveKind: null, bailOut: null, resumed: r.resumed === true, open: true };
      return;
    }
    const s = this.openStay ?? { at: r.at - r.dwellMs, surfaceKind: r.surfaceKind, arrivedBy: r.arrivedBy, plannedMs: r.plannedMs, dwellMs: 0, endReason: null, leaveKind: null, bailOut: null, resumed: false, open: true };
    s.dwellMs = r.dwellMs;
    s.endReason = r.endReason;
    s.leaveKind = r.leaveKind;
    s.bailOut = r.bailOut ?? null;
    if (r.plannedMs > 0) s.plannedMs = r.plannedMs;
    s.open = false;
    this.records.stays.push(s);
    this.openStay = null;
  }

  private closeStay(t: number, reason: ExcursionRecord['endReason']): void {
    const s = this.openStay;
    if (!s) return;
    s.dwellMs = Math.max(0, t - s.at);
    s.endReason = reason;
    this.records.stays.push(s);
    this.openStay = null;
  }

  onRelease(r: Release): void {
    const tr = { r: { at: r.at, kind: r.kind, speedDip: Math.round(r.speedDip), thrown: null, first: '-', states: [] as string[], hid: false, recoveryMs: null }, landedAt: null, until: r.at + 10_000, throwsBefore: this.counters().throws ?? 0 };
    this.tracked.push(tr);
    this.records.releases.push(tr.r);
  }

  // ---- steps

  /** Before each sim sub-step: the environment the hooks of this step see. */
  beforeStep(env: SimEnv): void {
    this.env = env;
    const t = env.now;
    const typing = typingRawOf(env);
    if (typing && this.typingSince === null) this.typingSince = t;
    if (!typing && this.typingSince !== null) {
      this.records.typing.push([this.typingSince, t]);
      this.typingSince = null;
      this.typingEndedAt = t;
    }
  }

  /** After every sim sub-step (the host may run several per host tick). */
  afterStep(env: SimEnv, events: readonly SimEvent[], out: SimOutput): void {
    const dt = env.dt;
    const t = env.now;
    const sup = supportKey(out);
    this.simMs += dt;
    inc(this.stateMs, out.state, dt);
    inc(this.clipMs, out.clip, dt);
    inc(this.supportMs, sup, dt);
    const cls = ACTIVITY_CLASS[out.state] ?? 'calm';
    inc(this.classByStateMs, cls, dt);
    const present = this.user.present;
    if (present) {
      this.presentMs += dt;
      if (cls === 'asleep') this.asleepPresentMs += dt;
    }
    const front = this.desk.maximizedFront ? 'maximizedFront' : Object.keys(this.desk.windows).length === 0 ? 'noWindow' : 'windowFront';
    inc(this.frontMs, front, dt);
    if (ELEVATED.has(sup)) inc(this.frontElevatedMs, front, dt);

    const prev = this.last;
    const d = prev ? Math.hypot(out.x - prev.x, out.y - prev.y) : 0;
    if (d > 0.5 && sup !== 'held' && !out.snap) this.movingMs += dt;
    if (sup === 'floor') {
      this.floorMs += dt;
      const i = Math.min(9, Math.max(0, Math.floor((out.x / SCREEN_W) * 10)));
      this.floorX[i] = (this.floorX[i] ?? 0) + dt;
      if (out.x < 2 * BL || out.x > SCREEN_W - 2 * BL) this.edgeMs += dt;
    }

    // Cursor around the cat (the user models' lingering; the watch band of ADR 0003 §4.1).
    const c = env.cursor;
    const playing = this.user.mode === 'play';
    if (playing) this.playMs += dt;
    if (c && present && out.visible) {
      const dx = Math.abs(c.x - out.x) / BL;
      const dy = (out.y - c.y) / BH;
      if (dx <= 14 && dy >= -0.6 && dy <= 4.5) {
        this.cursorWatchMs += dt;
        if (dx <= 6) {
          this.cursorNearMs += dt;
          if (playing) this.playNearMs += dt;
        }
      }
    }

    // Strikes: a new strike clip (by start time) is logged with the input around it.
    if (STRIKE_CLIPS.has(out.clip) && (out.clip !== this.lastClip || out.clipStartedAt !== this.lastClipAt)) {
      const rel = c ? { dx: (c.x - out.x) / BL, dy: (out.y - c.y) / BH } : null;
      const lastPress = this.user.log.presses[this.user.log.presses.length - 1];
      const s: StrikeRecord = {
        at: t,
        clip: out.clip,
        state: out.state,
        cursorDxBw: rel ? Math.round(rel.dx * 100) / 100 : null,
        cursorDyBh: rel ? Math.round(rel.dy * 100) / 100 : null,
        typingNear: this.typingNear(t),
        msSincePress: lastPress ? Math.round(t - lastPress.at) : null,
        landX: null,
        landY: null,
        pressNearBw: null,
      };
      this.records.strikes.push(s);
      this.pendingLand.push(s);
    }
    this.lastClip = out.clip;
    this.lastClipAt = out.clipStartedAt;
    if (this.pendingLand.length && out.support.kind !== 'air' && out.support.kind !== 'held' && out.state !== 'jumping') {
      for (const s of this.pendingLand) {
        s.landX = Math.round(out.x);
        s.landY = Math.round(out.y);
        s.pressNearBw = this.nearestPressBw({ x: out.x, y: out.y - 0.5 * BH }, s.at);
      }
      this.pendingLand = [];
    }

    // v1.1.1-style release reactions.
    if (events.some((e) => e.type === 'pointer.dragStart')) for (const tr of this.tracked) if (tr.landedAt !== null) tr.until = Math.min(tr.until, t - 1);
    if (events.some((e) => e.type === 'pointer.dragEnd')) {
      const throws = this.counters().throws ?? 0;
      for (const tr of this.tracked) if (tr.r.thrown === null) tr.r.thrown = throws > tr.throwsBefore;
    }
    this.tracked = this.tracked.filter((tr) => t <= tr.until);

    if (t >= this.nextSampleAt) {
      this.nextSampleAt = t + 5000;
      const cat = this.sim.serialize();
      for (const [k, v] of Object.entries(cat.stats)) (this.series[k] ??= []).push(v);
      for (const [k, v] of Object.entries(cat.drives ?? {})) (this.series[`drive.${k}`] ??= []).push(v);
      (this.series.exploreUrge ??= []).push(this.sim.surfaceDiagnostics().decision.exploreUrge);
    }
    this.last = out;
  }

  private nearestPressBw(p: Point, at: number): number | null {
    let best: number | null = null;
    const ps = this.user.log.presses;
    for (let i = ps.length - 1; i >= 0; i--) {
      const q = ps[i]!;
      if (q.at < at - PRESS_POINT_WINDOW_MS) break;
      const dBw = Math.hypot(q.x - p.x, q.y - p.y) / BL;
      best = best === null ? dBw : Math.min(best, dBw);
    }
    return best === null ? null : Math.round(best * 100) / 100;
  }

  finish(t: number): void {
    if (this.typingSince !== null) {
      this.records.typing.push([this.typingSince, t]);
      this.typingSince = null;
    }
    if (this.openStay) {
      // Still up there when the run ended: censored at the run's end.
      this.openStay.dwellMs = Math.max(0, t - this.openStay.at);
      this.records.stays.push(this.openStay);
      this.openStay = null;
    }
    this.records.pressTimes = this.user.log.presses.map((p) => p.at);
  }
}
