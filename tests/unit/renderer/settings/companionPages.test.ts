// Living Companion settings window (DOM-free): the page registry, the live-status sentences, the tolerant
// companion.events leaf (always sent whole), the journal rows, and the wording that must agree with the
// engine's constants and the personality tables. Written in the Living Companion sprint, NOT executed there.
import { describe, expect, it } from 'vitest';
import { PERSONALITY_PROFILES } from '../../../../src/core/behavior/personalityProfiles';
import { ALL_EVENT_IDS, EVENT_DELAY_FLOOR_MS, EVENT_DELAY_MAX_MS, EVENT_DELAY_MIN_MS, EVENT_PACE_RANGE, JOURNAL_MAX, MOODS, PERSONALITY_IDS, RARE_EVENT_IDS, WORLD_EVENT_IDS } from '../../../../src/shared/companion';
import type { CompanionStatus, SettingsViewState } from '../../../../src/shared/ipc';
import { SETTINGS_ACTIONS } from '../../../../src/shared/ipc';
import { PERSONALITY_TEXT } from '../../../../src/shared/personalityText';
import { applySettingsPatch, defaultSettings, type PatchResult, type SettingsPatch } from '../../../../src/shared/settings';
import { eventDescription, eventName } from '../../../../src/shared/worldText';
import { isPageId, PAGE_IDS } from '../../../../src/renderer/settings/catalog';
import {
  COMPANION_FIELD_IDS,
  EVENT_DEFAULTS,
  eventsWith,
  journalRows,
  moodLabel,
  nextEventText,
  pauseEventsNote,
  personalityLine,
  readEvents,
  setEventEnabled,
  worldEventLine,
} from '../../../../src/renderer/settings/companionView';
import { PACE_RANGE, paceLabel } from '../../../../src/renderer/settings/worldEventRows';
import { snapToStep } from '../../../../src/renderer/settings/fields';
import { SettingsStore, type FieldBinding, type Timers } from '../../../../src/renderer/settings/store';
import { S } from '../../../../src/renderer/settings/strings';
import { previewView } from './preview/fixture';

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const status = (over: Partial<CompanionStatus> = {}): CompanionStatus => ({
  mood: 'happy',
  activity: 'walking',
  personality: 'calm',
  personalityIsAuto: false,
  event: null,
  nextEventInMs: 12 * 60_000,
  eventsPaused: false,
  laserActive: false,
  ...over,
});

describe('page registry', () => {
  it('adds Companion, Audio, Accessibility & Focus and Journal, each with a nav label and a hash target', () => {
    for (const id of ['companion', 'audio', 'accessibility', 'journal'] as const) {
      expect(PAGE_IDS).toContain(id);
      expect(isPageId(id)).toBe(true);
      expect(S.nav[id].length).toBeGreaterThan(0);
    }
    expect(S.nav.accessibility).toBe('Accessibility & Focus');
    // One entry per id, and every id has its label (the nav is built from both).
    expect(new Set(PAGE_IDS).size).toBe(PAGE_IDS.length);
    expect(Object.keys(S.nav).sort()).toEqual([...PAGE_IDS].sort());
    // The cat comes first after the welcome page; the pages that already existed are all still there.
    expect(PAGE_IDS.slice(0, 2)).toEqual(['welcome', 'companion']);
    for (const old of ['welcome', 'general', 'appearance', 'behavior', 'interaction', 'privacy', 'ai', 'personality', 'diagnostics', 'about']) expect(PAGE_IDS).toContain(old);
  });

  it('every companion setting has a control, and the actions the Companion page sends exist', () => {
    const leaves = Object.keys(defaultSettings().companion).map((k) => `companion.${k}`);
    expect([...COMPANION_FIELD_IDS].sort()).toEqual(leaves.sort());
    for (const a of ['startLaserMode', 'stopLaserMode', 'pauseEvents', 'resumeEvents', 'clearJournal'] as const) expect(SETTINGS_ACTIONS).toContain(a);
    expect(Object.keys(defaultSettings().sound).sort()).toEqual(['cat', 'enabled', 'volume', 'world']);
  });
});

describe('companion.events leaf', () => {
  it('reads defaults for anything missing or malformed', () => {
    expect(readEvents(undefined)).toEqual(EVENT_DEFAULTS);
    expect(readEvents('x')).toEqual(EVENT_DEFAULTS);
    expect(readEvents([])).toEqual(EVENT_DEFAULTS);
    expect(readEvents({ enabled: 'no', rare: 1, pace: Number.NaN, disabled: 'mouseEncounter' })).toEqual(EVENT_DEFAULTS);
    expect(readEvents({ pace: 9 }).pace).toBe(EVENT_PACE_RANGE.max);
    expect(readEvents({ pace: 0 }).pace).toBe(EVENT_PACE_RANGE.min);
    expect(readEvents({ disabled: ['tinyUfo', 'nope', 'tinyUfo', 7] }).disabled).toEqual(['tinyUfo']);
  });

  it('always writes the whole object, the disabled list included, and never mutates its input', () => {
    const cur = { enabled: true, rare: false, pace: 1.5, disabled: ['tinyUfo'] };
    const frozen = JSON.stringify(cur);
    const next = eventsWith(cur, { enabled: false });
    expect(next).toEqual({ enabled: false, rare: false, pace: 1.5, disabled: ['tinyUfo'] });
    expect(JSON.stringify(cur)).toBe(frozen);
    expect(next.disabled).not.toBe(cur.disabled);
    expect(eventsWith(undefined, { pace: 2 })).toEqual({ ...EVENT_DEFAULTS, pace: 2 });
  });

  it('switching an event off or on keeps catalogue order and one entry per event', () => {
    let list = setEventEnabled([], 'tinyUfo', false);
    list = setEventEnabled(list, 'mouseEncounter', false);
    list = setEventEnabled(list, 'goldenButterfly', false);
    expect(list).toEqual(['mouseEncounter', 'tinyUfo', 'goldenButterfly']);
    expect(setEventEnabled(list, 'tinyUfo', false)).toEqual(list);
    expect(setEventEnabled(list, 'tinyUfo', true)).toEqual(['mouseEncounter', 'goldenButterfly']);
  });

  it('every patch the controls can build is accepted by main unchanged', () => {
    const base = defaultSettings();
    for (const pace of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
      const r = applySettingsPatch(base, { companion: { events: eventsWith(base.companion.events, { pace }) } });
      expect(r.ok, `pace ${pace}`).toBe(true);
      if (r.ok) expect(r.settings.companion.events.pace).toBe(pace);
    }
    const allOff = applySettingsPatch(base, { companion: { events: eventsWith(base.companion.events, { disabled: [...ALL_EVENT_IDS] }) } });
    expect(allOff.ok).toBe(true);
    if (allOff.ok) expect(allOff.settings.companion.events.disabled).toEqual([...ALL_EVENT_IDS]);
    expect(applySettingsPatch(base, { companion: { events: eventsWith(base.companion.events, { enabled: false, rare: false }) } }).ok).toBe(true);
    expect(applySettingsPatch(base, { companion: { journal: { enabled: false }, reducedMotion: true, personality: 'shy' } }).ok).toBe(true);
    expect(applySettingsPatch(base, { sound: { cat: false, world: false } }).ok).toBe(true);
  });

  it('the pace slider covers 0.5 to 2 in quarter steps and calls the default "Default"', () => {
    expect([PACE_RANGE.min, PACE_RANGE.max, PACE_RANGE.step]).toEqual([0.5, 2, 0.25]);
    expect(PACE_RANGE.min).toBe(EVENT_PACE_RANGE.min);
    expect(PACE_RANGE.max).toBe(EVENT_PACE_RANGE.max);
    expect(snapToStep(PACE_RANGE, 1.1)).toBe(1);
    expect(snapToStep(PACE_RANGE, 9)).toBe(2);
    expect(paceLabel(EVENT_PACE_RANGE.default)).toBe(S.behavior.worldPaceDefault);
    expect(paceLabel(1.5)).toBe('1.5×');
  });

  it('the wording agrees with the engine constants', () => {
    expect([EVENT_DELAY_MIN_MS / 60_000, EVENT_DELAY_MAX_MS / 60_000]).toEqual([5, 30]);
    expect(S.behavior.worldPaceDesc).toContain('one event every 5 to 30 minutes');
    expect(S.behavior.worldPaceDesc).toContain(`${EVENT_DELAY_FLOOR_MS / 60_000} minutes apart`);
    expect(S.behavior.worldPaceDesc.startsWith('Default:')).toBe(true);
  });

  it('lists all 20 everyday and 6 rare events, each with a name and a description', () => {
    expect([WORLD_EVENT_IDS.length, RARE_EVENT_IDS.length, ALL_EVENT_IDS.length]).toEqual([20, 6, 26]);
    for (const id of ALL_EVENT_IDS) {
      expect(eventName(id).length, id).toBeGreaterThan(0);
      expect(eventName(id), id).not.toBe(id);
      expect(eventDescription(id).length, id).toBeGreaterThan(0);
    }
  });
});

describe('store: companion.events and the journal switch', () => {
  function fakeTimers(): Timers {
    return { setTimeout: () => 1, clearTimeout: () => undefined };
  }
  function fakeApi() {
    const calls: Array<{ patch: SettingsPatch; resolve(r: PatchResult): void }> = [];
    return {
      calls,
      update(patch: SettingsPatch): Promise<PatchResult> {
        return new Promise<PatchResult>((resolve) => calls.push({ patch, resolve }));
      },
    };
  }
  const binding = (field: FieldBinding['field']): FieldBinding & { synced: unknown[] } => {
    const b = { field, synced: [] as unknown[], isBusy: () => false, sync: (v: unknown) => void b.synced.push(v), showError: () => undefined };
    return b;
  };
  const view = (): SettingsViewState => previewView(NOW, { electron: '44.9.3', chrome: '152.0.0.0', node: '24.0.0' });

  it('sends the whole events object, and builds the next change from the newest intended value', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const a = binding('companion.events');
    store.bind(a);
    expect(a.synced[0]).toEqual(defaultSettings().companion.events);
    store.set('companion', 'events', eventsWith(store.intended('companion', 'events'), { disabled: setEventEnabled([], 'tinyUfo', false) }), { origin: a });
    // A second switch moved before main answered must not lose the first.
    store.set('companion', 'events', eventsWith(store.intended('companion', 'events'), { rare: false }), { origin: a });
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.patch).toEqual({ companion: { events: { enabled: true, rare: true, pace: 1, disabled: ['tinyUfo'] } } });
    expect(api.calls[1]?.patch).toEqual({ companion: { events: { enabled: true, rare: false, pace: 1, disabled: ['tinyUfo'] } } });
    for (const c of api.calls) {
      const r = applySettingsPatch(store.settings, c.patch);
      expect(r.ok).toBe(true);
      c.resolve(r);
    }
    await store.settled();
    expect(store.settings.companion.events).toEqual({ enabled: true, rare: false, pace: 1, disabled: ['tinyUfo'] });
  });

  it('does not send a switch that was moved back to what main already has', () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    store.set('companion', 'events', eventsWith(store.intended('companion', 'events'), { enabled: true }));
    store.set('companion', 'journal', { enabled: true });
    expect(api.calls).toHaveLength(0);
    store.set('companion', 'journal', { enabled: false });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.patch).toEqual({ companion: { journal: { enabled: false } } });
  });

  it('a rejected change is shown as an error and the control goes back to main’s value', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const errors: Array<string | null> = [];
    const b: FieldBinding = { field: 'companion.events', isBusy: () => false, sync: () => undefined, showError: (m) => void errors.push(m) };
    store.bind(b);
    store.set('companion', 'events', eventsWith(store.intended('companion', 'events'), { enabled: false }), { origin: b });
    api.calls[0]?.resolve({ ok: false, error: 'invalid value for companion.events' });
    await store.settled();
    expect(store.settings.companion.events.enabled).toBe(true);
    expect(errors.at(-1)).toBe(S.errors.saveFailed('invalid value for companion.events'));
  });
});

describe('live status', () => {
  it('names every mood and falls back to the raw token for an unknown one', () => {
    for (const m of MOODS) expect(moodLabel(m).length).toBeGreaterThan(0);
    expect(moodLabel('happy')).toBe('Happy');
    expect(moodLabel('future-mood')).toBe('future-mood');
    expect(moodLabel('constructor')).toBe('constructor');
  });

  it('says "nearest profile" only for a cat that keeps its born traits', () => {
    expect(personalityLine({ personality: 'calm', personalityIsAuto: false })).toBe('Calm');
    expect(personalityLine({ personality: 'shy', personalityIsAuto: true })).toBe('Shy (nearest profile)');
    expect(personalityLine({ personality: 'toString' as never, personalityIsAuto: false })).toBe('toString');
  });

  it('shows the running event, else why nothing is running, else the countdown', () => {
    expect(worldEventLine(status({ event: 'mouseEncounter' }), true)).toBe('Little Mouse is happening now');
    expect(worldEventLine(status({ event: 'mouseEncounter', eventsPaused: true }), true)).toBe('Little Mouse is happening now');
    expect(worldEventLine(status(), false)).toBe(S.companion.eventsOff);
    expect(worldEventLine(status({ eventsPaused: true }), true)).toBe(S.companion.eventsPaused);
    expect(worldEventLine(status({ nextEventInMs: 12 * 60_000 }), true)).toBe('Next in about 12 min');
    expect(worldEventLine(status({ nextEventInMs: 20_000 }), true)).toBe(S.companion.eventNextSoon);
    expect(worldEventLine(status({ nextEventInMs: null }), true)).toBe(S.companion.eventNone);
  });

  it('rounds the countdown to whole minutes so it changes about once a minute', () => {
    expect(nextEventText(60_000)).toBe('Next in about 1 min');
    expect(nextEventText(89_000)).toBe('Next in about 1 min');
    expect(nextEventText(91_000)).toBe('Next in about 2 min');
    expect(nextEventText(65 * 60_000)).toBe('Next in about 1 h 5 min');
    expect(nextEventText(Number.NaN)).toBe(S.companion.eventNextSoon);
  });

  it('explains the session-only event pause, and why there is nothing to pause when events are off', () => {
    expect(pauseEventsNote(status(), true)).toBeNull();
    expect(pauseEventsNote(status({ eventsPaused: true }), true)).toBe(S.companion.eventsPausedNote);
    expect(pauseEventsNote(status(), false)).toBe(S.companion.eventsSwitchedOff);
    expect(pauseEventsNote(undefined, true)).toBeNull();
    expect(S.companion.pauseEventsDesc).toMatch(/this session only/);
    expect(S.companion.laserDesc).toMatch(/never catches it/);
  });

  it('a view state from an older build has no companion status and the page copes (the field is optional)', () => {
    const v = previewView(NOW, { electron: '44.9.3', chrome: '152.0.0.0', node: '24.0.0' });
    expect(v.companion).toBeUndefined();
    expect(readEvents(v.settings.companion.events)).toEqual(EVENT_DEFAULTS);
  });
});

describe('journal rows', () => {
  const at = (day: number, hour = 12): number => new Date(2026, 10, day, hour, 0, 0).getTime();

  it('lists the newest first with a local date and the sentence of the event and outcome', () => {
    const rows = journalRows([
      { id: 'mouseEncounter', at: at(3), outcome: 'chased' },
      { id: 'tinyUfo', at: at(9), outcome: 'watched' },
      { id: 'miniTsunami', at: at(6), outcome: 'wet' },
    ]);
    expect(rows.map((r) => r.date)).toEqual(['2026-11-09', '2026-11-06', '2026-11-03']);
    expect(rows[0]?.text).toBe('A tiny flying saucer crossed the sky. The cat watched it go.');
    expect(rows[0]?.event).toBe('Tiny UFO');
    expect(rows[1]?.text).toContain('got a little wet');
    expect(rows[2]?.iso).toBe(new Date(at(3)).toISOString());
  });

  it('keeps main’s order reversed for entries from the same moment, and uses the fallback for an unknown outcome', () => {
    const rows = journalRows([
      { id: 'fallingLeaf', at: at(5), outcome: 'first' },
      { id: 'fallingLeaf', at: at(5), outcome: 'tapped' },
    ]);
    expect(rows[0]?.text).toContain('gave it a tap');
    expect(rows[1]?.text).toBe('A leaf drifted down and settled on the floor.');
  });

  it('skips malformed entries, tolerates a non-list, and never shows more than the journal keeps', () => {
    expect(journalRows(undefined)).toEqual([]);
    expect(journalRows('x')).toEqual([]);
    expect(journalRows([null, 3, {}, { id: 'tinyUfo', at: 'now', outcome: 'x' }, { id: 'tinyUfo', at: Number.NaN, outcome: 'x' }, { id: 'tinyUfo', at: 1e20, outcome: 'x' }, { id: 1, at: at(1), outcome: 'x' }])).toEqual([]);
    const many = Array.from({ length: JOURNAL_MAX + 25 }, (_, i) => ({ id: 'tinyUfo', at: at(1) + i * 60_000, outcome: 'watched' }));
    const rows = journalRows(many);
    expect(rows).toHaveLength(JOURNAL_MAX);
    expect(rows[0]?.iso).toBe(new Date(at(1) + (JOURNAL_MAX + 24) * 60_000).toISOString());
  });

  it('the journal wording promises what is true: local, no streaks, a confirmation before clearing', () => {
    expect(S.journal.intro).toMatch(/only on this PC/);
    expect(S.journal.intro).toMatch(/no streaks, scores or reminders/);
    expect(S.journal.clearConfirmText).toMatch(/cannot be undone/);
    expect(S.journal.count(1, JOURNAL_MAX)).toBe(`1 entry (the newest ${JOURNAL_MAX} are kept)`);
    expect(S.journal.count(2, JOURNAL_MAX)).toBe(`2 entries (the newest ${JOURNAL_MAX} are kept)`);
  });
});

describe('personality cards', () => {
  it('describes all seven profiles in plain words, with a sentence and a short list each', () => {
    expect(Object.keys(PERSONALITY_TEXT).sort()).toEqual([...PERSONALITY_IDS].sort());
    for (const id of PERSONALITY_IDS) {
      const t = PERSONALITY_TEXT[id];
      expect(t.name.length, id).toBeGreaterThan(0);
      expect(t.summary.endsWith('.'), id).toBe(true);
      expect(t.behaves.length, id).toBeGreaterThanOrEqual(2);
      expect(t.behaves.length, id).toBeLessThanOrEqual(4);
    }
    expect(S.personality.autoTitle).toBe('Auto (keeps the cat’s born traits)');
    expect(S.personality.groupChoiceDesc).toMatch(/the cat never changes it/);
  });

  it('every claim in the words still agrees with the profile numbers', () => {
    const P = PERSONALITY_PROFILES;
    const top = <K extends 'restBias' | 'eventInterest' | 'approachBoldness' | 'chaseDuration' | 'startleScale' | 'calmness' | 'mischief' | 'playAppetite'>(k: K): string =>
      [...PERSONALITY_IDS].sort((a, b) => P[b][k] - P[a][k])[0] ?? '';
    const lowest = (k: 'restBias' | 'startleScale'): string => [...PERSONALITY_IDS].sort((a, b) => P[a][k] - P[b][k])[0] ?? '';
    expect(top('restBias')).toBe('lazy');
    expect(PERSONALITY_TEXT.lazy.behaves.join(' ')).toMatch(/Rests most of the time/);
    expect(lowest('restBias')).toBe('energetic');
    expect(PERSONALITY_TEXT.energetic.behaves.join(' ')).toMatch(/rests very little/);
    expect(top('chaseDuration')).toBe('energetic');
    expect(PERSONALITY_TEXT.energetic.behaves.join(' ')).toMatch(/Chases for the longest/);
    expect(top('playAppetite')).toBe('playful');
    expect(PERSONALITY_TEXT.playful.behaves.join(' ')).toMatch(/toys and games the longest/);
    expect(top('eventInterest')).toBe('curious');
    expect(PERSONALITY_TEXT.curious.behaves.join(' ')).toMatch(/Notices world events quickly/);
    expect(top('mischief')).toBe('mischievous');
    expect(PERSONALITY_TEXT.mischievous.behaves.join(' ')).toMatch(/cheeky/);
    expect(top('calmness')).toBe('calm');
    expect(PERSONALITY_TEXT.calm.behaves.join(' ')).toMatch(/few sudden movements/i);
    expect(top('startleScale')).toBe('shy');
    expect(PERSONALITY_TEXT.shy.behaves.join(' ')).toMatch(/Startles easily/);
    expect(lowest('startleScale')).toBe('calm');
    expect(PERSONALITY_TEXT.calm.behaves.join(' ')).toMatch(/hard to startle/i);
    // The two boolean knobs are each unique to one profile, and that profile says so.
    expect(PERSONALITY_IDS.filter((id) => P[id].watchFromDistance)).toEqual(['shy']);
    expect(PERSONALITY_TEXT.shy.behaves.join(' ')).toMatch(/from a distance/);
    expect(PERSONALITY_IDS.filter((id) => P[id].ignoreMinorEvents)).toEqual(['lazy']);
    expect(PERSONALITY_TEXT.lazy.behaves.join(' ')).toMatch(/small things/);
    // Bold: the profile that approaches fastest is the one that says it walks straight up.
    expect(top('approachBoldness')).toBe('mischievous');
    expect(PERSONALITY_TEXT.mischievous.behaves.join(' ')).toMatch(/walks straight up/);
  });
});

describe('accessibility and audio wording', () => {
  it('says the system setting is honoured, the cat stays out of full-screen apps and nothing blocks clicks', () => {
    expect(S.access.reducedDesc).toMatch(/system setting that reduces animations/);
    expect(S.access.fullscreenTitle).toBe('Full-screen quiet mode');
    expect(S.access.fullscreenNote).toMatch(/stays out of full-screen apps/);
    expect(S.access.clickThroughNote).toMatch(/never take clicks/);
    expect(S.access.pauseTitle).toBe('Pause all autonomous activity');
    expect(S.access.eventsOffTitle).toBe('Disable all world events');
  });

  it('keeps the sound master switch separate from the two kinds, and never mentions the microphone as used', () => {
    expect([S.audio.masterTitle, S.audio.catTitle, S.audio.worldTitle]).toEqual(['Sound', 'Cat sounds', 'World sounds']);
    expect(S.audio.intro).toMatch(/microphone is never used/);
    expect(defaultSettings().sound.enabled).toBe(false);
  });

  it('explains laser mode: a real-pointer dot, never caught, clicks pass through, no system cursor change, how to stop', () => {
    const text = [S.interaction.laserIntro, ...S.interaction.laserPoints].join(' ');
    expect(text).toMatch(/real pointer/);
    expect(text).toMatch(/never catches it/);
    expect(text).toMatch(/clicks go straight through/);
    expect(text).toMatch(/does not change your system cursor/);
    expect(text).toMatch(/right-click the cat or use the tray menu/);
    expect(S.companion.laserOn).toMatch(/Right-click the cat or use the tray menu/);
  });
});
