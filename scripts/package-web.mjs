#!/usr/bin/env node
// Packages the production web build (out/web) for static hosting (1.4.0). Run after
// `node scripts/build.mjs --web-only` (npm run package:web does both).
//
// Rebuilds release/<version>/web/ only (nothing else in release/ is touched: the installers live
// there) with:
//   GizeCat-web-<version>/      an exact copy of out/web
//   GizeCat-web-<version>.zip   the same files, deterministic (sorted entries, fixed 1980-01-01 time,
//                               deflate), written here with node:zlib, no dependency
//   README-web.txt              how to host it
//   SHA256SUMS.txt              sha256 of the zip, the README and every file of the folder
// It refuses an out/web that is incomplete, has a test hook or key-listener text, or a CSP or
// service-worker precache list that does not match (scripts/web-csp.mjs). Packaging is not testing:
// nothing here runs the app.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { checkWebBuild, SW_CSP, WEB_CSP } from './web-csp.mjs';
import { crc32 } from './web-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** MS-DOS date for 1980-01-01 (the earliest a zip can hold) and time 00:00:00. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/**
 * A deterministic zip of `entries` ([{ name, data: Buffer }], names with '/' separators), in the
 * order given. Deflate when it is smaller, else stored. No zip64 (every file here is small).
 */
export function zipBuffers(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const utf8 = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** The README shipped next to the web package. */
export function readmeText(version, files) {
  return `GizeCat web app ${version}
${'='.repeat(`GizeCat web app ${version}`.length)}

GizeCat, a GizeVerse character, as an installable web app (PWA) for tablets and browsers. This
folder (and the zip, which holds the same files) is a static website: ${files.length} files, no server code.

Hosting
- Put every file of GizeCat-web-${version}/ on any static web host, at any path (a sub-folder is
  fine: every URL inside is relative).
- HTTPS is required to install the app and for it to start offline (the service worker). Browsers
  also treat http://localhost as secure, for trying it on the same computer.
- Opening index.html from disk (file://) does not work: browsers do not run the app's module
  script from a file.
- Serve manifest.webmanifest as application/manifest+json and .js files as text/javascript.
- A GitHub project site works as it is (https://<owner>.github.io/<repository>/): the manifest's
  start_url and scope are relative, and the service worker only ever answers inside that path.

Optional response headers (if the host allows them; the page already carries its policy as a meta tag)
- Every file: Content-Security-Policy: ${WEB_CSP}; frame-ancestors 'none'
- sw.js instead: Content-Security-Policy: ${SW_CSP}
- X-Content-Type-Options: nosniff
- Referrer-Policy: no-referrer
- Cache-Control: no-cache for index.html, sw.js and manifest.webmanifest (so updates are seen)

Installing (after it is hosted)
- iPad (Safari): Share, then Add to Home Screen.
- Android tablet (Chrome): Install app (or Add to Home screen) from the menu, or the sheet's Install button.
Nothing here has been executed on an iPad or an Android tablet by the project.

Privacy
- No account, no ads, no analytics, no telemetry. The page cannot make network requests itself
  (connect-src 'none'); the only traffic is the browser loading these files from your host, once
  per version for the offline copy, and the browser's own update checks.
- The cat and its settings stay in the browser's storage on the device (localStorage).
- It never listens to the keyboard and never sees the screen.

Updating
- Replace all the files together. The service worker's cache is named after a hash of the files,
  so a new version is fetched in the background; the settings sheet then says it is ready and it
  starts when the app is closed and opened again. Old caches of this app are deleted.

Licences
- licenses.html is the third-party notices page, linked from the sheet's About section.

Integrity
- SHA256SUMS.txt lists the sha256 of the zip, this README and every file.
`;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const webDir = path.join(root, 'out', 'web');
  let files;
  try {
    files = checkWebBuild(webDir, 'out/web');
  } catch (err) {
    console.error(`package-web: ${err instanceof Error ? err.message : String(err)}`);
    console.error('package-web: build it first with: node scripts/build.mjs --web-only');
    process.exit(1);
  }
  const outDir = path.join(root, 'release', version, 'web');
  const name = `GizeCat-web-${version}`;
  fs.rmSync(outDir, { recursive: true, force: true });
  const folder = path.join(outDir, name);
  fs.mkdirSync(folder, { recursive: true });

  const entries = [];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(webDir, ...rel.split('/')));
    const dst = path.join(folder, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    entries.push({ name: `${name}/${rel}`, data });
  }
  const readme = Buffer.from(readmeText(version, files), 'utf8');
  fs.writeFileSync(path.join(outDir, 'README-web.txt'), readme);
  const zip = zipBuffers([...entries, { name: `${name}/README-web.txt`, data: readme }].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const zipName = `${name}.zip`;
  fs.writeFileSync(path.join(outDir, zipName), zip);

  const sums = [`${sha256(zip)}  ${zipName}`, `${sha256(readme)}  README-web.txt`, ...entries.map((e) => `${sha256(e.data)}  ${e.name}`)];
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

  const rel = path.relative(root, outDir).split(path.sep).join('/');
  const total = entries.reduce((a, e) => a + e.data.length, 0);
  console.log(`package-web: ${rel}/${name}/ (${files.length} files, ${total} bytes)`);
  console.log(`package-web: ${rel}/${zipName} (${zip.length} bytes, sha256 ${sha256(zip)})`);
  console.log(`package-web: ${rel}/README-web.txt, ${rel}/SHA256SUMS.txt`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
