// End-to-end test hooks: installed only in test mode (DESKTOP_CAT_TEST=1, never in a
// normal or packaged launch) and, from v1.1.1, exposing the surface diagnostics and the
// sim's outline segments. MOCKED context (no app).
import { describe, expect, it } from 'vitest';
import { installTestHooks, TEST_HOOK_GLOBAL, type DesktopCatTestApi, type TestHookContext } from '../../../src/main/testHooks';
import type { SurfaceDebugLine } from '../../../src/shared/surfaceDiagnostics';
import { fullDiagnostics } from './diagnosticsSurfaceFixture';
import { emptyBehaviorProfile } from '../../../src/shared/behaviorProfile';
import type { Point } from '../../../src/shared/geometry';

const lines: SurfaceDebugLine[] = [{ kind: 'windowSide', role: 'reachable', x0: 308, y0: 140, x1: 308, y1: 892 }];

const injected: Array<Point | null> = [];
const injectedIdle: Array<number | null> = [];
const restricted: Array<readonly number[] | null> = [];

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
    getBehaviorProfile: () => emptyBehaviorProfile(7),
    injectCursor: (p) => void injected.push(p),
    injectUserIdle: (ms) => void injectedIdle.push(ms),
    restrictSurfacesToPids: (pids) => void restricted.push(pids),
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
    // v1.2 (ADR 0003 §15.4): the behaviour profile, an injected cursor, own-process surfaces; inputs validated.
    expect(api.getBehaviorProfile().since).toBe(7);
    api.injectCursor({ x: 10, y: 20 });
    api.injectCursor(null);
    expect(injected).toEqual([{ x: 10, y: 20 }, null]);
    expect(() => api.injectCursor({ x: Number.NaN, y: 0 })).toThrow();
    expect(() => api.injectCursor('here' as unknown as Point)).toThrow();
    api.injectUserIdle(90_000);
    api.injectUserIdle(null);
    expect(injectedIdle).toEqual([90_000, null]);
    expect(() => api.injectUserIdle(-1)).toThrow();
    expect(() => api.injectUserIdle(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => api.injectUserIdle('soon' as unknown as number)).toThrow();
    api.restrictSurfacesToPids([1234]);
    api.restrictSurfacesToPids(null);
    expect(restricted).toEqual([[1234], null]);
    expect(() => api.restrictSurfacesToPids([1.5])).toThrow();
    expect(() => api.restrictSurfacesToPids([0])).toThrow();
  });
});
