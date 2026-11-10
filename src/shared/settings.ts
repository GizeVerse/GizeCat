import { z } from 'zod';
import { RENDER_STYLES, SKINS } from './cat';
import { ALL_EVENT_IDS, EVENT_PACE_RANGE, PERSONALITY_IDS, type AnyEventId } from './companion';
import { ACTIVITY_PRESET_IDS, matchingPreset, PRESET_VALUES } from './settingsPresets';
import { DEFAULT_TOGGLE_SHORTCUT, MAX_SHORTCUT_LENGTH, parseShortcut } from './shortcut';

/**
 * User settings. Every field has a default and falls back to it when the stored
 * value is missing or invalid, so a partially corrupt file degrades field by field
 * instead of resetting everything.
 */
export const SETTINGS_SCHEMA_VERSION = 3;

/** Behaviours the user can switch off individually. */
export const TOGGLEABLE_BEHAVIORS = [
  'chaseCursor',
  'pawAtCursor',
  'seekAttention',
  'inspectWindows',
  'perchOnWindows',
  'zoomies',
  'grooming',
  /** v1.1: react to / ride the (auto-hide) taskbar. */
  'taskbarPlay',
  /** v1.1: climb window sides and walk along window tops between corners. */
  'climbWindows',
  /** v1.1: discover browser tab strips (UI Automation, geometry only) and walk on them. */
  'tabStrips',
] as const;
export type ToggleableBehavior = (typeof TOGGLEABLE_BEHAVIORS)[number];

/**
 * v1.2: behaviours added from v1.2 on that the user can switch off (ADR 0003 §9). They live in
 * their own tolerant list (`behavior.disabledExtras`), never in `disabledBehaviors`: one id 1.1.1
 * does not know empties that whole strict list on a downgrade, re-enabling everything the user
 * turned off. TOGGLEABLE_BEHAVIORS is frozen at its v2 contents.
 */
export const LIVELY_BEHAVIORS = [
  /** Pouncing at the pointer (stalking and watching stay; 'chaseCursor' off turns hunting off entirely). */
  'pounce',
  /** Climbing the outer edges of the screen. */
  'screenEdges',
  /** Jumping from one surface to another (window to window, window to taskbar, off a wall). */
  'surfaceHops',
  /** Hissing and defensive swats after rough handling (it gets grumpy or walks off instead). */
  'hissing',
  /** Chasing its own tail. */
  'tailChase',
  /** Looking up when tabs are switched, added or closed on the strip it is on. */
  'tabReactions',
  /** File Explorer tab strips (needs 'tabStrips'). */
  'explorerTabs',
  /** Windows Terminal tab strips (needs 'tabStrips'). */
  'terminalTabs',
  /** The occasional deliberate slip on a risky leap (it always recovers). */
  'slips',
] as const;
export type LivelyBehavior = (typeof LIVELY_BEHAVIORS)[number];
/** Every behaviour id the user can switch off, either list. */
export type BehaviorId = ToggleableBehavior | LivelyBehavior;

/** Ids the tolerant list keeps: short camelCase slugs (also ids of newer versions, kept and ignored). */
export const OPT_OUT_ID_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
export const MAX_OPT_OUTS = 64;

/**
 * The tolerant opt-out list rule: entries are checked one by one, so a bad or unknown entry never
 * costs the others. Malformed entries and duplicates are dropped; well-formed unknown ids (a newer
 * version's opt-outs) are kept, so a v1.3 -> v1.2 -> v1.3 round trip keeps them, and ignored by
 * this version; at most MAX_OPT_OUTS, first ones win. Anything but an array is the empty list.
 * Also the rule for the downgrade-proof sidecar copy of the list (ADR 0003 §9.3). Pure.
 */
export function normalizeOptOutList(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const out: string[] = [];
  for (const it of items as unknown[]) {
    if (typeof it !== 'string' || !OPT_OUT_ID_PATTERN.test(it) || out.includes(it)) continue;
    out.push(it);
    if (out.length >= MAX_OPT_OUTS) break;
  }
  return out;
}

const OptOutListSchema = z.array(z.unknown()).transform((items) => normalizeOptOutList(items));

/**
 * Opt-outs a v2 behaviour implies for the new ones (ADR 0003 §9.4): the new model never re-enables
 * something the user switched off under its old name. Applied when reading, never written back.
 */
export const IMPLIED_OPT_OUTS: Readonly<Partial<Record<ToggleableBehavior, readonly LivelyBehavior[]>>> = {
  chaseCursor: ['pounce'],
  climbWindows: ['screenEdges'],
  perchOnWindows: ['surfaceHops'],
  tabStrips: ['explorerTabs', 'terminalTabs', 'tabReactions'],
};

/** The effective set of switched-off behaviours: both lists plus the implied opt-outs. */
export function disabledBehaviorSet(behavior: Pick<Settings['behavior'], 'disabledBehaviors' | 'disabledExtras'>): ReadonlySet<BehaviorId> {
  const out = new Set<BehaviorId>();
  for (const id of behavior.disabledBehaviors) {
    out.add(id);
    for (const implied of IMPLIED_OPT_OUTS[id] ?? []) out.add(implied);
  }
  const lively: ReadonlySet<string> = new Set(LIVELY_BEHAVIORS);
  for (const id of behavior.disabledExtras) if (lively.has(id)) out.add(id as LivelyBehavior);
  return out;
}

/** Processes whose windows are never analysed, previewed or sent: blacked out in memory right after each grab, and capture is skipped while one is in front (case-insensitive exe basenames). */
export const DEFAULT_EXCLUDED_PROCESSES: readonly string[] = [
  'keepass.exe',
  'keepassxc.exe',
  '1password.exe',
  'bitwarden.exe',
  'dashlane.exe',
  'lastpass.exe',
  'enpass.exe',
  'nordpass.exe',
  'proton pass.exe',
  'credentialuibroker.exe',
  'consent.exe',
  'logonui.exe',
  'lockapp.exe',
  'microsoft.aad.brokerplugin.exe',
  'authenticator.exe',
  'winauth.exe',
];

/** Window-title patterns (case-insensitive substrings) that block capture. Titles are matched in memory only. */
export const DEFAULT_EXCLUDED_TITLE_PATTERNS: readonly string[] = [
  'password',
  'passwort',
  'şifre',
  'sign in',
  'sign-in',
  'log in',
  'login',
  'two-factor',
  '2fa',
  'one-time code',
  'verification code',
  'authenticator',
  'credential',
  'bank',
  'banking',
  'wallet',
  'paypal',
  'checkout',
  'payment',
  'private browsing',
  'inprivate',
  'incognito',
];

/** schema.default(def).catch(def): missing or invalid values fall back to `def`. */
function field<T extends z.ZodType>(schema: T, def: z.output<T>) {
  return schema.default(def as never).catch(def as never);
}

/**
 * A global shortcut must not swallow ordinary typing in other apps (see shortcut.ts).
 * Stored values are normalised; patches must already be in canonical form.
 */
const ShortcutSchema = z
  .string()
  .max(MAX_SHORTCUT_LENGTH)
  .transform((text, ctx) => {
    const r = parseShortcut(text);
    if (r.ok) return r.accelerator;
    ctx.addIssue({ code: 'custom', message: `unsafe global shortcut (${r.error.code})` });
    return z.NEVER;
  });

const GeneralSchema = z.object({
  catName: field(z.string().trim().min(1).max(24), 'Miso'),
  shortcutsEnabled: field(z.boolean(), true),
  /** Electron accelerator that shows/hides the cat. */
  toggleShortcut: field(ShortcutSchema, DEFAULT_TOGGLE_SHORTCUT),
  firstRunCompleted: field(z.boolean(), false),
  /** How the cat starts: always visible, hidden, paused, or as it was when the app last closed. */
  startupState: field(z.enum(['visible', 'hidden', 'paused', 'remember']), 'visible'),
  /** Last visible/hidden/paused state, maintained by main for startupState 'remember'. */
  rememberedState: field(z.enum(['visible', 'hidden', 'paused']), 'visible'),
  /**
   * 1.4.0, macOS only: show GizeCat's icon in the Dock (on by default). Off makes the app an
   * accessory (menu-bar only). Ignored on other platforms; the schema default keeps older files valid.
   */
  showDockIcon: field(z.boolean(), true),
});

/**
 * Launch at Windows sign-in (v1.1). MAIN-OWNED: renderer patches to this section are rejected;
 * the user changes it only through the enable/disableLaunchAtLogin actions. Default for new
 * installs is on ('unset' resolves to the product default), and an explicit opt-out (in the app
 * or in Windows' Startup apps) is never overridden.
 */
const LoginItemSchema = z.object({
  /** 'unset' = the user never chose; the product default (on) applies. */
  preference: field(z.enum(['unset', 'enabled', 'disabled']), 'unset'),
  /** Who produced the current preference. */
  decidedBy: field(z.enum(['default', 'user', 'migration', 'windows']), 'default'),
  /** Why startup is off, when it is: the user in the app, Windows Startup apps, or an entry removed outside the app. */
  disabledBy: field(z.enum(['user', 'windows', 'external']).nullable(), null),
  /** Executable path last registered by the app (to repair stale entries after moves), or null. */
  registeredPath: field(z.string().max(1024).nullable(), null),
  /** The v1 `general.launchAtLogin` value carried over by the migration, or null for v2-native files. */
  v1Value: field(z.boolean().nullable(), null),
  /** One-time notice that startup was turned on by default has been shown. */
  noticeShown: field(z.boolean(), false),
});

const AppearanceSchema = z.object({
  skin: field(z.enum(SKINS), 'ginger'),
  style: field(z.enum(RENDER_STYLES), 'smooth'),
  size: field(z.number().min(0.5).max(2.5), 1),
  opacity: field(z.number().min(0.3).max(1), 1),
  animationSpeed: field(z.number().min(0.5).max(1.5), 1),
  shadow: field(z.boolean(), true),
  emotes: field(z.boolean(), true),
  /** Exclude the overlays from screenshots/screen sharing (WDA_EXCLUDEFROMCAPTURE). */
  hideFromScreenCapture: field(z.boolean(), false),
});

const BehaviorSchema = z.object({
  movementSpeed: field(z.number().min(0.5).max(2), 1),
  /** How often the cat starts things on its own. */
  autonomy: field(z.number().min(0).max(1), 0.6),
  /** How much the cat likes to chase / bat at the cursor. */
  cursorPlay: field(z.number().min(0).max(1), 0.5),
  /** How often it asks for attention after quiet periods. */
  attentionSeeking: field(z.number().min(0).max(1), 0.35),
  /** How strongly it reacts to window and activity events. */
  activitySensitivity: field(z.number().min(0).max(1), 0.6),
  sleepAfterIdleMinutes: field(z.number().int().min(1).max(120), 5),
  allowMultiMonitor: field(z.boolean(), true),
  reactToTyping: field(z.boolean(), true),
  reactToWindows: field(z.boolean(), true),
  /** What happens when a fullscreen app/game/video is in front on the cat's monitor. */
  fullscreenBehavior: field(z.enum(['hide', 'quiet', 'ignore']), 'hide'),
  disabledBehaviors: field(z.array(z.enum(TOGGLEABLE_BEHAVIORS)).max(TOGGLEABLE_BEHAVIORS.length), []),
  /** Typical length of a cursor chase in seconds (actual chases vary around it). */
  chaseDurationSec: field(z.number().min(1).max(20), 4.5),
  // ---- v1.2 (ADR 0003 §9). `autonomy` is shown as "Activity" and `cursorPlay` as "Cursor hunting".
  /** The preset the activity values came from; 'custom' once one of them no longer matches it. */
  activityPreset: field(z.enum([...ACTIVITY_PRESET_IDS, 'custom']), 'playful'),
  /** How much it explores: window tops, tab strips, screen edges and corners. */
  exploration: field(z.number().min(0).max(1), PRESET_VALUES.playful.behavior.exploration),
  /** How high it climbs and how far it jumps down (0 = keeps low, 1 = daring). */
  heights: field(z.number().min(0).max(1), PRESET_VALUES.playful.behavior.heights),
  /** How cheeky it is. */
  mischief: field(z.number().min(0).max(1), PRESET_VALUES.playful.behavior.mischief),
  /** How willing it is to play near what you are working on (never while you type). */
  workDisruption: field(z.number().min(0).max(1), PRESET_VALUES.playful.behavior.workDisruption),
  /** How long it stays up on window tops and tab strips (0 = short visits, 1 = long stays). */
  stayLength: field(z.number().min(0).max(1), PRESET_VALUES.playful.behavior.stayLength),
  /** v1.2 opt-outs (LIVELY_BEHAVIORS), tolerant: see OptOutListSchema. */
  disabledExtras: field(OptOutListSchema, []),
});

const InteractionSchema = z.object({
  /** false = the cat is fully click-through (cannot be clicked, petted or dragged). */
  enabled: field(z.boolean(), true),
  petting: field(z.boolean(), true),
  dragging: field(z.boolean(), true),
  throwing: field(z.boolean(), true),
  /** 0 = gets annoyed quickly by repeated clicks, 1 = very tolerant. */
  patience: field(z.number().min(0).max(1), 0.5),
  /** v1.2: how strongly it reacts to throws and rough handling (0 = shrugs it off, 1 = big reactions). */
  reactionIntensity: field(z.number().min(0).max(1), PRESET_VALUES.playful.interaction.reactionIntensity),
});

const PerceptionSchema = z.object({
  /** Screen analysis is OFF unless the user explicitly opts in. */
  visualMode: field(z.enum(['off', 'local-stats', 'ai']), 'off'),
  /** ISO timestamp of the explicit opt-in; analysis never runs while null. */
  consentAt: field(z.string().max(40).nullable(), null),
  /** Persisted privacy pause: stops all capture immediately. */
  paused: field(z.boolean(), false),
  region: field(z.enum(['around-cat', 'active-window', 'display']), 'around-cat'),
  minIntervalSec: field(z.number().int().min(5).max(3600), 20),
  excludedProcesses: field(z.array(z.string().trim().min(1).max(128)).max(200), [...DEFAULT_EXCLUDED_PROCESSES]),
  excludedTitlePatterns: field(z.array(z.string().trim().min(1).max(128)).max(100), [...DEFAULT_EXCLUDED_TITLE_PATTERNS]),
});

export const AI_PROVIDERS = ['none', 'ollama', 'openai-compatible', 'anthropic'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

const AiSchema = z.object({
  provider: field(z.enum(AI_PROVIDERS), 'none'),
  /** Must be true before any non-loopback endpoint may receive an image. */
  allowCloud: field(z.boolean(), false),
  ollamaBaseUrl: field(z.string().max(200), 'http://127.0.0.1:11434'),
  ollamaModel: field(z.string().max(200), ''),
  openaiBaseUrl: field(z.string().max(200), 'http://127.0.0.1:1234/v1'),
  openaiModel: field(z.string().max(200), ''),
  /** Smallest current vision-capable Claude model (docs.claude.com, verified 2026-10-28). */
  anthropicModel: field(z.string().max(100), 'claude-haiku-5-5'),
  minIntervalSec: field(z.number().int().min(30).max(86400), 120),
  maxPerHour: field(z.number().int().min(1).max(60), 12),
  timeoutSec: field(z.number().int().min(3).max(120), 30),
});

/** v1.2 (ADR 0003 §10): optional procedural sounds, off by default; Windows' volume and mute apply. */
const SoundSchema = z.object({
  enabled: field(z.boolean(), false),
  volume: field(z.number().min(0).max(1), 0.4),
  /** Living Companion: the cat's own sounds (meow, chirp, purr, squeak...). Only matters while `enabled`. */
  cat: field(z.boolean(), true),
  /** Living Companion: the world's sounds (chime, rumble, splash...). Only matters while `enabled`. */
  world: field(z.boolean(), true),
});

/**
 * Event ids the user switched off: tolerant like the opt-out lists (a bad entry never costs the
 * others), but only ids of THIS catalogue survive, each once, in the order given, at most one per
 * event. Anything but an array is the empty list. Pure.
 */
export function normalizeDisabledEvents(items: unknown): AnyEventId[] {
  if (!Array.isArray(items)) return [];
  const out: AnyEventId[] = [];
  for (const it of items as unknown[]) {
    if (typeof it !== 'string' || !(ALL_EVENT_IDS as readonly string[]).includes(it) || out.includes(it as AnyEventId)) continue;
    out.push(it as AnyEventId);
    if (out.length >= ALL_EVENT_IDS.length) break;
  }
  return out;
}

const EventChoicesSchema = z.object({
  /** Master switch for world events (the cat itself is unaffected). */
  enabled: field(z.boolean(), true),
  /** The rare pool (a separate, low-probability set). */
  rare: field(z.boolean(), true),
  /** How often events come: 0.5 = twice as far apart, 2 = twice as often (never closer than the floor). */
  pace: field(z.number().min(EVENT_PACE_RANGE.min).max(EVENT_PACE_RANGE.max), EVENT_PACE_RANGE.default),
  /** Events switched off one by one. */
  disabled: field(z.array(z.unknown()).transform((items) => normalizeDisabledEvents(items)), []),
});

/**
 * Living Companion: the personality the user picked, how often the world visits, calmer motion and
 * the diary. A patch may send one leaf of `events` / `journal` (applySettingsPatch merges them).
 */
const CompanionSchema = z.object({
  /** 'auto' keeps the traits the cat was born with; a name gives it that personality (the cat never changes the choice). */
  personality: field(z.enum([...PERSONALITY_IDS, 'auto']), 'auto'),
  events: EventChoicesSchema.prefault({}).catch(() => EventChoicesSchema.parse({})),
  /** Calmer motion: no sudden pounces or big jumps, gentler props. Also honoured when the system asks for reduced motion. */
  reducedMotion: field(z.boolean(), false),
  journal: z
    .object({
      /** false = nothing new is written to the journal; existing entries stay until cleared. */
      enabled: field(z.boolean(), true),
    })
    .prefault({})
    .catch(() => ({ enabled: true })),
});

const DiagnosticsSchema = z.object({
  logLevel: field(z.enum(['error', 'warn', 'info', 'debug']), 'info'),
  /** Compatibility switch (applies at next launch) for GPUs that render transparent windows black. */
  hardwareAcceleration: field(z.boolean(), true),
});

export const SettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION).default(SETTINGS_SCHEMA_VERSION),
  general: GeneralSchema.prefault({}).catch(() => GeneralSchema.parse({})),
  loginItem: LoginItemSchema.prefault({}).catch(() => LoginItemSchema.parse({})),
  appearance: AppearanceSchema.prefault({}).catch(() => AppearanceSchema.parse({})),
  behavior: BehaviorSchema.prefault({}).catch(() => BehaviorSchema.parse({})),
  interaction: InteractionSchema.prefault({}).catch(() => InteractionSchema.parse({})),
  perception: PerceptionSchema.prefault({}).catch(() => PerceptionSchema.parse({})),
  ai: AiSchema.prefault({}).catch(() => AiSchema.parse({})),
  sound: SoundSchema.prefault({}).catch(() => SoundSchema.parse({})),
  companion: CompanionSchema.prefault({}).catch(() => CompanionSchema.parse({})),
  diagnostics: DiagnosticsSchema.prefault({}).catch(() => DiagnosticsSchema.parse({})),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/** Section-level partial patch sent by the settings UI. */
export type SettingsPatch = {
  [K in Exclude<keyof Settings, 'schemaVersion'>]?: Partial<Settings[K]>;
};

/**
 * Upgrades any previously stored settings object to the current schema version.
 * Unknown future versions are parsed best-effort (fields are individually defaulted).
 */
export function migrateSettings(raw: unknown): Settings {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  if (version < 1) {
    // v0 (pre-release prototypes) stored a flat object; nothing to carry over except known keys if present.
    obj.schemaVersion = 1;
  }
  if (version < 2) {
    // v1 -> v2: general.launchAtLogin (boolean, default false, always written) becomes the main-owned
    // loginItem section. v1 true is an explicit opt-in. v1 false is ambiguous (default vs. opt-out),
    // so it becomes 'unset' and is kept in v1Value; the login-item reconciler looks for evidence of a
    // real opt-out (Windows Startup apps state, app logs) before applying the new default.
    const general = obj.general !== null && typeof obj.general === 'object' && !Array.isArray(obj.general) ? { ...(obj.general as Record<string, unknown>) } : null;
    const v1 = general && typeof general.launchAtLogin === 'boolean' ? general.launchAtLogin : null;
    if (general) {
      delete general.launchAtLogin;
      obj.general = general;
    }
    if (obj.loginItem === undefined) {
      obj.loginItem = v1 === true ? { preference: 'enabled', decidedBy: 'migration', v1Value: true } : { preference: 'unset', decidedBy: 'default', v1Value: v1 };
    }
    obj.schemaVersion = 2;
  }
  if (version < 3) {
    // v2 -> v3 (ADR 0003 §9.3). Pure and idempotent (it runs on every launch until the first save):
    // every v2 key keeps its value; new keys get their defaults (never inferred from v2 values, so
    // mischief and work disruption are never raised); the activity preset is the one the governed
    // values match, else 'custom' (an explicit autonomy 0.8 / cursorPlay 0.7 is kept and shown as
    // Custom); the v2 opt-out list is untouched and the new tolerant list starts empty. Consent,
    // privacy, AI and login-item fields are not looked at.
    obj.schemaVersion = 3;
  }
  // The stored preset name is never trusted over the values (a hand-edited file, or a preset a
  // newer version added): it is re-derived from them, as main does after every patch.
  return withReconciledPreset(SettingsSchema.parse(obj));
}

/** `s` with behavior.activityPreset set to the preset its governed values match, else 'custom' (mutates and returns `s`). */
function withReconciledPreset(s: Settings): Settings {
  s.behavior.activityPreset = matchingPreset(s) ?? 'custom';
  return s;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export type PatchResult = { ok: true; settings: Settings } | { ok: false; error: string };

/**
 * Consent fields can only change through the explicit consent actions in main
 * (grant*Consent / revokeConsent). A plain settings patch from a renderer may turn
 * screen analysis OFF, but never on, and may never write the consent timestamp.
 * Returns an error message, or null if the patch is acceptable.
 */
/** Settings sections only the main process may change (renderer patches touching them are rejected). */
export const MAIN_OWNED_SECTIONS = ['loginItem'] as const;

/** Returns an error message when a renderer patch touches a main-owned section, else null. */
export function rejectMainOwnedPatch(patch: unknown): string | null {
  if (patch === null || typeof patch !== 'object') return null;
  for (const section of MAIN_OWNED_SECTIONS) {
    if (section in (patch as Record<string, unknown>)) return `${section} can only be changed through its dedicated actions`;
  }
  return null;
}

export function rejectConsentBypass(patch: unknown): string | null {
  if (patch === null || typeof patch !== 'object') return null;
  const perception = (patch as Record<string, unknown>)['perception'];
  if (perception === null || typeof perception !== 'object') return null;
  const p = perception as Record<string, unknown>;
  if ('consentAt' in p) return 'perception.consentAt can only be changed by the consent dialog';
  if ('visualMode' in p && p['visualMode'] !== 'off') return 'screen analysis can only be enabled through the consent dialog';
  return null;
}

/**
 * Applies a patch from an untrusted source (the settings renderer). Unlike loading
 * from disk, invalid values are rejected rather than silently defaulted: every
 * patched leaf must survive parsing unchanged.
 *
 * v1.2 (ADR 0003 §9.2): afterwards behavior.activityPreset is re-derived from the governed values
 * (the matching preset, else 'custom'), whatever the patch said. A renderer sends 'custom' with a
 * slider change and lets this decide (moving a slider back onto a preset's value selects that
 * preset again); a patch naming a preset must carry that preset's values (presetPatch), or it is
 * rejected.
 */
export function applySettingsPatch(current: Settings, patch: unknown): PatchResult {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };
  const next: Record<string, unknown> = { ...current };
  const touched: Array<[string, string, unknown]> = [];
  for (const [section, values] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (current as Record<string, unknown>)[section];
    if (section === 'schemaVersion' || cur === null || typeof cur !== 'object') return { ok: false, error: `unknown section: ${section}` };
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: `section ${section} must be an object` };
    const merged: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      touched.push([section, k, v]);
      // A leaf that is itself a small object (companion.events, companion.journal) merges one level
      // deep, so a patch may name one of its leaves; every other leaf is replaced whole.
      merged[k] = isPlainObject(v) && isPlainObject(merged[k]) ? { ...merged[k], ...v } : v;
    }
    next[section] = merged;
  }
  const parsed = SettingsSchema.parse(next);
  for (const [section, key, value] of touched) {
    const got = (parsed as unknown as Record<string, Record<string, unknown> | undefined>)[section]?.[key];
    if (isPlainObject(value) && isPlainObject(got)) {
      for (const [k, v] of Object.entries(value)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) return { ok: false, error: `invalid value for ${section}.${key}.${k}` };
    } else if (JSON.stringify(got) !== JSON.stringify(value)) return { ok: false, error: `invalid value for ${section}.${key}` };
  }
  const asked = parsed.behavior.activityPreset;
  withReconciledPreset(parsed);
  const named = touched.some(([section, key]) => section === 'behavior' && key === 'activityPreset');
  if (named && asked !== 'custom' && asked !== parsed.behavior.activityPreset) return { ok: false, error: 'invalid value for behavior.activityPreset' };
  return { ok: true, settings: parsed };
}
