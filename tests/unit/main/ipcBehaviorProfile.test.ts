// v1.2 behaviour profile over IPC (ADR 0003 §11): the strict, bounded BehaviorProfileSchema
// (accepts the contract and the real recorder's output, rejects extra fields at any level,
// unknown kinds, out-of-range numbers and oversized lists) and settings:get-behavior-profile
// (sender check, output validation). MOCKED: Electron's ipcMain and the window registry.
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import { BehaviorProfileRecorder } from '../../../src/core/behavior/profile';
import { emptyBehaviorProfile, MAX_RECENT_STAYS, type BehaviorProfileSnapshot } from '../../../src/shared/behaviorProfile';
import { BEHAVIOR_PROFILE_SCHEMA_MATCHES_CONTRACT, parseBehaviorProfile } from '../../../src/shared/behaviorProfileSchema';
import { IPC } from '../../../src/shared/ipc';
import { fullProfile, profileStay as stay } from './diagnosticsBehaviorFixture';
import { memoryLogger } from './helpers';

type Mutator = (p: BehaviorProfileSnapshot & Record<string, unknown>) => void;
const mutated = (fn: Mutator): unknown => {
  const p = JSON.parse(JSON.stringify(fullProfile())) as BehaviorProfileSnapshot & Record<string, unknown>;
  fn(p);
  return p;
};

describe('BehaviorProfileSchema', () => {
  it('matches the contract type (compile-time check) and accepts a full profile as an equal copy', () => {
    expect(BEHAVIOR_PROFILE_SCHEMA_MATCHES_CONTRACT).toBe(true);
    const p = JSON.parse(JSON.stringify(fullProfile())) as unknown;
    expect(parseBehaviorProfile(p)).toEqual(p);
    expect(parseBehaviorProfile(emptyBehaviorProfile(0))).toEqual(emptyBehaviorProfile(0));
    // The optional record fields (bailOut, resumed) may be absent.
    const bare = mutated((q) => {
      delete (q.recentStays[1] as Partial<(typeof q.recentStays)[number]>).bailOut;
      delete (q.recentStays[1] as Partial<(typeof q.recentStays)[number]>).resumed;
    });
    expect(parseBehaviorProfile(bare)).toEqual(bare);
  });

  it('accepts what the real recorder produces', () => {
    const r = new BehaviorProfileRecorder(1000);
    r.addTime('idle', 60_000);
    r.addTime('walking', 30_000);
    r.addTime('sleeping', 10_000);
    r.addContext('typing', 5000);
    r.excursion({ ...stay(2000), phase: 'arrive', dwellMs: 0, endReason: null, leaveKind: null, bailOut: null });
    for (let i = 0; i < MAX_RECENT_STAYS + 3; i++) r.excursion(stay(3000 + i, { endReason: 'leave', leaveKind: 'climbDown', bailOut: null }));
    r.fall({ at: 5, cause: 'thrown', heightDip: 300, impact: 'hard', jumpKind: null });
    r.slip({ at: 6, kind: 'scramble', risk: 0.4 });
    r.reaction({ at: 7, kind: 'grumpy', speedDip: 2400, impact: 'hard', trigger: 'throw', capped: false, onLedge: false });
    r.hunt({ at: 8, startedAt: 1, durationMs: 7000, pounces: 1, pounceTimes: [4], minClearanceDip: 12, outcome: 'missed', gate: null });
    r.edgeVisit({ at: 9, side: 'right', covered: true, topReached: false, holdMs: 0, leave: 'climbDown' });
    const snap = r.snapshot(200_000);
    expect(parseBehaviorProfile(JSON.parse(JSON.stringify(snap)))).toEqual(JSON.parse(JSON.stringify(snap)));
  });

  it('rejects extra fields at any level, so an id, a title or a position can never ride along', () => {
    expect(parseBehaviorProfile(fullProfile())).not.toBeNull();
    const cases: Mutator[] = [
      (p) => (p.windowTitle = 'Inbox - Mail'),
      (p) => ((p.timeMs as Record<string, unknown>).typingWindow = 1),
      (p) => ((p.excursions as unknown as Record<string, unknown>).surfaceIds = ['windowTop:197482']),
      (p) => ((p.excursions.byKind as Record<string, unknown>)['windowTop:197482'] = 1),
      (p) => ((p.recentStays[0] as unknown as Record<string, unknown>).surfaceId = 'windowTop:197482'),
      (p) => ((p.recentStays[0] as unknown as Record<string, unknown>).title = 'x'),
      (p) => ((p.recentStays[0] as unknown as Record<string, unknown>).x = 812),
      (p) => ((p.hunts as unknown as Record<string, unknown>).cursor = { x: 1, y: 2 }),
      (p) => ((p.reactions as Record<string, unknown>).hissAt = 1),
      (p) => ((p.context as Record<string, unknown>).app = 'outlook.exe'),
      (p) => ((p.moodMs as Record<string, unknown>).bored = 1),
      (p) => ((p.excursions.dwellS as unknown as Record<string, unknown>).samples = [1, 2]),
    ];
    for (const [i, c] of cases.entries()) expect(parseBehaviorProfile(mutated(c)), `case ${i}`).toBeNull();
  });

  it('rejects unknown kinds, out-of-range and non-finite numbers, missing fields and oversized lists', () => {
    const cases: Mutator[] = [
      (p) => (p.recentStays[0]!.surfaceKind = 'taskbar' as never),
      (p) => (p.recentStays[0]!.endReason = 'closedByUser' as never),
      (p) => (p.recentStays[0]!.bailOut = 'teleport' as never),
      (p) => ((p.falls.byCause as Record<string, unknown>).gravity = 1),
      (p) => (p.activeShare = 1.5),
      (p) => (p.activeShare = -0.1),
      (p) => (p.decisions = -1),
      (p) => (p.decisions = Number.NaN),
      (p) => (p.timeMs.calm = Number.POSITIVE_INFINITY),
      (p) => (p.timeMs.calm = 1e14),
      (p) => (p.hunts.count = 'nine' as never),
      (p) => delete (p as Record<string, unknown>).moodMs,
      (p) => delete (p.timeMs as Partial<Record<string, number>>).away,
      (p) => (p.recentStays = Array.from({ length: MAX_RECENT_STAYS + 1 }, (_, i) => stay(i))),
      (p) => (p.recentStays = 'none' as never),
    ];
    for (const [i, c] of cases.entries()) expect(parseBehaviorProfile(mutated(c)), `case ${i}`).toBeNull();
    for (const v of [null, undefined, 42, 'profile', [fullProfile()]]) expect(parseBehaviorProfile(v)).toBeNull();
  });
});

const SETTINGS_URL = 'desktop-cat://app/renderer/settings/index.html#diagnostics';

function rig(get: (() => BehaviorProfileSnapshot) | undefined, kind: 'settings' | 'overlay' = 'settings') {
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
    getBehaviorProfile: get,
    clock: () => 0,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const call = (event: { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null }) =>
    Promise.resolve().then(() => handlers.get(IPC.settingsGetBehaviorProfile)!(event as unknown as IpcMainInvokeEvent));
  const trusted = { sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: null } };
  return { call, trusted, log, handlers };
}

describe('settings:get-behavior-profile', () => {
  it('serves the validated profile to the settings window', async () => {
    const r = rig(() => fullProfile());
    expect(IPC.settingsGetBehaviorProfile).toBe('settings:get-behavior-profile');
    expect(r.handlers.has(IPC.settingsGetBehaviorProfile)).toBe(true);
    await expect(r.call(r.trusted)).resolves.toEqual(fullProfile());
  });

  it('rejects untrusted senders without building the profile', async () => {
    let builds = 0;
    const get = (): BehaviorProfileSnapshot => {
      builds++;
      return fullProfile();
    };
    const overlay = rig(get, 'overlay');
    await expect(overlay.call({ sender: { id: 3 }, senderFrame: { url: 'desktop-cat://app/renderer/overlay/index.html?display=1', parent: null } })).rejects.toThrow('Forbidden');
    const r = rig(get);
    await expect(r.call({ sender: { id: 9 }, senderFrame: { url: SETTINGS_URL, parent: null } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: {} } })).rejects.toThrow('Forbidden');
    await expect(r.call({ sender: { id: 3 }, senderFrame: { url: 'https://evil.example/renderer/settings/index.html', parent: null } })).rejects.toThrow('Forbidden');
    expect(builds).toBe(0);
  });

  it('never sends a profile that fails the schema; a failing or missing source is reported as unavailable', async () => {
    const leaky = rig(() => ({ ...fullProfile(), windowTitle: 'Inbox - Mail' }) as BehaviorProfileSnapshot);
    await expect(leaky.call(leaky.trusted)).rejects.toThrow('Behaviour details are not available right now.');
    expect(leaky.log.entries.some((e) => e.msg === 'behaviour profile failed validation; not sent')).toBe(true);
    expect(JSON.stringify(leaky.log.entries)).not.toMatch(/Inbox/);
    const failing = rig(() => {
      throw new Error('boom');
    });
    await expect(failing.call(failing.trusted)).rejects.toThrow('Behaviour details are not available right now.');
    const missing = rig(undefined);
    await expect(missing.call(missing.trusted)).rejects.toThrow('Behaviour details are not available right now.');
  });
});
