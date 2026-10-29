// Behaviour profile (SIMULATED, see behaviorProfile.ts). Opt-in: runs only with DESKTOP_CAT_PROFILE=1
// (scripts/behavior-profile.mjs sets it and points vitest at this folder; the default vitest config
// does not include tests/profile). Writes out/profile/<label>.json. It measures, it does not judge:
// the only assertions are that every run completed its sim time without host or sim errors.
//
// Environment: DESKTOP_CAT_PROFILE_HOURS (3), _SEEDS (8, or a list "1,2,3"), _PROFILES (P1,P2),
// _LAYOUTS (L1,L2,L3), _LABEL (profile), _START_HOUR (18.5), _OUT (out/profile).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../integration/surfaces/pipeline';
import { configFromEnv, HOUR, runProfiles } from './behaviorProfile';

const enabled = process.env.DESKTOP_CAT_PROFILE === '1';

describe.skipIf(!enabled)('behaviour profile (DESKTOP_CAT_PROFILE=1)', () => {
  it(
    'runs every (profile, layout, seed) and writes the JSON report',
    () => {
      const cfg = configFromEnv(process.env);
      const report = runProfiles(cfg, (m) => console.log(m));
      const outDir = path.resolve(ROOT, process.env.DESKTOP_CAT_PROFILE_OUT ?? path.join('out', 'profile'));
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${cfg.label}.json`);
      fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
      console.log(`profile: wrote ${file}`);
      expect(report.runs).toHaveLength(cfg.profiles.length * cfg.layouts.length * cfg.seeds.length);
      for (const r of report.runs) {
        expect(r.simMs).toBeGreaterThanOrEqual(cfg.hours * HOUR - 2000);
        expect(r.integrity.hostTickErrors).toBe(0);
        expect(r.integrity.eventErrors).toBe(0);
      }
    },
    12 * 3600_000,
  );
});
