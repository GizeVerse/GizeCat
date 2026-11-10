// Loading a stored cat: schema validation, forward compatibility and recovery.
import type { PersistedCat } from '../../shared/catState';
import { CAT_STATE_SCHEMA_VERSION, PersistedCatSchema } from '../../shared/catState';
import { MEMORY_DETAILS, MEMORY_KINDS } from './memory';
import { newPersistedCat } from './personality';
import type { Random } from './random';

export interface MigrationResult {
  cat: PersistedCat;
  /** true when the stored data was missing/unusable and a new cat was created. */
  recovered: boolean;
}

/**
 * Validates a stored cat. Individual corrupt fields fall back to defaults (the
 * schema does that per field); if the identity itself (version, catId, bornAt)
 * is unusable a new cat is created and `recovered` is true. Newer schema versions
 * are read best-effort: known fields are kept, unknown ones dropped.
 */
export function migrateCatState(raw: unknown, random: Random, nowEpochMs: number): MigrationResult {
  const now = Number.isFinite(nowEpochMs) && nowEpochMs > 0 ? nowEpochMs : 0;
  const fresh = (): MigrationResult => ({ cat: newPersistedCat(random, now), recovered: true });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fresh();
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const version = obj.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fresh();
  if (version > CAT_STATE_SCHEMA_VERSION) obj.schemaVersion = CAT_STATE_SCHEMA_VERSION;
  const parsed = PersistedCatSchema.safeParse(obj);
  if (!parsed.success) return fresh();
  return { cat: sanitizeTimes(parsed.data, now), recovered: false };
}

const KINDS: ReadonlySet<string> = new Set(MEMORY_KINDS);
const DETAILS: ReadonlySet<string> = new Set(MEMORY_DETAILS);

/**
 * Keeps only memory entries made of known, content-free tokens, and makes sure clock
 * changes do not leave timestamps in the future.
 */
function sanitizeTimes(cat: PersistedCat, now: number): PersistedCat {
  cat.memory.recent = cat.memory.recent
    .filter((e) => KINDS.has(e.kind))
    .map((e) => (e.detail !== undefined && DETAILS.has(e.detail) ? { at: e.at, kind: e.kind, detail: e.detail } : { at: e.at, kind: e.kind }));
  if (now <= 0) return cat;
  const cap = (t: number): number => (t > now ? now : t);
  cat.bornAt = cap(cat.bornAt);
  cat.savedAt = cap(cat.savedAt);
  cat.memory.lastSeenAt = cap(cat.memory.lastSeenAt);
  for (const s of cat.memory.favoriteSpots) s.lastUsedAt = cap(s.lastUsedAt);
  for (const e of cat.memory.recent) e.at = cap(e.at);
  cat.memory.recent.sort((a, b) => a.at - b.at);
  // Living Companion world memory: same rule (no entry from the future), order kept (newest last).
  cat.world.lastEndedAt = cap(cat.world.lastEndedAt);
  for (const e of cat.world.events) e.at = cap(e.at);
  for (const e of cat.world.journal) e.at = cap(e.at);
  return cat;
}
