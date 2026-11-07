// The GizeCat web host's shared facts, in one place (1.4.0):
// - WEB_CSP: the page's Content-Security-Policy. src/web/index.html carries it as a meta tag
//   (scripts/build.mjs fails a production build whose meta differs), scripts/serve-web.mjs sends it
//   as a header, and tests/web/web.spec.ts checks both.
// - SW_CSP: the service worker's own policy (a worker's CSP comes from its own response, not from
//   the page): it may read the app's own files and nothing else.
// - the production checks that build.mjs and package-web.mjs both run on out/web: the required file
//   set, no test hook and no key-listener text in any text file, the CSP meta, and a service worker
//   whose precache list equals the files on disk.
// Pure Node (node:fs, node:path); importing it has no side effects.
import fs from 'node:fs';
import path from 'node:path';

/**
 * The page's policy. 'self' only: no inline code, no eval, no data: images. manifest-src and
 * worker-src are the 1.4.0 additions for the installable app (the manifest and sw.js, both
 * same-origin). connect-src 'none': the page itself can make no request (fetch, XHR, WebSocket,
 * beacons); the service worker's fetches are governed by SW_CSP instead.
 */
export const WEB_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

/** sw.js's policy wherever response headers can be set (serve-web; optional on other hosts). */
export const SW_CSP = "default-src 'none'; connect-src 'self'";

/** Strings that must never ship in out/web (M5): the test hook, and key listeners. */
export const WEB_FORBIDDEN = ['__gizecatWebTest', 'keydown', 'keyup', 'keypress'];

/** Text files the forbidden-string scan reads (everything else is binary, e.g. the icons). */
export const WEB_TEXT_EXTENSIONS = ['.html', '.js', '.css', '.webmanifest', '.json', '.txt'];

/** Every production web build has exactly these files ('/' separators, relative to out/web). */
export const WEB_SHELL_FILES = Object.freeze([
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'index.html',
  'main.js',
  'manifest.webmanifest',
  'sw.js',
  'web.css',
]);

/** The service worker's file name; it is never in its own precache list. */
export const SW_FILE = 'sw.js';

/** All files below `dir`, recursively, as sorted '/'-separated relative paths. */
export function listFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** The CSP of an HTML document's http-equiv meta tag, or null. */
export function metaCsp(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  return m ? m[1] : null;
}

/**
 * The precache list compiled into a built sw.js, or null when it cannot be found. build.mjs
 * defines __SHELL_FILES__ as a JSON array of relative paths; esbuild keeps it as an array literal
 * of double-quoted strings, the only one in the file that names index.html.
 */
export function swPrecacheList(swText) {
  for (const m of swText.matchAll(/\[("[^"\]]*"(?:,"[^"\]]*")*)\]/g)) {
    try {
      const list = JSON.parse(`[${m[1]}]`);
      if (Array.isArray(list) && list.includes('index.html')) return list;
    } catch {
      // Not the list.
    }
  }
  return null;
}

/**
 * Checks a production web build. Throws an Error naming every problem; returns the file list.
 * `label` is used in messages (e.g. 'out/web').
 */
export function checkWebBuild(dir, label = dir) {
  const problems = [];
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`${label} has no index.html (build it first: node scripts/build.mjs --web-only)`);
  const files = listFiles(dir);
  const missing = WEB_SHELL_FILES.filter((f) => !files.includes(f));
  const extra = files.filter((f) => !WEB_SHELL_FILES.includes(f));
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected ${extra.join(', ')} (a new shell file must be added to WEB_SHELL_FILES in scripts/web-csp.mjs)`);
  for (const f of files) {
    if (!WEB_TEXT_EXTENSIONS.includes(path.extname(f).toLowerCase())) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const hit = WEB_FORBIDDEN.find((s) => text.includes(s));
    if (hit) problems.push(`${f} contains "${hit}" (test hook or key listener in the production web host)`);
  }
  if (files.includes('index.html')) {
    const csp = metaCsp(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
    if (csp !== WEB_CSP) problems.push(`index.html's CSP meta differs from WEB_CSP (scripts/web-csp.mjs): ${csp ?? 'none'}`);
  }
  if (files.includes(SW_FILE)) {
    const list = swPrecacheList(fs.readFileSync(path.join(dir, SW_FILE), 'utf8'));
    const want = files.filter((f) => f !== SW_FILE);
    if (!list) problems.push(`${SW_FILE} has no precache list`);
    else if (JSON.stringify([...list].sort()) !== JSON.stringify(want)) problems.push(`${SW_FILE}'s precache list (${list.join(', ')}) differs from the files on disk (${want.join(', ')})`);
  }
  if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  return files;
}
