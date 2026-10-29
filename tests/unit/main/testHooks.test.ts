// End-to-end test hooks: installed only in test mode (DESKTOP_CAT_TEST=1, never in a
// normal or packaged launch) and, from v1.1.1, exposing the surface diagnostics and the
// sim's outline segments. MOCKED context (no app).
import { describe, expect, it } from 'vitest';
import { installTestHooks, TEST_HOOK_GLOBAL, type DesktopCatTestApi, type TestHookContext } from '../../../src/main/testHooks';
import type { SurfaceDebugLine } from '../../../src/shared/surfaceDiagnostics';
import { fullDiagnostics } from './diagnosticsSurfaceFixture';

const lines: SurfaceDebugLine[] = [{ kind: 'windowSide', role: 'reachable', x0: 308, y0: 140, x1: 308, y1: 892 }];

function context(): TestHookContext {
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  return {
    getSimOutput: () => null,
    getOverlays: () => [],
    getStatus: unused,
    getSettings: unused,
    getPerceptionStatus: () => null,
    getHostDebug: unused,
    getStartup: unused,
    getLogProblems: () => ({ warn: 0, error: 0 }),
    getRecentLogs: () => [],
    getDiagnosticsReport: () => ({}),
    injectEvent: () => undefined,
    getSurfaces: () => [],
    getSurfaceStatus: unused,
    injectSurfaces: () => undefined,
    getSurfaceDiagnostics: () => fullDiagnostics(),
    getSurfaceDebugLines: () => lines,
    forceInteractive: () => undefined,
    setTimeScale: () => undefined,
    runAction: () => Promise.resolve({ ok: true }),
    patchSettings: unused,
    openSettings: () => undefined,
    saveNow: () => undefined,
    quit: () => undefined,
  };
}

describe('test hooks', () => {
  it('are not installed outside test mode (normal and packaged launches)', () => {
    expect(installTestHooks(context(), {})).toBe(false);
    expect(installTestHooks(context(), { DESKTOP_CAT_TEST: '0' })).toBe(false);
    expect(installTestHooks(context(), { DESKTOP_CAT_TEST: 'true' })).toBe(false);
    expect(TEST_HOOK_GLOBAL in globalThis).toBe(false);
  });

  it('expose the surface diagnostics and the outline segments in test mode', () => {
    expect(installTestHooks(context(), { DESKTOP_CAT_TEST: '1' })).toBe(true);
    const api = (globalThis as unknown as Record<string, DesktopCatTestApi>)[TEST_HOOK_GLOBAL]!;
    expect(api.getSurfaceDiagnostics()).toEqual(fullDiagnostics());
    expect(api.getSurfaceDebugLines()).toEqual(lines);
    expect(Object.isFrozen(api)).toBe(true);
  });
});
