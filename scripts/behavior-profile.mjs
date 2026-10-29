#!/usr/bin/env node
// Behaviour profile runner (SIMULATED; see tests/profile/behaviorProfile.ts). Heavy on a shared
// machine: run it under the lock, one at a time:
//
//   node scripts/with-lock.mjs profile -- node scripts/behavior-profile.mjs [options]
//
// Options:
//   --hours <h>            sim-hours per (profile, layout, seed)       (default 3: the v1.2 baseline)
//   --seeds <n|a,b,c>      number of seeds or an explicit list          (default 8: the v1.2 baseline)
//   --profiles P1,P2       --layouts L1,L2,L3                           (default all)
//   --label <name>         report name: out/profile/<name>.json         (default profile)
//   --start-hour <h>       local hour the runs start at                 (default 18.5)
//   --copy-to <dir>        also copy the JSON there
//   --report <file.json>   only print the tables of a saved report
//   --compare <a.json> <b.json>   key metrics of two saved reports side by side (e.g. baseline vs v1.2)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// ------------------------------------------------------------------ rendering

const fmt = (v) => (v === null || v === undefined ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2)) : String(v));
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(fmt).join(' | ')} |`)].join('\n');
const top = (obj, n = 6, unit = '') =>
  Object.entries(obj ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${fmt(v)}${unit}`)
    .join(', ') || '-';
const d = (x) => (x && x.n ? `${fmt(x.min)} / ${fmt(x.median)} / ${fmt(x.p90)} / ${fmt(x.max)} (n ${x.n})` : 'n 0');
const get = (o, p) => p.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);

function render(report) {
  const cells = Object.entries(report.cells);
  const names = cells.map(([k]) => k);
  const col = (f) => cells.map(([, c]) => f(c));
  const out = [];
  const m = report.meta;
  out.push(`# Behaviour profile "${m.label}" (${m.createdAt})`);
  out.push(`${m.labels}. Screen: ${m.screen}. ${m.config.hours} sim-h x seeds ${m.config.seeds.join(',')} per cell; start hour ${m.config.startHour ?? 18.5}.`);
  out.push(`Layouts: ${Object.entries(m.layouts).map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  out.push(`Usage model: ${JSON.stringify(m.usage)}`);

  out.push('\n## Time share (% of sim time)');
  const rowsT = [
    ['calm + asleep', ...col((c) => c.timeSharePct.calmPlusAsleep)],
    ['  asleep', ...col((c) => c.timeSharePct.category.asleep ?? 0)],
    ['  calm (awake)', ...col((c) => c.timeSharePct.category.calm ?? 0)],
    ['active (states)', ...col((c) => c.timeSharePct.active)],
    ['moving (position changes)', ...col((c) => c.timeSharePct.moving)],
    ['interaction (petted, held)', ...col((c) => c.timeSharePct.category.interaction ?? 0)],
    ['reaction (startled, annoyed, hiding)', ...col((c) => c.timeSharePct.category.reaction ?? 0)],
    ['physical (falling, landing)', ...col((c) => c.timeSharePct.category.physical ?? 0)],
    ['up on windows (top, strip, side)', ...col((c) => c.timeSharePct.elevated)],
    ['  on a tab strip', ...col((c) => c.timeSharePct.support.tabStrip ?? 0)],
    ['  on a window top', ...col((c) => c.timeSharePct.support.windowTop ?? 0)],
    ['  on a window side', ...col((c) => c.timeSharePct.support.windowSide ?? 0)],
    ['maximized window in front (% of time)', ...col((c) => c.timeSharePct.front?.maximizedFront ?? 0)],
    ['  up on windows while a floating window is in front', ...col((c) => c.timeSharePct.elevatedWhileWindowFront)],
    ['  up on windows while a maximized one is in front', ...col((c) => c.timeSharePct.elevatedWhileMaximizedFront)],
    ['clip climb', ...col((c) => c.timeSharePct.clip.climb ?? 0)],
    ['clip loaf', ...col((c) => c.timeSharePct.clip.loaf ?? 0)],
  ];
  out.push(table(['metric', ...names], rowsT));
  out.push('\nTop states (% of sim time):');
  for (const [k, c] of cells) out.push(`- ${k}: ${top(c.timeSharePct.state, 9, ' %')}`);
  out.push('\nTop state/variant (% of sim time):');
  for (const [k, c] of cells) out.push(`- ${k}: ${top(c.timeSharePct.topVariants, 10, ' %')}`);

  out.push('\n## Autonomous decisions');
  const buckets = ['tripUp', 'chase', 'watchCursor', 'play', 'wander', 'calm', 'sleep', 'social', 'wary'];
  out.push(
    table(
      ['metric', ...names],
      [
        ['decisions per awake min', ...col((c) => c.decisions.perAwakeMin)],
        ['decisions (total / on floor / elevated)', ...col((c) => `${c.decisions.total} / ${c.decisions.floor.n} / ${c.decisions.elevated.n}`)],
        ['no choice / blocked request', ...col((c) => `${c.decisions.nullChoices} / ${c.decisions.results.blocked ?? 0}`)],
        ['autonomous locomotion picks / h', ...col((c) => c.locomotion.autonomousLocomotionPicksPerHour)],
        ['movement bouts >= 1 BL / h', ...col((c) => c.locomotion.boutsPerHour)],
        ...buckets.map((b) => [`floor: P(pick ${b}) % (eligible %)`, ...col((c) => `${fmt(c.decisions.floor.expectedPickPct[b] ?? 0)} (${fmt(c.decisions.floor.eligiblePct[b] ?? 0)})`)]),
      ],
    ),
  );
  out.push('\nPicks (% of autonomous requests):');
  for (const [k, c] of cells) out.push(`- ${k}: ${top(c.decisions.picksPct, 10, ' %')}`);
  out.push('\nDecisions while up on a top/strip, expected pick % by kind:');
  for (const [k, c] of cells) out.push(`- ${k} (n ${c.decisions.elevated.n}): ${top(c.decisions.elevated.expectedPickPct, 8, ' %')}`);
  out.push('\nCooldown blocks (% of decisions where a positive option was excluded by its state cooldown):');
  for (const [k, c] of cells) out.push(`- ${k}: ${top(c.decisions.cooldownBlockedPctOfDecisions, 8, ' %')}`);
  out.push('\nTrip-up target status at decisions (% of decisions):');
  for (const [k, c] of cells) out.push(`- ${k}: perch {${top(c.decisions.targetStatusPct.perch, 5, '')}} climb {${top(c.decisions.targetStatusPct.climb, 5, '')}} tabStrip {${top(c.decisions.targetStatusPct.tabStrip, 5, '')}}`);

  out.push('\n## Exploration (trips up: explore a top, climb a side, visit a tab strip)');
  const rowsE = [];
  for (const [k, c] of cells) {
    for (const [kind, a] of Object.entries(c.exploration.byKind)) rowsE.push([k, kind, a.perHour, a.attempts, a.successPct, top(a.reasons, 6), d(a.msToArrive)]);
  }
  out.push(table(['cell', 'kind', 'attempts/h', 'n', 'success %', 'outcomes', 'sec to arrive min/med/p90/max'], rowsE));

  out.push('\n## Elevated arrivals and stays (per ledge: a continuous stay on one top or strip)');
  const rowsS = [];
  for (const [k, c] of cells) {
    for (const kind of ['tabStrip', 'windowTop']) {
      const s = c.elevated.byKind[kind];
      if (!s) continue;
      rowsS.push([k, kind, s.ownArrivalsPerHour, s.stays, d(s.dwellOwnSec), d(s.dwellSec), top(s.how, 5), top(s.endReasons, 6)]);
    }
  }
  out.push(table(['cell', 'kind', 'own arrivals/h', 'stays', 'dwell s own (min/med/p90/max)', 'dwell s all', 'how it got on', 'why it ended'], rowsS));
  out.push('\nVisits (arrival up -> back on the floor):');
  for (const [k, c] of cells) out.push(`- ${k}: ${c.elevated.visits.perHour}/h, dwell s ${d(c.elevated.visits.dwellSec)}; first own arrival s per run: ${c.elevated.firstArrivalSec.map(fmt).join(', ')}; sim excursion counter ${c.elevated.diagExcursionsPerHour}/h`);
  out.push('\nDwell s by why the stay ended (min/med/p90/max):');
  for (const [k, c] of cells) {
    for (const kind of ['tabStrip', 'windowTop']) {
      const s = c.elevated.byKind[kind];
      if (!s?.stays || !s.dwellSecByEnd) continue;
      out.push(`- ${k} ${kind}: ${Object.entries(s.dwellSecByEnd).filter(([, x]) => x.n > 0).map(([cls, x]) => `${cls} ${d(x)}`).join('; ')}`);
    }
  }
  out.push('\nActivity when it left a strip / top:');
  for (const [k, c] of cells) for (const kind of ['tabStrip', 'windowTop']) if (c.elevated.byKind[kind]?.stays) out.push(`- ${k} ${kind}: ${top(c.elevated.byKind[kind].leftDuring, 6)}`);

  out.push('\n## Cursor hunting');
  out.push(
    table(
      ['metric', ...names],
      [
        ['chase starts / h', ...col((c) => c.cursor.chaseStartsPerHour)],
        ['  started with stalk / approach', ...col((c) => `${c.cursor.chaseStartPhase.stalk ?? 0} / ${c.cursor.chaseStartPhase.approach ?? 0}`)],
        ['pounces / h', ...col((c) => c.cursor.pouncesPerHour)],
        ['pawAt (in chase) / h', ...col((c) => c.cursor.phaseEntriesPerHour['chasingCursor/pawAt'] ?? 0)],
        ['watchingCursor starts / h', ...col((c) => c.cursor.watchStartsPerHour)],
        ['  crouch (wind-up) / h', ...col((c) => c.cursor.phaseEntriesPerHour['watchingCursor/crouch'] ?? 0)],
        ['playing/pawAt starts / h', ...col((c) => c.cursor.phaseEntriesPerHour['playing/pawAt'] ?? 0)],
        ['cursor in reach band % of awake', ...col((c) => c.cursor.cursorInReachBandPctOfAwake)],
        ['  and moving > 150 DIP/s', ...col((c) => c.cursor.cursorInBandAndMovingPctOfAwake)],
        ['chase eligible % of floor decisions', ...col((c) => c.decisions.floor.eligiblePct.chase ?? 0)],
      ],
    ),
  );

  out.push('\n## Falls, jumps, recovery');
  out.push(
    table(
      ['metric', ...names],
      [
        ['falls / h', ...col((c) => c.falls.perHour)],
        ['voluntary jump-downs from a top/strip / h', ...col((c) => c.falls.voluntaryJumpDownsPerHour)],
        ['falls by reason', ...col((c) => top(c.falls.byReason, 8))],
      ],
    ),
  );
  out.push('\nRecovery (s from fall start to the first settled state) by fall reason, min/med/p90/max:');
  for (const [k, c] of cells) out.push(`- ${k}: ${Object.entries(c.falls.recoverySec).map(([r, x]) => `${r} ${d(x)}`).join('; ')}`);
  out.push('\nJumps (kind:from:direction->onto):');
  for (const [k, c] of cells) out.push(`- ${k}: ${top(c.falls.jumps, 10)}`);

  out.push('\n## Reactions to releases (drag = gentle, throw:belowHard = brisk under the hard-throw speed, throw:hard = counted as thrown)');
  const rowsR = [];
  for (const [k, c] of cells) {
    for (const [cls, r] of Object.entries(c.releases)) rowsR.push([k, cls, r.n, top(r.firstReaction, 4), r.hidPct, d(r.fearMax), d(r.recoverySec)]);
  }
  out.push(table(['cell', 'release', 'n', 'first reaction after landing', 'hid %', 'fear max', 'recovery s'], rowsR));
  out.push('\nMost common reaction sequences:');
  for (const [k, c] of cells) out.push(`- ${k}: ${Object.entries(c.releases).map(([cls, r]) => `${cls}: ${top(r.sequences, 3)}`).join(' | ')}`);

  out.push('\n## Stats (min / mean / max over the runs)');
  out.push(table(['stat', ...names], ['energy', 'boredom', 'bond', 'annoyance', 'fear', 'urge'].map((s) => [s, ...col((c) => `${fmt(c.stats[s].min)} / ${fmt(c.stats[s].mean)} / ${fmt(c.stats[s].max)}`)])));

  out.push('\n## Counters per awake hour (sim) vs the user\'s installed 1.1.1 (REAL, counts only)');
  const ev = m.userEvidencePerAwakeHour;
  out.push(table(['counter', ...names, 'user 1.1.1'], ['pets', 'drags', 'throws', 'chasesStarted', 'chasesEngaged', 'windowsInspected', 'naps'].map((k) => [k, ...col((c) => c.countersPerAwakeHour[k] ?? 0), ev[k]])));

  out.push('\n## Screen edges and floor coverage');
  for (const [k, c] of cells) out.push(`- ${k}: near a screen edge ${c.floor.nearScreenEdgePct} % of floor time; x deciles % ${c.floor.xDecilesPct.map(fmt).join(' ')}`);

  out.push('\n## The simulated user (actual)');
  out.push(
    table(
      ['metric', ...names],
      [
        ['pet sessions / h', ...col((c) => c.user.petSessionsPerHour)],
        ['drags / h', ...col((c) => c.user.dragsPerHour)],
        ['throws / h', ...col((c) => c.user.throwsPerHour)],
        ['tab selections / h', ...col((c) => c.user.tabSwitchesPerHour)],
        ['mode share %', ...col((c) => top(c.user.modeSharePct, 6))],
      ],
    ),
  );
  out.push('\n## Integrity');
  for (const [k, c] of cells) out.push(`- ${k}: ${JSON.stringify(c.integrity)}; climbs ${JSON.stringify(c.nav)}`);
  const probes = new Set(report.runs.flatMap((r) => Object.entries(r.probes).filter(([, v]) => v !== 'ok').map(([p]) => p)));
  out.push(`- probes missing: ${probes.size ? [...probes].join(', ') : 'none'}`);
  return out.join('\n');
}

const KEY_METRICS = [
  ['calm + asleep %', 'timeSharePct.calmPlusAsleep'],
  ['active %', 'timeSharePct.active'],
  ['moving %', 'timeSharePct.moving'],
  ['elevated %', 'timeSharePct.elevated'],
  ['tab strip %', 'timeSharePct.support.tabStrip'],
  ['elevated % while a floating window is in front', 'timeSharePct.elevatedWhileWindowFront'],
  ['decisions / awake min', 'decisions.perAwakeMin'],
  ['P(tripUp) floor %', 'decisions.floor.expectedPickPct.tripUp'],
  ['P(chase) floor %', 'decisions.floor.expectedPickPct.chase'],
  ['locomotion picks / h', 'locomotion.autonomousLocomotionPicksPerHour'],
  ['bouts / h', 'locomotion.boutsPerHour'],
  ['strip own arrivals / h', 'elevated.byKind.tabStrip.ownArrivalsPerHour'],
  ['strip dwell median s', 'elevated.byKind.tabStrip.dwellOwnSec.median'],
  ['strip dwell p90 s', 'elevated.byKind.tabStrip.dwellOwnSec.p90'],
  ['top own arrivals / h', 'elevated.byKind.windowTop.ownArrivalsPerHour'],
  ['top dwell median s', 'elevated.byKind.windowTop.dwellOwnSec.median'],
  ['visits / h', 'elevated.visits.perHour'],
  ['chase starts / h', 'cursor.chaseStartsPerHour'],
  ['pounces / h', 'cursor.pouncesPerHour'],
  ['voluntary jump-downs / h', 'falls.voluntaryJumpDownsPerHour'],
  ['falls / h', 'falls.perHour'],
  ['hard throw: hid %', 'releases.throw:hard.hidPct'],
  ['boredom mean', 'stats.boredom.mean'],
  ['energy mean', 'stats.energy.mean'],
];

function compare(a, b) {
  const out = [`# Behaviour profile: "${a.meta.label}" vs "${b.meta.label}"`];
  for (const cell of Object.keys(a.cells).filter((k) => k in b.cells)) {
    out.push(`\n## ${cell}`);
    out.push(table(['metric', a.meta.label, b.meta.label, 'delta'], KEY_METRICS.map(([n, p]) => {
      const x = get(a.cells[cell], p);
      const y = get(b.cells[cell], p);
      return [n, x, y, typeof x === 'number' && typeof y === 'number' ? Math.round((y - x) * 100) / 100 : '-'];
    })));
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ main

async function main() {
  const reportFile = opt('report');
  if (reportFile) {
    console.log(render(JSON.parse(fs.readFileSync(reportFile, 'utf8'))));
    return 0;
  }
  const ci = argv.indexOf('--compare');
  if (ci >= 0) {
    const [fa, fb] = [argv[ci + 1], argv[ci + 2]];
    if (!fa || !fb) throw new Error('--compare needs two report files');
    console.log(compare(JSON.parse(fs.readFileSync(fa, 'utf8')), JSON.parse(fs.readFileSync(fb, 'utf8'))));
    return 0;
  }
  const label = (opt('label', 'profile') ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
  const env = {
    DESKTOP_CAT_PROFILE: '1',
    DESKTOP_CAT_PROFILE_LABEL: label,
    DESKTOP_CAT_PROFILE_HOURS: opt('hours', '3'),
    DESKTOP_CAT_PROFILE_SEEDS: opt('seeds', '8'),
    ...(opt('profiles') ? { DESKTOP_CAT_PROFILE_PROFILES: opt('profiles') } : {}),
    ...(opt('layouts') ? { DESKTOP_CAT_PROFILE_LAYOUTS: opt('layouts') } : {}),
    ...(opt('start-hour') ? { DESKTOP_CAT_PROFILE_START_HOUR: opt('start-hour') } : {}),
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
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
