// Endpoint parsing for AI providers. "Loopback" is decided on the WHATWG-parsed
// host only (never by substring), so look-alikes such as localhost.evil.com,
// 127.0.0.1.nip.io or user@host forms are treated as remote.
import { hasInvisibleOrSpace } from './text';

export type ParsedEndpoint = { ok: true; url: URL; loopback: boolean } | { ok: false; error: string };

export function parseEndpoint(raw: string): ParsedEndpoint {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: 'No endpoint URL is set.' };
  if (text.length > 200) return { ok: false, error: 'The endpoint URL is too long.' };
  if (hasInvisibleOrSpace(text)) return { ok: false, error: 'The endpoint URL contains invalid characters.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'The endpoint URL is not valid.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: 'The endpoint must use http or https.' };
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'The endpoint URL must not contain a user name or password.' };
  if (url.hostname === '') return { ok: false, error: 'The endpoint URL has no host.' };
  url.hash = '';
  url.search = '';
  return { ok: true, url, loopback: isLoopbackHostname(url.hostname) };
}

export function isLoopbackUrl(raw: string): boolean {
  const p = parseEndpoint(raw);
  return p.ok && p.loopback;
}

/**
 * `hostname` as produced by the WHATWG URL parser (lower-cased, IPv4 shorthand
 * such as 0x7f.1 or 2130706433 already normalised, IPv6 in brackets).
 * Only `localhost`, 127.0.0.0/8, ::1 and IPv4-mapped 127/8 count. A trailing dot
 * ("localhost.") is a DNS name and is treated as remote.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  const v4 = parseIPv4(h);
  if (v4) return v4[0] === 127;
  if (h.startsWith('[') && h.endsWith(']')) {
    const groups = parseIPv6(h.slice(1, -1));
    if (!groups) return false;
    const zeroPrefix5 = groups.slice(0, 5).every((g) => g === 0);
    if (zeroPrefix5 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return true;
    // ::ffff:127.x.y.z (IPv4-mapped)
    if (zeroPrefix5 && groups[5] === 0xffff && ((groups[6] ?? 0) >> 8) === 127) return true;
    return false;
  }
  return false;
}

function parseIPv4(h: string): [number, number, number, number] | null {
  const parts = h.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    out.push(v);
  }
  return out as [number, number, number, number];
}

function parseIPv6(s: string): number[] | null {
  if (s.includes('%')) return null;
  let text = s;
  // Embedded dotted IPv4 tail (the WHATWG serialiser emits hex, but accept both).
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0] ?? '');
  const rest = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/** Appends a path to an endpoint's existing path ("http://h:1/v1" + "/models" -> "http://h:1/v1/models"). */
export function joinEndpoint(base: URL, path: string): URL {
  const u = new URL(base.href);
  u.pathname = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  u.search = '';
  u.hash = '';
  return u;
}

/**
 * The server root behind an OpenAI-compatible base URL: a trailing "/v1" path
 * segment is dropped ("http://127.0.0.1:11434/v1" -> "http://127.0.0.1:11434/"),
 * which is where Ollama serves its native API next to its /v1 API.
 */
export function openAiServerRoot(base: URL): URL {
  const u = new URL(base.href);
  u.pathname = base.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '') || '/';
  u.search = '';
  u.hash = '';
  return u;
}

/** Ollama "cloud" models (e.g. gpt-oss:120b-cloud) are proxied to ollama.com even via a local server. */
export function isOllamaCloudModel(model: string): boolean {
  return /(^|[:-])cloud$/i.test(model.trim());
}
