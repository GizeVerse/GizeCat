import { z } from 'zod';

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
});
export type Counters = z.infer<typeof CountersSchema>;

export const PreferencesSchema = z.object({
  /** Exponential moving average of pets per active hour. */
  petRatePerHour: z.number().min(0).max(10000).default(0).catch(0),
  /** 0..1 how often the user engages when the cat starts cursor play. */
  cursorPlayAcceptance: unit(0.5),
  /** 0..1 how often the user responds to attention seeking. */
  attentionAcceptance: unit(0.5),
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
  counters: Counters;
  preferences: Preferences;
  favoriteSpotCount: number;
  recent: MemoryEntry[];
}
