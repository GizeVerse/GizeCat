// desktop-cat:// — serves the bundled renderer files (out/renderer/**) and nothing
// else, with a strict CSP. Renderers never load file:// or remote content.
import fs from 'node:fs';
import path from 'node:path';
import { protocol, type Session } from 'electron';
import type { Logger } from './contracts';
import { APP_SCHEME } from '../shared/ipc';

export const APP_HOST = 'app';
const ROUTE_PREFIX = '/renderer/';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=()',
};

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Must run before app 'ready'. */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      // corsEnabled lets module scripts load from our own origin; responses carry no
      // Access-Control-Allow-Origin, so cross-origin reads stay blocked.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, codeCache: true },
    },
  ]);
}

export type ResolveResult = { ok: true; filePath: string; mime: string } | { ok: false; status: 400 | 403 | 404 };

/**
 * Maps a desktop-cat:// URL to a file under `rendererRoot`. Rejects anything that
 * could escape the root: encoded or literal "..", ".", empty segments, backslashes,
 * NUL, drive letters/colons, absolute paths, unknown hosts and unknown file types.
 */
export function resolveAppRequest(rawUrl: string, rendererRoot: string): ResolveResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400 };
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== APP_HOST || url.port !== '' || url.username !== '' || url.password !== '') {
    return { ok: false, status: 404 };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  if (/[\0\\:]/.test(decoded) || /%(?:2e|2f|5c|00)/i.test(decoded)) return { ok: false, status: 403 };
  if (!decoded.startsWith(ROUTE_PREFIX)) return { ok: false, status: 404 };
  const rel = decoded.slice(ROUTE_PREFIX.length);
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.trim() !== s)) return { ok: false, status: 403 };
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return { ok: false, status: 403 };
  const root = path.resolve(rendererRoot);
  const full = path.resolve(root, ...segments);
  const relative = path.relative(root, full);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, status: 403 };
  const mime = MIME_TYPES[path.extname(full).toLowerCase()];
  if (!mime) return { ok: false, status: 404 };
  return { ok: true, filePath: full, mime };
}

function errorResponse(status: number): Response {
  return new Response(null, { status, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function installAppProtocol(ses: Session, rendererRoot: string, logger: Logger): void {
  ses.protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405);
    const r = resolveAppRequest(request.url, rendererRoot);
    if (!r.ok) {
      logger.warn('blocked app request', { status: r.status, path: safePath(request.url) });
      return errorResponse(r.status);
    }
    try {
      const body = await fs.promises.readFile(r.filePath);
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'Content-Type': r.mime, 'Content-Length': String(body.byteLength) },
      });
    } catch (err) {
      const code = err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : '';
      if (code === 'ENOENT' || code === 'EISDIR') {
        logger.warn('app file not found', { path: safePath(request.url) });
        return errorResponse(404);
      }
      logger.error('serving app file failed', { path: safePath(request.url), error: err });
      return errorResponse(500);
    }
  });
}

function safePath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.slice(0, 200);
  } catch {
    return '[unparseable]';
  }
}
