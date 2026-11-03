#!/usr/bin/env node
// Behaviour profile runner (SIMULATED; see tests/profile/behaviorProfile.ts). Heavy on a shared
// machine: run it under the lock, one at a time:
//
//   node scripts/with-lock.mjs profile -- node scripts/behavior-profile.mjs [options]
//
// The full §14 matrix (~576 sim-h, a few minutes) can run detached (--detach): it then takes the
// lock itself, writes out/profile/<label>.log and <label>.pid, checkpoints every finished cell in
// out/profile/<label>.cells/ (--resume reuses them) and must be stopped by whoever started it
// (taskkill /PID <pid> /T /F) if it is not to finish.
//
// Options:
//   --matrix bands|diagnosis|short   named cell set (default bands: every cell a §14 band needs)
//   --cells P2/L1/U-active,...       explicit cells (profile/layout/user[+variant])
//   --profiles P1,P2 --layouts L1,L4b --users U-active,U-play --variants default,edgesOff
//                                    a cross product instead (defaults P1,P2 x L1,L2,L3 x U-active)
//   --hours <h>            sim-hours per (cell, seed)                    (default 3)
//   --seeds <n|a,b,c>      number of seeds or an explicit list           (default 8)
//   --label <name>         report name: out/profile/<name>.json          (default profile)
//   --start-hour <h>       local hour the runs start at                  (default 18.5)
//   --scenarios            also the B7 throw Monte Carlo and the B8 recovery runs
//   --records              keep every run's record lists in the JSON (large)
//   --resume               reuse finished cells' checkpoints
//   --detach               start detached (Start-Process -WindowStyle Hidden) under the lock
//   --copy-to <dir>        also copy the JSON there
//   --compact-to <file>    also write a compact copy (meta, cells, bands, per-run headline numbers)
//   --report <file.json>   only print the tables of a saved report
//   --bands <file.json>    only print the band verdicts of a saved report
//   --compare <a.json> <b.json>   key metrics of two saved reports side by side (e.g. baseline vs v1.2)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

// ------------------------------------------------------------------ rendering

const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : Math.abs(v) >= 1 ? 2 : 3)) : String(v));
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(fmt).join(' | ')} |`)].join('\n');
const top = (obj, n = 6, unit = '') =>
  Object.entries(obj ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${fmt(v)}${unit}`)
    .join(', ') || '-';
const d = (x) => (x && x.n ? `${fmt(x.min)} / ${fmt(x.median)} / ${fmt(x.p90)} / ${fmt(x.max)} (n ${x.n})` : 'n 0');
const get = (o, p) => p.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
const pct = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 10 : x);

function renderBands(report) {
  const b = report.bands;
  if (!b || !Array.isArray(b.results)) return 'No band verdicts in this report (harness v1, or written before the bands existed).';
  const out = ['## Target bands (ADR 0003 §14)'];
  out.push(table(['band', 'pass', 'fail', 'n/a'], Object.entries(b.tally).map(([id, t]) => [id, t.pass, t.fail, t['n/a']])));
  out.push('');
  out.push(table(['band', 'cell', 'check', 'value', 'status'], b.results.map((r) => [r.id, r.cell, r.check, typeof r.value === 'number' ? r.value : (r.value ?? '-'), r.status === 'fail' ? '**fail**' : r.status])));
  return out.join('\n');
}

function renderV2(report) {
  const cells = Object.entries(report.cells);
  const names = cells.map(([k]) => k);
  const col = (f) => cells.map(([, c]) => f(c));
  const out = [];
  const m = report.meta;
  out.push(`# Behaviour profile "${m.label}" (${m.createdAt}, harness v${m.harnessVersion})`);
  out.push(`${m.labels}. Screen: ${m.screen}. ${m.config.hours} sim-h x seeds ${m.config.seeds.join(',')} per cell; start hour ${m.config.startHour ?? 18.5}.`);
  out.push(`Layouts: ${Object.entries(m.layouts).map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  out.push(`Users: ${Object.entries(m.users).map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  // One table per group of cells keeps the width readable.
  const rowsFor = (title, rows) => {
    out.push(`\n## ${title}`);
    for (let i = 0; i < names.length; i += 6) {
      const slice = names.slice(i, i + 6);
      const idx = slice.map((n) => names.indexOf(n));
      out.push(table(['metric', ...slice], rows.map(([label, ...vals]) => [label, ...idx.map((j) => vals[j])])));
      out.push('');
    }
  };
  rowsFor('Time', [
    ['active share of awake (B1, snapshot)', ...col((c) => pct(c.activeShare))],
    ['  by output state only (v1.1.1 measure)', ...col((c) => pct(c.activeShareByState))],
    ['calm % of awake', ...col((c) => c.timeSharePct.classOfAwake.calm ?? 0)],
    ['asleep % of sim', ...col((c) => pct(c.sleep.asleepShareOfSim))],
    ['asleep % of present (B15)', ...col((c) => pct(c.sleep.asleepShareOfPresent))],
    ['autonomous naps / present h (B15)', ...col((c) => c.sleep.napsPerPresentHour)],
    ['moving % of sim', ...col((c) => c.timeSharePct.moving)],
    ['up on windows / edges % of sim', ...col((c) => c.timeSharePct.elevated)],
    ['maximized window in front %', ...col((c) => c.desktop.maximizedFrontPct)],
    ['wary / irritable / fearful % of awake (B8b)', ...col((c) => `${pct(c.moods.waryShare)} / ${pct(c.moods.irritableShare)} / ${pct(c.moods.fearfulShare)}`)],
  ]);
  rowsFor('Decisions', [
    ['decisions / awake min', ...col((c) => c.decisions.perAwakeMin)],
    ['by cause', ...col((c) => top(c.decisions.byCause, 5))],
    ['by class %', ...col((c) => top(c.decisions.byClassPct, 4))],
    ['trip decisions / h', ...col((c) => c.decisions.tripDecisionsPerHour)],
  ]);
  rowsFor('Stays (B2-B4)', [
    ['own arrivals / h (B2)', ...col((c) => c.stays.ownArrivalsPerHour)],
    ['window climbs / h (B2, ceiling 12)', ...col((c) => c.stays.windowClimbsPerHour)],
    ['KM median / p10 / p90 s (B3)', ...col((c) => `${fmt(c.stays.km.median)} / ${fmt(c.stays.km.p10)} / ${fmt(c.stays.km.p90)}`)],
    ['KM P(>5 min) / P(>15 min)', ...col((c) => `${fmt(c.stays.km.pOver5min)} / ${fmt(c.stays.km.pOver15min)}`)],
    ['KM n (events)', ...col((c) => `${c.stays.km.n} (${c.stays.km.events})`)],
    ['experienced median s', ...col((c) => c.stays.experiencedMedianS)],
    ['plannedMs median / p10 / p90 s, >5 min share', ...col((c) => (c.stays.planned.n ? `${fmt(c.stays.planned.median)} / ${fmt(c.stays.planned.p10)} / ${fmt(c.stays.planned.p90)}, ${fmt(c.stays.planned.over5minShare)}` : 'none drawn'))],
    ['ends', ...col((c) => top(c.stays.byEnd, 6))],
    ['own leaves (B4: max share, kinds)', ...col((c) => `${top(c.stays.byLeave, 5)} (${fmt(c.stays.leave.maxShare)}, ${c.stays.leave.kinds})`)],
    ['arrival routes', ...col((c) => top(c.stays.byRoute, 5))],
    ['covered/gone ends with bail-out (B13)', ...col((c) => `${c.stays.imposedLoss.withBailOut}/${c.stays.imposedLoss.n}`)],
  ]);
  rowsFor('Hunting (B5, B5b, B5c, B6)', [
    ['hunts / h (onHunt)', ...col((c) => c.hunts.perHour)],
    ['pounces / h', ...col((c) => c.hunts.pouncesPerHour)],
    ['min pounce gap s', ...col((c) => c.hunts.minPounceGapS)],
    ['min clearance DIP', ...col((c) => c.hunts.minClearanceDip)],
    ['pounces < 2 s after a press / landings near a press point', ...col((c) => `${c.hunts.pouncesNearPress} / ${c.hunts.pounceLandingsNearPressPoint}`)],
    ['hunts / pounces started while typing', ...col((c) => `${c.hunts.startedWhileTyping} / ${c.hunts.pouncesWhileTyping}`)],
    ['strikes / play near the cursor while typing', ...col((c) => `${c.strikes.whileTypingNearCursor} / ${c.strikes.playNearCursorWhileTyping}`)],
    ['strike clips', ...col((c) => top(c.strikes.byClip, 4))],
    ['outcomes / gates', ...col((c) => `${top(c.hunts.byOutcome, 4)}; ${top(c.hunts.byGate, 4)}`)],
    ['v1.1.1: chase starts / pounces / watch starts per h', ...col((c) => `${fmt(c.hunts.legacy.chaseStartsPerHour)} / ${fmt(c.hunts.legacy.pouncesPerHour)} / ${fmt(c.hunts.legacy.watchStartsPerHour)}`)],
  ]);
  rowsFor('Reactions (B7)', [
    ['reactions (onReaction)', ...col((c) => c.reactions.n)],
    ['kinds / max share / hide share / capped share', ...col((c) => `${c.reactions.kinds} / ${fmt(c.reactions.maxShare)} / ${fmt(c.reactions.hideShare)} / ${fmt(c.reactions.cappedShare)}`)],
    ['by kind', ...col((c) => top(c.reactions.byKind, 5))],
    ['v1.1.1: hard throws, hid %', ...col((c) => `${c.reactions.legacyHard.n}, ${fmt(c.reactions.legacyHard.hidPct)}`)],
    ['v1.1.1: first after a hard throw', ...col((c) => top(c.reactions.legacyHard.first, 3))],
  ]);
  rowsFor('Falls, slips, edges, watchdog (B9-B11, B13, B14)', [
    ['falls / h', ...col((c) => c.falls.perHour)],
    ['by cause', ...col((c) => top(c.falls.byCause, 6))],
    ['physics errors (B9)', ...col((c) => c.falls.physicsErrors)],
    ['slips / awake h (B10)', ...col((c) => c.slips.perAwakeHour)],
    ['edge visits / h, peeks / h (B11, B1b)', ...col((c) => `${fmt(c.edges.visitsPerHour)}, ${fmt(c.edges.peeksPerHour)}`)],
    ['stuck resets (B14)', ...col((c) => c.stuckResets)],
  ]);
  rowsFor('The simulated user and desktop (actual)', [
    ['present % of sim', ...col((c) => c.user.presentPct)],
    ['pets / drags / throws per present h', ...col((c) => `${fmt(c.user.petSessionsPerPresentHour)} / ${fmt(c.user.dragsPerPresentHour)} / ${fmt(c.user.throwsPerPresentHour)}`)],
    ['presses per present h', ...col((c) => c.user.pressesPerPresentHour)],
    ['raw typing % of present', ...col((c) => c.user.typingRawPctOfPresent)],
    ['cursor within 6 bw of the cat % of present', ...col((c) => c.user.cursorNearCatPctOfPresent)],
    ['taskbar reveals / h, shown %', ...col((c) => `${fmt(c.user.taskbarRevealsPerHour)}, ${fmt(c.user.taskbarShownPct)}`)],
    ['churn / h, window drags / h, tab selections / h', ...col((c) => `${fmt(c.desktop.churnPerHour)}, ${fmt(c.desktop.windowDragsPerHour)}, ${fmt(c.desktop.tabSwitchesPerHour)}`)],
  ]);
  out.push("\n## Counters per awake hour (sim) vs the user's installed 1.1.1 (REAL, counts only)");
  const ev = m.userEvidencePerAwakeHour;
  out.push(table(['counter', ...names.slice(0, 8), 'user 1.1.1'], ['pets', 'drags', 'throws', 'chasesStarted', 'windowsInspected', 'naps'].map((k) => [k, ...cells.slice(0, 8).map(([, c]) => c.countersPerAwakeHour[k] ?? 0), ev[k]])));
  out.push('\n## Integrity');
  for (const [k, c] of cells) out.push(`- ${k}: ${JSON.stringify(c.integrity)}; hooks ${JSON.stringify(c.hooks)}`);
  out.push(`\n${renderBands(report)}`);
  return out.join('\n');
}

/** Harness v1 reports (the v1.2 diagnosis baseline): the headline numbers only. */
function renderV1(report) {
  const cells = Object.entries(report.cells);
  const out = [`# Behaviour profile "${report.meta.label}" (harness v1, ${report.meta.createdAt})`];
  out.push(table(['metric', ...cells.map(([k]) => k)], KEY_METRICS_V1.map(([n, p]) => [n, ...cells.map(([, c]) => get(c, p))])));
  return out.join('\n');
}

const render = (report) => (report.meta.harnessVersion >= 2 ? renderV2(report) : renderV1(report));

const KEY_METRICS_V1 = [
  ['active %', 'timeSharePct.active'],
  ['moving %', 'timeSharePct.moving'],
  ['elevated %', 'timeSharePct.elevated'],
  ['decisions / awake min', 'decisions.perAwakeMin'],
  ['strip own arrivals / h', 'elevated.byKind.tabStrip.ownArrivalsPerHour'],
  ['strip dwell median s', 'elevated.byKind.tabStrip.dwellOwnSec.median'],
  ['top own arrivals / h', 'elevated.byKind.windowTop.ownArrivalsPerHour'],
  ['top dwell median s', 'elevated.byKind.windowTop.dwellOwnSec.median'],
  ['chase starts / h', 'cursor.chaseStartsPerHour'],
  ['pounces / h', 'cursor.pouncesPerHour'],
  ['falls / h', 'falls.perHour'],
  ['hard throw: hid %', 'releases.throw:hard.hidPct'],
];

/** Harness v2 headline metrics (cells summarised by summarizeCell). */
const KEY_METRICS = [
  ['active share (B1)', 'activeShare'],
  ['active share, output state only', 'activeShareByState'],
  ['moving %', 'timeSharePct.moving'],
  ['elevated %', 'timeSharePct.elevated'],
  ['asleep % of present (B15)', 'sleep.asleepShareOfPresent'],
  ['naps / present h (B15)', 'sleep.napsPerPresentHour'],
  ['decisions / awake min', 'decisions.perAwakeMin'],
  ['own arrivals / h (B2)', 'stays.ownArrivalsPerHour'],
  ['window climbs / h (B2)', 'stays.windowClimbsPerHour'],
  ['KM median s (B3)', 'stays.km.median'],
  ['KM p10 s (B3)', 'stays.km.p10'],
  ['KM P(>5 min) (B3)', 'stays.km.pOver5min'],
  ['experienced median s', 'stays.experiencedMedianS'],
  ['plannedMs median s (B3)', 'stays.planned.median'],
  ['leave max share (B4)', 'stays.leave.maxShare'],
  ['leave kinds (B4)', 'stays.leave.kinds'],
  ['hunts / h (B5)', 'hunts.perHour'],
  ['pounces / h (B5)', 'hunts.pouncesPerHour'],
  ['v1.1.1 chase starts / h', 'hunts.legacy.chaseStartsPerHour'],
  ['reactions max share (B7)', 'reactions.maxShare'],
  ['v1.1.1 hard throw: hid %', 'reactions.legacyHard.hidPct'],
  ['falls / h', 'falls.perHour'],
  ['physics errors (B9)', 'falls.physicsErrors'],
  ['slips / awake h (B10)', 'slips.perAwakeHour'],
  ['edge visits / h (B11)', 'edges.visitsPerHour'],
  ['edge peeks / h (B1b)', 'edges.peeksPerHour'],
  ['wary share (B8b)', 'moods.waryShare'],
  ['stuck resets (B14)', 'stuckResets'],
];

function compare(a, b) {
  const out = [`# Behaviour profile: "${a.meta.label}" (v${a.meta.harnessVersion}) vs "${b.meta.label}" (v${b.meta.harnessVersion})`];
  if (a.meta.harnessVersion !== b.meta.harnessVersion) out.push('\nThe reports come from different harness versions; only metrics with the same path are compared.');
  const metrics = a.meta.harnessVersion >= 2 && b.meta.harnessVersion >= 2 ? KEY_METRICS : KEY_METRICS_V1;
  for (const cell of Object.keys(a.cells).filter((k) => k in b.cells)) {
    out.push(`\n## ${cell}`);
    out.push(
      table(
        ['metric', a.meta.label, b.meta.label, 'delta'],
        metrics.map(([n, p]) => {
          const x = get(a.cells[cell], p);
          const y = get(b.cells[cell], p);
          return [n, x, y, typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 1000) / 1000 : '-'];
        }),
      ),
    );
  }
  const only = (r, s) => Object.keys(r.cells).filter((k) => !(k in s.cells));
  if (only(a, b).length) out.push(`\nOnly in "${a.meta.label}": ${only(a, b).join(', ')}`);
  if (only(b, a).length) out.push(`Only in "${b.meta.label}": ${only(b, a).join(', ')}`);
  if (a.bands && b.bands) {
    out.push('\n## Band verdicts (pass / fail)');
    const ids = [...new Set([...Object.keys(a.bands.tally), ...Object.keys(b.bands.tally)])];
    out.push(table(['band', a.meta.label, b.meta.label], ids.map((id) => [id, `${a.bands.tally[id]?.pass ?? 0} / ${a.bands.tally[id]?.fail ?? 0}`, `${b.bands.tally[id]?.pass ?? 0} / ${b.bands.tally[id]?.fail ?? 0}`])));
  }
  return out.join('\n');
}

/** Meta, cells and band verdicts plus each run's headline numbers: small enough to keep in docs/. */
function compact(report) {
  return {
    meta: { ...report.meta, compact: true },
    cells: report.cells,
    bands: report.bands,
    runs: report.runs.map((r) => ({ profile: r.profile, layout: r.layout, user: r.user, variant: r.variant, seed: r.seed, simMs: r.simMs, awakeMs: r.awakeMs, presentMs: r.presentMs, activeShare: r.snapshot?.activeShare, integrity: r.integrity, hooks: r.hooks })),
  };
}

// ------------------------------------------------------------------ main

const PASS_THROUGH = ['matrix', 'cells', 'profiles', 'layouts', 'users', 'variants', 'hours', 'seeds', 'label', 'start-hour', 'copy-to', 'compact-to'];

function detach() {
  const label = (opt('label', 'profile') ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
  const outDir = path.join(ROOT, 'out', 'profile');
  fs.mkdirSync(outDir, { recursive: true });
  const log = path.join(outDir, `${label}.log`);
  const errLog = path.join(outDir, `${label}.err.log`);
  const args = argv.filter((a) => a !== '--detach');
  if (!args.includes('--resume')) args.push('--resume');
  const nodeArgs = [path.join(ROOT, 'scripts', 'with-lock.mjs'), 'profile', '--', process.execPath, path.join(ROOT, 'scripts', 'behavior-profile.mjs'), ...args];
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const pidTmp = path.join(outDir, `${label}.pid.tmp`);
  fs.rmSync(pidTmp, { force: true });
  // Start-Process -WindowStyle Hidden survives the shell that started it (the machine's rule for long
  // jobs). It hands its inheritable handles to the child, so PowerShell gets no pipes from here
  // (stdio ignore: a pipe would stay open until the run ends) and reports the PID through a file.
  const ps = `$p = Start-Process -FilePath ${q(process.execPath)} -ArgumentList @(${nodeArgs.map((a) => q(/\s/.test(a) ? `"${a}"` : a)).join(',')}) -WorkingDirectory ${q(ROOT)} -WindowStyle Hidden -RedirectStandardOutput ${q(log)} -RedirectStandardError ${q(errLog)} -PassThru; Set-Content -Encoding ascii -Path ${q(pidTmp)} -Value $p.Id`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  const pid = Number(fs.readFileSync(pidTmp, 'utf8').trim());
  fs.rmSync(pidTmp, { force: true });
  fs.writeFileSync(path.join(outDir, `${label}.pid`), `${JSON.stringify({ pid, startedAt: new Date().toISOString(), args })}\n`);
  console.log(`profile: detached as PID ${pid}; log ${log}; stop with: taskkill /PID ${pid} /T /F`);
  return 0;
}

async function main() {
  const reportFile = opt('report');
  if (reportFile) {
    console.log(render(JSON.parse(fs.readFileSync(reportFile, 'utf8'))));
    return 0;
  }
  const bandsFile = opt('bands');
  if (bandsFile) {
    console.log(renderBands(JSON.parse(fs.readFileSync(bandsFile, 'utf8'))));
    return 0;
  }
  const ci = argv.indexOf('--compare');
  if (ci >= 0) {
    const [fa, fb] = [argv[ci + 1], argv[ci + 2]];
    if (!fa || !fb) throw new Error('--compare needs two report files');
    console.log(compare(JSON.parse(fs.readFileSync(fa, 'utf8')), JSON.parse(fs.readFileSync(fb, 'utf8'))));
    return 0;
  }
  if (flag('detach')) return detach();
  const unknown = argv.filter((a, i) => a.startsWith('--') && !PASS_THROUGH.includes(a.slice(2)) && !['scenarios', 'records', 'resume'].includes(a.slice(2)) && !(i > 0 && PASS_THROUGH.includes(argv[i - 1].slice(2))));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(' ')}`);
  const label = (opt('label', 'profile') ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
  const env = {
    DESKTOP_CAT_PROFILE: '1',
    DESKTOP_CAT_PROFILE_LABEL: label,
    DESKTOP_CAT_PROFILE_HOURS: opt('hours', '3'),
    DESKTOP_CAT_PROFILE_SEEDS: opt('seeds', '8'),
    ...(opt('matrix') ? { DESKTOP_CAT_PROFILE_MATRIX: opt('matrix') } : {}),
    ...(opt('cells') ? { DESKTOP_CAT_PROFILE_CELLS: opt('cells') } : {}),
    ...(opt('profiles') ? { DESKTOP_CAT_PROFILE_PROFILES: opt('profiles') } : {}),
    ...(opt('layouts') ? { DESKTOP_CAT_PROFILE_LAYOUTS: opt('layouts') } : {}),
    ...(opt('users') ? { DESKTOP_CAT_PROFILE_USERS: opt('users') } : {}),
    ...(opt('variants') ? { DESKTOP_CAT_PROFILE_VARIANTS: opt('variants') } : {}),
    ...(opt('start-hour') ? { DESKTOP_CAT_PROFILE_START_HOUR: opt('start-hour') } : {}),
    ...(flag('scenarios') ? { DESKTOP_CAT_PROFILE_SCENARIOS: '1' } : {}),
    ...(flag('records') ? { DESKTOP_CAT_PROFILE_RECORDS: '1' } : {}),
    ...(flag('resume') ? { DESKTOP_CAT_PROFILE_RESUME: '1' } : {}),
  };
  Object.assign(process.env, env);
  process.chdir(ROOT);
  const { startVitest } = await import('vitest/node');
  // The default config includes only tests/unit and tests/integration: point it at tests/profile.
  const vitest = await startVitest(['tests/profile/profile.test.ts'], { run: true, watch: false, include: ['tests/profile/**/*.test.ts'], testTimeout: 12 * 3600_000, maxWorkers: 1 });
  const failed = vitest?.state.getCountOfFailedTests() ?? 1;
  await vitest?.close();
  const file = path.join(ROOT, 'out', 'profile', `${label}.json`);
  if (!fs.existsSync(file)) {
    console.error(`profile: no report at ${file}`);
    return 1;
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`\n${render(report)}`);
  const copyTo = opt('copy-to');
  if (copyTo) {
    fs.mkdirSync(copyTo, { recursive: true });
    fs.copyFileSync(file, path.join(copyTo, path.basename(file)));
    console.log(`\nprofile: copied to ${path.join(copyTo, path.basename(file))}`);
  }
  const compactTo = opt('compact-to');
  if (compactTo) {
    fs.mkdirSync(path.dirname(path.resolve(compactTo)), { recursive: true });
    fs.writeFileSync(compactTo, `${JSON.stringify(compact(report), null, 1)}\n`);
    console.log(`profile: compact copy at ${compactTo}`);
  }
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
