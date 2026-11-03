// v1.2 stay model (ADR 0003 §2): one stay intent drawn on arrival at a window top or tab strip,
// an on-surface plan while up there (utility.ts, the stay pool), and one leave intent when the
// planned time is up, scored over the Mover's leave options. Pure.
import type { LeaveKind } from '../../shared/behaviorProfile';
import { subBehaviorAllowed } from '../../shared/behaviorGates';
import type { BehaviorId } from '../../shared/settings';
import type { LeaveOption } from '../movement';
import { HARD_DROP_DIP } from '../movement';
import type { Random, Scored } from './random';
import { range } from './random';
import { logNormalDraw } from './rhythm';
import { pickWithVariety } from './utility';

/** No stay lasts longer than this, naps up there included (then the leave intent). */
export const STAY_HARD_CAP_MS = 30 * 60_000;
/** The long branch is capped here. */
export const STAY_LONG_CAP_MS = 25 * 60_000;
/** While the cat is being petted the leave is deferred this long (drawn). */
export const LEAVE_DEFER_PETTED_MS: readonly [number, number] = [10_000, 20_000];
/** Backoff after a failed leave: 2 -> 4 -> 8 s. */
export const LEAVE_BACKOFF_MS: readonly number[] = [2000, 4000, 8000];
/** After this many failures within LEAVE_FAILURE_WINDOW_MS the cat takes the emergency option. */
export const LEAVE_FAILURES_FOR_EMERGENCY = 3;
export const LEAVE_FAILURE_WINDOW_MS = 30_000;
/** A stay this far past its plan is overdue (logged, rate-limited). */
export const STAY_OVERDUE_MS = 2 * 60_000;
/** A patrol along the surface at most this often. */
export const PATROL_MIN_GAP_MS = 45_000;
/** The resume token (ADR 0003 §2.4): the surface must come back within this long, the new stay lasts at least this. */
export const STAY_RESUME_WINDOW_MS = 3 * 60_000;
export const STAY_RESUME_MIN_MS = 60_000;
/** A social need above this, this far into the stay, ends it early (end reason 'stimulus'). */
export const STAY_LONELY_NEED = 0.9;
export const STAY_LONELY_MIN_MS = 60_000;
/** Leave kinds remembered for N_leave. */
export const LEAVE_HISTORY = 4;

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

export interface StayContext {
  /** settings.behavior.stayLength (S). */
  stayLength: number;
  laziness: number;
  curiosity: number;
  zEff: number;
  /** On a tab strip (x1.1). */
  strip: boolean;
  /** The user is typing (x1.3). */
  typing: boolean;
}

export type StayBranch = 'short' | 'typical' | 'long';

/** Median of the typical branch, ms: 150 s (0.55 + 0.9 S)(0.8 + 0.4 laziness)(1.15 - 0.3 curiosity)(zEff > 0.5 ? 1.4 : 1)(strip ? 1.1 : 1). */
export function typicalStayMedianMs(c: StayContext): number {
  const S = clamp01(c.stayLength);
  return 150_000 * (0.55 + 0.9 * S) * (0.8 + 0.4 * clamp01(c.laziness)) * (1.15 - 0.3 * clamp01(c.curiosity)) * (clamp01(c.zEff) > 0.5 ? 1.4 : 1) * (c.strip ? 1.1 : 1);
}

/** Branch odds: short p_s = 0.10 (1.5 - S), long p_l = 0.08 + 0.12 S (0.5 + laziness). */
export function stayBranchOdds(c: Pick<StayContext, 'stayLength' | 'laziness'>): { short: number; long: number } {
  const S = clamp01(c.stayLength);
  return { short: 0.1 * (1.5 - S), long: 0.08 + 0.12 * S * (0.5 + clamp01(c.laziness)) };
}

/** The stay intent, drawn once on arrival (Activity is not in it: T3). */
export function drawStayIntent(r: Random, c: StayContext): { plannedMs: number; branch: StayBranch } {
  const odds = stayBranchOdds(c);
  const u = r();
  let branch: StayBranch;
  let ms: number;
  if (u < odds.short) {
    branch = 'short';
    ms = range(r, 20_000, 60_000);
  } else if (u < odds.short + odds.long) {
    branch = 'long';
    ms = Math.min(STAY_LONG_CAP_MS, logNormalDraw(r, 7 * 60_000, 0.35));
  } else {
    branch = 'typical';
    ms = logNormalDraw(r, typicalStayMedianMs(c), 0.55);
  }
  if (c.typing) ms *= 1.3;
  if (!Number.isFinite(ms) || ms <= 0) ms = 60_000;
  return { plannedMs: Math.min(STAY_HARD_CAP_MS, ms), branch };
}

/**
 * Jump-down limits of ADR 0003 §6.3, DIP below the feet: H_safe = min((240 + 520 Ht)(0.7 + 0.6
 * confidence)(0.6 + 0.4 energy), 0.95 h_hard (0.8 + 0.4 Ht)), H_max = min(1.35 H_safe, 900).
 */
export function jumpDownLimitsFor(heights: number, confidence: number, energy: number): { safeDip: number; maxDip: number } {
  const Ht = clamp01(heights);
  const safe = Math.min((240 + 520 * Ht) * (0.7 + 0.6 * clamp01(confidence)) * (0.6 + 0.4 * clamp01(energy)), 0.95 * HARD_DROP_DIP * (0.8 + 0.4 * Ht));
  return { safeDip: safe, maxDip: Math.min(1.35 * safe, 900) };
}

export interface LeaveContext {
  /** settings.behavior.heights (Ht). */
  heights: number;
  confidence: number;
  laziness: number;
  exploreNeed: number;
  typing: boolean;
  disabled: ReadonlySet<BehaviorId>;
}

/** ρ = 0.15 + 0.6 confidence (0.4 + Ht): how much risk the cat accepts. */
export function riskTolerance(confidence: number, heights: number): number {
  return 0.15 + 0.6 * clamp01(confidence) * (0.4 + clamp01(heights));
}

/** w_kind of ADR 0003 §2.3. */
export function leaveKindWeight(o: Pick<LeaveOption, 'kind' | 'impact'>, c: Pick<LeaveContext, 'heights' | 'confidence' | 'laziness' | 'exploreNeed' | 'typing'>): number {
  const Ht = clamp01(c.heights);
  const typing = c.typing ? 1.5 : 1;
  switch (o.kind) {
    case 'jumpDown': {
      const imp = o.impact === 'hard' ? 0.3 * Ht : o.impact === 'medium' ? 0.7 : 1;
      return (0.6 + 0.8 * Ht) * (0.5 + clamp01(c.confidence)) * imp;
    }
    case 'climbDown':
      return 0.8 * (1.2 - Ht) * (0.5 + clamp01(c.laziness)) * typing;
    case 'climbLeap':
      return 0.9;
    case 'hop':
      return 1.0 * (0.5 + clamp01(c.exploreNeed));
    case 'walkOff':
      return 0.6 * typing;
  }
}

/** The sub-acts a leave option needs (a taskbar landing needs 'taskbarTarget'; never for the emergency option). */
export function leaveAllowed(o: Pick<LeaveOption, 'kind' | 'toKind' | 'emergency'>, disabled: ReadonlySet<BehaviorId>): boolean {
  if (o.emergency) return true;
  if (o.toKind === 'taskbar' && !subBehaviorAllowed('taskbarTarget', disabled)) return false;
  if (o.kind === 'hop' && !subBehaviorAllowed('surfaceHop', disabled)) return false;
  if (o.kind === 'climbLeap' && !subBehaviorAllowed('windowWallJump', disabled)) return false;
  if (o.kind === 'climbDown' && disabled.has('climbWindows')) return false;
  return true;
}

/** U(o) = w_kind · exp(-risk/ρ) · N_leave(kind) / (1 + effort/20); N_leave = 0.55 per same kind in the last four leaves. */
export function scoreLeaveOptions(opts: readonly LeaveOption[], c: LeaveContext, recent: readonly LeaveKind[]): Scored<LeaveOption>[] {
  const rho = riskTolerance(c.confidence, c.heights);
  const last = recent.slice(-LEAVE_HISTORY);
  const out: Scored<LeaveOption>[] = [];
  for (const o of opts) {
    if (o.emergency || !leaveAllowed(o, c.disabled)) continue;
    const n = Math.pow(0.55, last.filter((k) => k === o.kind).length);
    const effort = Number.isFinite(o.effort) ? Math.max(0, o.effort) : 0;
    const risk = Number.isFinite(o.risk) ? clamp01(o.risk) : 1;
    const u = (leaveKindWeight(o, c) * Math.exp(-risk / rho) * n) / (1 + effort / 20);
    if (Number.isFinite(u) && u > 0) out.push({ item: o, score: u });
  }
  return out;
}

/**
 * The single leave decision: a τ = 0.5 softmax over the scored options; with none left (or
 * `emergencyOnly`), the emergency option if the Mover offers one; else null (retry later).
 */
export function chooseLeave(r: Random, opts: readonly LeaveOption[], c: LeaveContext, recent: readonly LeaveKind[], emergencyOnly = false): LeaveOption | null {
  if (!emergencyOnly) {
    const pick = pickWithVariety(r, scoreLeaveOptions(opts, c, recent));
    if (pick) return pick.item;
  }
  return opts.find((o) => o.emergency) ?? null;
}

/** Backoff before the next leave attempt after `failures` failures (2, 4, 8 s). */
export function leaveBackoffMs(failures: number): number {
  const i = Math.max(0, Math.min(LEAVE_BACKOFF_MS.length - 1, failures - 1));
  return LEAVE_BACKOFF_MS[i] as number;
}
