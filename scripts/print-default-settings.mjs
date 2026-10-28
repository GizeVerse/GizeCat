#!/usr/bin/env node
// Prints the default settings (from the real zod schema) as JSON. Used to regenerate
// docs/settings.example.json:  node scripts/print-default-settings.mjs > docs/settings.example.json
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-defaults-'));
const out = path.join(dir, 'settings.mjs');
try {
  await build({ entryPoints: [path.join(root, 'src/shared/settings.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  const mod = await import(pathToFileURL(out).href);
  process.stdout.write(`${JSON.stringify(mod.defaultSettings(), null, 2)}\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
