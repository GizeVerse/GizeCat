// Pieces of the settings view state that are pure data transformations.
import type { BehaviorState } from '../../shared/cat';
import { ALL_EVENT_IDS, JOURNAL_MAX, MOODS, PERSONALITY_IDS, type AnyEventId, type JournalEntry, type PersonalityChoice } from '../../shared/companion';
import type { CompanionStatus, PerceptionPreview } from '../../shared/ipc';
import type { VisualSummary } from '../../shared/perception';
import type { CatSim } from '../../shared/sim';

/** Maps the perception service's preview to the IPC shape; only data:image/ URLs pass. */
export function toPerceptionPreview(r: { ok: boolean; imageDataUrl?: string; summary?: VisualSummary; blockedReason?: string }): PerceptionPreview {
  const out: PerceptionPreview = { ok: r.ok };
  if (r.imageDataUrl && r.imageDataUrl.startsWith('data:image/')) out.imageDataUrl = r.imageDataUrl;
  if (r.summary) {
    out.features = r.summary.features;
    out.events = [...r.summary.events];
  }
  if (r.blockedReason) out.blockedReason = r.blockedReason;
  return out;
}

const EVENT_IDS: ReadonlySet<string> = new Set<string>(ALL_EVENT_IDS);
const MOOD_IDS: ReadonlySet<string> = new Set<string>(MOODS);
const PERSONALITIES: ReadonlySet<string> = new Set<string>(PERSONALITY_IDS);
const OUTCOME_TOKEN = /^[a-z0-9_]{1,24}$/;

/**
 * The journal as it may leave main: only entries with a known event id, a short lowercase outcome
 * token and a finite non-negative time, at most JOURNAL_MAX (the newest), oldest first. Whatever the
 * sim holds, nothing else (no free text, no extra field) reaches the settings renderer. Total: any
 * input yields a list.
 */
export function sanitizeJournal(raw: unknown): JournalEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: JournalEntry[] = [];
  for (const item of raw.slice(-JOURNAL_MAX)) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, at, outcome } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !EVENT_IDS.has(id)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    if (typeof outcome !== 'string' || !OUTCOME_TOKEN.test(outcome)) continue;
    out.push({ id: id as AnyEventId, at, outcome });
  }
  return out;
}

/**
 * The live Companion status for the settings view, from the sim's own report plus the host's session
 * flags. The settings window must keep working when the sim cannot answer (an older or stubbed sim,
 * or a throw): then the field is simply absent. Content-free: ids and numbers only.
 */
export function buildCompanionStatus(
  sim: Pick<CatSim, 'companionStatus'>,
  activity: BehaviorState,
  choice: PersonalityChoice,
  session: { eventsPaused: boolean; laserActive: boolean },
): CompanionStatus | undefined {
  if (typeof sim.companionStatus !== 'function') return undefined;
  let c: ReturnType<CatSim['companionStatus']>;
  try {
    c = sim.companionStatus();
  } catch {
    return undefined;
  }
  if (typeof c !== 'object' || c === null || !MOOD_IDS.has(c.mood)) return undefined;
  const chosen = choice !== 'auto' && PERSONALITIES.has(choice);
  const nearest = PERSONALITIES.has(c.nearestPersonality) ? c.nearestPersonality : null;
  if (!chosen && nearest === null) return undefined;
  return {
    mood: c.mood,
    activity,
    personality: chosen ? (choice) : (nearest as CompanionStatus['personality']),
    personalityIsAuto: !chosen && c.personalityIsAuto === true,
    event: c.event !== null && EVENT_IDS.has(c.event) ? c.event : null,
    nextEventInMs: typeof c.nextEventInMs === 'number' && Number.isFinite(c.nextEventInMs) && c.nextEventInMs >= 0 ? c.nextEventInMs : null,
    eventsPaused: session.eventsPaused,
    laserActive: session.laserActive,
  };
}
