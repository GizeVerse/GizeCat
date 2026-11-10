// DOM-free view logic of the Living Companion pages: the live status sentences, the tolerant reading
// and writing of the companion.events leaf, and the journal rows. Everything here is total: a view
// state from an older build (no `companion`), a missing field or an odd journal entry never throws.
import { ALL_EVENT_IDS, EVENT_PACE_RANGE, JOURNAL_MAX, type AnyEventId, type CompanionEventChoices, type JournalEntry } from '../../shared/companion';
import type { CompanionStatus } from '../../shared/ipc';
import { PERSONALITY_TEXT } from '../../shared/personalityText';
import { eventName, formatJournalDate, journalText } from '../../shared/worldText';
import type { FieldId } from './fields';
import { formatDuration } from './format';
import { S } from './strings';

const C = S.companion;

/**
 * The settings of the companion section and where each has its control (tests check that none can be
 * added to the schema without one): personality on the Personality page, events on Behaviour (and the
 * inverse "disable all" switch on Accessibility & Focus), reduced motion on Accessibility & Focus and
 * the journal switch on the Journal page. The sound.cat and sound.world switches are on the Audio page.
 */
export const COMPANION_FIELD_IDS: readonly FieldId[] = ['companion.personality', 'companion.events', 'companion.reducedMotion', 'companion.journal'];

const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const isEventId = (v: unknown): v is AnyEventId => typeof v === 'string' && (ALL_EVENT_IDS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// companion.events (one leaf: master switch, rare pool, pace and the disabled list travel together)

/** companion.events as the settings hold it (a mutable list, so it is assignable to the setting itself). */
export type EventsLeaf = Omit<CompanionEventChoices, 'disabled'> & { disabled: AnyEventId[] };

export const EVENT_DEFAULTS: EventsLeaf = { enabled: true, rare: true, pace: EVENT_PACE_RANGE.default, disabled: [] };

/** The leaf as the UI shows it: anything missing or malformed falls back to the default. */
export function readEvents(leaf: unknown): EventsLeaf {
  if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) return { ...EVENT_DEFAULTS, disabled: [] };
  const o = leaf as Record<string, unknown>;
  const disabled: AnyEventId[] = [];
  if (Array.isArray(o.disabled)) for (const id of o.disabled as unknown[]) if (isEventId(id) && !disabled.includes(id)) disabled.push(id);
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : EVENT_DEFAULTS.enabled,
    rare: typeof o.rare === 'boolean' ? o.rare : EVENT_DEFAULTS.rare,
    pace: Math.min(EVENT_PACE_RANGE.max, Math.max(EVENT_PACE_RANGE.min, finiteOr(o.pace, EVENT_DEFAULTS.pace))),
    disabled,
  };
}

/** The whole leaf with some fields changed: patches always carry the complete object, the list included. */
export function eventsWith(current: unknown, change: Partial<CompanionEventChoices>): EventsLeaf {
  const base = readEvents(current);
  return { ...base, ...change, disabled: [...(change.disabled ?? base.disabled)] };
}

/** The disabled list with one event switched, in catalogue order and without duplicates. */
export function setEventEnabled(disabled: readonly AnyEventId[], id: AnyEventId, enabled: boolean): AnyEventId[] {
  const set = new Set<AnyEventId>(disabled);
  if (enabled) set.delete(id);
  else set.add(id);
  return ALL_EVENT_IDS.filter((e) => set.has(e));
}

// ---------------------------------------------------------------------------
// Live status

const own = (labels: Readonly<Record<string, string>>, id: string): string | undefined => (Object.prototype.hasOwnProperty.call(labels, id) ? labels[id] : undefined);

export function moodLabel(mood: string): string {
  return own(C.moods, mood) ?? mood;
}

/** "Calm", or "Calm (nearest profile)" for a cat that keeps its born traits. */
export function personalityLine(status: Pick<CompanionStatus, 'personality' | 'personalityIsAuto'>): string {
  const known = Object.prototype.hasOwnProperty.call(PERSONALITY_TEXT, status.personality);
  const name = known ? PERSONALITY_TEXT[status.personality].name : String(status.personality);
  return status.personalityIsAuto ? C.personalityAuto(name) : C.personalityChosen(name);
}

/** "5 min", "1 h 5 min": minutes are rounded, so the line changes about once a minute, not every poll. */
export function nextEventText(ms: number): string {
  const v = finiteOr(ms, 0);
  if (v < 60_000) return C.eventNextSoon;
  return C.eventNext(formatDuration(Math.round(v / 60_000) * 60));
}

/** The "World event" line: what is running, or why nothing is, or when the next one comes. */
export function worldEventLine(status: Pick<CompanionStatus, 'event' | 'eventsPaused' | 'nextEventInMs'>, eventsEnabled: boolean): string {
  if (status.event !== null && status.event !== undefined) return C.eventRunning(eventName(status.event));
  if (!eventsEnabled) return C.eventsOff;
  if (status.eventsPaused) return C.eventsPaused;
  if (typeof status.nextEventInMs === 'number' && Number.isFinite(status.nextEventInMs)) return nextEventText(status.nextEventInMs);
  return C.eventNone;
}

/** The text of the pause-events control's note, or null. */
export function pauseEventsNote(status: Pick<CompanionStatus, 'eventsPaused'> | undefined, eventsEnabled: boolean): string | null {
  if (!eventsEnabled) return C.eventsSwitchedOff;
  return status?.eventsPaused ? C.eventsPausedNote : null;
}

// ---------------------------------------------------------------------------
// Journal

export interface JournalRow {
  /** 'YYYY-MM-DD' in local time (src/shared/worldText.ts), never empty. */
  date: string;
  /** ISO timestamp for the <time> element. */
  iso: string;
  event: string;
  text: string;
}

/**
 * Journal entries as rows, newest first. main returns them oldest first and already bounded; this
 * re-checks the shape and the bound so a malformed entry is skipped instead of breaking the page.
 */
export function journalRows(entries: unknown): JournalRow[] {
  if (!Array.isArray(entries)) return [];
  const rows: Array<JournalRow & { at: number }> = [];
  for (const raw of entries as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    const e = raw as Partial<JournalEntry>;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || typeof e.id !== 'string' || typeof e.outcome !== 'string') continue;
    const date = formatJournalDate(e.at);
    if (date === '') continue;
    const id = e.id;
    rows.push({ at: e.at, date, iso: new Date(e.at).toISOString(), event: eventName(id), text: journalText(id, e.outcome) });
  }
  // Stable: entries from the same instant keep main's order, reversed with the rest.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.at - a.r.at || b.i - a.i)
    .slice(0, JOURNAL_MAX)
    .map(({ r }) => ({ date: r.date, iso: r.iso, event: r.event, text: r.text }));
}
