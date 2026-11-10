// The Living Companion user settings: the `companion` section and the sound categories (defaults,
// canonical round trip through applySettingsPatch, tolerant loading, the privacy lines untouched).
import { describe, expect, it } from 'vitest';
import { ALL_EVENT_IDS, EVENT_PACE_RANGE, PERSONALITY_IDS } from '../../../src/shared/companion';
import { applySettingsPatch, defaultSettings, migrateSettings, normalizeDisabledEvents, SETTINGS_SCHEMA_VERSION, type Settings } from '../../../src/shared/settings';

function patched(cur: Settings, patch: unknown): Settings {
  const r = applySettingsPatch(cur, patch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

describe('companion defaults', () => {
  it('start as auto personality, every event and the rare pool on at the default pace, journal on, motion normal', () => {
    const s = defaultSettings();
    expect(s.companion).toEqual({
      personality: 'auto',
      events: { enabled: true, rare: true, pace: EVENT_PACE_RANGE.default, disabled: [] },
      reducedMotion: false,
      journal: { enabled: true },
    });
    expect(EVENT_PACE_RANGE.default).toBe(1);
  });

  it('sound stays off by default and the two categories are on (they only matter while sound is on)', () => {
    const s = defaultSettings();
    expect(s.sound.enabled).toBe(false);
    expect(s.sound.cat).toBe(true);
    expect(s.sound.world).toBe(true);
  });

  it('does not bump the settings schema version and leaves the privacy defaults alone', () => {
    const s = defaultSettings();
    expect(SETTINGS_SCHEMA_VERSION).toBe(3);
    expect(s.perception.visualMode).toBe('off');
    expect(s.perception.consentAt).toBeNull();
    expect(s.ai.allowCloud).toBe(false);
  });

  it('an older settings file (no companion, no sound categories) loads with the defaults and every other value kept', () => {
    const file = JSON.parse(JSON.stringify(defaultSettings())) as Record<string, Record<string, unknown>>;
    delete file.companion;
    delete file.sound!.cat;
    delete file.sound!.world;
    file.general!.catName = 'Pamuk';
    file.sound!.enabled = true;
    const s = migrateSettings(file);
    expect(s.companion).toEqual(defaultSettings().companion);
    expect(s.sound).toEqual({ enabled: true, volume: 0.4, cat: true, world: true });
    expect(s.general.catName).toBe('Pamuk');
  });
});

describe('companion patches', () => {
  it('accepts every personality and refuses anything else', () => {
    for (const id of [...PERSONALITY_IDS, 'auto'] as const) expect(patched(defaultSettings(), { companion: { personality: id } }).companion.personality).toBe(id);
    expect(applySettingsPatch(defaultSettings(), { companion: { personality: 'grumpy' } }).ok).toBe(false);
    expect(applySettingsPatch(defaultSettings(), { companion: { personality: 3 } }).ok).toBe(false);
  });

  it('merges one leaf of events or journal and keeps the others', () => {
    let s = patched(defaultSettings(), { companion: { events: { pace: 1.5 } } });
    expect(s.companion.events).toEqual({ enabled: true, rare: true, pace: 1.5, disabled: [] });
    s = patched(s, { companion: { events: { rare: false, disabled: ['tinyUfo'] } } });
    expect(s.companion.events).toEqual({ enabled: true, rare: false, pace: 1.5, disabled: ['tinyUfo'] });
    s = patched(s, { companion: { journal: { enabled: false }, reducedMotion: true } });
    expect(s.companion.journal.enabled).toBe(false);
    expect(s.companion.reducedMotion).toBe(true);
    expect(s.companion.events.pace).toBe(1.5);
  });

  it('refuses out-of-range pace, wrong types and unknown leaves (every patched leaf must survive unchanged)', () => {
    const cur = defaultSettings();
    expect(patched(cur, { companion: { events: { pace: EVENT_PACE_RANGE.min } } }).companion.events.pace).toBe(0.5);
    expect(patched(cur, { companion: { events: { pace: EVENT_PACE_RANGE.max } } }).companion.events.pace).toBe(2);
    for (const bad of [
      { events: { pace: 0.49 } },
      { events: { pace: 2.01 } },
      { events: { pace: '1' } },
      { events: { enabled: 'yes' } },
      { events: { rare: 1 } },
      { events: { nothing: true } },
      { events: 'off' },
      { journal: { enabled: 0 } },
      { journal: { other: true } },
      { reducedMotion: 'true' },
      { notALeaf: 1 },
    ]) {
      expect(applySettingsPatch(cur, { companion: bad }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(applySettingsPatch(cur, { sound: { cat: 'yes' } }).ok).toBe(false);
    expect(patched(cur, { sound: { cat: false, world: false } }).sound).toMatchObject({ cat: false, world: false });
  });

  it('the disabled list takes catalogue ids once each and refuses unknown ids and duplicates in a patch', () => {
    const cur = defaultSettings();
    expect(patched(cur, { companion: { events: { disabled: ['mouseEncounter', 'goldenButterfly'] } } }).companion.events.disabled).toEqual(['mouseEncounter', 'goldenButterfly']);
    expect(applySettingsPatch(cur, { companion: { events: { disabled: ['mouseEncounter', 'notAnEvent'] } } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { companion: { events: { disabled: ['tinyUfo', 'tinyUfo'] } } }).ok).toBe(false);
    expect(applySettingsPatch(cur, { companion: { events: { disabled: 'tinyUfo' } } }).ok).toBe(false);
    expect(patched(cur, { companion: { events: { disabled: [...ALL_EVENT_IDS] } } }).companion.events.disabled).toHaveLength(ALL_EVENT_IDS.length);
  });

  it('a patch to another section never touches the companion choices', () => {
    const cur = patched(defaultSettings(), { companion: { personality: 'shy', events: { disabled: ['tinyUfo'] } } });
    const next = patched(cur, { appearance: { size: 1.2 } });
    expect(next.companion).toEqual(cur.companion);
  });

  it('round-trips through JSON and migrateSettings unchanged', () => {
    const s = patched(defaultSettings(), {
      companion: { personality: 'mischievous', reducedMotion: true, events: { enabled: false, rare: false, pace: 0.5, disabled: ['thunderstorm', 'tinyDragon'] }, journal: { enabled: false } },
      sound: { enabled: true, cat: false },
    });
    expect(migrateSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('companion loading is tolerant', () => {
  const load = (companion: unknown): Settings => migrateSettings({ ...JSON.parse(JSON.stringify(defaultSettings())), companion });

  it('degrades field by field: a bad leaf falls back, its siblings survive', () => {
    const s = load({ personality: 'grumpy', reducedMotion: true, events: { enabled: false, pace: 99, rare: false }, journal: { enabled: 'maybe' } });
    expect(s.companion.personality).toBe('auto');
    expect(s.companion.reducedMotion).toBe(true);
    expect(s.companion.events).toEqual({ enabled: false, rare: false, pace: 1, disabled: [] });
    expect(s.companion.journal.enabled).toBe(true);
  });

  it('survives garbage sections', () => {
    for (const bad of ['x', 3, null, [], { events: 'x', journal: [] }]) expect(load(bad).companion).toEqual(defaultSettings().companion);
  });

  it('strips unknown and duplicate event ids on load, in order, and ignores a non-array', () => {
    expect(load({ events: { disabled: ['tinyUfo', 'futureEvent', 'tinyUfo', 7, null, 'windGust'] } }).companion.events.disabled).toEqual(['tinyUfo', 'windGust']);
    expect(load({ events: { disabled: 'tinyUfo' } }).companion.events.disabled).toEqual([]);
    expect(normalizeDisabledEvents(undefined)).toEqual([]);
    expect(normalizeDisabledEvents(Array.from({ length: 500 }, () => 'tinyUfo'))).toEqual(['tinyUfo']);
    expect(normalizeDisabledEvents([...ALL_EVENT_IDS, ...ALL_EVENT_IDS])).toHaveLength(ALL_EVENT_IDS.length);
  });
});
