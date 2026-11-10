// The persistent half of the Living Companion: what happened in the cat's world (event history,
// per-event counters, the journal). Pure helpers over the `world` section of the persisted cat
// (src/shared/catState.ts): each takes a WorldMemory and returns a NEW one, never mutating its input,
// and every result stays inside the schema's bounds even when the input did not (the entries are
// re-validated on the way in, so a bad id or outcome token can never be written). The sim stores the
// result back into `cat.world`; catStore's atomic write, backup and quarantine already protect it.
import type { WorldMemory } from '../../shared/catState';
import { normalizeWorldCounts, normalizeWorldEntries, parseWorldEntry, WORLD_COUNT_MAX, WorldMemorySchema } from '../../shared/catState';
import type { EventHistoryEntry, JournalEntry } from '../../shared/companion';
import { EVENT_HISTORY_MAX, JOURNAL_MAX } from '../../shared/companion';

/** The empty world memory (a cat that has seen nothing yet). */
export function emptyWorldMemory(): WorldMemory {
  return WorldMemorySchema.parse({});
}

/** A copy of `world` re-checked against the schema bounds (unknown ids stripped, lists capped). */
export function boundedWorldMemory(world: WorldMemory): WorldMemory {
  return {
    events: normalizeWorldEntries(world.events, EVENT_HISTORY_MAX),
    counts: normalizeWorldCounts(world.counts),
    lastEndedAt: Number.isFinite(world.lastEndedAt) && world.lastEndedAt > 0 ? world.lastEndedAt : 0,
    journal: normalizeWorldEntries(world.journal, JOURNAL_MAX),
  };
}

/**
 * Records an event that ended: appended to the history (newest last, at most EVENT_HISTORY_MAX), its
 * counter raised (capped), `lastEndedAt` moved forward. An entry with an unknown id or a bad outcome
 * token changes nothing.
 */
export function appendEventHistory(world: WorldMemory, entry: EventHistoryEntry): WorldMemory {
  const e = parseWorldEntry(entry);
  const base = boundedWorldMemory(world);
  if (!e) return base;
  const counts = { ...base.counts, [e.id]: Math.min(WORLD_COUNT_MAX, (base.counts[e.id] ?? 0) + 1) };
  return {
    ...base,
    events: normalizeWorldEntries([...base.events, e], EVENT_HISTORY_MAX),
    counts,
    lastEndedAt: Math.max(base.lastEndedAt, e.at),
  };
}

/**
 * Adds a journal line (newest last, oldest dropped beyond JOURNAL_MAX). The CALLER honours
 * settings.companion.journal.enabled: when it is off nothing new is written, and what is there stays
 * until clearJournal. An invalid entry changes nothing.
 */
export function appendJournal(world: WorldMemory, entry: JournalEntry): WorldMemory {
  const e = parseWorldEntry(entry);
  const base = boundedWorldMemory(world);
  if (!e) return base;
  return { ...base, journal: normalizeWorldEntries([...base.journal, e], JOURNAL_MAX) };
}

/** Empties the journal only (history and counters stay: they steer which events play, not what the user reads). */
export function clearJournal(world: WorldMemory): WorldMemory {
  return { ...boundedWorldMemory(world), journal: [] };
}

/** Forgets the whole world: history, counters, schedule time and journal ("Clear history" and a replaced cat). */
export function clearWorldMemory(): WorldMemory {
  return emptyWorldMemory();
}

/** How many times `id` has played (0 for never). */
export function eventCount(world: WorldMemory, id: EventHistoryEntry['id']): number {
  return world.counts[id] ?? 0;
}
