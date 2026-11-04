// v1.2 utility picker (ADR 0003 §1.3-§1.5): every feasible candidate is scored
//   U(c) = B_c · I_c · F_c · C_c · N_c · E_c · R_e(c)
// (base, interest from the drives, feasibility, context, repetition keyed on the variant, energy
// cost, rhythm), candidates below 3 % of the best are dropped and the rest drawn with P ∝ U^(1/τ),
// τ = 0.5. There is no top-k cut. Drive-gated candidates (attention seeking, hunts, naps, hiding,
// the surprise startle, ambushes) have no interest baseline, so a satisfied drive never starts them.
// Pure; switched-off behaviours and sub-acts (behaviorGates.ts) are never generated.
import type { BehaviorState } from '../../shared/cat';
import type { ActivityClass } from '../../shared/behaviorProfile';
import { activityClassOf } from '../../shared/behaviorProfile';
import type { SubBehavior } from '../../shared/behaviorGates';
import { subBehaviorAllowed } from '../../shared/behaviorGates';
import type { Drives } from '../../shared/catState';
import type { Point } from '../../shared/geometry';
import type { BehaviorId } from '../../shared/settings';
import type { Candidate, DecisionView } from './decide';
import { userIdleForSleep } from './decide';
import { zEff } from './drives';
import type { Random, Scored } from './random';
import { pickWeighted } from './random';
import { rhythmWeight } from './rhythm';

/** Softmax temperature over the utilities: half the utility keeps ~25 % of the leader's odds. */
export const PICK_TAU = 0.5;
/** Candidates below this share of the best utility are dropped before the draw. */
export const PICK_FLOOR = 0.03;
/** Picks remembered for the repetition term. */
export const REPEAT_WINDOW = 8;
const REPEAT_STEP = 0.45;
const REPEAT_DECAY = 0.7;
const FAMILY_SIMILARITY = 0.35;
const CURRENT_KEY_MUL = 0.4;
const RECENT_PLACE_MUL = 0.7;
const QUIET_CALM_MUL = 5;
/** The ADR's starting 0.25 measured 12-13 window climbs an hour for P1 once B1 was met (ceiling 12, SIMULATED). */
const TRIP_BASE = 0.2;
const TYPING_TRIP_MUL = 0.6;
/** With 'React to typing' off nothing else damps a trip while the user types (§1.4 reads the raw signal here). */
const TYPING_TRIP_RAW_MUL = 0.2;
const TYPING_TRIP_RECENT_MS = 30_000;
const TYPING_TRIP_RECENT_MUL = 0.35;
const PATROL_MIN_RHYTHM = 0.8;

/** Variants that should not repeat back to back share a family (ADR 0003 §1.5). */
export type Family = 'observe' | 'rest' | 'groom' | 'explore' | 'tripUp' | 'hunt' | 'play' | 'social' | 'wary' | 'leave' | 'other';

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** Repetition key `state:variant` (trips add `:surfaceKind`). */
export function candidateKey(c: Pick<Candidate, 'state' | 'variant'> & { surfaceKind?: string | null }): string {
  const base = `${c.state}:${c.variant ?? ''}`;
  return c.surfaceKind ? `${base}:${c.surfaceKind}` : base;
}

export function familyOf(state: BehaviorState, variant: string | null): Family {
  switch (state) {
    case 'idle':
      return variant === 'stretch' ? 'groom' : 'observe';
    case 'watchingUser':
    case 'watchingCursor':
    case 'curious':
      return 'observe';
    case 'inspectingWindow':
      return variant === 'explore' ? 'tripUp' : 'observe';
    case 'resting':
    case 'fallingAsleep':
    case 'sleeping':
      return 'rest';
    case 'grooming':
      return 'groom';
    case 'walking':
    case 'running':
      switch (variant) {
        case 'climb':
        case 'tabStrip':
        case 'screenEdge':
          return 'tripUp';
        case 'favorite':
          return 'rest';
        case 'leave':
          return 'leave';
        case 'wander':
        case 'corner':
        case 'patrol':
          return 'explore';
        default:
          return 'other';
      }
    case 'chasingCursor':
      return 'hunt';
    case 'playing':
      return 'play';
    case 'seekingAttention':
      return 'social';
    case 'hiding':
    case 'startled':
      return 'wary';
    default:
      return 'other';
  }
}

function familyOfKey(key: string): Family {
  const [state, variant] = key.split(':');
  return familyOf(state as BehaviorState, variant ? variant : null);
}

/**
 * N_c = Π_j (1 - 0.45 sim(c, r_j) 0.7^j) over the last REPEAT_WINDOW picks (j = 0 most recent);
 * sim = 1 for the same key, 0.35 for the same family. Repeating the activity being left x0.4 (not
 * idle or observing).
 */
export function repetitionFactor(key: string, recent: readonly string[], currentKey: string | null): number {
  const fam = familyOfKey(key);
  let n = 1;
  const k = Math.min(recent.length, REPEAT_WINDOW);
  for (let j = 0; j < k; j++) {
    const r = recent[j] as string;
    const sim = r === key ? 1 : familyOfKey(r) === fam ? FAMILY_SIMILARITY : 0;
    if (sim > 0) n *= 1 - REPEAT_STEP * sim * Math.pow(REPEAT_DECAY, j);
  }
  if (currentKey !== null && key === currentKey && fam !== 'observe' && !key.startsWith('idle:')) n *= CURRENT_KEY_MUL;
  return n;
}

/** Energy cost κ by kind: 0 calm, 0.2 a walk, 0.5 a climb or trip, 0.7 a sprint, zoomies or a hunt. */
function energyKappa(c: Candidate, family: Family, cls: ActivityClass): number {
  if (cls !== 'active') return 0;
  if (family === 'hunt' || c.variant === 'zoomies') return 0.7;
  if (family === 'tripUp' || c.variant === 'tailChase') return 0.5;
  return 0.2;
}

/** The v1.2 defaults when a view has no drives (scoring tests, older harnesses). */
function drivesOf(v: DecisionView): Drives {
  if (v.drives) return v.drives;
  const b = clamp01(v.stats.boredom);
  return { socialNeed: 0.3, playNeed: b, exploreNeed: b, sleepiness: 0.2, mischief: 0.3, huntDrive: 0, irritability: 0, frustration: 0, wariness: 0 };
}

const distBl = (a: Point, b: Point, bw: number): number => Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1e-6, bw);

/** The v1.2 sub-acts (behaviorGates.ts) an activity `state:variant` is made of. */
export function subActsOf(state: BehaviorState, variant: string | null): SubBehavior[] {
  switch (`${state}:${variant ?? ''}`) {
    case 'inspectingWindow:explore':
    case 'walking:climb':
      return ['tripUp'];
    case 'inspectingWindow:edge':
      return ['edgeSit'];
    case 'chasingCursor:hunt':
      return ['huntStalk'];
    case 'resting:ambush':
      return ['ambush'];
    case 'playing:zoomies':
      return ['zoomies'];
    case 'playing:tailChase':
      return ['tailChase'];
    case 'idle:watchTab':
      return ['watchTab'];
    case 'curious:restored':
      return ['inspectWindow'];
    case 'annoyed:defensive':
      return ['defensiveHiss'];
    case 'walking:taskbar':
      return ['taskbarTarget'];
    case 'walking:screenEdge':
      return ['screenEdgeClimb'];
    case 'grooming:':
    case 'grooming:displacement':
      return ['groom'];
    default:
      return [];
  }
}

/**
 * May the activity `state:variant` run with this opt-out set? The v2 switches as in v1.1.1 (a
 * trip up onto a window top is 'Sit on windows', looking at windows 'Inspect windows', ...) plus
 * every v1.2 sub-act gate, so no v2 switch is re-enabled under a new name (ADR 0003 §9.4).
 */
export function variantAllowed(state: BehaviorState, variant: string | null, d: ReadonlySet<BehaviorId>): boolean {
  for (const act of subActsOf(state, variant)) if (!subBehaviorAllowed(act, d)) return false;
  switch (state) {
    case 'chasingCursor':
      return !d.has('chaseCursor');
    case 'seekingAttention':
      return !d.has('seekAttention');
    case 'grooming':
      return !d.has('grooming');
    case 'playing':
      return variant !== 'zoomies' || !d.has('zoomies');
    case 'inspectingWindow':
      if (variant === 'explore') return !d.has('perchOnWindows');
      if (variant === 'edge') return !d.has('perchOnWindows') && !d.has('inspectWindows');
      return !d.has('inspectWindows');
    case 'walking':
      if (variant === 'climb') return !d.has('climbWindows') && !d.has('perchOnWindows');
      if (variant === 'tabStrip') return !d.has('tabStrips');
      if (variant === 'taskbar') return !d.has('taskbarPlay');
      return true;
    default:
      return true;
  }
}

/** Is candidate `c` generated at all with the view's opt-outs? */
export function candidateAllowed(c: Candidate, v: Pick<DecisionView, 'disabled'>): boolean {
  return variantAllowed(c.state, c.variant, v.disabled);
}

/** The exploration urge's bonus for a trip up: u³ · 0.8 · (0.35 + 0.65 X) · nE^0.5 (ADR 0003 §1.2). */
export function urgeBonus(urge: number, exploration: number, exploreNeed: number): number {
  const u = clamp01(urge);
  return u * u * u * 0.8 * (0.35 + 0.65 * clamp01(exploration)) * Math.sqrt(clamp01(exploreNeed));
}

/** A frightened or annoyed cat feels no urge to go up: fear 0.2-0.5 and annoyance 0.3-0.7 take the bonus to nothing (v1.1.1). */
export function urgeCalm(fear: number, annoyance: number): number {
  return (1 - clamp01((fear - 0.2) / 0.3)) * (1 - clamp01((annoyance - 0.3) / 0.4));
}

function cand(state: BehaviorState, extra: Partial<Candidate> = {}): Candidate {
  return { state, variant: null, target: null, windowId: null, then: null, thenVariant: null, ...extra };
}

/** All feasible candidates with their utility (cooling-down states and switched-off acts excluded). */
export function scoreAll(v: DecisionView): Scored<Candidate>[] {
  const t = v.traits;
  const s = v.stats;
  const b = v.behavior;
  const d = drivesOf(v);
  const out: Scored<Candidate>[] = [];
  const energy = clamp01(s.energy);
  const zE = Number.isFinite(v.zEff) ? clamp01(v.zEff as number) : zEff(d.sleepiness, energy);
  const X = clamp01(b.exploration);
  const W = clamp01(b.workDisruption);
  const m = clamp01(d.mischief);
  const h = clamp01(d.huntDrive);
  const nS = clamp01(d.socialNeed);
  const nP = clamp01(d.playNeed);
  const nE = clamp01(d.exploreNeed);
  const typingRaw = v.typingRaw ?? v.typing;
  // The typing reactions (calming down, watching the user) follow 'React to typing'; the gates do not.
  const typingReact = v.typing && b.reactToTyping;
  const video = v.mediaForeground || v.screen === 'video';
  const night = v.localHour >= 23 || v.localHour < 6;
  const episode = v.episode ?? 'none';
  const onStay = !!v.stay;
  const cat = v.cat ?? null;
  const cursor = v.cursor?.point ?? null;
  const recent = v.recentKeys ?? [];
  const currentKey = v.currentKey ?? null;
  const rough = clamp01(v.recentRough / 4);

  const add = (c: Candidate, base: number, interest: number): void => {
    if (!(interest > 0) || !(base > 0) || v.isCoolingDown(c.state) || !candidateAllowed(c, v)) return;
    const cls = activityClassOf(c.state, c.variant);
    const family = familyOf(c.state, c.variant);
    // F: feasibility (unreachable targets are never generated; distance in body widths).
    let F = 1;
    if (c.target && cat) {
      const d0 = 10 * (0.6 + energy);
      const dist = distBl(c.target, cat, cat.bw);
      F = 1 / (1 + (dist / d0) * (dist / d0));
    }
    // C: context.
    let C = 1;
    if (cls === 'active') {
      if (typingReact) C *= 0.35;
      // The ADR's 0.4 measured 6-8 % moving under fast switching with B1's rhythm (the cat is meant to stop and watch).
      if (v.busySwitching) C *= 0.25;
      if (video) C *= 0.4;
      if (night) C *= 0.75;
    }
    if (family === 'observe' && typingReact) C *= 1.2;
    // Typing: trips up are rarer on top of that (B6: 0.2-0.6 x the rate of a user who is not typing).
    if (family === 'tripUp' && typingRaw) C *= typingReact ? TYPING_TRIP_MUL : TYPING_TRIP_RAW_MUL;
    // ... and for a while after: a pause between sentences is no invitation to climb the window being written in.
    else if (family === 'tripUp' && (v.sinceTypingMs ?? Infinity) < TYPING_TRIP_RECENT_MS) C *= TYPING_TRIP_RECENT_MUL;
    if (typingRaw && (family === 'hunt' || family === 'play' || c.variant === 'ambush')) C = 0;
    if (c.target && cursor && cat && (cls === 'active' || family === 'hunt') && distBl(c.target, cursor, cat.bw) < 3) C *= 0.2 + 0.8 * W;
    if (v.avoidCursor && c.target && cursor && cat && cls === 'active' && family !== 'leave' && distBl(c.target, cursor, cat.bw) < 4) C = 0;
    // Place novelty for trips (and the mischief bonus for the foreground window's top).
    let P = 1;
    if (family === 'tripUp' && c.place && v.placeSeen) {
      const seen = v.placeSeen(c.place);
      P = seen === 'recent' ? RECENT_PLACE_MUL : seen === 'never' ? 1 + 0.3 * clamp01(t.curiosity) : 1;
    }
    if (family === 'tripUp' && m > 0.15 && c.windowId !== null && c.windowId === v.foregroundId) P += 0.4 * m * (0.5 + W);
    // The stay a cover or a vanished window cut short (ADR 0003 §2.4).
    if (family === 'tripUp' && c.place && c.place === v.resumePlace) P *= 2;
    const N = repetitionFactor(candidateKey(c), recent, currentKey);
    const E = Math.exp(-2 * energyKappa(c, family, cls) * (1 - energy));
    let R = rhythmWeight(episode, cls, m, onStay);
    // Typing, video or fast switching: calm picks keep their chance even in an active episode (§1.4 C_c).
    if (episode === 'active' && cls !== 'active' && (typingReact || video || v.busySwitching)) R *= QUIET_CALM_MUL;
    // The walk along a top or strip is what keeps a long stay alive, whatever the episode (at most once per 45 s anyway).
    if (c.variant === 'patrol' && onStay && !typingRaw) R = Math.max(R, PATROL_MIN_RHYTHM);
    const u = base * interest * F * C * N * E * R * P;
    if (Number.isFinite(u) && u > 0) out.push({ item: c, score: u });
  };

  // ---- rest and sleep (also with nobody around) ----
  const idleSleep = userIdleForSleep(v);
  let nap = idleSleep ? 4 : 2 * Math.pow(Math.max(0, zE - 0.25), 1.5);
  if (onStay && !idleSleep && zE <= 0.5) nap = 0;
  if (!idleSleep && v.isCoolingDown('fallingAsleep')) nap = 0;
  const spot = v.favoriteSpot;
  if (!onStay && spot && spot.distBodyLengths > 1.5 && (zE > 0.3 || idleSleep) && nap > 0) {
    add(cand('walking', { variant: 'favorite', target: spot.point, then: 'fallingAsleep' }), 0.6, nap * 1.1);
    nap *= 0.8;
  }
  add(cand('fallingAsleep', { variant: idleSleep ? 'idleSleep' : null }), 0.6, nap);
  add(cand('resting'), 0.3, onStay ? 0.3 + 0.4 * (1 - energy) : 0.2 + 0.4 * (1 - energy) + 0.3 * zE);
  add(cand('grooming'), onStay ? 0.2 : 0.25, onStay ? 0.3 : 0.2 + 0.3 * (clamp01(s.annoyance) + clamp01(d.frustration)));
  if (!onStay) add(cand('idle'), 0.3, 0.2 + 0.3 * clamp01(t.laziness));
  if (idleSleep) return out; // nobody is around: only rest options

  // ---- the cursor ----
  if (v.cursorBand) add(cand('watchingCursor', { variant: v.cursorBand === 'chatter' ? 'chatter' : null }), 0.25, 0.2 + 0.7 * h);
  if (v.huntReady && !typingRaw && v.cursor) add(cand('chasingCursor', { variant: 'hunt' }), 0.6, h * h);

  // ---- on a stay: the on-surface plan only (ADR 0003 §2.2); leaving is not a candidate ----
  const st = v.stay;
  if (st) {
    if (st.patrolReady && st.walkRangeBl >= 2 && st.patrolTarget) add(cand('walking', { variant: 'patrol', target: st.patrolTarget }), 0.2, 0.3 + 0.4 * nE);
    if (v.edgeLook) add(cand('inspectingWindow', { variant: 'edge', windowId: v.edgeLook.windowId, target: v.edgeLook.point }), 0.25, 0.3 + 0.4 * clamp01(t.curiosity));
    if (st.kind === 'tabStrip' && st.watchTab) add(cand('idle', { variant: 'watchTab', target: st.watchTab }), 0.25, 0.4);
    return out;
  }

  // ---- calm ----
  if (v.foreground) {
    const nearby = typingReact && v.foreground.distBodyLengths > 6 && rough < 0.5;
    add(cand('watchingUser', { variant: nearby ? 'nearby' : null, target: v.foreground.center }), 0.25, 0.2 + 0.4 * nS + 0.3 * clamp01(t.affection));
  }
  const lookAt = v.foreground?.center ?? v.wanderTarget;
  if (lookAt) add(cand('curious', { target: lookAt, variant: 'look' }), 0.12, 0.2 + 0.5 * nE);
  if (m > 0.15 && !typingRaw && v.ambushSpot) add(cand('resting', { variant: 'ambush', target: v.ambushSpot }), 0.1, 0.8 * m + 0.4 * h);
  add(cand('idle', { variant: 'stretch' }), 0.08, 0.2 + ((v.restedMs ?? 0) >= 60_000 ? 0.5 : 0));

  // ---- exploring ----
  if (v.wanderTarget) add(cand('walking', { variant: 'wander', target: v.wanderTarget }), 0.3, 0.2 + 0.6 * nE + 0.1 * m);
  if (v.cornerTarget) add(cand('walking', { variant: 'corner', target: v.cornerTarget }), 0.12, 0.2 + 0.7 * nE);
  const urge = urgeBonus(v.exploreUrge, X, nE) * urgeCalm(s.fear, s.annoyance);
  const trip = (stripBonus: boolean): number => 0.2 + 0.5 * nE + (stripBonus ? 0.2 * m : 0) + urge;
  if (v.perchTarget) {
    const p = v.perchTarget;
    add(cand('inspectingWindow', { variant: 'explore', windowId: p.windowId, target: p.point, surfaceKind: 'windowTop', place: `w:${p.windowId}` }), TRIP_BASE, trip(false));
  }
  if (v.climbTarget && v.climbTarget.dir === 'up') {
    const owner = v.climbTarget.ownerId;
    add(cand('walking', { variant: 'climb', target: v.climbTarget.point, then: 'walking', thenVariant: 'patrol', surfaceKind: 'windowTop', place: owner ? `w:${owner}` : `c:${Math.round(v.climbTarget.point.x)}` }), TRIP_BASE, trip(false));
  }
  if (v.tabStripTarget && v.standingOn !== 'tabStrip') {
    add(cand('walking', { variant: 'tabStrip', target: v.tabStripTarget, then: 'resting', surfaceKind: 'tabStrip', place: v.tabStripOwner ? `w:${v.tabStripOwner}` : `s:${Math.round(v.tabStripTarget.y)}` }), TRIP_BASE, trip(true));
  }
  if (v.edgeTarget) {
    // ADR 0003 §1.4: x2 when no other elevated target exists.
    const alone = !v.perchTarget && !(v.climbTarget && v.climbTarget.dir === 'up') && !v.tabStripTarget;
    add(cand('walking', { variant: 'screenEdge', target: v.edgeTarget.point, surfaceKind: 'screenEdge', place: `e:${v.edgeTarget.side}` }), 0.15, (0.2 + 0.6 * nE) * (alone ? 2 : 1));
  }

  // ---- play ----
  if (!typingRaw) {
    add(cand('playing', { variant: 'pawAt' }), 0.2, 0.2 + 0.7 * nP);
    add(cand('playing', { variant: 'rollOver' }), 0.12, 0.2 + 0.5 * nP + 0.3 * clamp01(s.bond));
  }
  if (energy > 0.55) add(cand('playing', { variant: 'zoomies' }), 0.08, 0.2 + nP * energy);
  add(cand('playing', { variant: 'tailChase' }), 0.05, 0.2 + 0.6 * nP + 0.3 * m);

  // ---- social and wary (drive-gated: no baseline) ----
  if (v.userIdleMs < 60_000 && b.attentionSeeking > 0) add(cand('seekingAttention'), 0.35, nS * nS);
  if (rough > 0) add(cand('hiding'), 0.05, clamp01(d.wariness) + 0.5 * rough);
  if (v.surpriseReady && v.recentStimulus && !typingRaw) add(cand('startled', { variant: 'surprise' }), 0.02, 0.5 + clamp01(t.curiosity));
  return out;
}

/** Drops candidates below PICK_FLOOR of the best, then draws with P ∝ U^(1/τ) (one random draw). */
export function pickWithVariety<T>(r: Random, scored: readonly Scored<T>[], tau = PICK_TAU): Scored<T> | undefined {
  const ok = scored.filter((c) => Number.isFinite(c.score) && c.score > 0);
  if (ok.length === 0) return undefined;
  let best = 0;
  for (const c of ok) if (c.score > best) best = c.score;
  const kept = ok.filter((c) => c.score >= PICK_FLOOR * best);
  const k = 1 / Math.max(1e-3, tau);
  return pickWeighted(r, kept, (c) => Math.pow(c.score / best, k));
}

/** Probability of each kept candidate under pickWithVariety (tests and the profile harness). */
export function pickProbabilities<T>(scored: readonly Scored<T>[], tau = PICK_TAU): Array<{ item: T; p: number }> {
  const ok = scored.filter((c) => Number.isFinite(c.score) && c.score > 0);
  if (ok.length === 0) return [];
  let best = 0;
  for (const c of ok) if (c.score > best) best = c.score;
  const kept = ok.filter((c) => c.score >= PICK_FLOOR * best);
  const k = 1 / Math.max(1e-3, tau);
  const w = kept.map((c) => Math.pow(c.score / best, k));
  const total = w.reduce((a, x) => a + x, 0);
  return kept.map((c, i) => ({ item: c.item, p: (w[i] as number) / total }));
}
