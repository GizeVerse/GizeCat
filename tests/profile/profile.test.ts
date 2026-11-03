// Behaviour profile (SIMULATED, see behaviorProfile.ts). Opt-in: runs only with DESKTOP_CAT_PROFILE=1
// (scripts/behavior-profile.mjs sets it and points vitest at this folder; the default vitest config
// does not include tests/profile). Writes out/profile/<label>.json with every cell's summary and the
// §14 band verdicts (tests/profile/bands.ts). It measures and reports; the only assertions are that
// every run completed its sim time without host or sim errors. The band assertions live in
// tests/integration/behavior/bands-*.test.ts.
//
// Environment: DESKTOP_CAT_PROFILE_MATRIX (bands | diagnosis | short), or _CELLS / _PROFILES /
// _LAYOUTS / _USERS / _VARIANTS; _HOURS (3), _SEEDS (8, or a list "1,2,3"), _LABEL (profile),
// _START_HOUR (18.5), _OUT (out/profile), _RECORDS=1 (keep record lists), _RESUME=1 (reuse the
// per-cell checkpoints in <out>/<label>.cells/), _SCENARIOS=1 (also the B7 Monte Carlo and the B8
// recovery runs, on the run's seeds).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../integration/surfaces/pipeline';
import { bandTally, evaluateBands, recoveryChecks, throwMonteCarloChecks, type BandResult } from './bands';
import { configFromEnv, HOUR, runProfiles, runRecovery, runThrowMonteCarlo, type CellCheckpoint } from './behaviorProfile';

const enabled = process.env.DESKTOP_CAT_PROFILE === '1';

describe.skipIf(!enabled)('behaviour profile (DESKTOP_CAT_PROFILE=1)', () => {
  it(
    'runs every cell and seed, evaluates the bands and writes the JSON report',
    () => {
      const cfg = configFromEnv(process.env);
      const outDir = path.resolve(ROOT, process.env.DESKTOP_CAT_PROFILE_OUT ?? path.join('out', 'profile'));
      const cpDir = path.join(outDir, `${cfg.label}.cells`);
      fs.mkdirSync(cpDir, { recursive: true });
      const cpFile = (key: string): string => path.join(cpDir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
      const resume = process.env.DESKTOP_CAT_PROFILE_RESUME === '1';
      const report = runProfiles(cfg, (m) => console.log(m), {
        load: (key) => {
          if (!resume || !fs.existsSync(cpFile(key))) return null;
          try {
            return JSON.parse(fs.readFileSync(cpFile(key), 'utf8')) as CellCheckpoint;
          } catch {
            return null;
          }
        },
        save: (cp) => fs.writeFileSync(cpFile(cp.key), `${JSON.stringify(cp)}\n`),
      });
      const extra: BandResult[] = [];
      if (process.env.DESKTOP_CAT_PROFILE_SCENARIOS === '1') {
        for (const p of ['P1', 'P2'] as const) {
          for (const seed of cfg.seeds) {
            const mc = runThrowMonteCarlo(p, seed);
            extra.push(...throwMonteCarloChecks(`B7 ${p} seed ${seed}`, mc));
            console.log(`profile B7 ${p} seed ${seed}: ${mc.records.reactions.length} reactions in ${(mc.simMs / HOUR).toFixed(1)} sim-h`);
            extra.push(...recoveryChecks(`B8 ${p} seed ${seed}`, runRecovery(p, seed, false), 10));
            extra.push(...recoveryChecks(`B8 ${p} seed ${seed} with petting`, runRecovery(p, seed, true), 8));
          }
        }
        // ADR 0003 §15.2: a 1000-throw Monte Carlo (one long run of P2), as bands-full.test.ts runs it.
        extra.push(...throwMonteCarloChecks('B7 P2 1000 throws', runThrowMonteCarlo('P2', 101, 1000), 1000));
      }
      const bands = evaluateBands(report.cells, extra);
      report.bands = { tally: bandTally(bands), results: bands };
      const file = path.join(outDir, `${cfg.label}.json`);
      fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
      console.log(`profile: wrote ${file}`);
      expect(report.runs).toHaveLength(cfg.cells.length * cfg.seeds.length);
      for (const r of report.runs) {
        expect(r.simMs).toBeGreaterThanOrEqual(cfg.hours * HOUR - 2000);
        expect(r.integrity.hostTickErrors).toBe(0);
        expect(r.integrity.eventErrors).toBe(0);
      }
    },
    12 * 3600_000,
  );
});
