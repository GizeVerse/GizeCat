#!/usr/bin/env node
// Writes release/<version>/SHA256SUMS.txt over every distributable file of a version, the one checksum
// file the install guides tell users to check (docs/platforms/*.md). It reads the per-platform output
// folders (windows/, mac/, web/, android/) and hashes installers and archives only: *.exe, *.dmg,
// *.zip, *.apk and *.aab (not blockmaps, unpacked folders or per-folder checksum files). Lines are
// "<sha256>  <file name>", sorted by name, because release assets are attached flat. Read-only apart
// from that one file; nothing is executed.
//
// Usage: node scripts/release-sums.mjs [--version <x.y.z>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const vi = argv.indexOf('--version');
const version = vi >= 0 ? argv[vi + 1] : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`release-sums: bad version ${String(version)}`);

const base = path.join(root, 'release', version);
const DISTRIBUTABLE = /\.(exe|dmg|zip|apk|aab)$/i;
const files = [];
for (const sub of ['windows', 'mac', 'web', 'android']) {
  const dir = path.join(base, sub);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile() && DISTRIBUTABLE.test(name) && !name.endsWith('.__uninstaller.exe')) files.push({ name, p, sub });
  }
}
if (files.length === 0) throw new Error(`release-sums: no distributable files under ${path.relative(root, base)}`);
const names = new Set();
for (const f of files) {
  if (names.has(f.name)) throw new Error(`release-sums: two files named ${f.name}; release assets must have unique names`);
  names.add(f.name);
}
files.sort((a, b) => a.name.localeCompare(b.name));
const lines = files.map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f.p)).digest('hex')}  ${f.name}`);
fs.writeFileSync(path.join(base, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(`release-sums: ${files.length} file(s) -> ${path.relative(root, path.join(base, 'SHA256SUMS.txt'))}`);
for (const f of files) console.log(`  ${f.sub}/${f.name} (${fs.statSync(f.p).size} bytes)`);
