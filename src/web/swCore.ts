// The service worker's decisions (1.4.0), pure and unit-testable (src/web/sw.ts is the thin entry).
// The worker keeps one versioned cache of the app's own files (the "shell") and serves them
// offline. It never caches anything else (no runtime caching), never touches a request outside its
// scope or origin, and on activation deletes only its own older caches: other apps on a shared
// origin (e.g. a github.io organization site) keep theirs.

/** Every cache this app creates starts with this; nothing else is ever deleted. */
export const SHELL_CACHE_PREFIX = 'gizecat-shell-';

/** The cache for one shell version (`<package version>-<content hash>`, set at build time). */
export function shellCacheName(version: string): string {
  return `${SHELL_CACHE_PREFIX}${version}`;
}

/** The request fields routeRequest reads (a Request satisfies it). */
export interface RouteInput {
  readonly method: string;
  readonly url: string;
  /** Request.mode: 'navigate' for page loads. */
  readonly mode: string;
}

export type Route =
  /** A page load inside the scope: the cached index.html (network if it is missing). */
  | { kind: 'navigate' }
  /** One of the shell's files: from the cache, network if it is missing. */
  | { kind: 'shell'; key: string }
  /** Not ours: the browser handles it as if there were no worker. */
  | { kind: 'pass' };

const PASS: Route = Object.freeze({ kind: 'pass' });

/**
 * Where a request goes. Only GETs on the worker's own origin inside its scope are ever answered;
 * `files` are the shell's paths relative to the scope (as precached).
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
  if (req.mode === 'navigate') return { kind: 'navigate' };
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname.slice(scope.pathname.length));
  } catch {
    return PASS;
  }
  if (rel === '') rel = 'index.html';
  return files.includes(rel) ? { kind: 'shell', key: rel } : PASS;
}

/** The caches to delete on activation: this app's (by prefix) other than the current one. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((n) => n.startsWith(SHELL_CACHE_PREFIX) && n !== current);
}
