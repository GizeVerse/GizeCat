// v1.2 event salience (ADR 0003 §1.8): salience = relevance (v1.1) x (1 - habituation) x
// (0.4 + sensitivity) x receptivity of what the cat is doing. Above 0.6 an event interrupts a calm
// activity. A short dedupe keeps one desktop change delivered twice (a window both shown and
// restored, a strip re-announced) from producing two reactions. Pure.
import type { BehaviorState } from '../../shared/cat';
import { ACTIVITY_CLASS } from '../../shared/behaviorProfile';

/** An event this salient interrupts a calm activity. */
export const INTERRUPT_SALIENCE = 0.6;
/** Salience of a window that was restored or un-maximized (a curious look at its new top). */
export const RESTORED_SALIENCE = 0.7;
/** Two deliveries of the same event key within this window count once. */
export const EVENT_DEDUPE_MS = 500;

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** How open the cat is to an event: asleep 0.2, calm 1, active 0.5, on a stay 0.6, reacting or in the air 0. */
export function receptivity(state: BehaviorState, onStay: boolean): number {
  const cls = ACTIVITY_CLASS[state];
  switch (cls) {
    case 'asleep':
      return 0.2;
    case 'reaction':
    case 'physical':
    case 'away':
      return 0;
    case 'interaction':
      return state === 'beingPetted' ? 0.5 : 0;
    case 'active':
      return onStay ? 0.5 * 0.6 : 0.5;
    case 'calm':
      return onStay ? 0.6 : 1;
  }
}

/** Salience of an event of v1.1 relevance `relevance` (habituation already applied, as v1.1 relevance does). */
export function eventSalience(relevance: number, sensitivity: number, receptivityValue: number): number {
  return clamp01(clamp01(relevance) * (0.4 + clamp01(sensitivity)) * clamp01(receptivityValue));
}

/** Remembers recent event keys (bounded) so a duplicate within EVENT_DEDUPE_MS is dropped. */
export class EventDedupe {
  private readonly seen = new Map<string, number>();

  /** True the first time `key` is seen within the window (and records it); false for a duplicate. */
  fresh(key: string, now: number): boolean {
    const at = this.seen.get(key);
    if (at !== undefined && now - at < EVENT_DEDUPE_MS) return false;
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > 64) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}
