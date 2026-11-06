#!/usr/bin/env node
// Regenerates docs/gizeverse/capability-matrix.md from the declared capability table in
// src/shared/platform.ts (ADR 0004 §2.3). `--check` exits 1 when the file is stale instead of
// writing it. The unit test tests/unit/shared/capabilityMatrixDoc.test.ts enforces the same.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'gizeverse', 'capability-matrix.md');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gizeverse-matrix-'));
try {
  const outfile = path.join(work, 'matrix.mjs');
  await build({ entryPoints: [path.join(ROOT, 'src', 'shared', 'capabilityMatrixDoc.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'warning' });
  const { renderCapabilityMatrix } = await import(pathToFileURL(outfile).href);
  const text = renderCapabilityMatrix();
  const current = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : null;
  if (process.argv.includes('--check')) {
    if (current !== text) {
      console.error(`${path.relative(ROOT, DOC)} is stale: run node scripts/capability-matrix.mjs`);
      process.exitCode = 1;
    } else console.log(`${path.relative(ROOT, DOC)} is up to date`);
  } else if (current === text) {
    console.log(`${path.relative(ROOT, DOC)} unchanged`);
  } else {
    fs.mkdirSync(path.dirname(DOC), { recursive: true });
    fs.writeFileSync(DOC, text);
    console.log(`wrote ${path.relative(ROOT, DOC)}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
