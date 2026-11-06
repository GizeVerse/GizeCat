#!/usr/bin/env node
// Bundles the main process, preloads and renderers with esbuild into out/, and the GizeCat web host
// (ADR 0004 §8) into out/web.
// Usage: node scripts/build.mjs [--dev] [--watch] [--web-only] [--web-test]
//   --web-only  build only the web host; out/web (and out/web-test) are replaced, the rest of out/ is kept
//   --web-test  also build out/web-test: the web host with the read-only window.__gizecatWebTest hook
//               for tests/web (never in out/web)
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiaHelper } from './build-uia-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');
const webOnly = process.argv.includes('--web-only');
const webTest = process.argv.includes('--web-test');
const outDir = path.join(root, 'out');
const webDir = path.join(outDir, 'web');
const webTestDir = path.join(outDir, 'web-test');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const define = {
  __DEV__: JSON.stringify(dev),
  __APP_VERSION__: JSON.stringify(pkg.version),
  'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
};

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : 'linked',
  minify: !dev,
  logLevel: 'warning',
  define,
  legalComments: 'none',
};

/** @type {import('esbuild').BuildOptions[]} */
const appTargets = [
  {
    ...common,
    entryPoints: { 'main/index': 'src/main/index.ts' },
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'koffi'],
    outdir: outDir,
  },
  {
    ...common,
    entryPoints: { 'preload/overlay': 'src/preload/overlay.ts', 'preload/settings': 'src/preload/settings.ts' },
    platform: 'node',
    format: 'cjs',
    target: 'chrome150',
    external: ['electron'],
    outdir: outDir,
  },
  {
    ...common,
    entryPoints: {
      'renderer/overlay/main': 'src/renderer/overlay/main.ts',
      'renderer/settings/main': 'src/renderer/settings/main.ts',
    },
    platform: 'browser',
    format: 'esm',
    target: 'chrome150',
    outdir: outDir,
  },
];

/**
 * The web host for any current browser. Production has no source map (nothing but the page's own
 * three files is ever requested) and no test hook: __WEB_TEST__ is false, so esbuild drops the hook.
 * @returns {import('esbuild').BuildOptions}
 */
function webTarget(test) {
  return {
    ...common,
    sourcemap: dev ? 'inline' : false,
    define: { ...define, __WEB_TEST__: JSON.stringify(test) },
    entryPoints: { main: 'src/web/main.ts' },
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    outdir: test ? webTestDir : webDir,
  };
}

const webTargets = [webTarget(false), ...(webTest ? [webTarget(true)] : [])];
const targets = webOnly ? webTargets : [...appTargets, ...webTargets];

function copyStatic() {
  if (webOnly) return;
  // HTML/CSS for each renderer entry live next to its main.ts.
  for (const page of ['overlay', 'settings']) {
    const srcDir = path.join(root, 'src', 'renderer', page);
    const dstDir = path.join(outDir, 'renderer', page);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
  }
}

/** The web host's page and stylesheet next to its bundle. */
function copyWebStatic() {
  const srcDir = path.join(root, 'src', 'web');
  for (const dstDir of [webDir, ...(webTest ? [webTestDir] : [])]) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.html') || f.endsWith('.css')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
  }
}

/** Strings that must never ship in out/web (M5): the test hook, and key listeners. */
const WEB_FORBIDDEN = ['__gizecatWebTest', 'keydown', 'keyup', 'keypress'];

/** Fails the build when the production web host contains a forbidden string. */
function checkWebProduction() {
  for (const f of fs.readdirSync(webDir)) {
    const text = fs.readFileSync(path.join(webDir, f), 'utf8');
    const hit = WEB_FORBIDDEN.find((s) => text.includes(s));
    if (hit) throw new Error(`build: out/web/${f} contains "${hit}" (test hook or key listener in the production web host)`);
  }
}

/**
 * The UI Automation helper (browser tab strips) into out/native. Without csc.exe (.NET Framework
 * 4.x) it is skipped and logged; the app then reports tab strips as unavailable. A compile error
 * in the helper's sources fails the build.
 */
function buildNative() {
  if (webOnly) return;
  buildUiaHelper({ outDir: path.join(outDir, 'native') });
}

if (webOnly) {
  fs.rmSync(webDir, { recursive: true, force: true });
  fs.rmSync(webTestDir, { recursive: true, force: true });
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
}
if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  copyStatic();
  copyWebStatic();
  buildNative();
  console.log('build: watching for changes');
} else {
  const t0 = Date.now();
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  copyWebStatic();
  if (!dev) checkWebProduction();
  buildNative();
  const what = webOnly ? `web host written to out/web${webTest ? ' and out/web-test' : ''}` : `bundle written to out/${webTest ? ' (with out/web-test)' : ''}`;
  console.log(`build: ${dev ? 'development' : 'production'} ${what} in ${Date.now() - t0} ms`);
}
