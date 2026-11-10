import { z } from 'zod';
import { ALL_EVENT_IDS, EVENT_HISTORY_MAX, JOURNAL_MAX, type AnyEventId, type EventHistoryEntry } from './companion';

/**
 * The cat's persistent identity: personality traits, game-like need/mood variables
 * and a small, bounded memory. These are simulation variables, not claims of
 * sentience. Stored locally as JSON (versioned); never transmitted.
 */
export const CAT_STATE_SCHEMA_VERSION = 1;

const unit = (def: number) => z.number().min(0).max(1).default(def).catch(def);
const count = z.number().int().min(0).max(1e9).default(0).catch(0);

export const TraitsSchema = z.object({
  curiosity: unit(0.6),
  playfulness: unit(0.55),
  affection: unit(0.5),
  confidence: unit(0.5),
  energyLevel: unit(0.5),
  laziness: unit(0.45),
  /**
   * v1.2: how easily it startles (sudden motion, rough handling). Cats saved before v1.2 load the
   * neutral 0.5; new cats derive it from confidence (personality.ts; ADR 0003 §1.2).
   */
  startleSensitivity: unit(0.5),
});
export type Traits = z.infer<typeof TraitsSchema>;

export const StatsSchema = z.object({
  /** 1 = full of energy, 0 = exhausted. Drains while active, recovers while sleeping/resting. */
  energy: unit(0.8),
  /** Rises when nothing interesting happens. */
  boredom: unit(0.3),
  /** Familiarity/bond with the user. Grows with gentle interaction, decays very slowly. */
  bond: unit(0.3),
  /** Short-term irritation from repeated clicks/drags. Decays within minutes. */
  annoyance: unit(0),
  /** Short-term fear after startles. Decays within seconds. */
  fear: unit(0),
});
export type Stats = z.infer<typeof StatsSchema>;

/**
 * v1.2 drives (ADR 0003 §1.2), all 0..1. Needs grow on their own and are satisfied by matching
 * activities (petting satisfies social, not play); moods rise on events and decay to their
 * baseline within minutes. A separate object so the v1.1.1 `stats` keep their meaning; a cat file
 * without it (any v1.0/v1.1 cat) loads these defaults. No schema bump: 1.1.1 drops the object.
 */
export const DrivesSchema = z.object({
  /** Wants company; petting, greeting and answered attention satisfy it. */
  socialNeed: unit(0.3),
  /** Wants to play; play, hunts and zoomies satisfy it (never petting). */
  playNeed: unit(0.4),
  /** Wants to explore; trips up, stays, screen edges, corners and inspecting satisfy it. */
  exploreNeed: unit(0.4),
  /** Builds while awake (faster at night and with a dark screen), drops while asleep. */
  sleepiness: unit(0.2),
  /** Inclination to cheeky acts; relaxes toward a target set by settings.behavior.mischief. */
  mischief: unit(0.3),
  /** Interest in the cursor as prey; evaluated continuously while the cursor is in reach. */
  huntDrive: unit(0.3),
  /** Slow grumpiness from rough handling (integrates annoyance); recovers over minutes. */
  irritability: unit(0),
  /** Failed attempts (missed pounces, trips that failed); recovers within a couple of minutes. */
  frustration: unit(0),
  /** Keeps away from the cursor after rough handling (temporary cursor avoidance). */
  wariness: unit(0),
});
export type Drives = z.infer<typeof DrivesSchema>;

export const FavoriteSpotSchema = z.object({
  /** Display id the spot was learned on. */
  displayKey: z.string().max(64),
  /** Horizontal position as a fraction of the display work area. */
  xFrac: z.number().min(0).max(1),
  kind: z.enum(['floor', 'window']),
  score: z.number().min(0).max(1000),
  lastUsedAt: z.number().min(0),
});
export type FavoriteSpot = z.infer<typeof FavoriteSpotSchema>;

export const CountersSchema = z.object({
  pets: count,
  clicks: count,
  doubleClicks: count,
  drags: count,
  throws: count,
  chasesStarted: count,
  chasesEngaged: count,
  chasesIgnored: count,
  attentionRequests: count,
  attentionAnswered: count,
  windowsInspected: count,
  naps: count,
  sessions: count,
  // v1.2
  hunts: count,
  pounces: count,
  excursions: count,
  surfaceHops: count,
  edgeClimbs: count,
  slips: count,
  hardLandings: count,
});
export type Counters = z.infer<typeof CountersSchema>;

export const PreferencesSchema = z.object({
  /** Exponential moving average of pets per active hour. */
  petRatePerHour: z.number().min(0).max(10000).default(0).catch(0),
  /** 0..1 how often the user engages when the cat starts cursor play. */
  cursorPlayAcceptance: unit(0.5),
  /** 0..1 how often the user responds to attention seeking. */
  attentionAcceptance: unit(0.5),
  /** v1.2: exponential moving average of throws and rough drags per active hour (recent handling frequency). */
  roughRatePerHour: z.number().min(0).max(10000).default(0).catch(0),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const MemoryEntrySchema = z.object({
  at: z.number().min(0),
  kind: z.string().max(32),
  detail: z.string().max(48).optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

export const MAX_FAVORITE_SPOTS = 8;
export const MAX_RECENT_MEMORIES = 40;

export const MemorySchema = z.object({
  favoriteSpots: z.array(FavoriteSpotSchema).max(MAX_FAVORITE_SPOTS).default([]).catch([]),
  counters: CountersSchema.prefault({}).catch(() => CountersSchema.parse({})),
  preferences: PreferencesSchema.prefault({}).catch(() => PreferencesSchema.parse({})),
  recent: z.array(MemoryEntrySchema).max(MAX_RECENT_MEMORIES).default([]).catch([]),
  lastSeenAt: z.number().min(0).default(0).catch(0),
  totalAwakeMs: z.number().min(0).default(0).catch(0),
});
export type Memory = z.infer<typeof MemorySchema>;

// ---- Living Companion world memory (additive; no schema bump) -----------------------------------
// Event history, per-event counters and the journal. Cats saved before the Living Companion have no
// `world` and load the empty one; a build that does not know the section drops it on its next save,
// which only forgets the diary. Every list is checked entry by entry (one bad entry never costs the
// others) and bounded on load; ids outside the catalogue are stripped, outcome tokens are short,
// content-free [a-z0-9_] words (the sentence is built from id + outcome in worldText.ts).

/** Largest stored per-event counter. */
export const WORLD_COUNT_MAX = 1e6;
/** Outcome tokens: lower-case words, digits and underscores, at most 24 characters. */
export const OUTCOME_TOKEN_PATTERN = /^[a-z0-9_]{1,24}$/;
/** Epoch ms are kept inside the range a Date can show. */
const WALL_MS_MAX = 8.64e15;
/** A hand-edited file cannot make load work scale with its size: only the tail of a list is looked at. */
const WORLD_SCAN_MAX = 1024;

const ID_SET: ReadonlySet<string> = new Set(ALL_EVENT_IDS);

/** One history or journal entry from untrusted data, or null (unknown id, bad time, bad outcome token). */
export function parseWorldEntry(raw: unknown): EventHistoryEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const { id, at, outcome } = e;
  if (typeof id !== 'string' || !ID_SET.has(id)) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > WALL_MS_MAX) return null;
  if (typeof outcome !== 'string' || !OUTCOME_TOKEN_PATTERN.test(outcome)) return null;
  return { id: id as AnyEventId, at, outcome };
}

/** The newest `max` valid entries of `items`, oldest first (anything but an array is the empty list). */
export function normalizeWorldEntries(items: unknown, max: number): EventHistoryEntry[] {
  if (!Array.isArray(items)) return [];
  const out: EventHistoryEntry[] = [];
  const from = Math.max(0, items.length - WORLD_SCAN_MAX);
  for (let i = items.length - 1; i >= from && out.length < max; i--) {
    const e = parseWorldEntry((items as unknown[])[i]);
    if (e) out.push(e);
  }
  return out.reverse();
}

/** Per-event counters: known ids only, whole numbers 1..WORLD_COUNT_MAX (zero and junk are dropped). */
export function normalizeWorldCounts(raw: unknown): Partial<Record<AnyEventId, number>> {
  const out: Partial<Record<AnyEventId, number>> = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const id of ALL_EVENT_IDS) {
    const v = Object.hasOwn(src, id) ? src[id] : undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const n = Math.min(WORLD_COUNT_MAX, Math.floor(v));
    if (n >= 1) out[id] = n;
  }
  return out;
}

export const WorldMemorySchema = z.object({
  /** The last EVENT_HISTORY_MAX events that ended (repetition control), oldest first. */
  events: z.unknown().optional().transform((v) => normalizeWorldEntries(v, EVENT_HISTORY_MAX)),
  /** How many times each event has played. */
  counts: z.unknown().optional().transform((v) => normalizeWorldCounts(v)),
  /** Wall-clock ms the last event ended (0 = none yet); the schedule restarts from a fresh delay anyway. */
  lastEndedAt: z.number().min(0).max(WALL_MS_MAX).default(0).catch(0),
  /** The diary: meaningful moments, newest last, at most JOURNAL_MAX. */
  journal: z.unknown().optional().transform((v) => normalizeWorldEntries(v, JOURNAL_MAX)),
});
export type WorldMemory = z.infer<typeof WorldMemorySchema>;

export const LastPositionSchema = z.object({
  displayKey: z.string().max(64),
  xFrac: z.number().min(0).max(1),
  support: z.enum(['floor', 'window', 'air']),
});
export type LastPosition = z.infer<typeof LastPositionSchema>;

export const PersistedCatSchema = z.object({
  schemaVersion: z.literal(CAT_STATE_SCHEMA_VERSION),
  catId: z.string().min(8).max(64),
  bornAt: z.number().min(0),
  traits: TraitsSchema.prefault({}).catch(() => TraitsSchema.parse({})),
  stats: StatsSchema.prefault({}).catch(() => StatsSchema.parse({})),
  memory: MemorySchema.prefault({}).catch(() => MemorySchema.parse({})),
  /** v1.2 drives; defaults for cats saved before v1.2. */
  drives: DrivesSchema.prefault({}).catch(() => DrivesSchema.parse({})),
  /** Living Companion world memory; the empty one for every cat saved before it. */
  world: WorldMemorySchema.prefault({}).catch(() => WorldMemorySchema.parse({})),
  lastPosition: LastPositionSchema.nullable().default(null).catch(null),
  savedAt: z.number().min(0).default(0).catch(0),
});
export type PersistedCat = z.infer<typeof PersistedCatSchema>;

/** Non-sensitive summary shown in the settings window. */
export interface CatSummary {
  name: string;
  catId: string;
  bornAt: number;
  state: string;
  traits: Traits;
  stats: Stats;
  /** v1.2 drives (optional for summaries built by older code paths). */
  drives?: Drives;
  counters: Counters;
  preferences: Preferences;
  favoriteSpotCount: number;
  recent: MemoryEntry[];
}
