#!/usr/bin/env node
// Bundles the main process, preloads and renderers with esbuild into out/, and the GizeCat web host
// (ADR 0004 §8) into out/web.
// Usage: node scripts/build.mjs [--dev] [--watch] [--web-only] [--web-test]
//   --web-only  build only the web host; out/web (and out/web-test) are replaced, the rest of out/ is kept
//   --web-test  also build out/web-test: the web host with the read-only window.__gizecatWebTest hook
//               for tests/web (never in out/web)
// 1.4.0 (installable web app): the web host also gets its manifest, icons (scripts/web-icons.mjs)
// and, in production builds, a versioned service worker (sw.js, from src/web/sw.ts) whose precache
// list is every other file of the build. out/web is then checked by scripts/web-csp.mjs. The web
// path needs no Windows tooling (--web-only skips the native helper).
import { build, context } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiaHelper } from './build-uia-helper.mjs';
import { checkWebBuild, listFiles, SW_FILE } from './web-csp.mjs';
import { writeWebIcons } from './web-icons.mjs';

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
 * files is ever requested) and no test hook: __WEB_TEST__ is false, so esbuild drops the hook.
 * __WEB_SW__: the service worker exists (and is registered) only in production builds.
 * @returns {import('esbuild').BuildOptions}
 */
function webTarget(test) {
  return {
    ...common,
    sourcemap: dev ? 'inline' : false,
    define: { ...define, __WEB_TEST__: JSON.stringify(test), __WEB_SW__: JSON.stringify(!dev) },
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

const webDirs = () => [webDir, ...(webTest ? [webTestDir] : [])];

/** The web host's page, stylesheet and manifest next to its bundle, and the icons (scripts/web-icons.mjs). */
function copyWebStatic() {
  const srcDir = path.join(root, 'src', 'web');
  for (const dstDir of webDirs()) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      if (f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.webmanifest')) fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
    writeWebIcons(dstDir);
  }
}

/**
 * The service worker for one web build directory, after everything else is in it: its precache
 * list is every file there but sw.js, and its version is the package version plus a hash of those
 * files' paths and bytes, so sw.js changes (and browsers update) whenever any file changes.
 */
async function buildServiceWorker(dir) {
  const files = listFiles(dir).filter((f) => f !== SW_FILE);
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, ...f.split('/'))));
    hash.update('\0');
  }
  const version = `${pkg.version}-${hash.digest('hex').slice(0, 16)}`;
  await build({
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    entryPoints: { sw: 'src/web/sw.ts' },
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    outdir: dir,
    define: { ...define, __SHELL_VERSION__: JSON.stringify(version), __SHELL_FILES__: JSON.stringify(files) },
  });
  return version;
}

/** Fails the build when the production web host is incomplete or contains a forbidden string (scripts/web-csp.mjs). */
function checkWebProduction() {
  try {
    checkWebBuild(webDir, 'out/web');
  } catch (err) {
    throw new Error(`build: ${err instanceof Error ? err.message : String(err)}`);
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
  let swVersion = null;
  if (!dev) {
    // Production only: a development build never registers a worker (__WEB_SW__ is false there).
    for (const dir of webDirs()) {
      const v = await buildServiceWorker(dir);
      if (dir === webDir) swVersion = v;
    }
    checkWebProduction();
  }
  buildNative();
  const what = webOnly ? `web host written to out/web${webTest ? ' and out/web-test' : ''}` : `bundle written to out/${webTest ? ' (with out/web-test)' : ''}`;
  console.log(`build: ${dev ? 'development' : 'production'} ${what} in ${Date.now() - t0} ms${swVersion ? ` (web shell ${swVersion})` : ''}`);
}
