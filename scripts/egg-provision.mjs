#!/usr/bin/env node
// OWNER-ONLY, LOCAL-ONLY provisioning of the secret-name payload.
//
//   node scripts/egg-provision.mjs [--out <file>] [--iterations <n>] [--force]
//
// Run it in YOUR OWN terminal window, on your own computer. Do not run it inside a Claude session
// (no "!" prefix, no assistant-driven shell): anything typed there can end up in a transcript.
//
// What it does: asks twice, with no echo, for the trigger word and for the message, seals them with
// the app's own module (src/shared/secretEgg.ts: PBKDF2-SHA256 -> AES-256-GCM), re-opens the result
// as the app will to prove it works, and writes ONLY the encrypted payload to
// secrets/easter-egg.payload.json (git-ignored). The next `npm run package` / `npm run android:*`
// embeds it. Values are read from the terminal only: never from arguments, environment variables,
// files or pipes, and never printed, logged or written anywhere except inside the ciphertext.
// No network access happens here.
import { buildSync } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const fail = (m) => {
  console.error(`egg-provision: ${m}`);
  process.exit(1);
};

if (flag('--help') || flag('-h')) {
  console.log('node scripts/egg-provision.mjs [--out <file>] [--iterations <n>] [--force]\nSee secrets/README-PRIVATE.md.');
  process.exit(0);
}
for (const a of args) if (a.startsWith('--') && !['--out', '--iterations', '--force', '--help'].includes(a)) fail(`unknown option ${a}`);
if (!process.stdin.isTTY || !process.stdout.isTTY) fail('this tool needs an interactive terminal (values are never read from pipes, files or arguments)');

const out = path.resolve(opt('--out') ?? path.join(root, 'secrets', 'easter-egg.payload.json'));
if (fs.existsSync(out) && !flag('--force')) fail(`${path.relative(process.cwd(), out)} already exists; pass --force to replace it`);

// The very module the app runs, bundled in memory (so sealing and opening cannot diverge).
const built = buildSync({ entryPoints: [path.join(root, 'src', 'shared', 'secretEgg.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const egg = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const iterations = opt('--iterations') === undefined ? egg.EGG_DEFAULT_ITERATIONS : Number(opt('--iterations'));

/** Reads one line without echo. Ctrl+C aborts; the value exists only in the returned string. */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = (v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n') return done(buf);
        if (ch === '\u007f' || ch === '\b') buf = Array.from(buf).slice(0, -1).join('');
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function askTwice(label) {
  for (;;) {
    const a = await readHidden(`${label}: `);
    const b = await readHidden(`${label} (again): `);
    if (a === b && a.length > 0) return a;
    console.log('They did not match, or were empty. Try again.');
  }
}

console.log('Secret-name provisioning. Nothing you type is shown, stored in plain text or sent anywhere.\n');
const trigger = await askTwice('Trigger word (what the cat is named)');
const normalized = egg.normalizeEggName(trigger);
if (normalized.length === 0) fail('the trigger is empty after trimming');
if (normalized.length > egg.EGG_MAX_NAME_UNITS) fail('the trigger is too long');
if ([...trigger].length < 12) console.log('Note: a short trigger can be guessed offline by anyone who holds a build. 12 or more characters you would not say aloud is much safer.');
if (/[İı]/.test(trigger)) console.log('Note: the trigger contains a dotted or dotless i. Matching is locale-independent (see secrets/README-PRIVATE.md); a dotless i never equals i.');
const message = await askTwice(`Message (1..${egg.EGG_MAX_MESSAGE_UNITS} characters, one line)`);

let payload;
try {
  payload = await egg.sealEggPayload(trigger, message, iterations);
} catch (e) {
  fail(e instanceof Error ? e.message : 'sealing failed');
}

// Self-check exactly as the app will do it: the right name opens it, a wrong one must not.
const parsed = egg.parseEggPayload(payload);
if (!parsed) fail('internal error: the sealed payload failed structural validation');
const opened = await egg.openEggPayload(parsed, ` ${trigger.toUpperCase()} `);
const wrong = await egg.openEggPayload(parsed, `${trigger}x`);
if (opened !== message && opened !== null) fail('self-check failed: the payload opened to a different message');
if (opened === null) {
  // Upper-casing can legitimately change a name (for example a dotless i). Fall back to the exact entry.
  const exact = await egg.openEggPayload(parsed, trigger);
  if (exact !== message) fail('self-check failed: the payload does not open with the trigger');
}
if (wrong !== null) fail('self-check failed: a different name opened the payload');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, payload, { mode: 0o600 });
const sha = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
console.log(`\nWrote the encrypted payload (${payload.length} bytes, sha256 ${sha}, ${iterations} rounds) to ${path.relative(process.cwd(), out)}.`);
console.log('Self-check passed. It is git-ignored: never commit it, never paste it into a chat. Rebuild to embed it.');
