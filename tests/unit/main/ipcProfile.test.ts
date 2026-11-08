// 1.4.0 profile transfer over IPC (src/main/ipc/handlers.ts): settings:export-profile,
// settings:open-profile and settings:apply-profile sit behind the settings sender check and rate
// limit, take strict payloads (extra keys refused, the token's shape checked), pass the verified
// sender id to the service, and answer 'unavailable' without one. MOCKED: Electron's ipcMain, the
// window registry and the profile service. Written in the 1.4.0 mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import type { ProfileTransferService } from '../../../src/main/profile/profileService';
import { ApplyProfileRequestSchema, ExportProfileRequestSchema, IPC, PROFILE_TOKEN_PATTERN } from '../../../src/shared/ipc';
import { memoryLogger } from './helpers';

const SETTINGS_URL = 'desktop-cat://app/renderer/settings/index.html#personality';
const TOKEN = '0123456789abcdef0123456789abcdef';
const PARTS = { cat: true, appearance: true, preferences: false, memory: false };

function fakeService() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const service: ProfileTransferService = {
    exportToFile: (req) => {
      calls.push({ fn: 'export', args: [req] });
      return Promise.resolve({ status: 'saved', fileName: 'gizecat-miso-2026-11-08.json' });
    },
    openForImport: (senderId) => {
      calls.push({ fn: 'open', args: [senderId] });
      return Promise.resolve({ status: 'cancelled' });
    },
    applyImport: (senderId, req) => {
      calls.push({ fn: 'apply', args: [senderId, req] });
      return { ok: true, name: 'Miso', catReplaced: false, keptOff: [] };
    },
    clearPending: () => undefined,
    hasPending: false,
  };
  return { service, calls };
}

function rig(profiles: ProfileTransferService | undefined, kind: 'settings' | 'overlay' = 'settings') {
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
    profiles,
    clock: () => 0,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const trusted = { sender: { id: 3 }, senderFrame: { url: SETTINGS_URL, parent: null } };
  const call = (channel: string, payload?: unknown, event: unknown = trusted) => Promise.resolve().then(() => handlers.get(channel)!(event as IpcMainInvokeEvent, payload));
  return { call, handlers, log };
}

describe('profile channels', () => {
  it('are registered under their frozen names', () => {
    const r = rig(fakeService().service);
    expect(IPC.settingsExportProfile).toBe('settings:export-profile');
    expect(IPC.settingsOpenProfile).toBe('settings:open-profile');
    expect(IPC.settingsApplyProfile).toBe('settings:apply-profile');
    for (const ch of [IPC.settingsExportProfile, IPC.settingsOpenProfile, IPC.settingsApplyProfile]) expect(r.handlers.has(ch)).toBe(true);
  });

  it('refuse an untrusted sender (an overlay, or another page) with Forbidden and never reach the service', async () => {
    const f = fakeService();
    const overlay = rig(f.service, 'overlay');
    await expect(overlay.call(IPC.settingsOpenProfile)).rejects.toThrow('Forbidden');
    const r = rig(f.service);
    const foreign = { sender: { id: 3 }, senderFrame: { url: 'https://example.invalid/', parent: null } };
    await expect(r.call(IPC.settingsExportProfile, { includeMemory: false }, foreign)).rejects.toThrow('Forbidden');
    await expect(r.call(IPC.settingsApplyProfile, { token: TOKEN, parts: PARTS }, foreign)).rejects.toThrow('Forbidden');
    expect(f.calls).toHaveLength(0);
  });

  it('export: strict payload; the option is passed through', async () => {
    const f = fakeService();
    const r = rig(f.service);
    await expect(r.call(IPC.settingsExportProfile, { includeMemory: true })).resolves.toEqual({ status: 'saved', fileName: 'gizecat-miso-2026-11-08.json' });
    expect(f.calls).toEqual([{ fn: 'export', args: [{ includeMemory: true }] }]);
    for (const bad of [undefined, null, {}, { includeMemory: 'yes' }, { includeMemory: false, path: 'C:\\x.json' }]) {
      await expect(r.call(IPC.settingsExportProfile, bad)).resolves.toEqual({ status: 'failed' });
    }
    expect(f.calls).toHaveLength(1);
  });

  it('open: takes no content from the renderer and passes the verified sender id', async () => {
    const f = fakeService();
    const r = rig(f.service);
    await expect(r.call(IPC.settingsOpenProfile, { text: '{"kind":"gizeverse-character-profile"}' })).resolves.toEqual({ status: 'cancelled' });
    expect(f.calls).toEqual([{ fn: 'open', args: [3] }]);
  });

  it('apply: a well-formed token and exactly the four parts; anything else is invalid-request', async () => {
    const f = fakeService();
    const r = rig(f.service);
    await expect(r.call(IPC.settingsApplyProfile, { token: TOKEN, parts: PARTS })).resolves.toEqual({ ok: true, name: 'Miso', catReplaced: false, keptOff: [] });
    expect(f.calls).toEqual([{ fn: 'apply', args: [3, { token: TOKEN, parts: PARTS }] }]);
    const bad: unknown[] = [
      undefined,
      { token: TOKEN },
      { token: 'short', parts: PARTS },
      { token: TOKEN.toUpperCase(), parts: PARTS },
      { token: TOKEN, parts: { ...PARTS, perception: true } },
      { token: TOKEN, parts: { cat: true } },
      { token: TOKEN, parts: PARTS, profile: { cat: {} } },
      { token: TOKEN, parts: { ...PARTS, cat: 'yes' } },
    ];
    for (const b of bad) await expect(r.call(IPC.settingsApplyProfile, b)).resolves.toEqual({ ok: false, reason: 'invalid-request' });
    expect(f.calls).toHaveLength(1);
  });

  it('answer unavailable without a service', async () => {
    const r = rig(undefined);
    await expect(r.call(IPC.settingsExportProfile, { includeMemory: false })).resolves.toEqual({ status: 'unavailable' });
    await expect(r.call(IPC.settingsOpenProfile)).resolves.toEqual({ status: 'unavailable' });
    await expect(r.call(IPC.settingsApplyProfile, { token: TOKEN, parts: PARTS })).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('a throwing service becomes a reason code, never an error text for the renderer', async () => {
    const f = fakeService();
    f.service.exportToFile = () => Promise.reject(new Error('EACCES C:\\Users\\someone\\x.json'));
    f.service.openForImport = () => Promise.reject(new Error('boom'));
    f.service.applyImport = () => {
      throw new Error('boom');
    };
    const r = rig(f.service);
    await expect(r.call(IPC.settingsExportProfile, { includeMemory: false })).resolves.toEqual({ status: 'failed' });
    await expect(r.call(IPC.settingsOpenProfile)).resolves.toEqual({ status: 'rejected', reason: 'unreadable' });
    await expect(r.call(IPC.settingsApplyProfile, { token: TOKEN, parts: PARTS })).resolves.toEqual({ ok: false, reason: 'failed' });
    expect(JSON.stringify(r.log.entries)).not.toContain('someone');
  });
});

describe('profile request schemas', () => {
  it('are strict', () => {
    expect(ExportProfileRequestSchema.safeParse({ includeMemory: false }).success).toBe(true);
    expect(ExportProfileRequestSchema.safeParse({ includeMemory: false, x: 1 }).success).toBe(false);
    expect(ApplyProfileRequestSchema.safeParse({ token: TOKEN, parts: PARTS }).success).toBe(true);
    expect(ApplyProfileRequestSchema.safeParse({ token: TOKEN, parts: PARTS, extra: true }).success).toBe(false);
    expect(PROFILE_TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(PROFILE_TOKEN_PATTERN.test(`${TOKEN}0`)).toBe(false);
  });
});
