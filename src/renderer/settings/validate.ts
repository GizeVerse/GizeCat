// Pure client-side validation for free-text settings. Main re-validates every
// patch; these checks exist to give immediate, specific feedback.
import { isLoopbackUrl } from '../../core/perception/endpoint';
import { API_KEY_LENGTH, MAX_CAT_NAME_LENGTH, MAX_LIST_ENTRY_LENGTH, MAX_SHORTCUT_LENGTH, MAX_URL_LENGTH } from './catalog';
import { macModifierName } from './format';
import { S, type PlatformWording } from './strings';

const V = S.validation;

export type Validation<T = string> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const fail = <T = string>(error: string): Validation<T> => ({ ok: false, error });

// eslint-disable-next-line no-control-regex -- deliberately matching control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function stripControl(text: string): string {
  return text.replace(CONTROL_CHARS, '');
}

export function validateCatName(text: string): Validation {
  const value = stripControl(text).trim();
  if (value.length === 0) return fail(V.required);
  if (value.length > MAX_CAT_NAME_LENGTH) return fail(V.tooLong(MAX_CAT_NAME_LENGTH));
  return ok(value);
}

// ---------------------------------------------------------------------------
// Electron accelerators (https://www.electronjs.org/docs/latest/api/accelerator)

type Modifier = 'Control' | 'CommandOrControl' | 'Alt' | 'AltGr' | 'Shift' | 'Super';
const MODIFIER_ORDER: readonly Modifier[] = ['CommandOrControl', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  control: 'Control',
  ctrl: 'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  win: 'Super',
  windows: 'Super',
};

/**
 * macOS only (1.4.0): the Command key under its own name. Stored as Super, which Electron maps to the
 * Command key on macOS (shell/common/keyboard_util.cc) and which main's shortcut rules accept.
 */
const MAC_MODIFIER_ALIASES: ReadonlyMap<string, Modifier> = new Map<string, Modifier>([
  ['command', 'Super'],
  ['cmd', 'Super'],
]);

/** Modifiers that make a combination safe to grab globally (Shift alone is not). */
const STRONG_MODIFIERS: ReadonlySet<Modifier> = new Set<Modifier>(['Control', 'CommandOrControl', 'Alt', 'AltGr', 'Super']);

const NAMED_KEYS: readonly string[] = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];
const NAMED_KEY_LOOKUP: ReadonlyMap<string, string> = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
const PUNCTUATION_KEYS = new Set([')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '=', '<', ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'"]);

/** Combinations Windows keeps for itself (order-insensitive signatures). */
const RESERVED = new Set(
  [
    ['Control', 'Alt', 'Delete'],
    ['Control', 'Shift', 'Escape'],
    ['Control', 'Escape'],
    ['Alt', 'Tab'],
    ['Alt', 'Shift', 'Tab'],
    ['Alt', 'Escape'],
    ['Alt', 'F4'],
    ['Super', 'L'],
    ['Super', 'D'],
    ['Super', 'Tab'],
  ].map((parts) => signature(parts)),
);

function signature(parts: readonly string[]): string {
  return [...parts].sort().join('+');
}

function canonicalKey(part: string): string | null {
  if (part.length === 1) {
    if (/^[a-z]$/i.test(part)) return part.toUpperCase();
    if (/^[0-9]$/.test(part)) return part;
    return PUNCTUATION_KEYS.has(part) ? part : null;
  }
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(part);
  if (fn) return `F${fn[1] ?? ''}`;
  return NAMED_KEY_LOOKUP.get(part.toLowerCase()) ?? null;
}

const isHighFunctionKey = (key: string): boolean => /^F(1[3-9]|2[0-4])$/.test(key);

/**
 * Validates and normalises a shortcut such as "ctrl + alt + shift + c" -> "Control+Alt+Shift+C".
 * `wording` changes only the messages and, on macOS, also accepts Command and Cmd.
 */
export function validateShortcut(text: string, wording: PlatformWording = 'windows'): Validation {
  const mac = wording === 'mac';
  const unknownPart = wording === 'windows' ? V.shortcutUnknownPart : V.shortcutUnknownPartElsewhere;
  const raw = stripControl(text).trim();
  if (raw.length === 0) return fail(mac ? V.shortcutEmptyMac : V.shortcutEmpty);
  if (raw.length > MAX_SHORTCUT_LENGTH) return fail(V.tooLong(MAX_SHORTCUT_LENGTH));
  const parts = raw.split('+').map((p) => p.trim());
  if (parts.length > 0 && parts[parts.length - 1] === '') return fail(V.shortcutNoKey);
  const modifiers: Modifier[] = [];
  let key: string | null = null;
  for (const part of parts) {
    if (part === '') return fail(unknownPart('+'));
    const mod = MODIFIER_ALIASES[part.toLowerCase()] ?? (mac ? MAC_MODIFIER_ALIASES.get(part.toLowerCase()) : undefined);
    if (mod) {
      const family = (m: Modifier): Modifier => (m === 'CommandOrControl' ? 'Control' : m);
      if (modifiers.some((m) => family(m) === family(mod))) return fail(V.shortcutDuplicateModifier(mac ? macModifierName(mod) : mod));
      modifiers.push(mod);
      continue;
    }
    const k = canonicalKey(part);
    if (k === null) return fail(unknownPart(part));
    if (key !== null) return fail(V.shortcutTwoKeys);
    key = k;
  }
  if (key === null) return fail(V.shortcutNoKey);
  if (!modifiers.some((m) => STRONG_MODIFIERS.has(m)) && !isHighFunctionKey(key)) return fail(mac ? V.shortcutNeedsModifierMac : V.shortcutNeedsModifier);
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const keyForSignature = key === 'Esc' ? 'Escape' : key === 'Return' ? 'Enter' : key;
  const sigParts = [...ordered.map((m) => (m === 'CommandOrControl' ? 'Control' : m)), keyForSignature];
  if (RESERVED.has(signature(sigParts))) return fail(wording === 'windows' ? V.shortcutReserved : V.shortcutReservedElsewhere);
  return ok([...ordered, key].join('+'));
}

// ---------------------------------------------------------------------------
// Privacy exclusion lists

const FORBIDDEN_FILENAME_CHARS = /[\\/:*?"<>|]/;

function listGuard(existing: readonly string[], max: number, value: string): string | null {
  if (existing.some((e) => e.toLowerCase() === value)) return V.duplicate;
  if (existing.length >= max) return V.listFull(max);
  return null;
}

/** Executable basename, lower-cased, ".exe" appended when missing. */
export function validateProcessName(text: string, existing: readonly string[], max: number): Validation {
  let value = stripControl(text).trim().toLowerCase();
  if (value.length === 0) return fail(V.required);
  if (FORBIDDEN_FILENAME_CHARS.test(value) || value.startsWith('.')) return fail(V.processInvalid);
  if (!value.endsWith('.exe')) value = `${value}.exe`;
  if (value.length > MAX_LIST_ENTRY_LENGTH) return fail(V.tooLong(MAX_LIST_ENTRY_LENGTH));
  const guard = listGuard(existing, max, value);
  return guard === null ? ok(value) : fail(guard);
}

/** Case-insensitive title substring, stored lower-cased. */
export function validateTitlePattern(text: string, existing: readonly string[], max: number): Validation {
  const value = stripControl(text).trim().replace(/\s+/g, ' ').toLowerCase();
  if (value.length === 0) return fail(V.required);
  if (value.length < 2) return fail(V.patternTooShort);
  if (value.length > MAX_LIST_ENTRY_LENGTH) return fail(V.tooLong(MAX_LIST_ENTRY_LENGTH));
  const guard = listGuard(existing, max, value);
  return guard === null ? ok(value) : fail(guard);
}

// ---------------------------------------------------------------------------
// AI connection

export interface BaseUrlInfo {
  url: string;
  /** Main's own rule (isLoopbackUrl), so the "not on this PC" hints match what main enforces. */
  loopback: boolean;
}

export function validateBaseUrl(text: string): Validation<BaseUrlInfo> {
  const value = stripControl(text).trim();
  if (value.length === 0) return fail(V.required);
  if (value.length > MAX_URL_LENGTH) return fail(V.tooLong(MAX_URL_LENGTH));
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(V.urlInvalid);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail(V.urlInvalid);
  if (parsed.username !== '' || parsed.password !== '') return fail(V.urlCredentials);
  return ok({ url: value, loopback: isLoopbackUrl(value) });
}

/** Model identifiers: optional (empty clears), no whitespace. */
export function validateModel(text: string, max: number): Validation {
  const value = stripControl(text).trim();
  if (/\s/.test(value)) return fail(V.modelInvalid);
  if (value.length > max) return fail(V.tooLong(max));
  return ok(value);
}

export function validateApiKey(text: string): Validation {
  const value = stripControl(text).trim();
  if (/\s/.test(value)) return fail(V.apiKeyWhitespace);
  if (value.length < API_KEY_LENGTH.min || value.length > API_KEY_LENGTH.max) return fail(V.apiKeyLength);
  return ok(value);
}
