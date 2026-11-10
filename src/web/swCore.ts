// The service worker's decisions (1.4.0), pure and unit-testable (src/web/sw.ts is the thin entry).
// The worker keeps one versioned cache of the app's own files (the "shell") and serves them
// offline. It never caches anything else (no runtime caching), never touches a request outside its
// scope or origin, answers only the app's own pages (the scope root, its index.html and the static
// licenses and privacy pages), and on activation deletes only older caches of its own scope: other
// apps on a shared origin (e.g. a github.io organization site), and other GizeCat copies at other
// paths, keep theirs.

/** Every cache this app creates starts with this; nothing else is ever deleted. */
export const SHELL_CACHE_PREFIX = 'gizecat-shell-';

/** The app's other pages (third-party notices and privacy statement, linked from the sheet): they open offline too. */
export const STATIC_PAGES: readonly string[] = ['licenses.html', 'privacy.html'];

/**
 * A short, stable hash of the worker's registration scope (FNV-1a, 32 bits, 8 lowercase hex
 * digits). CacheStorage is shared per origin, so the scope in the cache name keeps two copies of
 * GizeCat at different paths of one origin from deleting each other's caches.
 */
export function scopeHash(scopeUrl: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < scopeUrl.length; i++) {
    h ^= scopeUrl.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The start of every cache name of one scope: `gizecat-shell-<scope hash>-`. */
export function scopeCachePrefix(scopeUrl: string): string {
  return `${SHELL_CACHE_PREFIX}${scopeHash(scopeUrl)}-`;
}

/**
 * The cache for one shell version in one scope: `gizecat-shell-<scope hash>-<version>`, where the
 * version (`<package version>-<content hash>`) is set at build time.
 */
export function shellCacheName(scopeUrl: string, version: string): string {
  return `${scopeCachePrefix(scopeUrl)}${version}`;
}

/** The request fields routeRequest reads (a Request satisfies it). */
export interface RouteInput {
  readonly method: string;
  readonly url: string;
  /** Request.mode: 'navigate' for page loads. */
  readonly mode: string;
}

export type Route =
  /** A load of the app's own page (the scope root or its index.html): the cached index.html (network if it is missing). */
  | { kind: 'navigate' }
  /** One of the shell's files: from the cache, network if it is missing. */
  | { kind: 'shell'; key: string }
  /** Not ours: the browser handles it as if there were no worker. */
  | { kind: 'pass' };

const PASS: Route = Object.freeze({ kind: 'pass' });

/**
 * Where a request goes. Only GETs on the worker's own origin inside its scope are ever answered;
 * `files` are the shell's paths relative to the scope (as precached). A page load is answered
 * only for the app's own pages (the scope root or index.html under it, and its static pages);
 * every other page load in the scope (another site on the same origin, a nested copy, the host's
 * 404 page) goes to the network untouched.
 */
export function routeRequest(req: RouteInput, scopeUrl: string, files: readonly string[]): Route {
  if (req.method !== 'GET') return PASS;
  let url: URL;
  let scope: URL;
  try {
    url = new URL(req.url);
    scope = new URL(scopeUrl);
  } catch {
    return PASS;
  }
  if (url.origin !== scope.origin) return PASS;
  if (!url.pathname.startsWith(scope.pathname)) return PASS;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(scope.pathname.length));
  } catch {
    return PASS;
  }
  if (req.mode === 'navigate') {
    if (rel === '' || rel === 'index.html') return { kind: 'navigate' };
    return STATIC_PAGES.includes(rel) && files.includes(rel) ? { kind: 'shell', key: rel } : PASS;
  }
  if (rel === '') rel = 'index.html';
  return files.includes(rel) ? { kind: 'shell', key: rel } : PASS;
}

/**
 * The caches to delete on activation: this scope's (by its prefix) other than the current one.
 * Caches of other scopes (another GizeCat copy on the same origin) and of other apps are kept.
 */
export function staleCaches(names: readonly string[], scopeUrl: string, current: string): string[] {
  const prefix = scopeCachePrefix(scopeUrl);
  return names.filter((n) => n.startsWith(prefix) && n !== current);
}

/**
 * A response that can be stored and used to answer any request, navigations included: a
 * redirected one (e.g. a host that answers /index.html with a redirect to /) is rebuilt with the
 * same body, status and headers, because a navigation answered with a redirected response is a
 * network error. Any other response is returned as it is.
 */
export function withoutRedirect(response: Response): Response {
  if (!response.redirected) return response;
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
