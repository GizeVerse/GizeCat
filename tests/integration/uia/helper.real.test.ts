// REAL: DesktopCatUia.exe + UiaHelperClient + TabStripService against our own throwaway Edge and
// Chrome instances (temp profiles, about:blank tabs; see realBrowser.ts for the safety rules).
// Opt-in: DESKTOP_CAT_REAL_BROWSER=1 (it opens browser windows on the desktop). Run it under the
// machine lock:  node scripts/with-lock.mjs uia-real -- cmd /c "set DESKTOP_CAT_REAL_BROWSER=1&& npx vitest run tests/integration/uia"
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveUiaHelperPath } from '../../../src/main/uia';
import { probeBrowser } from './probe';
import { findBrowser } from './realBrowser';

const enabled = process.platform === 'win32' && process.env.DESKTOP_CAT_REAL_BROWSER === '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe.runIf(enabled)('tab strips with a real browser (REAL)', () => {
  let helperPath: string | null = null;

  beforeAll(() => {
    execFileSync(process.execPath, [path.join(root, 'scripts', 'build-uia-helper.mjs'), '--strict'], { cwd: root, stdio: 'pipe', windowsHide: true });
    helperPath = resolveUiaHelperPath({ packaged: false, resourcesPath: '', appRoot: root });
  });

  for (const kind of ['edge', 'chrome'] as const) {
    it.runIf(findBrowser(kind) !== null)(
      `${kind}: strip, segment, tab added, maximize, cleanup`,
      async () => {
        expect(helperPath).not.toBeNull();
        const r = await probeBrowser(kind, helperPath!);
        expect(r.failures).toEqual([]);
        expect(r.strip?.count).toBe(3);
        expect(r.added?.countAfter).toBe(4);
        expect(r.added?.change).toBe('added');
        expect(r.maximized).toEqual({ reported: true, listedWhileMaximized: false, restored: true });
        expect(r.close?.leftOver).toBe(0);
        expect(r.close?.profileRemoved).toBe(true);
      },
      120_000,
    );
  }
});
