// Redaction applied to every log entry before it is buffered or written, and again
// to diagnostics exports. Errs on the side of removing too much.

export const REDACTED = '[REDACTED]';

/** Keys whose values are never logged, whatever they contain (compared case-insensitively). */
const SENSITIVE_KEYS = new Set([
  'title',
  'windowtitle',
  'windowtitles',
  'titles',
  'caption',
  'password',
  'passwd',
  'secret',
  'secrets',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'api-key',
  'x-api-key',
  'key',
  'authorization',
  'cookie',
  'set-cookie',
  'imagedataurl',
  'image',
  'clipboard',
]);

const STRING_RULES: Array<[RegExp, string]> = [
  // data: URLs (screen frames, images) — never logged in any form.
  [/\bdata:(?:[a-z0-9.+-]+\/[a-z0-9.+-]+)?(?:;[^,\s"']*)?,[^\s"')]*/gi, `data:${REDACTED}`],
  // Header-style secrets: "Authorization: Bearer xyz", "x-api-key=abc", JSON "apiKey":"abc".
  [/\b(authorization|x-api-key|api[-_]?key|access[-_]?token|bearer)("?\s*[:=]\s*"?)(?:bearer\s+)?[^\s",;}]+/gi, `$1$2${REDACTED}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Provider-style keys: sk-..., sk-ant-..., ghp_..., xox?-...
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, `sk-${REDACTED}`],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // Long hex runs (hashes, raw keys).
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED],
];

/** Long base64/base64url-looking runs (tokens, ciphertext). */
const BASE64_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

const mixedClasses = (s: string): boolean => /[0-9]/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

function looksLikeToken(run: string): boolean {
  const core = run.replace(/=+$/, '');
  // Forward-slash paths are long runs too; only flag them when a segment itself looks random.
  if (core.includes('/')) return core.split('/').some((seg) => seg.length >= 24 && mixedClasses(seg));
  return core.length >= 64 || mixedClasses(core);
}

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of STRING_RULES) out = out.replace(re, replacement);
  out = out.replace(BASE64_RUN, (m) => (looksLikeToken(m) ? REDACTED : m));
  return out;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

/** Deep-copies `value`, removing sensitive keys and redacting strings. Never throws. */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const r = redactString(value);
    return r.length > MAX_STRING ? `${r.slice(0, MAX_STRING)}…(+${r.length - MAX_STRING})` : r;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return undefined;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack).split('\n').slice(0, 12).join('\n') : undefined,
    };
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) arr.push(`…(+${value.length - MAX_ARRAY})`);
    return arr;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}
