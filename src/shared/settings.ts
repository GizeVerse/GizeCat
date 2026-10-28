import { z } from 'zod';
import { RENDER_STYLES, SKINS } from './cat';
import { DEFAULT_TOGGLE_SHORTCUT, MAX_SHORTCUT_LENGTH, parseShortcut } from './shortcut';

/**
 * User settings. Every field has a default and falls back to it when the stored
 * value is missing or invalid, so a partially corrupt file degrades field by field
 * instead of resetting everything.
 */
export const SETTINGS_SCHEMA_VERSION = 2;

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
});

const InteractionSchema = z.object({
  /** false = the cat is fully click-through (cannot be clicked, petted or dragged). */
  enabled: field(z.boolean(), true),
  petting: field(z.boolean(), true),
  dragging: field(z.boolean(), true),
  throwing: field(z.boolean(), true),
  /** 0 = gets annoyed quickly by repeated clicks, 1 = very tolerant. */
  patience: field(z.number().min(0).max(1), 0.5),
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
  return SettingsSchema.parse(obj);
}

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
 */
export function applySettingsPatch(current: Settings, patch: unknown): PatchResult {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };
  const next: Record<string, unknown> = { ...current };
  const touched: Array<[string, string, unknown]> = [];
  for (const [section, values] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (current as Record<string, unknown>)[section];
    if (section === 'schemaVersion' || cur === null || typeof cur !== 'object') return { ok: false, error: `unknown section: ${section}` };
    if (values === null || typeof values !== 'object' || Array.isArray(values)) return { ok: false, error: `section ${section} must be an object` };
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) touched.push([section, k, v]);
    next[section] = { ...(cur as Record<string, unknown>), ...(values as Record<string, unknown>) };
  }
  const parsed = SettingsSchema.parse(next);
  for (const [section, key, value] of touched) {
    const got = (parsed as unknown as Record<string, Record<string, unknown> | undefined>)[section]?.[key];
    if (JSON.stringify(got) !== JSON.stringify(value)) return { ok: false, error: `invalid value for ${section}.${key}` };
  }
  return { ok: true, settings: parsed };
}
