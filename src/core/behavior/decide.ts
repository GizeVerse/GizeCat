// Autonomous choice of the next activity: utility scoring over candidates using
// traits, needs, settings and context, a repetition penalty and a gentle daily
// rhythm, then a softmax pick among the best few.
import type { BehaviorState } from '../../shared/cat';
import type { Preferences, Stats, Traits } from '../../shared/catState';
import type { Point } from '../../shared/geometry';
import type { Settings, ToggleableBehavior } from '../../shared/settings';
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
  | 'screen';

export interface Candidate {
  state: BehaviorState;
  variant: Variant | null;
  target: Point | null;
  windowId: string | null;
  then: BehaviorState | null;
}

export interface DecisionView {
  traits: Traits;
  stats: Stats;
  prefs: Preferences;
  behavior: Settings['behavior'];
  disabled: ReadonlySet<ToggleableBehavior>;
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
  /** The far end of the floor the cat stands on, when it is a walk away. */
  cornerTarget: Point | null;
  /** The long cooldown of an occasional surprise startle has elapsed. */
  surpriseReady: boolean;
  /** Most recent first, the activities chosen lately. */
  recentStates: readonly BehaviorState[];
  /** The state being left. */
  current: BehaviorState;
  isCoolingDown: (s: BehaviorState) => boolean;
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
  return { state, variant: null, target: null, windowId: null, then: null, ...extra };
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
  // Jumping up to explore a window top is 'Sit on windows', independent of 'Inspect windows'.
  if (v.perchTarget && !v.disabled.has('perchOnWindows')) {
    const score = (0.04 + 0.32 * t.curiosity * (0.3 + s.boredom)) * energyGate * activeMul * (0.6 + 0.4 * t.confidence);
    add(cand('inspectingWindow', { variant: 'explore', windowId: v.perchTarget.windowId, target: v.perchTarget.point }), score);
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
