// Emote bubbles with bounded frequency: at most one visible at a time, a global
// minimum gap between bubbles, and a per-kind minimum gap.
import type { Emote } from '../../shared/cat';

export const EMOTE_DURATION_MS = 2200;
export const EMOTE_MIN_GAP_MS = 3500;

const PER_KIND_GAP_MS: Readonly<Record<Emote, number>> = {
  heart: 2500,
  zzz: 14000,
  exclaim: 4000,
  question: 8000,
  anger: 4000,
  note: 6000,
  sparkle: 6000,
};

export class EmoteController {
  private current: Emote | null = null;
  private startedAt = 0;
  private lastShownAt = -Infinity;
  private readonly lastByKind = new Map<Emote, number>();
  enabled = true;

  /** Shows `kind` unless rate limits forbid it. `urgent` skips the global gap (not the per-kind gap). */
  show(kind: Emote, now: number, urgent = false): boolean {
    if (!this.enabled) return false;
    if (!urgent && now - this.lastShownAt < EMOTE_MIN_GAP_MS) return false;
    if (now - (this.lastByKind.get(kind) ?? -Infinity) < PER_KIND_GAP_MS[kind]) return false;
    this.current = kind;
    this.startedAt = now;
    this.lastShownAt = now;
    this.lastByKind.set(kind, now);
    return true;
  }

  update(now: number): void {
    if (!this.enabled || (this.current && now - this.startedAt >= EMOTE_DURATION_MS)) this.current = null;
  }

  get emote(): Emote | null {
    return this.current;
  }

  get emoteStartedAt(): number {
    return this.startedAt;
  }
}
