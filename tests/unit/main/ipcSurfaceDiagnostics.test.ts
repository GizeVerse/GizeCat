// v1.1.1 surface diagnostics over IPC: the strict zod/mini schemas (accept the full
// contract, reject malformed, oversized and extra fields), the sender check and output
// validation of settings:get-surface-diagnostics, and the session-only outline toggle.
// MOCKED: Electron's ipcMain and the window registry.
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { createActionRunner, type ActionTargets } from '../../../src/main/ipc/actions';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import { createSurfaceOutlines } from '../../../src/main/overlay/surfaceLines';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import type { JsonStore } from '../../../src/main/store/jsonStore';
import { IPC, SETTINGS_ACTIONS } from '../../../src/shared/ipc';
import { applySettingsPatch, defaultSettings } from '../../../src/shared/settings';
import { MAX_DEBUG_LINES, type SurfaceDebugLine, type SurfaceDiagnostics } from '../../../src/shared/surfaceDiagnostics';
import {
  MAX_DIAGNOSTIC_DISPLAYS,
  MAX_RECENT_ERRORS,
  MAX_VERDICT_LENGTH,
  parseSurfaceDiagnostics,
  parseSurfaceLinesPayload,
  SCHEMAS_MATCH_CONTRACT,
} from '../../../src/shared/surfaceDiagnosticsSchema';
import { fullDiagnostics } from './diagnosticsSurfaceFixture';
import { memoryLogger } from './helpers';

type Mutator = (d: SurfaceDiagnostics & Record<string, unknown>) => void;
const mutated = (fn: Mutator): unknown => {
  const d = fullDiagnostics() as SurfaceDiagnostics & Record<string, unknown>;
  fn(d);
  return d;
};

describe('SurfaceDiagnosticsSchema', () => {
  it('accepts a fully populated object and returns an equal copy', () => {
    expect(SCHEMAS_MATCH_CONTRACT).toBe(true);
    const d = fullDiagnostics();
    const parsed = parseSurfaceDiagnostics(d);
    expect(parsed).toEqual(d);
    expect(parsed).not.toBe(d);
  });

  it('rejects malformed values', () => {
    const bad: Mutator[] = [
      (d) => delete (d as Partial<SurfaceDiagnostics>).verdict,
      (d) => (d.at = Number.NaN),
      (d) => (d.provider.windowsConsidered = Number.POSITIVE_INFINITY),
      (d) => (d.provider.listed.windowTop = -1),
      (d) => (d.provider.tabStrips.state = 'busy' as never),
      (d) => (d.provider.skipped = { tooTall: 1 } as never),
      (d) => (d.nav.rejected = { nearFloor: '3' } as never),
      (d) => (d.decision.support = 'ceiling' as never),
      (d) => (d.decision.targets.perch = 'maybe' as never),
      (d) => (d.decision.exploreUrge = 1.5),
      (d) => (d.coordinates.displays[0]!.scale = 0),
      (d) => (d.coordinates.cat.floorYPx = 'low' as never),
      (d) => ((d as Record<string, unknown>).coordinates = null),
    ];
    for (const fn of bad) expect(parseSurfaceDiagnostics(mutated(fn))).toBeNull();
    expect(parseSurfaceDiagnostics(null)).toBeNull();
    expect(parseSurfaceDiagnostics('{}')).toBeNull();
  });

  it('rejects extra fields at any level, so a title or window id can never ride along', () => {
    const extra: Mutator[] = [
      (d) => (d.title = 'Inbox - Mail'),
      (d) => ((d.provider as unknown as Record<string, unknown>).windowTitles = ['Inbox']),
      (d) => ((d.provider.tabStrips as unknown as Record<string, unknown>).tabName = 'Inbox'),
      (d) => ((d.provider.recentErrors[0] as unknown as Record<string, unknown>).processName = 'chrome.exe'),
      (d) => ((d.decision as unknown as Record<string, unknown>).targetId = 'windowTop:197482'),
      (d) => ((d.coordinates.cat as unknown as Record<string, unknown>).hwnd = '197482'),
      (d) => ((d.nav.climbs as unknown as Record<string, unknown>).lastWallId = 'windowSide:1:left'),
    ];
    for (const fn of extra) expect(parseSurfaceDiagnostics(mutated(fn))).toBeNull();
  });

  it('rejects oversized arrays and strings', () => {
    const big: Mutator[] = [
      (d) => (d.coordinates.displays = Array.from({ length: MAX_DIAGNOSTIC_DISPLAYS + 1 }, () => fullDiagnostics().coordinates.displays[0]!)),
      (d) => (d.provider.recentErrors = Array.from({ length: MAX_RECENT_ERRORS + 1 }, (_, i) => ({ at: i, source: 'uia', kind: 'timeout' }))),
      (d) => (d.verdict = 'x'.repeat(MAX_VERDICT_LENGTH + 1)),
      (d) => (d.provider.recentErrors[0]!.kind = 'k'.repeat(65)),
      (d) => (d.decision.state = 's'.repeat(65)),
    ];
    for (const fn of big) expect(parseSurfaceDiagnostics(mutated(fn))).toBeNull();
    // At the caps: accepted.
    expect(parseSurfaceDiagnostics(mutated((d) => (d.provider.recentErrors = Array.from({ length: MAX_RECENT_ERRORS }, (_, i) => ({ at: i, source: 'uia', kind: 'timeout' })))))).not.toBeNull();
  });
});

describe('SurfaceLinesPayloadSchema (overlay preload)', () => {
  const line = (over: Partial<SurfaceDebugLine> = {}): SurfaceDebugLine => ({ kind: 'windowTop', role: 'reachable', x0: 10, y0: 20, x1: 300, y1: 20, ...over });

  it('accepts up to MAX_DEBUG_LINES segments and the empty clearing frame', () => {
    expect(parseSurfaceLinesPayload({ lines: [] })).toEqual({ lines: [] });
    const full = { lines: Array.from({ length: MAX_DEBUG_LINES }, (_, i) => line({ x0: i, role: i % 2 ? 'rejected' : 'target', kind: i % 3 ? 'floor' : 'tabStrip' })) };
    expect(parseSurfaceLinesPayload(full)).toEqual(full);
  });

  it('rejects oversized, malformed and extra-field frames', () => {
    expect(parseSurfaceLinesPayload({ lines: Array.from({ length: MAX_DEBUG_LINES + 1 }, () => line()) })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [line({ role: 'secret' as never })] })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [line({ kind: 'desk' as never })] })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [line({ x1: Number.NaN })] })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [line({ y0: 1e9 })] })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [{ ...line(), id: 'windowTop:197482' }] })).toBeNull();
    expect(parseSurfaceLinesPayload({ lines: [], title: 'x' })).toBeNull();
    expect(parseSurfaceLinesPayload([line()])).toBeNull();
    expect(parseSurfaceLinesPayload(undefined)).toBeNull();
  });
});

const SETTINGS_URL = 'desktop-cat://app/renderer/settings/index.html#diagnostics';

function rig(get: (() => SurfaceDiagnostics) | undefined, kind: 'settings' | 'overlay' = 'settings') {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload?: unknown) => unknown>();
  const log = memoryLogger();
  const deps = {
    ipcMain: {
      on: () => undefined,
      removeAllListeners: () => undefined,
      handle: (channel: string, fn: (event: IpcMainInvokeEvent, payload?: unknown) => unknown) => handlers.set(channel, fn),
      removeHandler: () => undefined,
    },
    registry: { register: () => undefined, unregister: () => undefined, kindOf: (id: number) => (id === 3 ? kind : null), ids: () => [3] },
    logger: log,
    overlays: { handleReady: () => undefined, handlePointer: () => undefined, handleHitRegion: () => undefined, handleRendererError: () => undefined },
    getSurfaceDiagnostics: get,
    clock: () => 0,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const call = (event: { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null }) =>
    Promise.resolve().then(() => handlers.get(IPC.settingsGetSurfaceDiagnostics)!(event as unknown as IpcMainInvokeEvent));
  const trusted = { sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: null } };
  return { call, trusted, log, handlers };
}

describe('settings:get-surface-diagnostics', () => {
  it('serves the validated object to the settings window', async () => {
    const r = rig(() => fullDiagnostics());
    expect(r.handlers.has(IPC.settingsGetSurfaceDiagnostics)).toBe(true);
    expect(IPC.settingsGetSurfaceDiagnostics).toBe('settings:get-surface-diagnostics');
    await expect(r.call(r.trusted)).resolves.toEqual(fullDiagnostics());
  });

  it('rejects untrusted senders: another window kind, an unknown window, a subframe, a foreign page', async () => {
    let builds = 0;
    const get = (): SurfaceDiagnostics => {
      builds++;
      return fullDiagnostics();
    };
    const overlay = rig(get, 'overlay');
    await expect(overlay.call({ sender: { id: 3 }, senderFrame: { url: 'desktop-cat://app/renderer/overlay/index.html?display=1', parent: null } })).rejects.toThrow('Forbidden');
    const r = rig(get);
    await expect(r.call({ sender: { id: 9 }, senderFrame: { url: SETTINGS_URL, parent: null } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: {} } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: 'https://evil.example/renderer/settings/index.html', parent: null } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: null })).rejects.toThrow('Forbidden');
    expect(builds).toBe(0);
    expect(r.log.entries.some((e) => e.msg === 'rejected settings call from an untrusted sender')).toBe(true);
  });

  it('never sends an object that fails the contract schema (e.g. one carrying a title)', async () => {
    const r = rig(() => ({ ...fullDiagnostics(), title: 'Inbox - Mail' }) as SurfaceDiagnostics);
    await expect(r.call(r.trusted)).rejects.toThrow('Surface details are not available right now.');
    expect(r.log.entries.some((e) => e.msg === 'surface diagnostics failed validation; not sent')).toBe(true);
    const failing = rig(() => {
      throw new Error('boom');
    });
    await expect(failing.call(failing.trusted)).rejects.toThrow('Surface details are not available right now.');
    const missing = rig(undefined);
    await expect(missing.call(missing.trusted)).rejects.toThrow('Surface details are not available right now.');
  });
});

function memoryJsonStore(): JsonStore & { writes: number } {
  let value: unknown = null;
  const store = {
    writes: 0,
    filePath: 'mem://settings.json',
    backupPath: 'mem://settings.json.bak',
    read: () => ({ status: value === null ? 'missing' : 'ok', value, quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (v: unknown) => {
      store.writes++;
      value = v;
      return true;
    },
    write: (v: unknown) => {
      store.writes++;
      value = v;
      return Promise.resolve(true);
    },
  };
  return store as unknown as JsonStore & { writes: number };
}

describe('surface outline toggle is session-only', () => {
  it('is an action that reaches main’s session state and never touches the settings', async () => {
    const json = memoryJsonStore();
    const settings = createSettingsStore({ store: json, logger: memoryLogger() });
    settings.load();
    await settings.flush();
    const before = JSON.stringify(settings.get());
    const writesBefore = json.writes;
    const calls: boolean[] = [];
    const runner = createActionRunner({ targets: { setSurfaceOutlines: (on: boolean) => calls.push(on) } as unknown as ActionTargets, settings, logger: memoryLogger() });
    expect(SETTINGS_ACTIONS).toContain('showSurfaceOutlines');
    expect(SETTINGS_ACTIONS).toContain('hideSurfaceOutlines');
    expect(await runner.run('showSurfaceOutlines')).toEqual({ ok: true });
    expect(await runner.run('hideSurfaceOutlines')).toEqual({ ok: true });
    expect(calls).toEqual([true, false]);
    expect(JSON.stringify(settings.get())).toBe(before);
    await settings.flush();
    expect(settings.dirty).toBe(false);
    expect(json.writes).toBe(writesBefore);
    const without = createActionRunner({ targets: {} as ActionTargets, settings, logger: memoryLogger() });
    expect((await without.run('showSurfaceOutlines')).ok).toBe(false);
  });

  it('has no settings field to persist it, and a new session starts with the outlines off', () => {
    expect(JSON.stringify(defaultSettings())).not.toMatch(/outline/i);
    expect(applySettingsPatch(defaultSettings(), { diagnostics: { surfaceOutlines: true } }).ok).toBe(false);
    const sink = { renderSurfaceLines: () => undefined, clearSurfaceLines: () => undefined };
    const timers = { setInterval: () => 1, clearInterval: () => undefined };
    const first = createSurfaceOutlines({ getLines: () => [], sink, logger: memoryLogger(), timers });
    first.setEnabled(true);
    expect(first.enabled).toBe(true);
    // "Restart": a fresh instance, as app.ts creates at every start.
    const next = createSurfaceOutlines({ getLines: () => [], sink, logger: memoryLogger(), timers });
    expect(next.enabled).toBe(false);
  });
});
