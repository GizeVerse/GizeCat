// The decision's vocabulary (candidates, variants, the view of the cat and its surroundings) and
// the v1.1.1 reference scorer. Since v1.2 the sim picks with utility.ts (ADR 0003 §1.3-§1.5: every
// feasible candidate, variant-keyed repetition, rhythm, softmax at tau 0.5); scoreCandidates,
// applyRepetitionPenalty and chooseActivity below stay as the v1.1.1 reference the opt-in baseline
// profile harness (tests/profile) compares against. The sim no longer calls them.
import type { BehaviorState } from '../../shared/cat';
import type { Drives, Preferences, Stats, Traits } from '../../shared/catState';
import type { Point } from '../../shared/geometry';
import type { BehaviorId, Settings } from '../../shared/settings';
import type { SupportSurfaceKind, SurfaceKind } from '../../shared/surfaces';
import type { Random, Scored } from './random';
import { softmaxPick } from './random';

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
  prefs: Preferences;
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
  /** 0..1 "the screen is dark" bias from perception. */
  darkBias: number;
  /** ms since the user last interacted with the cat. */
  quietMs: number;
  /** ms since the cat last slept (sleep pressure builds while awake). */
  awakeMs: number;
  cursor: { point: Point; speedDip: number; distBodyLengths: number; reachable: boolean } | null;
  foreground: { center: Point; distBodyLengths: number } | null;
  favoriteSpot: { point: Point; distBodyLengths: number } | null;
  perchTarget: { windowId: string; point: Point } | null;
  wanderTarget: Point | null;
  /** The far end of the floor (or window top / taskbar) the cat stands on, when it is a walk away. */
  cornerTarget: Point | null;
  /** 0..1 share of the last ~30 s with keyboard-like activity: intensive typing keeps the cat off surfaces. */
  typingIntensity: number;
  /** What the cat stands on. */
  standingOn: 'floor' | SurfaceKind;
  /** A climb up a window side to its top corner, or down from the window top the cat stands on (null: none, off or cooling down). */
  climbTarget: { point: Point; dir: 'up' | 'down' } | null;
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
  /**
   * v1.1.1: up on a window top or tab strip it has explored, the floor below to head back down to
   * (null: not up there, or still exploring it), and how long it has been up there, ms.
   */
  downTarget: Point | null;
  elevatedMs: number;
  /** Most recent first, the activities chosen lately. */
  recentStates: readonly BehaviorState[];
  /** The state being left. */
  current: BehaviorState;
  isCoolingDown: (s: BehaviorState) => boolean;
  // ---- v1.2 (ADR 0003 §1.4), optional: absent = derived from the v1.1 fields above ----------
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
  /** The cursor is inside the foreground window (work disruption). */
  cursorInForeground?: boolean;
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
export function sleepiness(v: Pick<DecisionView, 'stats' | 'traits' | 'localHour' | 'darkBias' | 'awakeMs'>): number {
  const need = clamp01((0.6 - v.stats.energy) / 0.45);
  const awakeMin = v.awakeMs / 60_000;
  const pressure = clamp01((awakeMin - (20 + 25 * (1 - v.traits.laziness))) / 60);
  const night = v.localHour >= 23 || v.localHour < 6 ? 1 : 0;
  return clamp01(need + 0.8 * pressure + 0.15 * night + 0.2 * v.darkBias + 0.08 * v.traits.laziness);
}

export function userIdleForSleep(v: Pick<DecisionView, 'userIdleMs' | 'behavior'>): boolean {
  return v.userIdleMs >= v.behavior.sleepAfterIdleMinutes * 60_000;
}

function cand(state: BehaviorState, extra: Partial<Candidate> = {}): Candidate {
  return { state, variant: null, target: null, windowId: null, then: null, thenVariant: null, ...extra };
}

/** Up on a top it explored, the pull to come back down starts after this long up there and is full this much later. */
export const DOWN_PULL_AFTER_MS = 20_000;
export const DOWN_PULL_RAMP_MS = 120_000;

/** Share of a trip up's own utility left right after the last trip (urge 0); all of it at urge 1. */
export const EXCURSION_RHYTHM_MIN = 0.35;

/** Weight of the exploration urge at urge 1, autonomy 1 (see excursionBoost). */
export const EXPLORE_URGE_WEIGHT = 0.8;

/**
 * v1.1.1: utility added to each trip up (exploring a window top, climbing a side, visiting a tab
 * strip) by the exploration urge. Cubic in the urge, so a cat that just came down stays
 * down for a while; at urge 1 a trip up beats sitting, wandering and grooming for a calm,
 * rested cat at the default autonomy (scaled by autonomy, never to nothing). Fear, annoyance,
 * low energy, typing, fast app switching, video and the night damp it. Sleep still wins (a
 * tired cat's nap outscores it; with nobody around only rest options exist), and switched-off
 * behaviours never get it (their options do not exist).
 */
export function excursionBoost(v: Pick<DecisionView, 'exploreUrge' | 'behavior' | 'stats' | 'typing' | 'typingIntensity' | 'busySwitching' | 'mediaForeground' | 'screen' | 'localHour'>): number {
  const urge = Number.isFinite(v.exploreUrge) ? clamp01(v.exploreUrge) : 0;
  if (!(urge > 0)) return 0;
  const s = v.stats;
  const autonomy = clamp01(v.behavior.autonomy);
  const typing = v.typing && v.behavior.reactToTyping;
  const intensity = v.behavior.reactToTyping && Number.isFinite(v.typingIntensity) ? clamp01(v.typingIntensity) : 0;
  const energyGate = clamp01((s.energy - 0.15) / 0.35);
  const calm = (1 - clamp01((s.fear - 0.2) / 0.3)) * (1 - clamp01((s.annoyance - 0.3) / 0.4));
  const night = v.localHour >= 23 || v.localHour < 6;
  const video = v.mediaForeground || v.screen === 'video';
  const context = (typing ? 0.5 : 1) * (1 - 0.4 * intensity) * (v.busySwitching ? 0.5 : 1) * (night ? 0.75 : 1) * (video ? 0.5 : 1);
  return urge * urge * urge * EXPLORE_URGE_WEIGHT * (0.35 + 0.65 * autonomy) * energyGate * calm * context;
}

/** All candidates with their utility. Cooling-down states are excluded. */
export function scoreCandidates(v: DecisionView): Scored<Candidate>[] {
  const { traits: t, stats: s, behavior: b } = v;
  const out: Scored<Candidate>[] = [];
  const add = (c: Candidate, score: number): void => {
    if (!(score > 0) || v.isCoolingDown(c.state)) return;
    out.push({ item: c, score });
  };
  const hour = v.localHour;
  const night = hour >= 23 || hour < 6;
  const crepuscular = (hour >= 17 && hour < 21) || (hour >= 5 && hour < 8);
  const autonomy = clamp01(b.autonomy);
  // 'React to typing' off: typing does not change what the cat does.
  const typing = v.typing && b.reactToTyping;
  const video = v.mediaForeground || v.screen === 'video';
  const screenMul = video ? 0.4 : v.screen === 'busy' ? 0.8 : 1;
  const activeMul = (0.25 + 1.15 * autonomy) * (typing ? 0.3 : 1) * (v.busySwitching ? 0.35 : 1) * (night ? 0.75 : 1) * screenMul;
  const calmMul = 1.3 - 0.6 * autonomy;
  const energyGate = clamp01((s.energy - 0.15) / 0.35);
  const sleepy = sleepiness(v);
  const idleSleep = userIdleForSleep(v);
  const playTime = crepuscular ? 1.15 : 1;
  // Learned from past sessions: a cat petted often asks for affection more; rough handling makes it wary.
  const petted = clamp01(v.prefs.petRatePerHour / 6);
  const rough = clamp01(v.recentRough / 4);

  add(cand('idle'), 0.3 * calmMul * (0.8 + 0.4 * t.laziness));
  add(cand('resting'), (0.12 + 0.22 * t.laziness + 0.3 * (1 - s.energy) + 0.15 * sleepy) * calmMul * (typing ? 1.3 : 1) * (v.screen === 'quiet' ? 1.1 : 1));
  if (!v.disabled.has('grooming')) add(cand('grooming'), (0.14 + 0.12 * (1 - s.annoyance)) * calmMul);

  let nap = Math.pow(sleepy, 1.5) * 1.4;
  if (s.energy > 0.9 && !idleSleep) nap *= 0.3;
  if (idleSleep) nap = 4;
  const spot = v.favoriteSpot;
  if (spot && spot.distBodyLengths > 1.5 && (sleepy > 0.3 || idleSleep)) {
    add(cand('walking', { variant: 'favorite', target: spot.point, then: 'fallingAsleep' }), nap * 1.1);
    nap *= 0.8;
  }
  add(cand('fallingAsleep', { variant: idleSleep ? 'idleSleep' : null }), nap);
  if (idleSleep) return out; // nobody is around: only rest-related options

  if (v.wanderTarget) {
    add(cand('walking', { variant: 'wander', target: v.wanderTarget }), (0.12 + 0.22 * t.curiosity + 0.28 * s.boredom) * energyGate * activeMul);
  }
  if (v.cornerTarget) {
    add(cand('walking', { variant: 'corner', target: v.cornerTarget }), (0.03 + 0.16 * s.boredom) * energyGate * activeMul);
  }
  if (v.foreground) {
    const nearby = typing && v.foreground.distBodyLengths > 6 && rough < 0.5;
    const score = (0.12 + 0.15 * t.affection + (typing ? 0.4 : 0) + (v.busySwitching ? 0.55 : 0) + (video ? 0.25 : 0)) * calmMul;
    add(cand('watchingUser', { variant: nearby ? 'nearby' : null, target: v.foreground.center }), score);
  }
  const c = v.cursor;
  if (c && c.distBodyLengths < 10 && c.speedDip > 20) {
    add(cand('watchingCursor'), (0.12 + 0.5 * b.cursorPlay * t.playfulness) * (c.speedDip > 300 ? 1.3 : 1) * (typing ? 0.5 : 1));
  }
  // Pointer play scales the whole chase score: at 0 % the cat never chases on its own; a bored cat chases more.
  if (c && c.reachable && !typing && !v.disabled.has('chaseCursor') && c.speedDip > 150 && c.distBodyLengths < 12) {
    const cursorPlay = clamp01(b.cursorPlay);
    add(cand('chasingCursor'), cursorPlay * (0.12 + 0.8 * t.playfulness) * (0.4 + v.prefs.cursorPlayAcceptance) * (0.5 + s.boredom) * energyGate * activeMul * playTime);
  }
  if (!typing) {
    const play = (0.08 + 0.55 * t.playfulness * (0.3 + s.boredom)) * energyGate * activeMul * playTime;
    add(cand('playing', { variant: 'pawAt' }), play * 0.5);
    add(cand('playing', { variant: 'rollOver' }), play * 0.35 * (0.5 + s.bond) * (0.8 + 0.5 * petted) * (1 - 0.7 * rough));
    if (!v.disabled.has('zoomies') && s.energy > 0.55) add(cand('playing', { variant: 'zoomies' }), play * 0.18 * (0.5 + t.energyLevel));
  }
  if (!v.disabled.has('seekAttention') && v.userIdleMs < 60_000) {
    const minQuiet = 20 * 60_000 * (1.3 - clamp01(b.attentionSeeking));
    const quiet = clamp01((v.quietMs - minQuiet) / minQuiet);
    const score =
      1.2 * b.attentionSeeking * (0.3 + t.affection) * (0.3 + s.bond) * (0.3 + v.prefs.attentionAcceptance) * quiet * (typing ? 0.15 : 1) * (0.8 + 0.5 * petted) * (1 - 0.6 * rough);
    add(cand('seekingAttention'), score);
  }
  // After rough handling the cat now and then keeps out of the way for a while.
  if (rough > 0) add(cand('hiding'), 0.05 * rough * (1.2 - t.confidence) * (typing ? 0.5 : 1));
  // A rare, mild start at nothing in particular (long cooldown, see surpriseReady).
  if (v.surpriseReady && !typing) add(cand('startled', { variant: 'surprise' }), 0.02 * (0.5 + t.curiosity) * energyGate * activeMul);
  // Trips onto surfaces (window tops, sides, tab strips) get rarer while the user types hard.
  const excursion = (1 - 0.85 * clamp01(v.typingIntensity)) * (typing ? 0.3 : 1);
  // ... and likelier the longer the cat has stayed down with somewhere to go (v1.1.1).
  const urge = excursionBoost(v);
  // Right after a trip (urge reset) another one is less likely: trips up come in a rhythm, not back to back.
  const rhythm = EXCURSION_RHYTHM_MIN + (1 - EXCURSION_RHYTHM_MIN) * (Number.isFinite(v.exploreUrge) ? clamp01(v.exploreUrge) : 0);
  // Jumping up to explore a window top is 'Sit on windows', independent of 'Inspect windows'.
  if (v.perchTarget && !v.disabled.has('perchOnWindows')) {
    const score = (0.04 + 0.32 * t.curiosity * (0.3 + s.boredom)) * energyGate * activeMul * (0.6 + 0.4 * t.confidence) * excursion * rhythm + urge;
    add(cand('inspectingWindow', { variant: 'explore', windowId: v.perchTarget.windowId, target: v.perchTarget.point }), score);
  }
  // On a window top: sit at its edge and look down into the window ('Sit on windows' and 'Inspect windows').
  if (v.edgeLook && !v.disabled.has('perchOnWindows') && !v.disabled.has('inspectWindows')) {
    add(cand('inspectingWindow', { variant: 'edge', windowId: v.edgeLook.windowId, target: v.edgeLook.point }), (0.05 + 0.2 * t.curiosity) * calmMul);
  }
  // Climbing a window side is 'Climb windows' (and needs 'Sit on windows' for the top it leads to).
  if (v.climbTarget && !v.disabled.has('climbWindows') && !v.disabled.has('perchOnWindows')) {
    // About as attractive as jumping up to explore a window top (climbing is the way up a tall one); the
    // climb cooldown (1.5-4 min) keeps it occasional. Up on the top it first walks along it (patrol).
    const up = v.climbTarget.dir === 'up';
    const score = (0.06 + 0.3 * t.curiosity * (0.3 + s.boredom) * (0.5 + t.energyLevel)) * energyGate * activeMul * excursion * (up ? (0.6 + 0.4 * t.confidence) * rhythm : 1) + (up ? urge : 0);
    add(cand('walking', { variant: 'climb', target: v.climbTarget.point, then: up ? 'walking' : null, thenVariant: up ? 'patrol' : null }), score);
  }
  if (v.tabStripTarget && !v.disabled.has('tabStrips')) {
    const onStrip = v.standingOn === 'tabStrip';
    const score = (onStrip ? 0.06 + 0.1 * t.curiosity : (0.02 + 0.1 * t.curiosity * (0.3 + s.boredom)) * rhythm) * energyGate * activeMul * excursion + (onStrip ? 0 : urge);
    add(cand('walking', { variant: 'tabStrip', target: v.tabStripTarget, then: onStrip ? null : 'resting' }), score);
  }
  // Up there a while (v1.1.1): the longer it has been up on the top it explored, the likelier it heads
  // back down; a tired or resting-minded cat (low autonomy, the user typing) stays put longer.
  if (v.downTarget) {
    const up = clamp01((v.elevatedMs - DOWN_PULL_AFTER_MS) / DOWN_PULL_RAMP_MS);
    add(cand('walking', { variant: 'wander', target: v.downTarget }), (0.06 + 0.4 * up) * (1.2 - 0.4 * t.curiosity) * energyGate * activeMul);
  }
  const lookAt = v.foreground?.center ?? v.wanderTarget;
  if (lookAt) add(cand('curious', { target: lookAt, variant: 'look' }), (0.06 + 0.22 * t.curiosity * s.boredom) * activeMul);
  return out;
}

/** Penalises recently repeated choices so the cat varies what it does. */
export function applyRepetitionPenalty(scored: Scored<Candidate>[], recent: readonly BehaviorState[], current: BehaviorState): Scored<Candidate>[] {
  const window = recent.slice(0, 6);
  return scored.map((c) => {
    const n = window.filter((s) => s === c.item.state).length;
    let mul = Math.pow(0.65, n);
    if (c.item.state === current && current !== 'idle') mul *= 0.35;
    return { item: c.item, score: c.score * mul };
  });
}

export const DECISION_TEMPERATURE = 0.12;
export const DECISION_TOP_K = 4;

export function chooseActivity(v: DecisionView, random: Random): Candidate | null {
  const scored = applyRepetitionPenalty(scoreCandidates(v), v.recentStates, v.current);
  return softmaxPick(random, scored, DECISION_TEMPERATURE, DECISION_TOP_K)?.item ?? null;
}
