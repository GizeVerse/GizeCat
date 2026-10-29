#!/usr/bin/env node
// Bundles the main process, preloads and renderers with esbuild into out/.
// Usage: node scripts/build.mjs [--dev] [--watch]
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUiaHelper } from './build-uia-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const watch = process.argv.includes('--watch');
const outDir = path.join(root, 'out');
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
const targets = [
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

function copyStatic() {
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

/**
 * The UI Automation helper (browser tab strips) into out/native. Without csc.exe (.NET Framework
 * 4.x) it is skipped and logged; the app then reports tab strips as unavailable. A compile error
 * in the helper's sources fails the build.
 */
function buildNative() {
  buildUiaHelper({ outDir: path.join(outDir, 'native') });
}

fs.rmSync(outDir, { recursive: true, force: true });
if (watch) {
  for (const t of targets) {
    const ctx = await context(t);
    await ctx.watch();
  }
  copyStatic();
  buildNative();
  console.log('build: watching for changes');
} else {
  const t0 = Date.now();
  await Promise.all(targets.map((t) => build(t)));
  copyStatic();
  buildNative();
  console.log(`build: ${dev ? 'development' : 'production'} bundle written to out/ in ${Date.now() - t0} ms`);
}
