// Global shortcut (Electron accelerator) rules shared by main and the settings UI.
// A global shortcut takes its key combination away from every other app, so it must
// include Control, Alt or Super (or be a rarely used F13-F24 key), use exactly one
// key, and not be a combination Windows keeps for itself.
// https://www.electronjs.org/docs/latest/api/accelerator

export const DEFAULT_TOGGLE_SHORTCUT = 'Control+Alt+Shift+C';
export const MAX_SHORTCUT_LENGTH = 64;

export type ShortcutModifier = 'Control' | 'CommandOrControl' | 'Alt' | 'AltGr' | 'Shift' | 'Super';

export type ShortcutError =
  | { code: 'empty' }
  | { code: 'too-long'; max: number }
  | { code: 'no-key' }
  | { code: 'unknown-part'; part: string }
  | { code: 'two-keys' }
  | { code: 'duplicate-modifier'; modifier: ShortcutModifier }
  | { code: 'needs-modifier' }
  | { code: 'reserved' };

export type ShortcutResult = { ok: true; accelerator: string } | { ok: false; error: ShortcutError };

const MODIFIER_ORDER: readonly ShortcutModifier[] = ['CommandOrControl', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

const MODIFIER_ALIASES: Readonly<Record<string, ShortcutModifier>> = {
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

/** Modifiers that make a combination safe to grab globally (Shift alone is not). */
const STRONG_MODIFIERS: ReadonlySet<ShortcutModifier> = new Set<ShortcutModifier>(['Control', 'CommandOrControl', 'Alt', 'AltGr', 'Super']);

const NAMED_KEYS: readonly string[] = [
  'Plus', 'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
];
const NAMED_KEY_LOOKUP: ReadonlyMap<string, string> = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
const PUNCTUATION_KEYS = new Set([')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '=', '<', ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', ']', '[', '|', '\\', '}', '"', "'"]);

function signature(parts: readonly string[]): string {
  return [...parts].sort().join('+');
}

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
const family = (m: ShortcutModifier): ShortcutModifier => (m === 'CommandOrControl' ? 'Control' : m);
const fail = (error: ShortcutError): ShortcutResult => ({ ok: false, error });

/** Validates and normalises a shortcut such as "ctrl + alt + shift + c" -> "Control+Alt+Shift+C". */
export function parseShortcut(text: string): ShortcutResult {
  const raw = text.trim();
  if (raw.length === 0) return fail({ code: 'empty' });
  if (raw.length > MAX_SHORTCUT_LENGTH) return fail({ code: 'too-long', max: MAX_SHORTCUT_LENGTH });
  const parts = raw.split('+').map((p) => p.trim());
  if (parts.length > 0 && parts[parts.length - 1] === '') return fail({ code: 'no-key' });
  const modifiers: ShortcutModifier[] = [];
  let key: string | null = null;
  for (const part of parts) {
    if (part === '') return fail({ code: 'unknown-part', part: '+' });
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      if (modifiers.some((m) => family(m) === family(mod))) return fail({ code: 'duplicate-modifier', modifier: mod });
      modifiers.push(mod);
      continue;
    }
    const k = canonicalKey(part);
    if (k === null) return fail({ code: 'unknown-part', part });
    if (key !== null) return fail({ code: 'two-keys' });
    key = k;
  }
  if (key === null) return fail({ code: 'no-key' });
  if (!modifiers.some((m) => STRONG_MODIFIERS.has(m)) && !isHighFunctionKey(key)) return fail({ code: 'needs-modifier' });
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.includes(m));
  const keyForSignature = key === 'Esc' ? 'Escape' : key === 'Return' ? 'Enter' : key;
  if (RESERVED.has(signature([...ordered.map(family), keyForSignature]))) return fail({ code: 'reserved' });
  return { ok: true, accelerator: [...ordered, key].join('+') };
}

/** True only for a valid shortcut already in canonical form (what main stores and registers). */
export function isSafeShortcut(accelerator: string): boolean {
  const r = parseShortcut(accelerator);
  return r.ok && r.accelerator === accelerator;
}
