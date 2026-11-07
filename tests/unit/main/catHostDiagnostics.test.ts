// Diagnosis F8: the long-run interaction counters reach the host debug state and the diagnostics export
// (the `interaction` section), as counters only. REAL createCatHost and buildDiagnosticsReport; the
// sim, Win32 and the overlays are in-memory stand-ins (MOCKED).
import { describe, expect, it } from 'vitest';
import { createCatHost, type ClickGuardStats, type HostOverlays } from '../../../src/main/catHost';
import type { ActivityMonitor, DisplayService, PerceptionService, Win32Api, WindowTracker } from '../../../src/main/contracts';
import { buildDiagnosticsReport, exportedInteraction, type DiagnosticsInput } from '../../../src/main/diagnostics/diagnosticsReport';
import type { OverlayInteractionStats } from '../../../src/main/overlay/overlayManager';
import { emptyBehaviorProfile } from '../../../src/shared/behaviorProfile';
import type { PersistedCat } from '../../../src/shared/catState';
import type { AppStatus } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';
import type { CatSim, SimOutput } from '../../../src/shared/sim';
import { manualTimers, memoryLogger } from './helpers';

const OVERLAY_STATS: OverlayInteractionStats = {
  presses: 120,
  lostPresses: { buttonUp: 2, silent: 1, moved: 0 },
  win32Disagreements: 3,
  contextCancels: 1,
  failClosedPolls: 4,
  ignoreToggles: 250,
  recreates: 0,
  staleRegionDenials: 5,
};

const GUARD_STATS: ClickGuardStats = {
  episodes: { band: 3, edgeFlight: 2, bailOut: 1 },
  timeInGuardMs: { band: 9000, edgeFlight: 800, bailOut: 1500 },
  longestEpisodeMs: 6000,
  bailOutsCapped: 1,
  failClosedPolls: 7,
  staleGracePolls: 30,
  activePolls: 400,
};

const status: AppStatus = {
  version: '1.0.0',
  visible: true,
  paused: false,
  interactionsEnabled: true,
  catState: 'idle',
  displayCount: 1,
  perception: { mode: 'off', paused: false, blockedReason: null, lastCaptureAt: null, capturesThisHour: 0, aiProviderLabel: null, lastError: null },
  windowAwareness: 'event-hooks',
  loginItem: { enabled: true, preference: 'unset', disabledBy: null, active: false, writable: false, reason: null, showNotice: false },
  shortcutRegistered: true,
  startedAt: 0,
};

function input(interaction: DiagnosticsInput['interaction']): DiagnosticsInput {
  return {
    generatedAt: new Date('2026-11-07T00:00:00Z'),
    versions: { app: '1.2.0' },
    os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
    world: { version: 1, displays: [] },
    settings: defaultSettings(),
    apiKeysStored: { anthropic: false, openaiCompatible: false },
    status,
    cat: {},
    ...(interaction === undefined ? {} : { interaction }),
    services: {},
    resources: [],
    logs: [],
  };
}

describe('diagnostics export: the interaction section (F8)', () => {
  it('carries the press-path counters, the click-guard time per reason and episodes, and the lock recoveries', () => {
    const report = buildDiagnosticsReport(input({ overlays: OVERLAY_STATS, clickGuard: GUARD_STATS, lifecycle: { suspended: false, locks: 4, lockRecoveries: 1, resumeRecoveries: 0 } }));
    expect(report.interaction).toEqual({
      overlays: OVERLAY_STATS,
      clickGuard: GUARD_STATS,
      lifecycle: { suspended: false, locks: 4, lockRecoveries: 1, resumeRecoveries: 0 },
    });
  });

  it('absent, or a source missing: null, never a throw', () => {
    expect(buildDiagnosticsReport(input(undefined)).interaction).toBeNull();
    expect(buildDiagnosticsReport(input(null)).interaction).toBeNull();
    expect(exportedInteraction({ overlays: null, clickGuard: GUARD_STATS, lifecycle: null })).toEqual({ overlays: null, clickGuard: GUARD_STATS, lifecycle: null });
  });

  it('counters only: strings, arrays, rects nested past the counters and non-finite values never reach the export', () => {
    const leaky = {
      ...OVERLAY_STATS,
      lastTitle: 'Inbox - private@example.com',
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
      nested: { deeper: { deepest: { x: 1 } } },
      bad: Number.NaN,
    } as unknown as OverlayInteractionStats;
    const out = exportedInteraction({ overlays: leaky, clickGuard: null, lifecycle: null });
    expect(out?.overlays).toEqual({ ...OVERLAY_STATS, nested: { deeper: {} }, bad: null });
    expect(JSON.stringify(buildDiagnosticsReport(input({ overlays: leaky, clickGuard: null, lifecycle: null })))).not.toMatch(/private@example|Inbox/);
  });
});

describe('host debug state: guard stats, lifecycle and the overlay counters (F8)', () => {
  function host(overlayStats: (() => OverlayInteractionStats) | null) {
    const timers = manualTimers();
    const out: SimOutput = {
      x: 900,
      y: 1040,
      facing: 1,
      state: 'idle',
      clip: 'stand',
      clipStartedAt: 0,
      speed: 0,
      vy: 0,
      look: null,
      arousal: 0,
      contentment: 0.5,
      emote: null,
      emoteStartedAt: 0,
      opacity: 1,
      visible: true,
      snap: false,
      displayId: '1',
      support: { kind: 'surface', surfaceId: 'screenEdge:1:left', surfaceKind: 'screenEdge', orientation: 'wall' },
      boundsPx: { x: 0, y: 600, width: 84, height: 84 },
      nextTickMs: 33,
      requests: [],
    };
    const sim = {
      tick: () => out,
      updateSettings: () => undefined,
      setWorld: () => undefined,
      serialize: () => ({}) as PersistedCat,
      resetPersonality: () => undefined,
      clearHistory: () => undefined,
      state: 'idle',
      debugInfo: () => ({}),
      surfaceDiagnostics: () => {
        throw new Error('unused');
      },
      surfaceDebugLines: () => [],
      behaviorProfile: () => emptyBehaviorProfile(0),
    } as unknown as CatSim;
    const overlays: HostOverlays = {
      render: () => undefined,
      updateInteractivity: () => undefined,
      isCursorOverCat: () => false,
      dragging: false,
      pressed: false,
      interactive: false,
      ...(overlayStats ? { interactionStats: overlayStats } : {}),
    };
    const world = { version: 1, displays: [{ id: '1', primary: true, scaleFactor: 1, boundsDip: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 }, boundsPx: { x: 0, y: 0, width: 1920, height: 1080 }, workAreaPx: { x: 0, y: 0, width: 1920, height: 1040 } }] };
    const h = createCatHost({
      sim,
      win32: { available: false, getCursorPos: () => null, isLeftButtonDown: () => false } as unknown as Win32Api,
      tracker: { drainEvents: () => [], getForeground: () => null, getFullscreenDisplayIds: () => [] } as unknown as WindowTracker,
      activity: { sample: () => undefined, drainEvents: () => [], idleMs: 0, typing: false, typingIntensity: 0, cursorSpeed: 0 } as unknown as ActivityMonitor,
      perception: { drainEvents: () => [], request: () => undefined } as unknown as PerceptionService,
      display: { world, displayAt: () => '1' } as unknown as DisplayService,
      overlays,
      catStore: { markDirty: () => undefined, save: () => Promise.resolve(true) },
      logger: memoryLogger(),
      getSettings: () => defaultSettings(),
      cursorFallback: () => null,
      clock: () => timers.now,
      timers,
    });
    h.start();
    timers.advance(5000);
    return h;
  }

  it('reports time in the band phase, the episodes, the lifecycle counters and the overlays press counters', () => {
    const h = host(() => OVERLAY_STATS);
    const d = h.debug();
    expect(d.clickGuardStats.episodes.band).toBe(1);
    // The phase still running counts: about the 5 s the cat has clung so far.
    expect(d.clickGuardStats.timeInGuardMs.band).toBeGreaterThan(4900);
    expect(d.clickGuardStats.timeInGuardMs.band).toBeLessThanOrEqual(5000);
    expect(d.lifecycle).toEqual({ suspended: false, locks: 0, lockRecoveries: 0, resumeRecoveries: 0 });
    expect(d.interaction).toEqual(OVERLAY_STATS);
    h.stop();
  });

  it('overlays without counters, or counters that throw: null, and the debug state still builds', () => {
    expect(host(null).debug().interaction).toBeNull();
    const throwing = host(() => {
      throw new Error('gone');
    });
    expect(throwing.debug().interaction).toBeNull();
  });
});
