#!/usr/bin/env node
// Puts the production web bundle into the Android app: builds the web host (out/web, the same
// bundle as the PWA) and copies out/web/** into android/app/src/main/assets/, a generated,
// gitignored folder that the APK serves at https://appassets.androidplatform.net/assets/.
// Usage: node scripts/build-web-app.mjs [--no-build]
//   --no-build  copy the existing out/web instead of rebuilding it first
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'out', 'web');
const assetsDir = path.join(root, 'android', 'app', 'src', 'main', 'assets');
const noBuild = process.argv.includes('--no-build');

function fail(message) {
  console.error(`build-web-app: ${message}`);
  process.exit(1);
}

if (!noBuild) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs'), '--web-only'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail(`the web build failed (exit ${r.status ?? r.signal})`);
}

if (!fs.existsSync(path.join(webDir, 'index.html')) || !fs.existsSync(path.join(webDir, 'main.js'))) {
  fail('out/web is missing or incomplete: run "node scripts/build.mjs --web-only" (or drop --no-build)');
}

/** Every file under dir, as forward-slash paths relative to it. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

const files = listFiles(webDir);

// Same strings scripts/build.mjs (WEB_FORBIDDEN) keeps out of the production web host: refuses a
// development or out/web-test build that was copied into out/web by hand.
const FORBIDDEN = ['__gizecatWebTest', 'keydown', 'keyup', 'keypress'];
const TEXT = /\.(html|js|mjs|css|json|webmanifest|txt|svg)$/i;
for (const rel of files) {
  if (rel.endsWith('.map')) fail(`out/web/${rel}: source maps never ship in the app (production build expected)`);
  if (!TEXT.test(rel)) continue;
  const text = fs.readFileSync(path.join(webDir, rel), 'utf8');
  const hit = FORBIDDEN.find((s) => text.includes(s));
  if (hit) fail(`out/web/${rel} contains "${hit}" (test hook or key listener): rebuild with "node scripts/build.mjs --web-only"`);
}
const indexHtml = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
if (!/http-equiv="Content-Security-Policy"/i.test(indexHtml)) fail('out/web/index.html has no Content-Security-Policy meta tag');

fs.rmSync(assetsDir, { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });
fs.cpSync(webDir, assetsDir, { recursive: true });

let total = 0;
for (const rel of files) {
  const buf = fs.readFileSync(path.join(assetsDir, rel));
  total += buf.length;
  console.log(`  ${crypto.createHash('sha256').update(buf).digest('hex')}  ${String(buf.length).padStart(9)}  ${rel}`);
}
console.log(`build-web-app: ${files.length} files (${total} bytes) copied from out/web to android/app/src/main/assets`);
