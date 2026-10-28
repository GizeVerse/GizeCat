// Minimal JSON-over-HTTP for AI providers: one deadline for the whole exchange,
// external cancellation, a hard response size cap, and no redirects.
import { replaceInvisible } from '../../../core/perception/text';
import type { AdapterFailure, AdapterFailureKind } from './types';

export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface JsonRequest {
  fetchImpl: typeof fetch;
  method: 'GET' | 'POST';
  url: URL;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

export type TransportFailureKind = 'timeout' | 'aborted' | 'network' | 'redirect' | 'too-large' | 'http' | 'bad-json';

export type JsonResponse =
  | { ok: true; status: number; json: unknown; latencyMs: number }
  | { ok: false; kind: TransportFailureKind; status?: number; providerMessage?: string; providerType?: string; latencyMs: number };

class BodyTooLarge extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  if (!res.body) return '';
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function providerError(json: unknown): { message?: string; type?: string } {
  if (!isObj(json)) return {};
  const e = json.error;
  if (typeof e === 'string') return { message: e };
  if (isObj(e)) return { message: typeof e.message === 'string' ? e.message : undefined, type: typeof e.type === 'string' ? e.type : undefined };
  return { message: typeof json.message === 'string' ? json.message : undefined };
}

export async function requestJson(req: JsonRequest): Promise<JsonResponse> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (req.signal?.aborted) return { ok: false, kind: 'aborted', latencyMs: 0 };

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      ctrl.abort();
    },
    Math.max(1, req.timeoutMs),
  );
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  const failKind = (): TransportFailureKind => (timedOut ? 'timeout' : req.signal?.aborted ? 'aborted' : 'network');

  try {
    let res: Response;
    try {
      const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
      if (req.body !== undefined) headers['content-type'] = 'application/json';
      res = await req.fetchImpl(req.url.href, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: ctrl.signal,
        redirect: 'manual',
      });
    } catch {
      return { ok: false, kind: failKind(), latencyMs: elapsed() };
    }

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, kind: 'redirect', status: res.status, latencyMs: elapsed() };
    }

    let text: string;
    try {
      text = await readCapped(res, maxBytes);
    } catch (e) {
      if (e instanceof BodyTooLarge) return { ok: false, kind: 'too-large', status: res.status, latencyMs: elapsed() };
      return { ok: false, kind: failKind(), status: res.status, latencyMs: elapsed() };
    }

    let json: unknown;
    let parsed = true;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }

    if (res.status < 200 || res.status >= 300) {
      const pe = parsed ? providerError(json) : {};
      return { ok: false, kind: 'http', status: res.status, providerMessage: pe.message, providerType: pe.type, latencyMs: elapsed() };
    }
    if (!parsed) return { ok: false, kind: 'bad-json', status: res.status, latencyMs: elapsed() };
    return { ok: true, status: res.status, json, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Makes a provider-supplied error message safe to show: no control characters,
 * no long base64/token-like runs, no secrets, <= 160 chars.
 */
export function sanitizeProviderMessage(raw: string | undefined, secrets: readonly string[] = []): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = replaceInvisible(raw);
  for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join('[redacted]');
  s = s
    .replace(/\b(?:sk|key|api|token)[-_][A-Za-z0-9_-]{6,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[...]')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length === 0) return undefined;
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

export function failure(kind: AdapterFailureKind, message: string, latencyMs: number, status?: number): AdapterFailure {
  return status === undefined ? { ok: false, kind, message, latencyMs } : { ok: false, kind, message, status, latencyMs };
}

/** Maps a transport failure to a short message; adapters handle provider-specific statuses first. */
export function transportFailure(
  res: Extract<JsonResponse, { ok: false }>,
  ctx: { label: string; timeoutMs: number; maxBytes?: number; secrets?: readonly string[]; cloud?: boolean },
): AdapterFailure {
  const { label } = ctx;
  switch (res.kind) {
    case 'timeout':
      return failure('timeout', `${label} did not answer within ${Math.round(ctx.timeoutMs / 1000)} s.`, res.latencyMs);
    case 'aborted':
      return failure('aborted', 'The request was cancelled.', res.latencyMs);
    case 'network':
      return failure(
        'network',
        ctx.cloud ? `Could not reach ${label}. Check the internet connection.` : `Could not connect to ${label}. Is it running?`,
        res.latencyMs,
      );
    case 'redirect':
      return failure('redirect', `${label} answered with a redirect; redirects are not followed.`, res.latencyMs, res.status);
    case 'too-large':
      return failure('too-large', `${label} sent an answer larger than ${Math.round((ctx.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES) / 1024)} KB.`, res.latencyMs);
    case 'bad-json':
      return failure('bad-response', `${label} sent an answer that is not valid JSON.`, res.latencyMs, res.status);
    case 'http': {
      const status = res.status ?? 0;
      const detail = sanitizeProviderMessage(res.providerMessage, ctx.secrets);
      if (status === 401 || status === 403) return failure('auth', `${label} rejected the credentials (HTTP ${status}).`, res.latencyMs, status);
      if (status === 404) return failure('not-found', `${label} reported "not found" (HTTP 404)${detail ? `: ${detail}` : '.'}`, res.latencyMs, status);
      if (status === 413) return failure('http', `${label} rejected the image as too large.`, res.latencyMs, status);
      if (status === 429) return failure('rate-limited', `${label} is rate limiting requests; try again later.`, res.latencyMs, status);
      if (status >= 500) return failure('http', `${label} reported a server error (HTTP ${status}).`, res.latencyMs, status);
      return failure('http', `${label} rejected the request (HTTP ${status})${detail ? `: ${detail}` : '.'}`, res.latencyMs, status);
    }
  }
}
