// Runtime schema for the v1.2 behaviour profile (contract: ./behaviorProfile.ts, ADR 0003 §11).
// Main parses every BehaviorProfileSnapshot with it before the snapshot reaches the settings
// window or the diagnostics export: strict objects with bounded numbers, enum keys and bounded
// arrays, so nothing beyond the contract's kinds, counts and durations (no window, surface or app
// id, no title, no position) can leave main, whatever a producer put in. zod/mini, like the
// surface diagnostics schema; the type check at the bottom fails to compile if it drifts from the
// contract.
import * as z from 'zod/mini';
import { LANDING_IMPACTS } from './cat';
import {
  ACTIVITY_CLASSES,
  ARRIVAL_ROUTES,
  FALL_CAUSES,
  HUNT_OUTCOMES,
  LEAVE_KINDS,
  MAX_RECENT_STAYS,
  MOOD_EXPOSURES,
  PROFILE_CONTEXTS,
  STAY_END_REASONS,
  STAY_SURFACE_KINDS,
  THROW_REACTIONS,
  type ActivityClass,
  type BailOutKind,
  type BehaviorProfileSnapshot,
  type ExcursionRecord,
  type MoodExposure,
  type ProfileContext,
} from './behaviorProfile';

/** BailOutKind as a list (the contract has only the type; the check below keeps them equal). */
export const BAIL_OUT_KINDS = ['hop', 'jump', 'wall', 'emergency'] as const satisfies readonly BailOutKind[];

const COUNT_MAX = 1e9;
/** Sim-clock times and durations, ms (about 300 years; anything beyond is a broken producer). */
const TIME_LIMIT = 1e13;

const count = z.number().check(z.gte(0), z.lte(COUNT_MAX));
const duration = z.number().check(z.gte(0), z.lte(TIME_LIMIT));
const time = z.number().check(z.gte(-TIME_LIMIT), z.lte(TIME_LIMIT));
const fraction = z.number().check(z.gte(0), z.lte(1));

/** A strict object with one duration per key of `keys` (every key required). */
function durations<K extends string>(keys: readonly K[]) {
  return z.strictObject(Object.fromEntries(keys.map((k) => [k, duration])) as Record<K, typeof duration>);
}

const QuantilesSchema = z.strictObject({ n: count, p10: duration, p50: duration, p90: duration, max: duration });

const ExcursionRecordSchema = z.strictObject({
  phase: z.enum(['arrive', 'end']),
  at: time,
  surfaceKind: z.enum(STAY_SURFACE_KINDS),
  arrivedBy: z.enum(ARRIVAL_ROUTES),
  plannedMs: duration,
  dwellMs: duration,
  endReason: z.nullable(z.enum(STAY_END_REASONS)),
  leaveKind: z.nullable(z.enum(LEAVE_KINDS)),
  bailOut: z.optional(z.nullable(z.enum(BAIL_OUT_KINDS))),
  resumed: z.optional(z.boolean()),
});

export const BehaviorProfileSchema = z.strictObject({
  since: time,
  at: time,
  timeMs: durations<ActivityClass>(ACTIVITY_CLASSES),
  activeShare: fraction,
  decisions: count,
  excursions: z.strictObject({
    arrivals: count,
    byKind: z.partialRecord(z.enum(STAY_SURFACE_KINDS), count),
    dwellS: QuantilesSchema,
    byEnd: z.partialRecord(z.enum(STAY_END_REASONS), count),
    byLeave: z.partialRecord(z.enum(LEAVE_KINDS), count),
  }),
  hunts: z.strictObject({ count, pounces: count, byOutcome: z.partialRecord(z.enum(HUNT_OUTCOMES), count) }),
  falls: z.strictObject({ count, byCause: z.partialRecord(z.enum(FALL_CAUSES), count), byImpact: z.partialRecord(z.enum(LANDING_IMPACTS), count) }),
  slips: count,
  reactions: z.partialRecord(z.enum(THROW_REACTIONS), count),
  screenEdgeVisits: count,
  screenEdgePeeks: count,
  sleeps: count,
  stuckResets: count,
  moodMs: durations<MoodExposure>(MOOD_EXPOSURES),
  context: durations<ProfileContext>(PROFILE_CONTEXTS),
  recentStays: z.array(ExcursionRecordSchema).check(z.maxLength(MAX_RECENT_STAYS)),
});

/** The validated copy (unknown fields, unknown kinds and out-of-range numbers rejected), or null. */
export function parseBehaviorProfile(value: unknown): BehaviorProfileSnapshot | null {
  const r = BehaviorProfileSchema.safeParse(value);
  return r.success ? r.data : null;
}

// Compile-time drift checks: the schema's output and the contract type are mutually assignable.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const profileMatch: Same<z.infer<typeof BehaviorProfileSchema>, BehaviorProfileSnapshot> = true;
const staysMatch: Same<z.infer<typeof ExcursionRecordSchema>, ExcursionRecord> = true;
const bailOutsComplete: [Exclude<BailOutKind, (typeof BAIL_OUT_KINDS)[number]>] extends [never] ? true : false = true;
export const BEHAVIOR_PROFILE_SCHEMA_MATCHES_CONTRACT = profileMatch && staysMatch && bailOutsComplete;
