// v1.2 reactions to throws and rough handling (ADR 0003 §5): a softmax over nine kinds from the
// throw's severity, recent handling, irritability, personality, bond, the landing room and the
// 'Reactions to rough handling' slider, with per-kind caps applied by water-filling. Wariness and
// the other moods recover within minutes (drives.ts); rough handling is remembered in its own
// bounded list so frequent ordinary events cannot evict it (§5.4). Pure.
import type { LandingImpact } from '../../shared/cat';
import type { ThrowReactionKind } from '../../shared/behaviorProfile';
import { THROW_REACTIONS } from '../../shared/behaviorProfile';
import { subBehaviorAllowed } from '../../shared/behaviorGates';
import type { BehaviorId } from '../../shared/settings';
import type { Random } from './random';

/** A release at least this fast (DIP/s) is a throw (MOVEMENT throw threshold). */
export const THROW_SPEED_DIP = 1100;
/** A rough drag: faster than this (DIP/s) for longer than ROUGH_DRAG_MIN_MS within the last ROUGH_DRAG_WINDOW_MS. */
export const ROUGH_DRAG_SPEED_DIP = 1500;
export const ROUGH_DRAG_MIN_MS = 300;
export const ROUGH_DRAG_WINDOW_MS = 2000;
/** A rough drag released slowly reacts at this share of its severity. */
export const ROUGH_DRAG_SEVERITY = 0.6;
/** Throws and rough drags within this window count as handling frequency (hf). */
export const HANDLING_WINDOW_MS = 10 * 60_000;
/** Startle-like reactions within this window count as recent startles (st). */
export const STARTLE_WINDOW_MS = 5 * 60_000;
/** Rough handling is remembered this long (wall clock). */
export const ROUGH_MEMORY_MS = 60 * 60_000;
export const ROUGH_MEMORY_SIZE = 16;

/** Wariness each reaction leaves behind (w <- max(w, w_k)). */
export const WARINESS_BY_REACTION: Readonly<Record<ThrowReactionKind, number>> = {
  shrug: 0,
  surprise: 0.2,
  startledJump: 0.5,
  grumpy: 0.4,
  defensive: 0.7,
  flight: 0.6,
  playful: 0,
  avoid: 0.8,
  hide: 0.8,
};

/** Highest share any kind may take (water-filled), when at least three kinds are eligible. */
export const REACTION_CAPS: Readonly<Record<ThrowReactionKind, number>> = {
  shrug: 0.5,
  surprise: 0.5,
  startledJump: 0.5,
  grumpy: 0.5,
  defensive: 0.5,
  flight: 0.5,
  playful: 0.5,
  avoid: 0.5,
  hide: 0.25,
};

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

const HARDNESS: Readonly<Record<LandingImpact, number>> = { soft: 0, medium: 0.5, hard: 1 };

/** s = 0.6 clamp((v - 1100) / 1500) + 0.4 hardness. */
export function severityOf(releaseSpeedDip: number, impact: LandingImpact): number {
  const v = Number.isFinite(releaseSpeedDip) ? releaseSpeedDip : 0;
  return clamp01(0.6 * clamp01((v - THROW_SPEED_DIP) / 1500) + 0.4 * (HARDNESS[impact] ?? 0));
}

export interface ReactionContext {
  /** 0..1 severity (severityOf, x0.6 for a rough drag). */
  severity: number;
  /** clamp((throws + rough drags in the last 10 min) / 5). */
  handling: number;
  irritability: number;
  confidence: number;
  bond: number;
  /** clamp(startle-like reactions in the last 5 min / 3). */
  recentStartles: number;
  /** settings.interaction.reactionIntensity (R). */
  intensity: number;
  startleSensitivity: number;
  playfulness: number;
  playNeed: number;
  /** ℓ: landed on an elevated ledge with less than 4 body widths of room. */
  littleRoom: boolean;
  /** The previous reaction (a repeat gets -0.5). */
  previous: ThrowReactionKind | null;
  /** Effective opt-outs (a kind whose acts are all switched off is not eligible). */
  disabled: ReadonlySet<BehaviorId>;
}

/** Logits z_k (ADR 0003 §5.1); null = not eligible. */
export function reactionLogits(c: ReactionContext): Record<ThrowReactionKind, number | null> {
  const s = clamp01(c.severity);
  const hf = clamp01(c.handling);
  const i = clamp01(c.irritability);
  const conf = clamp01(c.confidence);
  const b = clamp01(c.bond);
  const st = clamp01(c.recentStartles);
  const R = clamp01(c.intensity);
  const sig = clamp01(c.startleSensitivity);
  const pl = clamp01(c.playfulness);
  const nP = clamp01(c.playNeed);
  const l = c.littleRoom ? 1 : 0;
  const base: Record<ThrowReactionKind, [z: number, iota: number, room: number]> = {
    shrug: [0.6 + 1.2 * conf - 1.8 * s - 0.8 * i - 0.6 * hf, -1, 0],
    surprise: [0.7 + 0.8 * sig - 0.5 * hf - 0.3 * s, -0.4, 0.5],
    startledJump: [-0.1 + 1.1 * sig + 0.9 * s - 0.7 * conf, 0.5, -1.5],
    grumpy: [-0.4 + 1.6 * i + 0.8 * hf + 0.5 * conf, 0.2, 0.5],
    defensive: [-1.2 + 2.0 * i + 0.8 * hf * s - 0.9 * b, 1, 0],
    flight: [-0.5 + 1.0 * s + 0.7 * (1 - conf) + 0.6 * st, 0.7, -1.5],
    playful: [-0.6 + 1.4 * b * pl + 0.8 * nP - 1.4 * i - 0.9 * s, 0, 0],
    avoid: [-0.7 + 0.9 * hf + 0.6 * i + 0.4 * (1 - b), 0.3, -1.5],
    hide: [-1.3 + 1.1 * (1 - conf) + 0.8 * hf + 0.6 * st - 0.6 * b, 0.6, 0],
  };
  const out = {} as Record<ThrowReactionKind, number | null>;
  for (const k of THROW_REACTIONS) {
    const [z0, iota, room] = base[k];
    if (k === 'defensive' && !subBehaviorAllowed('defensiveHiss', c.disabled)) {
      out[k] = null;
      continue;
    }
    out[k] = z0 + 1.2 * (R - 0.5) * iota + (c.previous === k ? -0.5 : 0) + room * l;
  }
  return out;
}

/** Plain softmax over the eligible logits (ineligible kinds get 0). */
export function softmaxReactions(z: Readonly<Record<ThrowReactionKind, number | null>>): Record<ThrowReactionKind, number> {
  let max = -Infinity;
  for (const k of THROW_REACTIONS) {
    const v = z[k];
    if (v !== null && Number.isFinite(v)) max = Math.max(max, v);
  }
  const out = {} as Record<ThrowReactionKind, number>;
  let total = 0;
  for (const k of THROW_REACTIONS) {
    const v = z[k];
    const e = v !== null && Number.isFinite(v) ? Math.exp(v - max) : 0;
    out[k] = e;
    total += e;
  }
  for (const k of THROW_REACTIONS) out[k] = total > 0 ? out[k] / total : 0;
  return out;
}

/**
 * Water-filling: clamps every kind above its cap to the cap and renormalises the rest, repeating
 * until nothing changes (at most nine passes). Caps apply only with at least three eligible kinds.
 */
export function waterFill(p: Readonly<Record<ThrowReactionKind, number>>, caps: Readonly<Record<ThrowReactionKind, number>> = REACTION_CAPS): { p: Record<ThrowReactionKind, number>; capped: boolean } {
  const out = { ...p } as Record<ThrowReactionKind, number>;
  const eligible = THROW_REACTIONS.filter((k) => out[k] > 0);
  if (eligible.length < 3) return { p: out, capped: false };
  const fixed = new Set<ThrowReactionKind>();
  let capped = false;
  for (let pass = 0; pass < THROW_REACTIONS.length; pass++) {
    const over = eligible.filter((k) => !fixed.has(k) && out[k] > caps[k] + 1e-12);
    if (over.length === 0) break;
    capped = true;
    for (const k of over) {
      out[k] = caps[k];
      fixed.add(k);
    }
    const fixedMass = [...fixed].reduce((a, k) => a + out[k], 0);
    const free = eligible.filter((k) => !fixed.has(k));
    const freeMass = free.reduce((a, k) => a + out[k], 0);
    if (freeMass <= 0) break;
    const scale = Math.max(0, 1 - fixedMass) / freeMass;
    for (const k of free) out[k] *= scale;
  }
  return { p: out, capped };
}

/** The reaction weights: the uncapped softmax, the water-filled draw weights and whether a cap changed them. */
export function throwReactionWeights(c: ReactionContext): { weights: Record<ThrowReactionKind, number>; uncapped: Record<ThrowReactionKind, number>; capped: boolean; eligible: number } {
  const uncapped = softmaxReactions(reactionLogits(c));
  const eligible = THROW_REACTIONS.filter((k) => uncapped[k] > 0).length;
  const { p, capped } = waterFill(uncapped);
  return { weights: p, uncapped, capped, eligible };
}

/** One draw from the weights (one random number). */
export function drawReaction(r: Random, weights: Readonly<Record<ThrowReactionKind, number>>): ThrowReactionKind {
  let total = 0;
  for (const k of THROW_REACTIONS) total += Math.max(0, weights[k]);
  let x = r() * total;
  for (const k of THROW_REACTIONS) {
    x -= Math.max(0, weights[k]);
    if (x < 0) return k;
  }
  return 'surprise';
}

export type RoughKind = 'throw' | 'roughDrag' | 'annoyed';

/**
 * Rough-handling memory (ADR 0003 §5.4): its own bounded list of the last ROUGH_MEMORY_SIZE
 * throws, rough drags and annoyed reactions (wall clock), so stays, hunts, pounces and slips (which
 * are counted, not remembered) and frequent pets can never evict them.
 */
export class RoughMemory {
  private items: Array<{ at: number; kind: RoughKind }> = [];

  add(at: number, kind: RoughKind): void {
    this.items.push({ at: Number.isFinite(at) ? Math.max(0, at) : 0, kind });
    if (this.items.length > ROUGH_MEMORY_SIZE) this.items.splice(0, this.items.length - ROUGH_MEMORY_SIZE);
  }

  /** Entries at or after `since` (wall clock), optionally of some kinds. */
  countSince(since: number, kinds?: readonly RoughKind[]): number {
    let n = 0;
    for (const e of this.items) if (e.at >= since && (!kinds || kinds.includes(e.kind))) n++;
    return n;
  }

  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  /** Seeds the list from persisted memory entries (throw and annoyed), oldest first. */
  seed(entries: ReadonlyArray<{ at: number; kind: string }>): void {
    for (const e of entries) if (e.kind === 'throw' || e.kind === 'annoyed') this.add(e.at, e.kind);
  }
}
