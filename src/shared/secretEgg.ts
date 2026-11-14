// Generic, value-free runtime for an owner-provisioned secret name feature.
//
// This file contains NO trigger word and NO message, and neither can be derived from it. The owner
// seals both locally (scripts/egg-provision.mjs, which imports this very module so the two sides can
// never disagree) into one encrypted payload that the build embeds. Design, in short:
//
//   key        = PBKDF2-HMAC-SHA256(normalized trigger, random salt, `iter` rounds)  -> AES-256 key
//   ciphertext = AES-256-GCM(message padded to a fixed size), AAD binds the format and the rounds
//
// The app therefore stores NO key and NO trigger: "does this name match" is "does this name decrypt
// the payload". A wrong name fails the GCM tag; there is no comparison against a stored value and
// nothing for a diagnostic view to leak. A public-key scheme was considered and rejected: the app
// would have to embed the private key (extractable by anyone holding the binary) and still hold the
// trigger or a hash of it, which is strictly weaker.
//
// Honest limit: a person holding the build can still guess names offline against the payload, at
// the cost of one PBKDF2 run per guess. The `iter` cost slows that down but a short, guessable
// trigger remains guessable. Both algorithms are standard WebCrypto primitives (no custom crypto).
//
// Runs unchanged in Node (sealing, main process) and in browsers/WebViews (opening).

/** Payload format version. */
export const EGG_FORMAT = 1;
/** PBKDF2 rounds the provisioning tool uses by default. */
export const EGG_DEFAULT_ITERATIONS = 800_000;
/** Bounds the runtime accepts, so a malformed payload cannot make a device grind for minutes. */
export const EGG_MIN_ITERATIONS = 200_000;
export const EGG_MAX_ITERATIONS = 3_000_000;
/** Longest message, in UTF-16 code units (it is shown under a name field). */
export const EGG_MAX_MESSAGE_UNITS = 400;
/** Longest name that is ever tried (settings cap names at 24 units; a wider cap costs nothing). */
export const EGG_MAX_NAME_UNITS = 64;

const SALT_BYTES = 16;
const IV_BYTES = 12;
/** Plaintext is padded to this size so the ciphertext length reveals nothing about the message. */
const PLAIN_BYTES = 2048;
const AAD_TAG = 'gizecat-egg';

/** Parsed, structurally valid payload (not yet proven to open with any name). */
export interface EggPayload {
  readonly v: typeof EGG_FORMAT;
  readonly kdf: 'pbkdf2-sha256';
  readonly i: number;
  readonly s: string;
  readonly n: string;
  readonly c: string;
}

export type EggState = { readonly active: false } | { readonly active: true; readonly message: string };
export const EGG_OFF: EggState = Object.freeze({ active: false });

/**
 * One consistent, locale-independent normalisation for the trigger and every entered name:
 * trim surrounding whitespace, NFKC (compatibility forms, full-width letters, ligatures, no-break
 * spaces become their plain equivalents), lower-case (locale-independent: no Turkish rules), drop the
 * combining dot that lower-casing a dotted capital I leaves behind, NFC. The WHOLE result must be
 * equal; there is no substring or prefix matching. Dotless i stays distinct from i.
 */
export function normalizeEggName(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase().replace(/̇/g, '').normalize('NFC');
}

// Structural WebCrypto types: src/shared is built without the DOM lib, and this keeps it platform-agnostic.
interface SubtleLike {
  importKey(format: 'raw', data: Uint8Array, algorithm: string, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveKey(algorithm: { name: string; hash: string; salt: Uint8Array; iterations: number }, base: unknown, derived: { name: string; length: number }, extractable: boolean, usages: string[]): Promise<unknown>;
  encrypt(algorithm: { name: string; iv: Uint8Array; additionalData: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: { name: string; iv: Uint8Array; additionalData: Uint8Array }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle?: SubtleLike;
  getRandomValues(array: Uint8Array): Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function subtle(): SubtleLike | null {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  return c && c.subtle ? c.subtle : null;
}

function aad(iterations: number): Uint8Array {
  const tag = enc.encode(AAD_TAG);
  const out = new Uint8Array(tag.length + 5);
  out.set(tag, 0);
  out[tag.length] = EGG_FORMAT;
  new DataView(out.buffer).setUint32(tag.length + 1, iterations, false);
  return out;
}

async function deriveKey(normalized: string, salt: Uint8Array, iterations: number, usage: 'encrypt' | 'decrypt'): Promise<unknown> {
  const s = subtle();
  if (!s) return null;
  const material = await s.importKey('raw', enc.encode(normalized), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Structural validation only. Anything else (absent, malformed, wrong version, odd sizes) -> null: the feature stays off. */
export function parseEggPayload(text: string | undefined | null): EggPayload | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 16384) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== EGG_FORMAT || o.kdf !== 'pbkdf2-sha256') return null;
  if (typeof o.i !== 'number' || !Number.isInteger(o.i) || o.i < EGG_MIN_ITERATIONS || o.i > EGG_MAX_ITERATIONS) return null;
  const s = typeof o.s === 'string' ? fromBase64(o.s) : null;
  const n = typeof o.n === 'string' ? fromBase64(o.n) : null;
  const c = typeof o.c === 'string' ? fromBase64(o.c) : null;
  if (!s || s.length !== SALT_BYTES || !n || n.length !== IV_BYTES || !c || c.length !== PLAIN_BYTES + 16) return null;
  return { v: EGG_FORMAT, kdf: 'pbkdf2-sha256', i: o.i, s: o.s as string, n: o.n as string, c: o.c as string };
}

/**
 * Seals `message` so that only the normalised `trigger` opens it. Used by the provisioning tool;
 * tree-shaken out of the app bundles. Throws on unusable input (empty, too long) without echoing it.
 */
export async function sealEggPayload(trigger: string, message: string, iterations: number = EGG_DEFAULT_ITERATIONS): Promise<string> {
  const normalized = normalizeEggName(trigger);
  if (normalized.length === 0) throw new Error('the trigger is empty after normalisation');
  if (normalized.length > EGG_MAX_NAME_UNITS) throw new Error('the trigger is too long');
  if (message.length === 0 || message.length > EGG_MAX_MESSAGE_UNITS) throw new Error(`the message must be 1..${EGG_MAX_MESSAGE_UNITS} UTF-16 code units`);
  if (!Number.isInteger(iterations) || iterations < EGG_MIN_ITERATIONS || iterations > EGG_MAX_ITERATIONS) throw new Error('iterations out of range');
  const s = subtle();
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!s || !c) throw new Error('WebCrypto is unavailable');
  const body = enc.encode(message);
  if (body.length > PLAIN_BYTES - 2) throw new Error('the message is too long');
  const plain = new Uint8Array(PLAIN_BYTES);
  plain[0] = (body.length >> 8) & 0xff;
  plain[1] = body.length & 0xff;
  plain.set(body, 2);
  const salt = c.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = c.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(normalized, salt, iterations, 'encrypt');
  if (!key) throw new Error('WebCrypto is unavailable');
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(iterations) }, key, plain));
  plain.fill(0);
  body.fill(0);
  const payload = { v: EGG_FORMAT, kdf: 'pbkdf2-sha256', i: iterations, s: toBase64(salt), n: toBase64(iv), c: toBase64(ct) };
  return JSON.stringify(payload);
}

/** The message if `name` opens `payload`, else null. Never throws; a wrong name is an ordinary null. */
export async function openEggPayload(payload: EggPayload, name: string): Promise<string | null> {
  const normalized = normalizeEggName(name);
  if (normalized.length === 0 || normalized.length > EGG_MAX_NAME_UNITS) return null;
  try {
    const s = subtle();
    const salt = fromBase64(payload.s);
    const iv = fromBase64(payload.n);
    const ct = fromBase64(payload.c);
    if (!s || !salt || !iv || !ct) return null;
    const key = await deriveKey(normalized, salt, payload.i, 'decrypt');
    if (!key) return null;
    const plain = new Uint8Array(await s.decrypt({ name: 'AES-GCM', iv: iv, additionalData: aad(payload.i) }, key, ct));
    const len = (plain[0]! << 8) | plain[1]!;
    if (len < 1 || len > plain.length - 2) return null;
    const text = dec.decode(plain.subarray(2, 2 + len));
    plain.fill(0);
    return text.length > 0 && text.length <= EGG_MAX_MESSAGE_UNITS ? text : null;
  } catch {
    return null;
  }
}

/** What the hosts depend on: a boolean-plus-message answer for a name, and nothing else. */
export interface EggMatcher {
  /** True when a structurally valid payload is present (the only thing diagnostics may say). */
  readonly available: boolean;
  evaluate(name: string): Promise<EggState>;
}

export function createEggMatcher(payloadText: string | undefined | null): EggMatcher {
  const payload = parseEggPayload(payloadText);
  return {
    available: payload !== null,
    async evaluate(name: string): Promise<EggState> {
      if (!payload) return EGG_OFF;
      const message = await openEggPayload(payload, name);
      return message === null ? EGG_OFF : { active: true, message };
    },
  };
}

export interface EggTracker {
  /** The latest known result; `active` is also what the cat's accessory follows. */
  state(): EggState;
  /** Call with the current cat name on start, on every edit and after a profile restore. */
  setName(name: string): void;
  dispose(): void;
}

/**
 * Keeps the egg state in step with the name. Leaving a match is IMMEDIATE (synchronous, no key
 * derivation involved); entering one waits `delayMs` for typing to settle, then runs one derivation.
 * Stale results (the name changed while deriving) are dropped. `onChange` fires only on a change.
 */
export function createEggTracker(matcher: EggMatcher, onChange: (s: EggState) => void, delayMs = 200): EggTracker {
  let current: EggState = EGG_OFF;
  let matchedKey: string | null = null;
  let wanted = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let disposed = false;

  const set = (next: EggState): void => {
    const changed = current.active !== next.active || (current.active && next.active && current.message !== next.message);
    current = next;
    if (changed) onChange(next);
  };

  return {
    state: () => current,
    setName(name: string): void {
      if (disposed) return;
      const key = normalizeEggName(name);
      // The same name again (a settings echo, a restore of the same profile): its result is pending or settled.
      if (key === wanted) return;
      wanted = key;
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (current.active && key !== matchedKey) {
        matchedKey = null;
        set(EGG_OFF);
      }
      if (!matcher.available || key.length === 0 || key.length > EGG_MAX_NAME_UNITS || key === matchedKey) return;
      const mine = generation;
      timer = setTimeout(() => {
        timer = null;
        void matcher.evaluate(name).then((r) => {
          if (disposed || mine !== generation) return;
          matchedKey = r.active ? key : null;
          set(r);
        });
      }, delayMs);
    },
    dispose(): void {
      disposed = true;
      generation++;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      matchedKey = null;
      current = EGG_OFF;
    },
  };
}
