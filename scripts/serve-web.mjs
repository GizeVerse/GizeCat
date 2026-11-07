#!/usr/bin/env node
// Tiny static server for the GizeCat web host's browser tests (playwright.web.config.mts). Binds
// 127.0.0.1 only, serves one directory (default out/web-test), GET and HEAD only, with correct MIME
// types and the page's Content-Security-Policy sent as a header as well. No directory listings, no
// paths outside the directory, nothing cached.
// 1.4.0: sw.js gets its own policy (a worker's CSP comes from its own response; the page's
// connect-src 'none' would stop the worker from caching the app's files), and the manifest its
// registered type.
// Usage: node scripts/serve-web.mjs [--dir out/web-test] [--port 41731]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SW_CSP, SW_FILE, WEB_CSP } from './web-csp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The same policy as the meta tag in src/web/index.html (defined once, in scripts/web-csp.mjs). */
export { WEB_CSP };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(root, arg('--dir', 'out/web-test'));
const port = Number(arg('--port', process.env.GIZECAT_WEB_PORT ?? '41731'));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`serve-web: bad port ${port}`);
  process.exit(2);
}
if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`serve-web: ${dir} has no index.html (build it first: node scripts/build.mjs --web-only --web-test)`);
  process.exit(1);
}

const baseHeaders = {
  'Content-Security-Policy': WEB_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, text) {
  res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    send(res, 405, 'method not allowed');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    send(res, 400, 'bad request');
    return;
  }
  if (pathname.includes('\0')) {
    send(res, 400, 'bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(dir, `.${pathname}`);
  if (!file.startsWith(dir + path.sep)) {
    send(res, 404, 'not found');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      send(res, 404, 'not found');
      return;
    }
    const isWorker = path.relative(dir, file) === SW_FILE;
    res.writeHead(200, {
      ...baseHeaders,
      ...(isWorker ? { 'Content-Security-Policy': SW_CSP } : {}),
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': st.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serve-web: http://127.0.0.1:${port}/ serving ${path.relative(root, dir) || '.'}`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
