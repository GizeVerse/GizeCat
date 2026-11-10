// When a world event comes and which one: the delay draw, the eligibility rules and the weighted pool
// selection. Pure functions over plain data (the engine owns the countdown state), so each rule can be
// tested alone. All randomness arrives as an injected source.
import { CAT_BASE_WIDTH_DIP } from '../../shared/cat';
import {
  EVENT_DELAY_FLOOR_MS,
  EVENT_DELAY_MAX_MS,
  EVENT_DELAY_MIN_MS,
  EVENT_PACE_RANGE,
  RARE_EVENT_PROBABILITY,
  type AnyEventId,
  type EventHistoryEntry,
} from '../../shared/companion';
import type { Rect } from '../../shared/geometry';
import { EVENT_CATALOG, NORMAL_POOL, RARE_POOL, type EventDef } from './catalog';

/** One tick never advances the countdown by more than this: a suspend or a clock jump cannot cause a burst or an instant event. */
export const MAX_COUNTDOWN_STEP_MS = 5000;
/** A due event that needs an awake cat waits this much longer (random in the range) when the cat is asleep. */
export const GRACE_MIN_MS = 20_000;
export const GRACE_MAX_MS = 90_000;
/** Normal events: the previous three are excluded; rare ones: the previous six. */
export const NORMAL_REPEAT_EXCLUDE = 3;
export const RARE_REPEAT_EXCLUDE = 6;
/** An event seen this long ago (wall time) has recovered its full weight; a fresh one keeps this fraction of it. */
export const RECENCY_FULL_MS = 3 * 3_600_000;
export const RECENCY_MIN_FACTOR = 0.25;

const finite = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

export function clampPace(pace: number): number {
  return Math.min(EVENT_PACE_RANGE.max, Math.max(EVENT_PACE_RANGE.min, finite(pace, EVENT_PACE_RANGE.default)));
}

/** The raw delay at pace 1, uniform in [5, 30] minutes. */
export function drawRawDelayMs(random: () => number): number {
  return EVENT_DELAY_MIN_MS + (EVENT_DELAY_MAX_MS - EVENT_DELAY_MIN_MS) * random();
}

/** The delay actually waited: the raw draw divided by the pace, never below the floor. */
export function effectiveDelayMs(rawMs: number, pace: number): number {
  return Math.max(EVENT_DELAY_FLOOR_MS, rawMs / clampPace(pace));
}

export function drawGraceMs(random: () => number): number {
  return GRACE_MIN_MS + (GRACE_MAX_MS - GRACE_MIN_MS) * random();
}

/** Is `hour` (0..24) inside [from, to)? Wraps midnight when from > to. */
export function hourInWindow(hour: number, from: number, to: number): boolean {
  const h = ((finite(hour, 12) % 24) + 24) % 24;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

const isDay = (h: number): boolean => hourInWindow(h, 7, 19);
const isNight = (h: number): boolean => hourInWindow(h, 20, 6);

/** Weight multiplier from the time of day: a liked time of day counts more, a disliked one less. */
export function timeFactor(def: EventDef, hour: number): number {
  if (def.time.pref === 'day') return isDay(hour) ? 1.8 : isNight(hour) ? 0.5 : 1;
  if (def.time.pref === 'night') return isNight(hour) ? 1.8 : isDay(hour) ? 0.5 : 1;
  return 1;
}

/** Weight multiplier from how recently the same event ended (wall time), 0.25..1. */
export function recencyFactor(id: AnyEventId, history: readonly EventHistoryEntry[], wallNow: number): number {
  let factor = 1;
  for (const h of history) {
    if (h.id !== id) continue;
    const age = Math.max(0, wallNow - h.at);
    factor = Math.min(factor, RECENCY_MIN_FACTOR + (1 - RECENCY_MIN_FACTOR) * Math.min(1, age / RECENCY_FULL_MS));
  }
  return factor;
}

/** What the eligibility rules need to know about the world right now. */
export interface OfferContext {
  stage: Rect;
  /** The cat's body width in px (the unit of "floor width at scale 1" is CAT_BASE_WIDTH_DIP of it). */
  bodyW: number;
  localHour: number;
  reducedMotion: boolean;
  rare: boolean;
  disabled: readonly AnyEventId[];
  /** Skip the hour window (the dev menu may force the midnight visitor by day). */
  ignoreHours?: boolean;
}

/** Can this event be offered on this stage at this hour, under these choices? */
export function canOffer(def: EventDef, o: OfferContext): boolean {
  if (def.rare && !o.rare) return false;
  if (o.disabled.includes(def.id)) return false;
  if (def.skipReduced && o.reducedMotion) return false;
  const unit = o.bodyW > 0 && Number.isFinite(o.bodyW) ? o.bodyW : CAT_BASE_WIDTH_DIP;
  if (o.stage.width < def.minFloorPx * (unit / CAT_BASE_WIDTH_DIP)) return false;
  if (o.stage.height < def.minHeightBody * unit) return false;
  const strict = def.time.strict;
  if (strict && !o.ignoreHours && !hourInWindow(o.localHour, strict[0], strict[1])) return false;
  return true;
}

function poolFor(rare: boolean, o: OfferContext, history: readonly EventHistoryEntry[], wallNow: number, exclude: number): { id: AnyEventId; w: number }[] {
  const recent = exclude > 0 ? history.slice(-exclude).map((h) => h.id) : [];
  const out: { id: AnyEventId; w: number }[] = [];
  for (const id of rare ? RARE_POOL : NORMAL_POOL) {
    const def = EVENT_CATALOG[id];
    if (!def || !canOffer(def, o) || recent.includes(id)) continue;
    const w = def.weight * timeFactor(def, o.localHour) * recencyFactor(id, history, wallNow);
    if (w > 0) out.push({ id, w });
  }
  return out;
}

function weightedPick(random: () => number, items: readonly { id: AnyEventId; w: number }[]): AnyEventId | null {
  let total = 0;
  for (const it of items) total += it.w;
  if (items.length === 0 || total <= 0) return null;
  let x = random() * total;
  for (const it of items) {
    x -= it.w;
    if (x < 0) return it.id;
  }
  return items[items.length - 1]?.id ?? null;
}

/**
 * Draw the next event. With probability RARE_EVENT_PROBABILITY (when rare events are on) from the rare
 * pool, otherwise from the normal pool; a rare draw whose pool is empty falls back to the normal one, so
 * the rare pool never blocks it. The repeat exclusion is relaxed step by step (all, the last one only,
 * none) only when the user has switched off so much that nothing else would be left.
 */
export function chooseEvent(random: () => number, o: OfferContext, history: readonly EventHistoryEntry[], wallNow: number): AnyEventId | null {
  if (o.rare && random() < RARE_EVENT_PROBABILITY) {
    const rare = weightedPick(random, poolFor(true, o, history, wallNow, RARE_REPEAT_EXCLUDE));
    if (rare) return rare;
  }
  for (const exclude of [NORMAL_REPEAT_EXCLUDE, 1, 0]) {
    const id = weightedPick(random, poolFor(false, o, history, wallNow, exclude));
    if (id) return id;
  }
  return null;
}
