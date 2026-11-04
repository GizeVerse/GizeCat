// The decision's vocabulary (candidates, variants, the view of the cat and its surroundings). The sim
// picks with utility.ts (ADR 0003 §1.3-§1.5: every feasible candidate, variant-keyed repetition,
// rhythm, softmax at tau 0.5).
import type { BehaviorState } from '../../shared/cat';
import type { Drives, Stats, Traits } from '../../shared/catState';
import type { Point } from '../../shared/geometry';
import type { BehaviorId, Settings } from '../../shared/settings';
import type { SupportSurfaceKind, SurfaceKind } from '../../shared/surfaces';

export type Variant =
  | 'wander'
  | 'favorite'
  | 'called'
  | 'follow'
  | 'retreat'
  | 'flee'
  | 'greet'
  | 'nearby'
  | 'look'
  | 'pawAt'
  | 'rollOver'
  | 'zoomies'
  | 'hop'
  | 'explore'
  | 'intro'
  | 'idleSleep'
  | 'forced'
  | 'corner'
  | 'surprise'
  | 'playful'
  | 'screen'
  // v1.1 surfaces
  /** Sitting on a window top's edge, looking down into the window. */
  | 'edge'
  /** Climbing a window side (up to the top corner, or down from it). */
  | 'climb'
  /** Visiting or walking along a browser tab strip. */
  | 'tabStrip'
  /** Hopping onto (or off) the taskbar. */
  | 'taskbar'
  /** A short start after the surface under the cat suddenly vanished. */
  | 'lostFooting'
  /** v1.1.1: walking along the window top or tab strip it just got onto, before anything else. */
  | 'patrol'
  // ---- v1.2 (ADR 0003): new acts are variants, phases and clips, never new states (D14) ----
  /** idle: a standing stretch after a long rest or sleep. */
  | 'stretch'
  /** resting: lying low at a wall's foot, a strip end or a corner, ready to hunt a passing cursor. */
  | 'ambush'
  /** chasingCursor: the v1.2 hunt (notice, approach, stalk, crouch, pounce, bat). */
  | 'hunt'
  /** watchingCursor: chattering at a cursor too high to hunt. */
  | 'chatter'
  /** playing: chasing its own tail. */
  | 'tailChase'
  /** idle on a tab strip: watching the active tab. */
  | 'watchTab'
  /** curious: a look at the new top of a window that was restored or un-maximized. */
  | 'restored'
  /** walking or running: the stay's leave intent on its way down (Mover.leaveBy). */
  | 'leave'
  /** walking: a visit to an outer screen edge (a climb to the top hold, or a short low peek). */
  | 'screenEdge'
  /** grooming: a displacement groom after losing interest or a surprise. */
  | 'displacement'
  // reactions to rough handling (ReactionRecord.kind); 'jolt' = the surprise reaction's short startle
  | 'jolt'
  | 'shrug'
  | 'startledJump'
  | 'grumpy'
  | 'defensive'
  | 'flight'
  | 'playfulReaction'
  | 'avoid'
  /** walking: the slow, low retreat (slink rule, startled jump). */
  | 'slink';

export interface Candidate {
  state: BehaviorState;
  variant: Variant | null;
  target: Point | null;
  windowId: string | null;
  then: BehaviorState | null;
  /** Variant of the follow-up (`then`), e.g. a patrol along the top a climb ends on. */
  thenVariant: Variant | null;
  /** v1.2: kind of surface a trip goes to (part of its repetition key). */
  surfaceKind?: SupportSurfaceKind | null;
  /** v1.2: the place a trip goes to (a surface id, in memory only) for place novelty. */
  place?: string | null;
}

/** v1.2: the stay the cat is on (ADR 0003 §2.2): the decision pool holds only the on-surface plan. */
/** v1.2: an outer screen edge the cat may visit (ADR 0003 §6.1(b)); `point` is the wall's foot. */
export interface EdgeTarget {
  wallId: string;
  side: 'left' | 'right';
  point: Point;
  /** Anchor height to hold at, px. */
  gripY: number;
  /** A short, low peek (covered band, or the left edge of a visible desktop), not a full climb. */
  peek: boolean;
  /** The band is covered by a window. */
  covered: boolean;
}

export interface StayView {
  kind: 'windowTop' | 'tabStrip';
  /** Walkable span on the surface, body widths. */
  walkRangeBl: number;
  /** A patrol (walk along) is allowed now (>= 45 s since the last one). */
  patrolReady: boolean;
  /** A point along the surface to patrol to (null: no room). */
  patrolTarget: Point | null;
  /** Strips: the active tab to watch (focusX on the strip). */
  watchTab: Point | null;
}

export interface DecisionView {
  traits: Traits;
  stats: Stats;
  behavior: Settings['behavior'];
  /** Switched-off behaviours: disabledBehaviorSet (both lists and the implied opt-outs). */
  disabled: ReadonlySet<BehaviorId>;
  localHour: number;
  typing: boolean;
  userIdleMs: number;
  /** Rapid foreground switching: observe instead of moving. */
  busySwitching: boolean;
  /** The foreground app is a video player, game or media app (windowed): the cat keeps quiet. */
  mediaForeground: boolean;
  /** Coarse look of the screen from recent local statistics (Tier B) or an AI scene (Tier C); null when unknown or stale. */
  screen: 'video' | 'busy' | 'quiet' | null;
  /** Rough handling (throws, annoyed reactions) remembered from the last hour, across restarts. */
  recentRough: number;
  cursor: { point: Point; speedDip: number; distBodyLengths: number; reachable: boolean } | null;
  foreground: { center: Point; distBodyLengths: number } | null;
  favoriteSpot: { point: Point; distBodyLengths: number } | null;
  perchTarget: { windowId: string; point: Point } | null;
  wanderTarget: Point | null;
  /** The far end of the floor (or window top / taskbar) the cat stands on, when it is a walk away. */
  cornerTarget: Point | null;
  /** What the cat stands on. */
  standingOn: 'floor' | SurfaceKind;
  /** A climb up a window side to its top corner, or down from the window top the cat stands on (null: none, off or cooling down). */
  climbTarget: { point: Point; dir: 'up' | 'down'; ownerId?: string } | null;
  /** A tab-strip rest point worth a visit, or a walk along the strip the cat stands on (null: none, off or cooling down). */
  tabStripTarget: Point | null;
  /** Standing on a window top: sit on its edge and look down into the window. */
  edgeLook: { windowId: string; point: Point } | null;
  /** The long cooldown of an occasional surprise startle has elapsed. */
  surpriseReady: boolean;
  /**
   * v1.1.1, 0..1: grows while the cat is on the floor (or a taskbar) and some window top, side or
   * tab strip is within reach; resets when it gets up onto one. Raises the odds of a trip up.
   */
  exploreUrge: number;
  isCoolingDown: (s: BehaviorState) => boolean;
  // ---- v1.2 (ADR 0003 §1.4), optional: absent = derived from the v1.1 fields above ----------
  /** ms since the last raw keyboard-like input (Infinity: none yet). */
  sinceTypingMs?: number;
  /** The window of `tabStripTarget`, for place novelty (in memory only). */
  tabStripOwner?: string | null;
  /** An outer screen edge the cat may visit now (gated on env.edgeBands, ADR 0003 §6.1(b)). */
  edgeTarget?: EdgeTarget | null;
  /** The place (`w:<window id>`) a covered or vanished stay can resume on (trip x2, ADR 0003 §2.4). */
  resumePlace?: string | null;
  drives?: Drives;
  /** Effective sleepiness (drives.ts zEff). */
  zEff?: number;
  /** Raw keyboard-like input, whatever 'React to typing' says: every "never in the way" gate reads it. */
  typingRaw?: boolean;
  /** Rhythm episode (rhythm.ts); 'none' = not weighed. */
  episode?: 'active' | 'calm' | 'none';
  /** The stay the cat is on, or null. */
  stay?: StayView | null;
  /** Repetition keys of the last picks, most recent first (utility.ts candidateKey). */
  recentKeys?: readonly string[];
  /** Key of the activity being left. */
  currentKey?: string | null;
  /** Place novelty of a trip target. */
  placeSeen?: (place: string) => 'recent' | 'session' | 'never';
  /** The hunt drive is above its threshold, its cooldown is over and no gate holds (one start path, hunt.ts). */
  huntReady?: boolean;
  /** The cursor in the watch band (14 bw x -0.6..4.5 bh): 'watch'; more than 2.5 bh above the feet: 'chatter'. */
  cursorBand?: 'watch' | 'chatter' | null;
  /** The cat's anchor and body width, px (distances in body widths). */
  cat?: { x: number; y: number; bw: number };
  /** ms of rest or sleep just before this decision (a stretch after >= 60 s). */
  restedMs?: number;
  /** A stimulus happened in the last few seconds (a surprise startle needs one). */
  recentStimulus?: boolean;
  /** A wall's foot, strip end or corner the cat is at (ambush spot), or null. */
  ambushSpot?: Point | null;
  /** Soft cursor avoidance after rough handling: walk targets within 4 bw of the cursor are dropped. */
  avoidCursor?: boolean;
  /** The foreground window's id (mischief: its top gets a place-novelty bonus). */
  foregroundId?: string | null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 0..1 how much the cat wants to sleep: low energy, time awake, night, a dark screen. */
export function sleepiness(v: { stats: Pick<Stats, 'energy'>; traits: Pick<Traits, 'laziness'>; localHour: number; darkBias: number; awakeMs: number }): number {
  const need = clamp01((0.6 - v.stats.energy) / 0.45);
  const awakeMin = v.awakeMs / 60_000;
  const pressure = clamp01((awakeMin - (20 + 25 * (1 - v.traits.laziness))) / 60);
  const night = v.localHour >= 23 || v.localHour < 6 ? 1 : 0;
  return clamp01(need + 0.8 * pressure + 0.15 * night + 0.2 * v.darkBias + 0.08 * v.traits.laziness);
}

export function userIdleForSleep(v: Pick<DecisionView, 'userIdleMs' | 'behavior'>): boolean {
  return v.userIdleMs >= v.behavior.sleepAfterIdleMinutes * 60_000;
}
