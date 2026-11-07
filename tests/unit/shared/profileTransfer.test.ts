// GizeVerse character profile (1.4.0, src/shared/profileTransfer.ts): the portable file that moves
// one cat between devices. Pins the format rules (kind, major/minor, size cap, allow-listed keys),
// the exhaustive field policy, what never leaves the device, and the import semantics (copy, not
// sync; never weakens privacy; nothing half-applied).
import { describe, expect, it } from 'vitest';
import { defaultStats } from '../../../src/core/behavior/personality';
import * as coreText from '../../../src/core/perception/text';
import { PersistedCatSchema, type PersistedCat } from '../../../src/shared/catState';
import { IDENTITY } from '../../../src/shared/identity';
import {
  applyProfile,
  buildProfile,
  IMPORT_NEVER_ENABLES,
  MAX_PROFILE_BYTES,
  normalizeProfileName,
  parseProfile,
  parseProfileValue,
  prepareProfileExport,
  previewImport,
  PROFILE_CAT_POLICY,
  PROFILE_FIELD_POLICY,
  PROFILE_FORMAT,
  PROFILE_KIND,
  PROFILE_PARTS,
  PROFILE_SETTINGS_FIELDS,
  profileSettingsPatch,
  resolveProfileParts,
  serializeProfile,
  suggestedFileName,
  utf8ByteLength,
  type BuildProfileOptions,
  type GizeProfile,
  type ProfileParts,
} from '../../../src/shared/profileTransfer';
import { applySettingsPatch, defaultSettings, MAX_OPT_OUTS, rejectConsentBypass, rejectMainOwnedPatch, type Settings } from '../../../src/shared/settings';
import { PRESET_VALUES, presetPatch } from '../../../src/shared/settingsPresets';
import * as sharedText from '../../../src/shared/text';

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const OPTS: BuildProfileOptions = { includeMemory: false, app: { version: '1.4.0', host: 'win32' }, now: NOW };
const ALL: ProfileParts = { cat: true, appearance: true, preferences: true, memory: true };
const NONE: ProfileParts = { cat: false, appearance: false, preferences: false, memory: false };

/** Parsed file JSON (or a cat), edited freely: the parser under test treats it as untrusted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileJson = Record<string, any>;

function patched(cur: Settings, patch: unknown): Settings {
  const r = applySettingsPatch(cur, patch);
  if (!r.ok) throw new Error(r.error);
  return r.settings;
}

function makeCat(over: Record<string, unknown> = {}): PersistedCat {
  return PersistedCatSchema.parse({
    schemaVersion: 1,
    catId: 'cat-0123456789abcdef',
    bornAt: Date.UTC(2026, 0, 1),
    traits: { curiosity: 0.7, playfulness: 0.6, affection: 0.55, confidence: 0.4, energyLevel: 0.5, laziness: 0.3, startleSensitivity: 0.45 },
    stats: { energy: 0.9, boredom: 0.2, bond: 0.62, annoyance: 0.1, fear: 0.05 },
    memory: {
      counters: { pets: 12, sessions: 4, throws: 2 },
      preferences: { petRatePerHour: 3.5, cursorPlayAcceptance: 0.7, attentionAcceptance: 0.4, roughRatePerHour: 0.2 },
      favoriteSpots: [{ displayKey: 'display-1', xFrac: 0.3, kind: 'floor', score: 4, lastUsedAt: 1 }],
      recent: [{ at: 1, kind: 'pet', detail: 'head' }],
      lastSeenAt: 5,
      totalAwakeMs: 1000,
    },
    lastPosition: { displayKey: 'display-1', xFrac: 0.4, support: 'floor' },
    savedAt: 7,
    ...over,
  });
}

/** A file's JSON with `edit` applied, as text. */
function fileWith(edit: (json: FileJson) => void, opts: BuildProfileOptions = OPTS, settings = defaultSettings(), cat = makeCat()): string {
  const json = JSON.parse(serializeProfile(buildProfile(settings, cat, opts))) as FileJson;
  edit(json);
  return JSON.stringify(json);
}

function parsedOk(text: string): Extract<ReturnType<typeof parseProfile>, { ok: true }> {
  const r = parseProfile(text);
  if (!r.ok) throw new Error(`rejected: ${r.reason}`);
  return r;
}

describe('format and identity', () => {
  it('the kind tag is the frozen IDENTITY.profileKind and the format is 1.0', () => {
    expect(PROFILE_KIND).toBe(IDENTITY.profileKind);
    expect(PROFILE_KIND).toBe('gizeverse-character-profile');
    expect(PROFILE_FORMAT).toEqual({ major: 1, minor: 0 });
    const json = JSON.parse(serializeProfile(buildProfile(defaultSettings(), makeCat(), OPTS)));
    expect(json.kind).toBe(IDENTITY.profileKind);
    expect(json.format).toEqual({ major: 1, minor: 0 });
    expect(json.character).toBe('cat');
    expect(json.exportedAt).toBe(new Date(NOW).toISOString());
    expect(json.app).toEqual({ version: '1.4.0', host: 'win32' });
  });

  it('round-trips: build -> serialize -> parse gives the same profile, nothing skipped', () => {
    for (const includeMemory of [false, true]) {
      const settings = patched(defaultSettings(), { general: { catName: 'Pamuk' }, appearance: { skin: 'calico', size: 1.4 }, behavior: { autonomy: 0.8, disabledExtras: ['slips'] }, sound: { enabled: true } });
      const built = buildProfile(settings, makeCat(), { ...OPTS, includeMemory });
      const r = parsedOk(serializeProfile(built));
      expect(r.skipped).toEqual([]);
      expect(r.newerMinor).toBe(false);
      expect(r.profile).toEqual(built);
    }
  });

  it('memory travels only when asked for: 20 counters, 4 learned values and the bond', () => {
    const without = JSON.parse(serializeProfile(buildProfile(defaultSettings(), makeCat(), OPTS)));
    expect('memory' in without).toBe(false);
    const withMemory = JSON.parse(serializeProfile(buildProfile(defaultSettings(), makeCat(), { ...OPTS, includeMemory: true })));
    expect(Object.keys(withMemory.memory).sort()).toEqual(['bond', 'counters', 'learned']);
    expect(Object.keys(withMemory.memory.counters)).toHaveLength(20);
    expect(Object.keys(withMemory.memory.learned).sort()).toEqual(['attentionAcceptance', 'cursorPlayAcceptance', 'petRatePerHour', 'roughRatePerHour']);
    expect(withMemory.memory.bond).toBe(0.62);
    expect(withMemory.memory.counters.pets).toBe(12);
  });

  it('the file is small (a few KB) and pretty-printed with a trailing newline', () => {
    const text = serializeProfile(buildProfile(defaultSettings(), makeCat(), { ...OPTS, includeMemory: true }));
    expect(utf8ByteLength(text)).toBeLessThan(4096);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "kind": ');
  });
});

describe('what never leaves the device', () => {
  it('no secret, perception, AI, startup, path, display or memory-detail value appears in the file', () => {
    const settings = patched(defaultSettings(), {
      perception: { visualMode: 'local-stats', consentAt: '2026-01-01T00:00:00.000Z', excludedProcesses: ['SENTINEL.exe'], excludedTitlePatterns: ['SENTINEL title'] },
      ai: { provider: 'ollama', ollamaBaseUrl: 'http://SENTINEL:11434', ollamaModel: 'SENTINEL-model', openaiBaseUrl: 'https://SENTINEL.example/v1', openaiModel: 'SENTINEL', allowCloud: true },
      loginItem: { preference: 'enabled', registeredPath: 'C:\\Users\\SENTINEL\\DesktopCat.exe' },
      diagnostics: { logLevel: 'debug' },
      general: { startupState: 'hidden', showDockIcon: false, firstRunCompleted: true },
      appearance: { hideFromScreenCapture: true },
      behavior: { allowMultiMonitor: false },
      interaction: { enabled: false },
    });
    const cat = makeCat({
      memory: {
        favoriteSpots: [{ displayKey: 'SENTINEL-display', xFrac: 0.3, kind: 'window', score: 4, lastUsedAt: 1 }],
        recent: [{ at: 1, kind: 'SENTINEL', detail: 'SENTINEL detail' }],
      },
      lastPosition: { displayKey: 'SENTINEL-display', xFrac: 0.5, support: 'window' },
    });
    for (const includeMemory of [false, true]) {
      const text = serializeProfile(buildProfile(settings, cat, { ...OPTS, includeMemory }));
      expect(text).not.toContain('SENTINEL');
      const json = JSON.parse(text);
      for (const key of ['perception', 'ai', 'loginItem', 'diagnostics', 'general', 'schemaVersion', 'lastPosition', 'drives', 'stats']) expect(key in json).toBe(false);
      for (const key of ['consentAt', 'visualMode', 'registeredPath', 'toggleShortcut', 'shortcutsEnabled', 'startupState', 'rememberedState', 'firstRunCompleted', 'showDockIcon', 'allowMultiMonitor', 'hideFromScreenCapture', 'activityPreset', 'favoriteSpots', 'recent', 'displayKey', 'savedAt', 'lastSeenAt', 'totalAwakeMs']) {
        expect(text).not.toContain(`"${key}"`);
      }
      expect('enabled' in json.preferences.interaction).toBe(false);
      expect(json.preferences.sound.enabled).toBe(false);
    }
  });

  it('serializeProfile writes only allow-listed keys, whatever extra properties the object carries', () => {
    const p = buildProfile(defaultSettings(), makeCat(), OPTS) as GizeProfile & Record<string, unknown>;
    (p as Record<string, unknown>).secret = 'SENTINEL';
    (p.appearance as Record<string, unknown>).apiKey = 'SENTINEL';
    (p.cat as unknown as Record<string, unknown>).path = 'C:\\SENTINEL';
    (p.preferences.behavior as Record<string, unknown>).activityPreset = 'SENTINEL';
    expect(serializeProfile(p)).not.toContain('SENTINEL');
  });
});

describe('the field policy is exhaustive', () => {
  it('classifies every settings section and leaf of defaultSettings()', () => {
    const s = defaultSettings() as unknown as Record<string, unknown>;
    const policy = PROFILE_FIELD_POLICY as unknown as Record<string, unknown>;
    const sections = Object.keys(s).filter((k) => k !== 'schemaVersion');
    expect(Object.keys(policy).sort()).toEqual(sections.sort());
    for (const section of sections) {
      const entry = policy[section];
      if (entry === 'never') continue;
      expect(Object.keys(entry as object).sort()).toEqual(Object.keys(s[section] as object).sort());
    }
  });

  it('never: login item, perception, AI and diagnostics; device: shortcuts, startup, Dock icon, multi-monitor, click-through, capture hiding', () => {
    const entries = Object.entries(PROFILE_FIELD_POLICY as unknown as Record<string, unknown>);
    expect(entries.filter(([, v]) => v === 'never').map(([k]) => k).sort()).toEqual(['ai', 'diagnostics', 'loginItem', 'perception']);
    const leaves = (cls: string): string[] =>
      entries.flatMap(([section, v]) => (v === 'never' ? [] : Object.entries(v as Record<string, string>).filter(([, c]) => c === cls).map(([k]) => `${section}.${k}`))).sort();
    expect(leaves('device')).toEqual(
      ['appearance.hideFromScreenCapture', 'behavior.allowMultiMonitor', 'general.firstRunCompleted', 'general.rememberedState', 'general.shortcutsEnabled', 'general.showDockIcon', 'general.startupState', 'general.toggleShortcut', 'interaction.enabled'].sort(),
    );
    expect(leaves('cat')).toEqual(['general.catName']);
    expect(leaves('derived')).toEqual(['behavior.activityPreset']);
    expect(PROFILE_SETTINGS_FIELDS.appearance).toHaveLength(7);
    expect(PROFILE_SETTINGS_FIELDS.behavior).toHaveLength(17);
    expect(PROFILE_SETTINGS_FIELDS.interaction).toHaveLength(5);
    expect(PROFILE_SETTINGS_FIELDS.sound).toEqual(['enabled', 'volume']);
    expect(leaves('carry')).toHaveLength(7 + 17 + 5 + 2);
  });

  it('the cat policy classifies every persisted cat field: identity and traits travel, memory only as memory', () => {
    const cat = makeCat() as unknown as FileJson;
    const policy = PROFILE_CAT_POLICY as unknown as FileJson;
    expect(Object.keys(policy).sort()).toEqual(Object.keys(cat).sort());
    expect(Object.keys(policy.traits).sort()).toEqual(Object.keys(cat.traits).sort());
    expect(Object.keys(policy.stats).sort()).toEqual(Object.keys(cat.stats).sort());
    expect(Object.keys(policy.memory).sort()).toEqual(Object.keys(cat.memory).sort());
    expect(Object.keys(policy.memory.counters).sort()).toEqual(Object.keys(cat.memory.counters).sort());
    expect(Object.keys(policy.memory.preferences).sort()).toEqual(Object.keys(cat.memory.preferences).sort());
    for (const k of ['schemaVersion', 'drives', 'lastPosition', 'savedAt']) expect(policy[k]).toBe('never');
    for (const k of ['favoriteSpots', 'recent', 'lastSeenAt', 'totalAwakeMs']) expect(policy.memory[k]).toBe('never');
    expect(Object.entries(policy.stats).filter(([, v]) => v === 'memory').map(([k]) => k)).toEqual(['bond']);
  });
});

describe('parsing: versions, envelope and limits', () => {
  it('refuses a newer MAJOR format outright (never best-effort), whatever the rest says', () => {
    const text = fileWith((j) => {
      j.format = { major: 2, minor: 0 };
      j.character = 'dog';
      j.cat = 'garbage';
    });
    expect(parseProfile(text)).toEqual({ ok: false, reason: 'newer-format', formatMajor: 2 });
  });

  it('accepts a newer MINOR format and drops the fields it does not know', () => {
    const text = fileWith((j) => {
      j.format = { major: 1, minor: 7 };
      j.future = { anything: true };
      j.appearance.glow = 'neon';
      j.cat.mood = 'sunny';
      j.preferences.behavior.flying = 1;
      j.preferences.extra = {};
    });
    const r = parsedOk(text);
    expect(r.newerMinor).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.profile.format).toEqual({ major: 1, minor: 7 });
    expect('future' in r.profile).toBe(false);
    expect('glow' in r.profile.appearance).toBe(false);
    expect('mood' in r.profile.cat).toBe(false);
    expect('flying' in r.profile.preferences.behavior).toBe(false);
    expect(previewImport(r.profile, defaultSettings(), makeCat(), r).format.newerMinor).toBe(true);
    // Re-serializing writes this build's format.
    expect(JSON.parse(serializeProfile(r.profile)).format).toEqual(PROFILE_FORMAT);
  });

  it('rejects other files with a reason code', () => {
    expect(parseProfile('not json at all')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseProfile('')).toEqual({ ok: false, reason: 'not-json' });
    expect(parseProfile('[]')).toEqual({ ok: false, reason: 'not-a-profile' });
    expect(parseProfile('null')).toEqual({ ok: false, reason: 'not-a-profile' });
    expect(parseProfile('{"kind":"desktop-cat-diagnostics"}')).toEqual({ ok: false, reason: 'not-a-profile' });
    expect(parseProfile(fileWith((j) => (j.kind = 'something-else')))).toEqual({ ok: false, reason: 'not-a-profile' });
    expect(parseProfile(fileWith((j) => delete j.format))).toEqual({ ok: false, reason: 'unsupported-format' });
    expect(parseProfile(fileWith((j) => (j.format = { major: 1.5, minor: 0 })))).toEqual({ ok: false, reason: 'unsupported-format' });
    expect(parseProfile(fileWith((j) => (j.format = { major: 0, minor: 9 })))).toEqual({ ok: false, reason: 'unsupported-format', formatMajor: 0 });
    expect(parseProfile(fileWith((j) => (j.character = 'dog')))).toEqual({ ok: false, reason: 'other-character' });
    expect(parseProfile(fileWith((j) => delete j.cat))).toEqual({ ok: false, reason: 'invalid' });
    expect(parseProfileValue('a string')).toEqual({ ok: false, reason: 'not-a-profile' });
  });

  it('caps the size in UTF-8 bytes (64 KiB) before parsing, and accepts a BOM', () => {
    const text = serializeProfile(buildProfile(defaultSettings(), makeCat(), OPTS));
    const atCap = text + ' '.repeat(MAX_PROFILE_BYTES - utf8ByteLength(text));
    expect(utf8ByteLength(atCap)).toBe(MAX_PROFILE_BYTES);
    expect(parseProfile(atCap).ok).toBe(true);
    expect(parseProfile(`${atCap} `)).toEqual({ ok: false, reason: 'too-large' });
    // Fewer UTF-16 units than the cap, more bytes than the cap.
    const wide = '"' + 'é'.repeat(MAX_PROFILE_BYTES / 2) + '"';
    expect(wide.length).toBeLessThan(MAX_PROFILE_BYTES + 3);
    expect(parseProfile(wide)).toEqual({ ok: false, reason: 'too-large' });
    expect(parseProfile(`\uFEFF${text}`).ok).toBe(true);
  });

  it('utf8ByteLength counts like an encoder', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('\u{1F431}')).toBe(4);
    expect(utf8ByteLength('\uD800')).toBe(3);
    expect(utf8ByteLength('Miso şifre')).toBe(new TextEncoder().encode('Miso şifre').length);
  });

  it('ignores __proto__ and every other unlisted key, without touching prototypes', () => {
    const text = fileWith((j) => {
      j.appearance = JSON.parse('{"skin":"black","__proto__":{"polluted":true},"constructor":{"x":1}}');
    }).replace('"kind"', '"__proto__":{"polluted":true},"kind"');
    const r = parsedOk(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.profile)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(r.profile.appearance)).toBe(Object.prototype);
    expect(Object.hasOwn(r.profile.appearance, '__proto__')).toBe(false);
    expect(Object.hasOwn(r.profile.appearance, 'constructor')).toBe(false);
    expect(r.profile.appearance.skin).toBe('black');
  });

  it('never throws on a deeply nested value inside the cap', () => {
    const depth = 20_000;
    const text = fileWith((j) => (j.appearance.skin = 'DEEP')).replace('"DEEP"', '['.repeat(depth) + ']'.repeat(depth));
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(MAX_PROFILE_BYTES);
    const run = (): ReturnType<typeof parseProfile> => parseProfile(text);
    expect(run).not.toThrow();
    const r = run();
    if (r.ok) expect(r.skipped).toEqual(['appearance.skin']);
    else expect(r.reason).toBe('not-json');
  });

  it('metadata is kept only when well-formed', () => {
    const r = parsedOk(fileWith((j) => {
      j.exportedAt = 'next tuesday';
      j.app = { version: '<b>1.4</b>', host: 'amiga' };
    }));
    expect(r.profile.exportedAt).toBeNull();
    expect(r.profile.app).toEqual({ version: null, host: null });
    expect(r.skipped).toEqual([]);
  });
});

describe('parsing: per-leaf validation (skipped, never defaulted)', () => {
  it('an unknown skin or an out-of-range value is skipped; the local value stays', () => {
    const r = parsedOk(fileWith((j) => {
      j.appearance.skin = 'rainbow';
      j.preferences.behavior.autonomy = 5;
      j.preferences.interaction.patience = 'high';
      j.preferences.sound.volume = null;
    }));
    expect(r.skipped.sort()).toEqual(['appearance.skin', 'preferences.behavior.autonomy', 'preferences.interaction.patience', 'preferences.sound.volume'].sort());
    expect('skin' in r.profile.appearance).toBe(false);
    const local = patched(defaultSettings(), { appearance: { skin: 'tuxedo' }, behavior: { autonomy: 0.3 } });
    const applied = applyProfile(r.profile, ALL, local, makeCat(), { now: NOW });
    if (!applied.ok) throw new Error(applied.reason);
    expect(applied.settings.appearance.skin).toBe('tuxedo');
    expect(applied.settings.behavior.autonomy).toBe(0.3);
    expect(previewImport(r.profile, local, makeCat(), r).skipped).toHaveLength(4);
  });

  it('a section that is not an object is skipped as a whole', () => {
    const r = parsedOk(fileWith((j) => {
      j.appearance = 'pretty';
      j.preferences = [1, 2];
      j.memory = 7;
    }));
    expect(r.skipped.sort()).toEqual(['appearance', 'memory', 'preferences']);
    expect(r.profile.appearance).toEqual({});
    expect(r.profile.memory).toBeNull();
  });

  it('skipped paths come from the allow-lists only, never from file content', () => {
    const r = parsedOk(fileWith((j) => {
      j.appearance['<script>'] = 1;
      j.appearance.size = 'SENTINEL';
    }));
    expect(r.skipped).toEqual(['appearance.size']);
    expect(JSON.stringify(r.skipped)).not.toContain('script');
  });

  it('opt-out lists: unknown ids leave the strict list, the tolerant list keeps well-formed unknown ids', () => {
    const r = parsedOk(fileWith((j) => {
      j.preferences.behavior.disabledBehaviors = ['zoomies', 'futureBehavior', 'zoomies', 42];
      j.preferences.behavior.disabledExtras = ['slips', 'futureExtra', 'Bad Id', 'slips'];
    }));
    expect(r.profile.preferences.behavior.disabledBehaviors).toEqual(['zoomies']);
    expect(r.profile.preferences.behavior.disabledExtras).toEqual(['slips', 'futureExtra']);
    expect(r.skipped).toEqual([]);
  });

  it('the cat section is all-or-nothing', () => {
    const bad: Array<(j: FileJson) => void> = [
      (j) => delete j.cat.traits.laziness,
      (j) => (j.cat.traits.curiosity = 1.5),
      (j) => (j.cat.traits.curiosity = '0.5'),
      (j) => (j.cat.catId = 'x'),
      (j) => (j.cat.catId = 'cat_with_underscore'),
      (j) => (j.cat.catId = 'cat-0123/../../etc'),
      (j) => (j.cat.bornAt = -1),
      (j) => (j.cat.bornAt = '2026'),
      (j) => (j.cat.name = '\u200B\u202E '),
      (j) => (j.cat.name = 'A'.repeat(25)),
      (j) => (j.cat.name = 42),
      (j) => (j.cat = []),
    ];
    for (const edit of bad) expect(parseProfile(fileWith(edit))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('names lose invisible and bidi characters and collapse whitespace', () => {
    const r = parsedOk(fileWith((j) => (j.cat.name = '  Mi\u202Eso \t\n Kedi\u200B ')));
    expect(r.profile.cat.name).toBe('Mi so Kedi');
    expect(normalizeProfileName('\u2066x\u2069')).toBe('x');
    expect(normalizeProfileName('   ')).toBeNull();
    expect(normalizeProfileName('Ç'.repeat(24))).toBe('Ç'.repeat(24));
  });

  it('memory values are validated one by one', () => {
    const r = parsedOk(fileWith((j) => {
      j.memory.counters.pets = -3;
      j.memory.counters.naps = 2.5;
      j.memory.counters.unknownCounter = 9;
      j.memory.learned.cursorPlayAcceptance = 2;
      j.memory.bond = 'max';
    }, { ...OPTS, includeMemory: true }));
    expect(r.skipped.sort()).toEqual(['memory.bond', 'memory.counters.naps', 'memory.counters.pets', 'memory.learned.cursorPlayAcceptance']);
    expect(r.profile.memory?.counters.sessions).toBe(4);
    expect(r.profile.memory?.bond).toBeUndefined();
    expect('unknownCounter' in (r.profile.memory?.counters ?? {})).toBe(false);
  });
});

describe('import never weakens privacy', () => {
  it('tab-strip opt-outs that are off here stay off, and the preview says so', () => {
    const local = patched(defaultSettings(), { behavior: { disabledBehaviors: ['tabStrips'], disabledExtras: ['explorerTabs', 'terminalTabs'] } });
    const profile = buildProfile(defaultSettings(), makeCat(), OPTS); // both lists empty in the file
    const preview = previewImport(profile, local, makeCat());
    expect(preview.keptOff).toEqual(['tabStrips', 'explorerTabs', 'terminalTabs']);
    const r = applyProfile(profile, ALL, local, makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.behavior.disabledBehaviors).toContain('tabStrips');
    expect(r.settings.behavior.disabledExtras).toEqual(expect.arrayContaining(['explorerTabs', 'terminalTabs']));
    expect(r.keptOff).toEqual(['tabStrips', 'explorerTabs', 'terminalTabs']);
    expect(IMPORT_NEVER_ENABLES).toEqual({ disabledBehaviors: ['tabStrips'], disabledExtras: ['explorerTabs', 'terminalTabs'] });
  });

  it('an import can still switch them off', () => {
    const fromDevice = patched(defaultSettings(), { behavior: { disabledBehaviors: ['tabStrips'], disabledExtras: ['terminalTabs'] } });
    const profile = buildProfile(fromDevice, makeCat(), OPTS);
    const r = applyProfile(profile, { ...NONE, preferences: true }, defaultSettings(), makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.behavior.disabledBehaviors).toEqual(['tabStrips']);
    expect(r.settings.behavior.disabledExtras).toEqual(['terminalTabs']);
    expect(r.keptOff).toEqual([]);
  });

  it('kept-off ids survive a full tolerant list (they go first, the cap drops incoming ids)', () => {
    const local = patched(defaultSettings(), { behavior: { disabledExtras: ['explorerTabs'] } });
    const many = Array.from({ length: MAX_OPT_OUTS }, (_, i) => `future${String(i)}`);
    const r0 = parsedOk(fileWith((j) => (j.preferences.behavior.disabledExtras = many)));
    const r = applyProfile(r0.profile, { ...NONE, preferences: true }, local, makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.behavior.disabledExtras[0]).toBe('explorerTabs');
    expect(r.settings.behavior.disabledExtras).toHaveLength(MAX_OPT_OUTS);
  });

  it('the patch touches only general.catName and carried sections: never perception, AI, login item, diagnostics or the preset name', () => {
    const local = patched(defaultSettings(), {
      perception: { visualMode: 'local-stats', consentAt: '2026-01-01T00:00:00.000Z', paused: true },
      ai: { provider: 'ollama', ollamaModel: 'local-model' },
      loginItem: { preference: 'disabled', decidedBy: 'user', disabledBy: 'user' },
      diagnostics: { logLevel: 'warn', hardwareAcceleration: false },
    });
    const source = patched(defaultSettings(), { general: { catName: 'Boncuk' }, appearance: { skin: 'gray' }, sound: { enabled: true, volume: 0.9 }, ...presetPatch('calm') });
    const profile = buildProfile(source, makeCat({ catId: 'cat-fedcba9876543210' }), { ...OPTS, includeMemory: true });
    const patch = profileSettingsPatch(profile, ALL, local);
    expect(Object.keys(patch).sort()).toEqual(['appearance', 'behavior', 'general', 'interaction', 'sound']);
    expect(patch.general).toEqual({ catName: 'Boncuk' });
    expect('activityPreset' in (patch.behavior ?? {})).toBe(false);
    expect(rejectConsentBypass(patch)).toBeNull();
    expect(rejectMainOwnedPatch(patch)).toBeNull();
    const r = applyProfile(profile, ALL, local, makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.perception).toEqual(local.perception);
    expect(r.settings.ai).toEqual(local.ai);
    expect(r.settings.loginItem).toEqual(local.loginItem);
    expect(r.settings.diagnostics).toEqual(local.diagnostics);
    // The preset name is re-derived from the imported values.
    expect(r.settings.behavior.activityPreset).toBe('calm');
    expect(r.settings.behavior.autonomy).toBe(PRESET_VALUES.calm.behavior.autonomy);
  });

  it('device-only settings stay as they are on this device', () => {
    const local = patched(defaultSettings(), {
      general: { startupState: 'hidden', showDockIcon: false, shortcutsEnabled: false, firstRunCompleted: true },
      appearance: { hideFromScreenCapture: true },
      behavior: { allowMultiMonitor: false },
      interaction: { enabled: false },
    });
    const r = applyProfile(buildProfile(defaultSettings(), makeCat(), OPTS), ALL, local, makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.settings.general).toEqual(local.general);
    expect(r.settings.appearance.hideFromScreenCapture).toBe(true);
    expect(r.settings.behavior.allowMultiMonitor).toBe(false);
    expect(r.settings.interaction.enabled).toBe(false);
  });
});

describe('applying: a copy, not a sync', () => {
  const other = (): GizeProfile => buildProfile(patched(defaultSettings(), { general: { catName: 'Tarçın' } }), makeCat({ catId: 'cat-fedcba9876543210', bornAt: Date.UTC(2025, 5, 1) }), { ...OPTS, includeMemory: true });

  it('a different catId adopts another cat: stats and drives reset, memory cleared (sessions = 1), lastPosition stays', () => {
    const local = makeCat();
    const r = applyProfile(other(), { ...NONE, cat: true }, defaultSettings(), local, { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.catReplaced).toBe(true);
    expect(r.catChanged).toBe(true);
    expect(r.catState.catId).toBe('cat-fedcba9876543210');
    expect(r.catState.bornAt).toBe(Date.UTC(2025, 5, 1));
    expect(r.catState.stats).toEqual(defaultStats());
    expect(r.catState.drives).toEqual(PersistedCatSchema.parse({ schemaVersion: 1, catId: 'cat-00000000', bornAt: 0 }).drives);
    expect(r.catState.memory.counters.sessions).toBe(1);
    expect(r.catState.memory.counters.pets).toBe(0);
    expect(r.catState.memory.favoriteSpots).toEqual([]);
    expect(r.catState.memory.recent).toEqual([]);
    expect(r.catState.memory.lastSeenAt).toBe(NOW);
    expect(r.catState.lastPosition).toEqual(local.lastPosition);
    expect(r.catState.savedAt).toBe(NOW);
    expect(r.settings.general.catName).toBe('Tarçın');
    // The input objects are untouched.
    expect(local).toEqual(makeCat());
  });

  it('memory of another cat loads only together with the cat itself', () => {
    const p = other();
    expect(resolveProfileParts({ memory: true }, p, makeCat().catId).memory).toBe(false);
    expect(applyProfile(p, { ...NONE, memory: true }, defaultSettings(), makeCat(), { now: NOW })).toEqual({ ok: false, reason: 'nothing-selected' });
    const preview = previewImport(p, defaultSettings(), makeCat());
    expect(preview.sameCat).toBe(false);
    expect(preview.memoryNeedsCat).toBe(true);
    const both = applyProfile(p, { ...NONE, cat: true, memory: true }, defaultSettings(), makeCat(), { now: NOW });
    if (!both.ok) throw new Error(both.reason);
    expect(both.catState.memory.counters.pets).toBe(12);
    expect(both.catState.memory.counters.sessions).toBe(4);
    expect(both.catState.stats.bond).toBe(0.62);
  });

  it('the same catId updates traits and keeps local memory unless memory is ticked', () => {
    const local = makeCat({ memory: { counters: { pets: 99, sessions: 50 } } });
    const p = buildProfile(defaultSettings(), makeCat({ traits: { curiosity: 0.2, playfulness: 0.6, affection: 0.55, confidence: 0.4, energyLevel: 0.5, laziness: 0.3, startleSensitivity: 0.45 } }), { ...OPTS, includeMemory: true });
    const r = applyProfile(p, { ...NONE, cat: true }, defaultSettings(), local, { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.catReplaced).toBe(false);
    expect(r.catState.traits.curiosity).toBe(0.2);
    expect(r.catState.memory.counters.pets).toBe(99);
    expect(r.catState.stats).toEqual(local.stats);
  });

  it('counters are replaced, never added: applying twice gives the same result', () => {
    const local = makeCat({ memory: { counters: { pets: 10 } } });
    const p = buildProfile(defaultSettings(), makeCat({ memory: { counters: { pets: 7 } } }), { ...OPTS, includeMemory: true });
    const once = applyProfile(p, { ...NONE, memory: true }, defaultSettings(), local, { now: NOW });
    if (!once.ok) throw new Error(once.reason);
    expect(once.catState.memory.counters.pets).toBe(7);
    const twice = applyProfile(p, { ...NONE, memory: true }, once.settings, once.catState, { now: NOW });
    if (!twice.ok) throw new Error(twice.reason);
    expect(twice.catState.memory.counters.pets).toBe(7);
  });

  it('bornAt is capped at this device\'s clock', () => {
    const p = parsedOk(fileWith((j) => (j.cat.bornAt = NOW + 86_400_000))).profile;
    const r = applyProfile(p, { ...NONE, cat: true }, defaultSettings(), makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.catState.bornAt).toBe(NOW);
  });

  it('nothing selected, or nothing available, changes nothing', () => {
    const p = buildProfile(defaultSettings(), makeCat(), OPTS);
    expect(applyProfile(p, NONE, defaultSettings(), makeCat(), { now: NOW })).toEqual({ ok: false, reason: 'nothing-selected' });
    expect(applyProfile(p, { ...NONE, memory: true }, defaultSettings(), makeCat(), { now: NOW })).toEqual({ ok: false, reason: 'nothing-selected' });
  });

  it('appearance alone leaves the cat state unchanged', () => {
    const p = buildProfile(patched(defaultSettings(), { appearance: { skin: 'siamese', style: 'pixel' } }), makeCat({ catId: 'cat-fedcba9876543210' }), OPTS);
    const r = applyProfile(p, { ...NONE, appearance: true }, defaultSettings(), makeCat(), { now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.catChanged).toBe(false);
    expect(r.catState.catId).toBe(makeCat().catId);
    expect(r.patch).toEqual({ appearance: { skin: 'siamese', style: 'pixel' } });
    expect(r.settings.appearance.skin).toBe('siamese');
  });
});

describe('preview', () => {
  it('lists what would change per part, as plain data', () => {
    const local = patched(defaultSettings(), { general: { catName: 'Miso' } });
    const source = patched(defaultSettings(), { general: { catName: 'Duman' }, appearance: { skin: 'gray' }, behavior: { mischief: 0.9 } });
    const p = buildProfile(source, makeCat({ catId: 'cat-fedcba9876543210' }), { ...OPTS, includeMemory: true });
    const preview = previewImport(p, local, makeCat());
    expect(preview.incoming).toEqual({ name: 'Duman', skin: 'gray', bornAt: makeCat().bornAt });
    expect(preview.current).toEqual({ name: 'Miso', skin: 'ginger' });
    expect(preview.fromVersion).toBe('1.4.0');
    expect(preview.fromHost).toBe('win32');
    expect(preview.changes).toEqual(
      expect.arrayContaining([
        { part: 'cat', target: 'settings', field: 'general.catName', from: 'Miso', to: 'Duman' },
        { part: 'cat', target: 'cat', field: 'catId', from: 'cat-0123456789abcdef', to: 'cat-fedcba9876543210' },
        { part: 'appearance', target: 'settings', field: 'appearance.skin', from: 'ginger', to: 'gray' },
        { part: 'preferences', target: 'settings', field: 'behavior.mischief', from: defaultSettings().behavior.mischief, to: 0.9 },
      ]),
    );
    expect(preview.parts.cat.changes).toBe(2);
    expect(preview.parts.appearance).toEqual({ available: true, changes: 1 });
    expect(preview.parts.memory.available).toBe(true);
    expect(preview.changes.some((c) => c.field === 'behavior.activityPreset')).toBe(false);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    expect(structuredClone(preview)).toEqual(preview);
  });

  it('the parts are the four the user can choose', () => {
    expect(PROFILE_PARTS).toEqual(['cat', 'appearance', 'preferences', 'memory']);
  });
});

describe('export helpers', () => {
  it('prepareProfileExport self-checks the text and names the file', () => {
    const r = prepareProfileExport(patched(defaultSettings(), { general: { catName: 'Miso' } }), makeCat(), OPTS);
    if (!r.ok) throw new Error(r.reason);
    expect(parseProfile(r.text).ok).toBe(true);
    expect(r.fileName).toMatch(/^gizecat-miso-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('refuses to produce a file this build could not load (a catId outside the pattern)', () => {
    const r = prepareProfileExport(defaultSettings(), makeCat({ catId: 'cat with spaces' }), OPTS);
    expect(r).toEqual({ ok: false, reason: 'invalid', skipped: [] });
  });

  it('suggestedFileName: a safe slug of the name and the local export date', () => {
    const d = new Date(NOW);
    const date = `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const at = new Date(NOW).toISOString();
    const cat = buildProfile(defaultSettings(), makeCat(), OPTS).cat;
    expect(suggestedFileName({ cat: { ...cat, name: 'Miso' }, exportedAt: at })).toBe(`gizecat-miso-${date}.json`);
    expect(suggestedFileName({ cat: { ...cat, name: 'Ünal Kedi!' }, exportedAt: at })).toBe(`gizecat-ünal-kedi-${date}.json`);
    expect(suggestedFileName({ cat: { ...cat, name: '../../CON' }, exportedAt: at })).toBe(`gizecat-con-${date}.json`);
    expect(suggestedFileName({ cat: { ...cat, name: '***' }, exportedAt: at })).toBe(`gizecat-cat-${date}.json`);
    expect(suggestedFileName({ cat: { ...cat, name: 'Miso' }, exportedAt: null })).toBe('gizecat-miso.json');
  });

  it('a name that cleans to nothing exports as the default name', () => {
    const settings = defaultSettings();
    settings.general.catName = '\u200B';
    expect(buildProfile(settings, makeCat(), OPTS).cat.name).toBe(defaultSettings().general.catName);
  });
});

describe('shared text helpers', () => {
  it('src/core/perception/text re-exports the shared implementation', () => {
    expect(coreText.replaceInvisible).toBe(sharedText.replaceInvisible);
    expect(coreText.hasInvisibleOrSpace).toBe(sharedText.hasInvisibleOrSpace);
    expect(coreText.isInvisibleCodePoint).toBe(sharedText.isInvisibleCodePoint);
    expect(sharedText.replaceInvisible('a\u202Eb')).toBe('a b');
  });
});
