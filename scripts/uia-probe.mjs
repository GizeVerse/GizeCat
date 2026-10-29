#!/usr/bin/env node
// REAL tab-strip probe: builds DesktopCatUia.exe, launches OUR OWN Edge (and Chrome) with a temp
// --user-data-dir and a few about:blank tabs, reads the strip through the real helper, the real
// client and the TabStripService, opens one more tab by launching the browser again with the same
// profile, maximizes/restores our window, then closes only the processes it started and deletes
// the profile. Prints a JSON report. Run it under the machine lock:
//   node scripts/with-lock.mjs uia-probe -- node scripts/uia-probe.mjs [--browsers edge,chrome] [--out report.json]
// The probe logic lives in tests/integration/uia/probe.ts (shared with helper.real.test.ts) and is
// bundled with esbuild to out/.uia-probe/ for this run.
import { build } from 'esbuild';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiaHelper } from './build-uia-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const browsers = opt('--browsers', 'edge,chrome')
  .split(',')
  .map((b) => b.trim())
  .filter((b) => b === 'edge' || b === 'chrome');
const outFile = opt('--out', null);

if (process.platform !== 'win32') {
  console.error('uia-probe: Windows only');
  process.exit(2);
}

const helper = buildUiaHelper({ log: (m) => console.error(m) });
if (!helper.ok || !helper.path) {
  console.error(`uia-probe: helper unavailable (${helper.reason})`);
  process.exit(2);
}

const bundleDir = path.join(root, 'out', '.uia-probe');
fs.mkdirSync(bundleDir, { recursive: true });
const bundle = path.join(bundleDir, 'probe.cjs');
await build({
  entryPoints: [path.join(root, 'tests', 'integration', 'uia', 'probe.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['koffi', 'electron'],
  outfile: bundle,
  logLevel: 'warning',
  define: { __DEV__: 'true', __APP_VERSION__: '"0.0.0-probe"' },
});

const { probeBrowser, consoleLogger } = createRequire(import.meta.url)(bundle);
const report = { at: new Date().toISOString(), helper: { path: path.relative(root, helper.path), bytes: fs.statSync(helper.path).size }, os: `${os.type()} ${os.release()}`, node: process.version, results: [] };
let failed = 0;
try {
  for (const kind of browsers) {
    console.error(`uia-probe: ${kind}...`);
    const r = await probeBrowser(kind, helper.path, consoleLogger(`probe.${kind}`));
    report.results.push(r);
    if (r.skipped) console.error(`uia-probe: ${kind} skipped: ${r.skipped}`);
    else if (r.failures.length > 0) {
      failed++;
      for (const f of r.failures) console.error(`uia-probe: ${kind} FAIL ${f}`);
    } else console.error(`uia-probe: ${kind} ok`);
  }
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
const json = JSON.stringify(report, null, 2);
if (outFile) fs.writeFileSync(path.resolve(outFile), `${json}\n`);
console.log(json);
process.exit(failed > 0 ? 1 : 0);
