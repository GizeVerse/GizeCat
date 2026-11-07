// GizeVerse character profile (1.4.0): the portable, versioned file that moves one cat between
// devices (Windows, macOS, the web host on an iPad or in the Android app). It is a copy, not a sync:
// no account, no server, no network; the user saves the file and picks it on the other device.
//
// Pure and platform-agnostic: no file, dialog, clock or storage access here; hosts read and write
// the text and inject the time. Public API:
//   buildProfile(settings, cat, opts)            -> GizeProfile (what this device would export)
//   serializeProfile(profile)                    -> the file text (UTF-8 JSON, ~2-3 KB)
//   prepareProfileExport(settings, cat, opts)    -> build + serialize + self-check + file name
//   parseProfile(text) / parseProfileValue(raw)  -> { ok, profile, skipped } | { ok: false, reason }
//   previewImport(profile, settings, cat, notes) -> what an import would change (plain data)
//   applyProfile(profile, parts, settings, cat)  -> { settings, catState, patch, ... } (in memory)
//   suggestedFileName(profile)                   -> 'gizecat-<name>-<YYYY-MM-DD>.json'
//
// Bundle size: this module runs zod at load (through settings.ts and catState.ts). Renderers that
// must stay small (the desktop settings window, the preloads) import TYPES only and let main build,
// parse, preview and apply; every result here is plain, structured-clone-safe data for IPC. The web
// host already bundles zod (settings.ts) and may call these functions directly.
//
// Privacy (docs/PRIVACY.md): the file never holds API keys (they are not in settings at all), the
// perception, ai, loginItem or diagnostics sections, window titles, display ids, positions or
// machine paths. Only allow-listed fields travel (PROFILE_FIELD_POLICY, PROFILE_CAT_POLICY, both
// exhaustive at compile time); learned memory only when the user asks for it; an import never
// switches tab-strip reading back on (IMPORT_NEVER_ENABLES) and never touches consent.
import { z } from 'zod';
import type { SkinId } from './cat';
import {
  CountersSchema,
  DrivesSchema,
  MemorySchema,
  PersistedCatSchema,
  PreferencesSchema,
  StatsSchema,
  TraitsSchema,
  type Counters,
  type Memory,
  type PersistedCat,
  type Preferences,
  type Stats,
  type Traits,
} from './catState';
import type { CharacterDescriptor } from './character';
import { IDENTITY } from './identity';
import { PLATFORM_IDS, type PlatformId } from './platform';
import {
  applySettingsPatch,
  defaultSettings,
  normalizeOptOutList,
  TOGGLEABLE_BEHAVIORS,
  type BehaviorId,
  type LivelyBehavior,
  type Settings,
  type SettingsPatch,
  type ToggleableBehavior,
} from './settings';
import { replaceInvisible } from './text';

// ---------------------------------------------------------------------------------------------
// Format constants

/** The file's `kind` tag (frozen: files on users' disks match on it). */
export const PROFILE_KIND = IDENTITY.profileKind;
/**
 * The format this build writes. A new optional field bumps `minor` (older readers drop it); any
 * change an older reader would misread bumps `major`, and older readers then refuse the file.
 */
export const PROFILE_FORMAT: Readonly<{ major: 1; minor: 0 }> = Object.freeze({ major: 1, minor: 0 });
/** The character a profile describes (CharacterDescriptor.kind; the first persisted kind). */
export const PROFILE_CHARACTER: CharacterDescriptor['kind'] = 'cat';
/** Hard cap on a profile file: hosts check the file size before reading, parseProfile checks again. */
export const MAX_PROFILE_BYTES = 65536;
export const PROFILE_MIME = 'application/json';
export const PROFILE_FILE_EXTENSION = 'json';
/** Prefix of suggested file names (display text, not an identifier). */
export const PROFILE_FILE_PREFIX = 'gizecat';
/** Same limit as settings.general.catName (UTF-16 code units). */
export const PROFILE_NAME_MAX_LENGTH = 24;
/** catIds the import accepts ('cat-' + 16 hex digits today); the cat schema allows 8..64 chars. */
export const PROFILE_CAT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** The parts a user can choose to load. */
export const PROFILE_PARTS = ['cat', 'appearance', 'preferences', 'memory'] as const;
export type ProfilePart = (typeof PROFILE_PARTS)[number];
export type ProfileParts = Readonly<Record<ProfilePart, boolean>>;

// ---------------------------------------------------------------------------------------------
// Field policy: every settings leaf is classified, or the build fails

/**
 * carry: travels in the file and is applied on import. cat: travels in the profile's cat section
 * (the name). device: stays on each device. derived: re-computed on import (activityPreset).
 */
export type ProfileFieldClass = 'carry' | 'cat' | 'device' | 'derived';
type SettingsSection = Exclude<keyof Settings, 'schemaVersion'>;
type SettingsPolicyShape = {
  readonly [S in SettingsSection]: 'never' | { readonly [K in keyof Settings[S]]-?: ProfileFieldClass };
};

/**
 * Exhaustive over Settings (the same trick as src/renderer/settings/catalog.ts): a settings section
 * or field added later fails to type-check until someone classifies it here. A new 'carry' field
 * is a new optional profile field, so it also bumps PROFILE_FORMAT.minor.
 */
export const PROFILE_FIELD_POLICY = {
  general: {
    catName: 'cat',
    shortcutsEnabled: 'device',
    toggleShortcut: 'device',
    firstRunCompleted: 'device',
    startupState: 'device',
    rememberedState: 'device',
    /** macOS Dock icon: a per-device shell choice. */
    showDockIcon: 'device',
  },
  /** Startup entry and a machine path: main-owned, never carried. */
  loginItem: 'never',
  appearance: {
    skin: 'carry',
    style: 'carry',
    size: 'carry',
    opacity: 'carry',
    animationSpeed: 'carry',
    shadow: 'carry',
    emotes: 'carry',
    hideFromScreenCapture: 'device',
  },
  behavior: {
    movementSpeed: 'carry',
    autonomy: 'carry',
    cursorPlay: 'carry',
    attentionSeeking: 'carry',
    activitySensitivity: 'carry',
    sleepAfterIdleMinutes: 'carry',
    /** Multi-monitor roaming depends on this device's displays. */
    allowMultiMonitor: 'device',
    reactToTyping: 'carry',
    reactToWindows: 'carry',
    fullscreenBehavior: 'carry',
    disabledBehaviors: 'carry',
    chaseDurationSec: 'carry',
    /** Re-derived from the governed values by applySettingsPatch. */
    activityPreset: 'derived',
    exploration: 'carry',
    heights: 'carry',
    mischief: 'carry',
    workDisruption: 'carry',
    stayLength: 'carry',
    disabledExtras: 'carry',
  },
  interaction: {
    /** Fully click-through: a per-device accessibility/safety choice. */
    enabled: 'device',
    petting: 'carry',
    dragging: 'carry',
    throwing: 'carry',
    patience: 'carry',
    reactionIntensity: 'carry',
  },
  /** Consent, capture settings and exclusion lists: never leave the device. */
  perception: 'never',
  /** Provider, endpoints, models, cloud permission (API keys are not in settings at all). */
  ai: 'never',
  sound: { enabled: 'carry', volume: 'carry' },
  diagnostics: 'never',
} as const satisfies SettingsPolicyShape;

type Policy = typeof PROFILE_FIELD_POLICY;
type ObjectSection = { [S in SettingsSection]: Policy[S] extends 'never' ? never : S }[SettingsSection];
type KeysOfClass<S extends ObjectSection, C extends ProfileFieldClass> = {
  [K in keyof Policy[S]]: Policy[S][K] extends C ? K : never;
}[keyof Policy[S]] &
  keyof Settings[S];
type SectionsWithClass<C extends ProfileFieldClass> = { [S in ObjectSection]: [KeysOfClass<S, C>] extends [never] ? never : S }[ObjectSection];
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Settings sections with carried fields. */
export type CarriedSection = SectionsWithClass<'carry'>;
export type CarriedKey<S extends CarriedSection> = KeysOfClass<S, 'carry'>;

// Compile-time pins: the file layout below groups exactly these sections (appearance at the top,
// the other three under `preferences`), and the profile's cat section carries only the name. A
// policy edit that changes either fails here until the layout and parser follow.
const _carriedSections: Readonly<Record<CarriedSection, true>> = { appearance: true, behavior: true, interaction: true, sound: true };
const _catClassOnlyName: Exact<KeysOfClass<'general', 'cat'>, 'catName'> = true;
const _catClassOnlyGeneral: Exact<SectionsWithClass<'cat'>, 'general'> = true;

function keysOfClass<S extends CarriedSection>(section: S): ReadonlyArray<CarriedKey<S>> {
  const policy = PROFILE_FIELD_POLICY[section] as Readonly<Record<string, ProfileFieldClass>>;
  return Object.freeze(Object.keys(policy).filter((k) => policy[k] === 'carry')) as ReadonlyArray<CarriedKey<S>>;
}

/** The carried settings fields per section, derived from the policy (also the web storage subset). */
export const PROFILE_SETTINGS_FIELDS: { readonly [S in CarriedSection]: ReadonlyArray<CarriedKey<S>> } = Object.freeze({
  appearance: keysOfClass('appearance'),
  behavior: keysOfClass('behavior'),
  interaction: keysOfClass('interaction'),
  sound: keysOfClass('sound'),
});

/** Which profile part a settings section belongs to. */
export const PROFILE_SECTION_PART: Readonly<Record<'general' | CarriedSection, ProfilePart>> = Object.freeze({
  general: 'cat',
  appearance: 'appearance',
  behavior: 'preferences',
  interaction: 'preferences',
  sound: 'preferences',
});

/**
 * Opt-outs an import may switch OFF but never ON: they keep the UI Automation helper from reading
 * tab-strip rectangles (src/main/uia/allowList.ts). When one is disabled on this device it stays
 * disabled whatever the file says, and the preview lists it in `keptOff`.
 */
export const IMPORT_NEVER_ENABLES: Readonly<{ disabledBehaviors: readonly ToggleableBehavior[]; disabledExtras: readonly LivelyBehavior[] }> = Object.freeze({
  disabledBehaviors: Object.freeze(['tabStrips'] as const),
  disabledExtras: Object.freeze(['explorerTabs', 'terminalTabs'] as const),
});

// ---------------------------------------------------------------------------------------------
// Cat policy: every persisted cat field is classified, or the build fails

type CatFieldClass = 'cat' | 'memory' | 'never';
type CatPolicyShape = {
  readonly [K in keyof PersistedCat]-?: K extends 'traits'
    ? { readonly [T in keyof Traits]-?: 'cat' }
    : K extends 'stats'
      ? { readonly [T in keyof Stats]-?: Exclude<CatFieldClass, 'cat'> }
      : K extends 'memory'
        ? {
            readonly [M in keyof Memory]-?: M extends 'counters'
              ? { readonly [C in keyof Counters]-?: Exclude<CatFieldClass, 'cat'> }
              : M extends 'preferences'
                ? { readonly [P in keyof Preferences]-?: Exclude<CatFieldClass, 'cat'> }
                : 'never';
          }
        : K extends 'catId' | 'bornAt'
          ? 'cat'
          : 'never';
};

/**
 * What travels from the cat. Identity (catId, bornAt) and all traits always; counters, learned
 * preferences and the bond only with "include what it has learned". Never: the other stats, drives,
 * favourite spots and last position (display ids and positions), recent memories and timestamps.
 * Traits are required in a 1.x file: a trait added later must be read as optional (minor bump).
 */
export const PROFILE_CAT_POLICY = {
  schemaVersion: 'never',
  catId: 'cat',
  bornAt: 'cat',
  traits: {
    curiosity: 'cat',
    playfulness: 'cat',
    affection: 'cat',
    confidence: 'cat',
    energyLevel: 'cat',
    laziness: 'cat',
    startleSensitivity: 'cat',
  },
  stats: { energy: 'never', boredom: 'never', bond: 'memory', annoyance: 'never', fear: 'never' },
  memory: {
    favoriteSpots: 'never',
    counters: {
      pets: 'memory',
      clicks: 'memory',
      doubleClicks: 'memory',
      drags: 'memory',
      throws: 'memory',
      chasesStarted: 'memory',
      chasesEngaged: 'memory',
      chasesIgnored: 'memory',
      attentionRequests: 'memory',
      attentionAnswered: 'memory',
      windowsInspected: 'memory',
      naps: 'memory',
      sessions: 'memory',
      hunts: 'memory',
      pounces: 'memory',
      excursions: 'memory',
      surfaceHops: 'memory',
      edgeClimbs: 'memory',
      slips: 'memory',
      hardLandings: 'memory',
    },
    preferences: { petRatePerHour: 'memory', cursorPlayAcceptance: 'memory', attentionAcceptance: 'memory', roughRatePerHour: 'memory' },
    recent: 'never',
    lastSeenAt: 'never',
    totalAwakeMs: 'never',
  },
  drives: 'never',
  lastPosition: 'never',
  savedAt: 'never',
} as const satisfies CatPolicyShape;

type CatPolicy = typeof PROFILE_CAT_POLICY;
type MemoryKeys<T> = { [K in keyof T]: T[K] extends 'memory' ? K : never }[keyof T];
// The file's memory section has a single stats field (bond); marking another stat 'memory' fails here.
const _statsMemoryOnlyBond: Exact<MemoryKeys<CatPolicy['stats']>, 'bond'> = true;

function classKeys<K extends string>(policy: Readonly<Record<K, CatFieldClass>>, cls: CatFieldClass): readonly K[] {
  return Object.freeze((Object.keys(policy) as K[]).filter((k) => policy[k] === cls));
}

const TRAIT_KEYS = classKeys<keyof Traits>(PROFILE_CAT_POLICY.traits, 'cat');
const COUNTER_KEYS = classKeys<MemoryKeys<CatPolicy['memory']['counters']>>(PROFILE_CAT_POLICY.memory.counters, 'memory');
const LEARNED_KEYS = classKeys<MemoryKeys<CatPolicy['memory']['preferences']>>(PROFILE_CAT_POLICY.memory.preferences, 'memory');

/**
 * Bond of a newly met cat: mirrors defaultStats() in src/core/behavior/personality.ts (shared may
 * not import core); tests/unit/shared/profileTransfer.test.ts pins the two together.
 */
const NEW_CAT_BOND = 0.15;

// ---------------------------------------------------------------------------------------------
// Types

export type ProfileSection<S extends CarriedSection> = Partial<Pick<Settings[S], CarriedKey<S>>>;
export type ProfileAppearance = ProfileSection<'appearance'>;
export interface ProfilePreferences {
  behavior: ProfileSection<'behavior'>;
  interaction: ProfileSection<'interaction'>;
  sound: ProfileSection<'sound'>;
}
export interface ProfileCat {
  /** Cleaned: no invisible or bidi characters, whitespace collapsed, 1..24 code units. */
  name: string;
  catId: string;
  /** Epoch ms; capped at the importing device's clock when applied. */
  bornAt: number;
  traits: Traits;
}
export interface ProfileMemory {
  counters: Partial<Pick<Counters, MemoryKeys<CatPolicy['memory']['counters']>>>;
  /** The cat's learned preferences (memory.preferences), named apart from the settings preferences. */
  learned: Partial<Pick<Preferences, MemoryKeys<CatPolicy['memory']['preferences']>>>;
  bond?: number;
}
export interface ProfileFormat {
  major: number;
  minor: number;
}
/** The normalized in-memory profile: what buildProfile returns and every format parser produces. */
export interface GizeProfile {
  kind: typeof PROFILE_KIND;
  /** For a parsed file, the file's format (the preview reports a newer minor); serializeProfile writes PROFILE_FORMAT. */
  format: ProfileFormat;
  character: CharacterDescriptor['kind'];
  /** ISO 8601 UTC (toISOString form), or null when absent or malformed. */
  exportedAt: string | null;
  /** The exporting app's version and platform id (no device names). */
  app: { version: string | null; host: PlatformId | null };
  cat: ProfileCat;
  appearance: ProfileAppearance;
  preferences: ProfilePreferences;
  /** Only when the user chose to include what the cat has learned. */
  memory: ProfileMemory | null;
}

export type ProfileRejectReason = 'too-large' | 'not-json' | 'not-a-profile' | 'newer-format' | 'unsupported-format' | 'other-character' | 'invalid';
export interface ProfileImportNotes {
  /**
   * Allow-listed values that failed validation and are left as they are on this device (dotted file
   * paths built from the allow-lists only, so they never echo file content).
   */
  skipped: string[];
  /** Saved by a newer minor format: unknown fields were dropped. */
  newerMinor: boolean;
}
export type ProfileParseResult = ({ ok: true; profile: GizeProfile } & ProfileImportNotes) | { ok: false; reason: ProfileRejectReason; formatMajor?: number };

export type ProfileValue = string | number | boolean | readonly string[] | null;
export interface ProfileChange {
  part: ProfilePart;
  /** settings: `field` is a settings path ('appearance.skin'); cat: a persisted-cat path ('traits.curiosity', 'memory.counters.pets', 'stats.bond'). */
  target: 'settings' | 'cat';
  field: string;
  from: ProfileValue;
  to: ProfileValue;
}
export interface ProfilePreview {
  format: { major: number; minor: number; newerMinor: boolean };
  exportedAt: string | null;
  fromVersion: string | null;
  fromHost: PlatformId | null;
  incoming: { name: string; skin: SkinId | null; bornAt: number };
  current: { name: string; skin: SkinId };
  /** Same catId: loading the cat part updates this cat; otherwise it replaces it (its memory is cleared). */
  sameCat: boolean;
  parts: Record<ProfilePart, { available: boolean; changes: number }>;
  /** Every value that would change if all available parts were loaded, in part order. */
  changes: ProfileChange[];
  /** The file has memory but holds another cat: memory loads only together with the cat part. */
  memoryNeedsCat: boolean;
  skipped: string[];
  /** Opt-outs kept off on this device although the file has them on (IMPORT_NEVER_ENABLES). */
  keptOff: BehaviorId[];
}

export interface BuildProfileOptions {
  includeMemory: boolean;
  app: { version: string; host: PlatformId };
  /** Export time (injected; shared code keeps no clock). */
  now: Date | number;
}

export type ProfileExportFailure = ProfileRejectReason | 'skipped-values';
export type ProfileExportResult = { ok: true; profile: GizeProfile; text: string; fileName: string } | { ok: false; reason: ProfileExportFailure; skipped: string[] };

export interface ApplyProfileOptions {
  /** Epoch ms used for bornAt capping, savedAt and a replaced cat's memory reset (default Date.now()). */
  now?: number;
}
export type ProfileApplyFailure = 'nothing-selected' | 'invalid-cat' | 'invalid-settings';
export type ProfileApplyResult =
  | {
      ok: true;
      /** The full next settings (applySettingsPatch(current, patch)). */
      settings: Settings;
      /** The full next persisted cat (lastPosition stays this device's). */
      catState: PersistedCat;
      /** The settings patch: only general.catName and carried fields, never activityPreset. Hosts with a settings store apply this. */
      patch: SettingsPatch;
      /** The parts actually applied (resolveProfileParts). */
      parts: ProfileParts;
      /** The cat part brought a different catId: stats, drives and memory were reset. */
      catReplaced: boolean;
      /** The cat state changed (cat or memory part): hosts adopt `catState`. */
      catChanged: boolean;
      keptOff: BehaviorId[];
    }
  | { ok: false; reason: ProfileApplyFailure; error?: string };

// ---------------------------------------------------------------------------------------------
// Export

/** Cleans an untrusted cat name: invisible/bidi characters out, whitespace collapsed; null when empty or too long. */
export function normalizeProfileName(raw: string): string | null {
  const name = replaceInvisible(raw).replace(/\s+/gu, ' ').trim();
  return name.length >= 1 && name.length <= PROFILE_NAME_MAX_LENGTH ? name : null;
}

/** The profile this device would export. Reads only the in-memory (migrated) settings and cat. */
export function buildProfile(settings: Settings, cat: PersistedCat, opts: BuildProfileOptions): GizeProfile {
  const t = typeof opts.now === 'number' ? opts.now : opts.now.getTime();
  return {
    kind: PROFILE_KIND,
    format: { major: PROFILE_FORMAT.major, minor: PROFILE_FORMAT.minor },
    character: PROFILE_CHARACTER,
    exportedAt: isoOrNull(t),
    app: { version: opts.app.version, host: opts.app.host },
    cat: {
      name: normalizeProfileName(settings.general.catName) ?? defaultSettings().general.catName,
      catId: cat.catId,
      bornAt: cat.bornAt,
      traits: pickPresent(cat.traits, TRAIT_KEYS) as Traits,
    },
    appearance: pickPresent(settings.appearance, PROFILE_SETTINGS_FIELDS.appearance),
    preferences: {
      behavior: pickPresent(settings.behavior, PROFILE_SETTINGS_FIELDS.behavior),
      interaction: pickPresent(settings.interaction, PROFILE_SETTINGS_FIELDS.interaction),
      sound: pickPresent(settings.sound, PROFILE_SETTINGS_FIELDS.sound),
    },
    memory: opts.includeMemory
      ? { counters: pickPresent(cat.memory.counters, COUNTER_KEYS), learned: pickPresent(cat.memory.preferences, LEARNED_KEYS), bond: cat.stats.bond }
      : null,
  };
}

/**
 * The file text: pretty JSON plus a newline. Writes the current kind, format and character and only
 * allow-listed keys, whatever extra properties the object may carry.
 */
export function serializeProfile(profile: GizeProfile): string {
  const file: Record<string, unknown> = {
    kind: PROFILE_KIND,
    format: { major: PROFILE_FORMAT.major, minor: PROFILE_FORMAT.minor },
    character: PROFILE_CHARACTER,
    exportedAt: profile.exportedAt,
    app: { version: profile.app.version, host: profile.app.host },
    cat: { name: profile.cat.name, catId: profile.cat.catId, bornAt: profile.cat.bornAt, traits: pickPresent(profile.cat.traits, TRAIT_KEYS) },
    appearance: pickPresent(profile.appearance, PROFILE_SETTINGS_FIELDS.appearance),
    preferences: {
      behavior: pickPresent(profile.preferences.behavior, PROFILE_SETTINGS_FIELDS.behavior),
      interaction: pickPresent(profile.preferences.interaction, PROFILE_SETTINGS_FIELDS.interaction),
      sound: pickPresent(profile.preferences.sound, PROFILE_SETTINGS_FIELDS.sound),
    },
  };
  if (profile.memory) {
    const memory: Record<string, unknown> = {
      counters: pickPresent(profile.memory.counters, COUNTER_KEYS),
      learned: pickPresent(profile.memory.learned, LEARNED_KEYS),
    };
    if (typeof profile.memory.bond === 'number') memory.bond = profile.memory.bond;
    file.memory = memory;
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Build, serialize and self-check: the text must parse back with nothing skipped (anything else is
 * a bug, e.g. a hand-edited catId outside PROFILE_CAT_ID_PATTERN), so a host never writes a file it
 * could not load itself.
 */
export function prepareProfileExport(settings: Settings, cat: PersistedCat, opts: BuildProfileOptions): ProfileExportResult {
  const profile = buildProfile(settings, cat, opts);
  const text = serializeProfile(profile);
  const check = parseProfile(text);
  if (!check.ok) return { ok: false, reason: check.reason, skipped: [] };
  if (check.skipped.length > 0) return { ok: false, reason: 'skipped-values', skipped: check.skipped };
  return { ok: true, profile, text, fileName: suggestedFileName(profile) };
}

/** 'gizecat-<name>-<YYYY-MM-DD>.json' (the export's local date), or without the date when unknown. */
export function suggestedFileName(profile: Pick<GizeProfile, 'cat' | 'exportedAt'>): string {
  const slug = fileNameSlug(profile.cat.name);
  const t = profile.exportedAt === null ? Number.NaN : Date.parse(profile.exportedAt);
  if (!Number.isFinite(t)) return `${PROFILE_FILE_PREFIX}-${slug}.${PROFILE_FILE_EXTENSION}`;
  const d = new Date(t);
  const date = `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${PROFILE_FILE_PREFIX}-${slug}-${date}.${PROFILE_FILE_EXTENSION}`;
}

function fileNameSlug(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const slug = Array.from(cleaned).slice(0, PROFILE_NAME_MAX_LENGTH).join('').replace(/-+$/, '');
  return slug.length > 0 ? slug : 'cat';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function isoOrNull(t: number): string | null {
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? new Date(t).toISOString() : null;
}

// ---------------------------------------------------------------------------------------------
// Parse

/** UTF-8 byte length without Buffer or TextEncoder (shared code runs everywhere). Lone surrogates count as U+FFFD. */
export function utf8ByteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

type AllowListed<K extends string> = { [P in K]?: unknown };

/** A z.object of optional unknown values for exactly `keys`: zod's default strips every other key (so `__proto__` and friends never come through). Never z.record. */
function allowListObject<K extends string>(keys: readonly K[]): z.ZodType<AllowListed<K>> {
  const shape: Record<string, z.ZodOptional<z.ZodUnknown>> = {};
  for (const k of keys) shape[k] = z.unknown().optional();
  return z.object(shape) as unknown as z.ZodType<AllowListed<K>>;
}

const EnvelopeSchema = allowListObject(['kind', 'format', 'character']);
const FormatSchema = z.object({ major: z.number().int().min(0).max(1_000_000), minor: z.number().int().min(0).max(1_000_000) });
const V1Schema = allowListObject(['exportedAt', 'app', 'cat', 'appearance', 'preferences', 'memory']);
const AppSchema = allowListObject(['version', 'host']);
const CatWireSchema = z.object({
  /** Raw, before normalizeProfileName (bounded so cleaning stays cheap). */
  name: z.string().max(256),
  catId: z.string().regex(PROFILE_CAT_ID_PATTERN),
  bornAt: z.number().min(0),
  traits: allowListObject(TRAIT_KEYS),
});
const PreferencesWireSchema = allowListObject(['behavior', 'interaction', 'sound']);
const MemoryWireSchema = allowListObject(['counters', 'learned', 'bond']);
const CountersWireSchema = allowListObject(COUNTER_KEYS);
const LearnedWireSchema = allowListObject(LEARNED_KEYS);
const SECTION_SCHEMAS: Readonly<Record<CarriedSection, z.ZodType<AllowListed<string>>>> = {
  appearance: allowListObject<string>(PROFILE_SETTINGS_FIELDS.appearance),
  behavior: allowListObject<string>(PROFILE_SETTINGS_FIELDS.behavior),
  interaction: allowListObject<string>(PROFILE_SETTINGS_FIELDS.interaction),
  sound: allowListObject<string>(PROFILE_SETTINGS_FIELDS.sound),
};

const EXPORTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const APP_VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.-]{1,32})?$/;

type ProfileParser = (raw: Record<string, unknown>, minor: number) => ProfileParseResult;
/** One parser per major format; each produces the same normalized GizeProfile, so a later major still reads 1.x files. */
const PROFILE_PARSERS: Readonly<Partial<Record<number, ProfileParser>>> = Object.freeze({ 1: parseV1 });

const reject = (reason: ProfileRejectReason): ProfileParseResult => ({ ok: false, reason });

/**
 * Parses file text: size cap (bytes), optional BOM, JSON.parse, then parseProfileValue. Never throws;
 * never best-effort for a newer major format.
 */
export function parseProfile(text: string): ProfileParseResult {
  if (typeof text !== 'string') return reject('not-json');
  if (text.length > MAX_PROFILE_BYTES || utf8ByteLength(text) > MAX_PROFILE_BYTES) return reject('too-large');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return reject('not-json');
  }
  return parseProfileValue(raw);
}

/** Parses an already-decoded JSON value. Order: kind, format (newer major refused), character, then that major's parser. */
export function parseProfileValue(raw: unknown): ProfileParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return reject('not-a-profile');
  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success || env.data.kind !== PROFILE_KIND) return reject('not-a-profile');
  const format = FormatSchema.safeParse(env.data.format);
  if (!format.success) return reject('unsupported-format');
  const { major, minor } = format.data;
  if (major > PROFILE_FORMAT.major) return { ok: false, reason: 'newer-format', formatMajor: major };
  if (major < 1) return { ok: false, reason: 'unsupported-format', formatMajor: major };
  if (env.data.character !== PROFILE_CHARACTER) return reject('other-character');
  const parser = PROFILE_PARSERS[major];
  if (!parser) return { ok: false, reason: 'unsupported-format', formatMajor: major };
  return parser(raw as Record<string, unknown>, minor);
}

function parseV1(raw: Record<string, unknown>, minor: number): ProfileParseResult {
  const top = V1Schema.safeParse(raw);
  if (!top.success) return reject('invalid');
  const base = defaultSettings();
  // The cat section is all-or-nothing: without a valid identity there is nothing to load.
  const cat = parseCatV1(top.data.cat, base);
  if (!cat) return reject('invalid');
  const skipped: string[] = [];
  const prefs = parseObject(PreferencesWireSchema, top.data.preferences, 'preferences', skipped);
  const profile: GizeProfile = {
    kind: PROFILE_KIND,
    format: { major: 1, minor },
    character: PROFILE_CHARACTER,
    exportedAt: typeof top.data.exportedAt === 'string' && EXPORTED_AT_PATTERN.test(top.data.exportedAt) && Number.isFinite(Date.parse(top.data.exportedAt)) ? top.data.exportedAt : null,
    app: parseApp(top.data.app),
    cat,
    // Each kept leaf survived applySettingsPatch, so it has its settings type.
    appearance: parseSection('appearance', top.data.appearance, 'appearance', base, skipped),
    preferences: {
      behavior: parseSection('behavior', prefs?.behavior, 'preferences.behavior', base, skipped),
      interaction: parseSection('interaction', prefs?.interaction, 'preferences.interaction', base, skipped),
      sound: parseSection('sound', prefs?.sound, 'preferences.sound', base, skipped),
    },
    memory: top.data.memory === undefined || top.data.memory === null ? null : parseMemoryV1(top.data.memory, skipped),
  };
  return { ok: true, profile, skipped, newerMinor: minor > PROFILE_FORMAT.minor };
}

/** Absent: null (nothing to report). Present but not the expected object: null and the path is skipped. */
function parseObject<T>(schema: z.ZodType<T>, value: unknown, path: string, skipped: string[]): T | null {
  if (value === undefined) return null;
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  skipped.push(path);
  return null;
}

function parseApp(value: unknown): GizeProfile['app'] {
  const r = AppSchema.safeParse(value);
  if (!r.success) return { version: null, host: null };
  const { version, host } = r.data;
  return {
    version: typeof version === 'string' && APP_VERSION_PATTERN.test(version) ? version : null,
    host: typeof host === 'string' && (PLATFORM_IDS as readonly string[]).includes(host) ? (host as PlatformId) : null,
  };
}

function parseCatV1(value: unknown, base: Settings): ProfileCat | null {
  const r = CatWireSchema.safeParse(value);
  if (!r.success) return null;
  const name = normalizeProfileName(r.data.name);
  if (name === null || !Number.isFinite(r.data.bornAt) || !applySettingsPatch(base, { general: { catName: name } }).ok) return null;
  const failed: string[] = [];
  const traits = survivingNumbers(TraitsSchema, r.data.traits, TRAIT_KEYS, 'cat.traits', failed);
  if (failed.length > 0 || TRAIT_KEYS.some((k) => !Object.hasOwn(traits, k))) return null;
  return { name, catId: r.data.catId, bornAt: r.data.bornAt, traits: traits as Traits };
}

/**
 * Carried settings leaves that survive applySettingsPatch unchanged (the same rule as a renderer
 * patch, so limits are never copied here). A failed leaf is skipped, never replaced by a default.
 */
function parseSection(section: CarriedSection, value: unknown, path: string, base: Settings, skipped: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const data = parseObject(SECTION_SCHEMAS[section], value, path, skipped);
  if (data) {
    for (const key of PROFILE_SETTINGS_FIELDS[section] as readonly string[]) {
      // JSON has no undefined: undefined means absent.
      if (!Object.hasOwn(data, key) || data[key] === undefined) continue;
      const leaf = prepareLeaf(section, key, data[key]);
      if (leaf !== undefined && applySettingsPatch(base, { [section]: { [key]: leaf } }).ok) out[key] = leaf;
      else skipped.push(`${path}.${key}`);
    }
  }
  return out;
}

/**
 * Every carried leaf is a primitive or a flat list of ids, so nothing else reaches the survival
 * check (a deeply nested value could otherwise overflow its JSON.stringify comparison). The opt-out
 * lists are normalized first: the strict v2 list keeps only ids this version knows, the tolerant
 * list follows its own rule.
 */
function prepareLeaf(section: CarriedSection, key: string, value: unknown): unknown {
  if (section === 'behavior' && key === 'disabledBehaviors') {
    if (!Array.isArray(value)) return undefined;
    const known: ReadonlySet<string> = new Set(TOGGLEABLE_BEHAVIORS);
    return [...new Set((value as unknown[]).filter((v): v is string => typeof v === 'string' && known.has(v)))];
  }
  if (section === 'behavior' && key === 'disabledExtras') return Array.isArray(value) ? normalizeOptOutList(value) : undefined;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

/** Numbers present in `raw` that survive `schema` parsing unchanged; the others are skipped. */
function survivingNumbers<K extends string>(schema: z.ZodType<Record<K, number>>, raw: AllowListed<K>, keys: readonly K[], path: string, skipped: string[]): Partial<Record<K, number>> {
  const input: Partial<Record<K, unknown>> = {};
  const present = keys.filter((k) => Object.hasOwn(raw, k) && raw[k] !== undefined);
  for (const k of present) input[k] = raw[k];
  const parsed = schema.safeParse(input);
  const out: Partial<Record<K, number>> = {};
  for (const k of present) {
    const v = raw[k];
    if (parsed.success && typeof v === 'number' && parsed.data[k] === v) out[k] = v;
    else skipped.push(`${path}.${k}`);
  }
  return out;
}

function parseMemoryV1(value: unknown, skipped: string[]): ProfileMemory | null {
  const m = parseObject(MemoryWireSchema, value, 'memory', skipped);
  if (!m) return null;
  const counters = parseObject(CountersWireSchema, m.counters, 'memory.counters', skipped);
  const learned = parseObject(LearnedWireSchema, m.learned, 'memory.learned', skipped);
  const memory: ProfileMemory = {
    counters: counters ? survivingNumbers(CountersSchema, counters, COUNTER_KEYS, 'memory.counters', skipped) : {},
    learned: learned ? survivingNumbers(PreferencesSchema, learned, LEARNED_KEYS, 'memory.learned', skipped) : {},
  };
  if (m.bond !== undefined) {
    const bond = m.bond;
    if (typeof bond === 'number' && StatsSchema.shape.bond.parse(bond) === bond) memory.bond = bond;
    else skipped.push('memory.bond');
  }
  return memory;
}

// ---------------------------------------------------------------------------------------------
// Preview and apply

function hasMemoryValues(m: ProfileMemory | null): m is ProfileMemory {
  return m !== null && (Object.keys(m.counters).length > 0 || Object.keys(m.learned).length > 0 || typeof m.bond === 'number');
}

/** Which parts the file can provide at all. */
export function profileAvailability(profile: GizeProfile): ProfileParts {
  const p = profile.preferences;
  return {
    cat: true,
    appearance: Object.keys(profile.appearance).length > 0,
    preferences: Object.keys(p.behavior).length + Object.keys(p.interaction).length + Object.keys(p.sound).length > 0,
    memory: hasMemoryValues(profile.memory),
  };
}

/** The parts to apply: requested AND available; memory of another cat only together with the cat part. */
export function resolveProfileParts(requested: Partial<ProfileParts>, profile: GizeProfile, localCatId: string): ProfileParts {
  const available = profileAvailability(profile);
  const cat = requested.cat === true;
  const sameCat = profile.cat.catId === localCatId;
  return {
    cat,
    appearance: requested.appearance === true && available.appearance,
    preferences: requested.preferences === true && available.preferences,
    memory: requested.memory === true && available.memory && (sameCat || cat),
  };
}

/** The incoming behavior values with IMPORT_NEVER_ENABLES enforced against this device's lists. */
function withPrivacyFloor(incoming: ProfileSection<'behavior'>, current: Settings['behavior']): { behavior: ProfileSection<'behavior'>; keptOff: BehaviorId[] } {
  const behavior: ProfileSection<'behavior'> = { ...incoming };
  const keptOff: BehaviorId[] = [];
  const disabled = incoming.disabledBehaviors;
  if (disabled) {
    const list = [...disabled];
    for (const id of IMPORT_NEVER_ENABLES.disabledBehaviors) {
      if (current.disabledBehaviors.includes(id) && !list.includes(id)) {
        list.push(id);
        keptOff.push(id);
      }
    }
    behavior.disabledBehaviors = list;
  }
  const extras = incoming.disabledExtras;
  if (extras) {
    const forced = IMPORT_NEVER_ENABLES.disabledExtras.filter((id) => current.disabledExtras.includes(id) && !extras.includes(id));
    keptOff.push(...forced);
    // Forced ids first, so the tolerant list's cap can never drop them.
    behavior.disabledExtras = normalizeOptOutList([...forced, ...extras]);
  }
  return { behavior, keptOff };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const x = (a as unknown[]).map((v) => JSON.stringify(v)).sort();
    const y = (b as unknown[]).map((v) => JSON.stringify(v)).sort();
    return x.every((v, i) => v === y[i]);
  }
  return a === b;
}

const cloneValue = (v: unknown): ProfileValue => (Array.isArray(v) ? [...(v as string[])] : (v as ProfileValue));

function addChanged(patch: SettingsPatch, section: CarriedSection, have: Readonly<Record<string, unknown>>, current: Settings): void {
  const now: Readonly<Record<string, unknown>> = current[section];
  const changed: Record<string, unknown> = {};
  for (const key of PROFILE_SETTINGS_FIELDS[section] as readonly string[]) {
    if (!Object.hasOwn(have, key)) continue;
    if (!sameValue(have[key], now[key])) changed[key] = cloneValue(have[key]);
  }
  if (Object.keys(changed).length > 0) (patch as Record<string, unknown>)[section] = changed;
}

/**
 * The settings patch for `parts` (pass resolved parts): only general.catName and carried fields
 * that differ from `current`, never activityPreset (re-derived) and never perception, ai,
 * loginItem or diagnostics. Hosts with a settings store apply it through their normal patch path.
 */
export function profileSettingsPatch(profile: GizeProfile, parts: Partial<ProfileParts>, current: Settings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (parts.cat === true && profile.cat.name !== current.general.catName) patch.general = { catName: profile.cat.name };
  if (parts.appearance === true) addChanged(patch, 'appearance', profile.appearance, current);
  if (parts.preferences === true) {
    addChanged(patch, 'behavior', withPrivacyFloor(profile.preferences.behavior, current.behavior).behavior, current);
    addChanged(patch, 'interaction', profile.preferences.interaction, current);
    addChanged(patch, 'sound', profile.preferences.sound, current);
  }
  return patch;
}

/** What loading the file would change on this device. Pass the parse result as `notes` to report skipped values. */
export function previewImport(profile: GizeProfile, settings: Settings, cat: PersistedCat, notes: Partial<Pick<ProfileImportNotes, 'skipped'>> = {}): ProfilePreview {
  const sameCat = profile.cat.catId === cat.catId;
  const changes: ProfileChange[] = [];
  const all: ProfileParts = { cat: true, appearance: true, preferences: true, memory: true };
  const patch = profileSettingsPatch(profile, all, settings) as Record<string, Record<string, unknown> | undefined>;
  const settingsChanges = (section: 'general' | CarriedSection): void => {
    const values = patch[section];
    if (!values) return;
    const now: Record<string, unknown> = settings[section];
    for (const [key, to] of Object.entries(values)) changes.push({ part: PROFILE_SECTION_PART[section], target: 'settings', field: `${section}.${key}`, from: cloneValue(now[key]), to: cloneValue(to) });
  };
  const catChange = (part: ProfilePart, field: string, from: ProfileValue, to: ProfileValue): void => {
    if (!sameValue(from, to)) changes.push({ part, target: 'cat', field, from, to });
  };

  settingsChanges('general');
  catChange('cat', 'catId', cat.catId, profile.cat.catId);
  catChange('cat', 'bornAt', cat.bornAt, profile.cat.bornAt);
  for (const k of TRAIT_KEYS) catChange('cat', `traits.${k}`, cat.traits[k], profile.cat.traits[k]);
  settingsChanges('appearance');
  settingsChanges('behavior');
  settingsChanges('interaction');
  settingsChanges('sound');
  if (profile.memory) {
    const m = profile.memory;
    for (const k of COUNTER_KEYS) {
      const v = m.counters[k];
      if (v !== undefined) catChange('memory', `memory.counters.${k}`, cat.memory.counters[k], v);
    }
    for (const k of LEARNED_KEYS) {
      const v = m.learned[k];
      if (v !== undefined) catChange('memory', `memory.preferences.${k}`, cat.memory.preferences[k], v);
    }
    if (typeof m.bond === 'number') catChange('memory', 'stats.bond', cat.stats.bond, m.bond);
  }

  const available = profileAvailability(profile);
  const count = (part: ProfilePart): number => changes.filter((c) => c.part === part).length;
  return {
    format: { major: profile.format.major, minor: profile.format.minor, newerMinor: profile.format.major === PROFILE_FORMAT.major && profile.format.minor > PROFILE_FORMAT.minor },
    exportedAt: profile.exportedAt,
    fromVersion: profile.app.version,
    fromHost: profile.app.host,
    incoming: { name: profile.cat.name, skin: profile.appearance.skin ?? null, bornAt: profile.cat.bornAt },
    current: { name: settings.general.catName, skin: settings.appearance.skin },
    sameCat,
    parts: {
      cat: { available: available.cat, changes: count('cat') },
      appearance: { available: available.appearance, changes: count('appearance') },
      preferences: { available: available.preferences, changes: count('preferences') },
      memory: { available: available.memory, changes: count('memory') },
    },
    changes,
    memoryNeedsCat: available.memory && !sameCat,
    skipped: [...(notes.skipped ?? [])],
    keptOff: withPrivacyFloor(profile.preferences.behavior, settings.behavior).keptOff,
  };
}

/**
 * The next cat for `parts` (resolved). A different catId adopts another cat: stats and drives reset
 * and memory is cleared (sessions = 1), as clearHistory does; counters are replaced, never added.
 */
function nextCatState(current: PersistedCat, profile: GizeProfile, parts: ProfileParts, now: number): { ok: true; cat: PersistedCat; replaced: boolean } | { ok: false; error: string } {
  // zod returns fresh objects and arrays: `next` shares nothing with `current`.
  const base = PersistedCatSchema.safeParse(current);
  if (!base.success) return { ok: false, error: 'current cat state is invalid' };
  const next = base.data;
  const clock = Number.isFinite(now) ? Math.max(0, now) : null;
  let replaced = false;
  if (parts.cat) {
    replaced = profile.cat.catId !== next.catId;
    next.catId = profile.cat.catId;
    next.bornAt = clock === null ? profile.cat.bornAt : Math.min(profile.cat.bornAt, clock);
    next.traits = { ...next.traits, ...pickPresent(profile.cat.traits, TRAIT_KEYS) };
    if (replaced) {
      next.stats = StatsSchema.parse({ bond: NEW_CAT_BOND });
      next.drives = DrivesSchema.parse({});
      next.memory = MemorySchema.parse({});
      next.memory.lastSeenAt = clock ?? 0;
      next.memory.counters.sessions = 1;
    }
  }
  if (parts.memory && profile.memory) {
    Object.assign(next.memory.counters, pickPresent(profile.memory.counters, COUNTER_KEYS));
    Object.assign(next.memory.preferences, pickPresent(profile.memory.learned, LEARNED_KEYS));
    if (typeof profile.memory.bond === 'number') next.stats.bond = profile.memory.bond;
  }
  if (clock !== null) next.savedAt = clock;
  const out = PersistedCatSchema.safeParse(next);
  return out.success ? { ok: true, cat: out.data, replaced } : { ok: false, error: 'next cat state is invalid' };
}

/**
 * Computes the import in memory: the cat first, then the settings, so a failure changes nothing.
 * Never touches consent, perception, ai, loginItem or diagnostics; the tab-strip opt-outs in
 * IMPORT_NEVER_ENABLES stay off when they are off here. Hosts commit `settings` (or `patch`
 * through their store) and adopt `catState` when `catChanged`.
 */
export function applyProfile(profile: GizeProfile, parts: Partial<ProfileParts>, settings: Settings, cat: PersistedCat, opts: ApplyProfileOptions = {}): ProfileApplyResult {
  const resolved = resolveProfileParts(parts, profile, cat.catId);
  if (!PROFILE_PARTS.some((p) => resolved[p])) return { ok: false, reason: 'nothing-selected' };
  const now = opts.now ?? Date.now();
  const nextCat = nextCatState(cat, profile, resolved, now);
  if (!nextCat.ok) return { ok: false, reason: 'invalid-cat', error: nextCat.error };
  const patch = profileSettingsPatch(profile, resolved, settings);
  const applied = applySettingsPatch(settings, patch);
  if (!applied.ok) return { ok: false, reason: 'invalid-settings', error: applied.error };
  return {
    ok: true,
    settings: applied.settings,
    catState: nextCat.cat,
    patch,
    parts: resolved,
    catReplaced: nextCat.replaced,
    catChanged: resolved.cat || resolved.memory,
    keptOff: resolved.preferences ? withPrivacyFloor(profile.preferences.behavior, settings.behavior).keptOff : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Copies the listed own keys that are present (arrays copied), and nothing else. */
function pickPresent<T extends object, K extends keyof T & string>(src: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) {
    if (!Object.hasOwn(src, k)) continue;
    const v = src[k];
    if (v === undefined) continue;
    out[k] = (Array.isArray(v) ? [...(v as unknown[])] : v) as T[K];
  }
  return out;
}
