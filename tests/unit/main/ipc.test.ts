import { describe, expect, it } from 'vitest';
import { consentPatch, createActionRunner, type ActionTargets } from '../../../src/main/ipc/actions';
import { createRateLimiter, createThrottle } from '../../../src/main/ipc/rateLimit';
import { toPerceptionPreview } from '../../../src/main/ipc/viewState';
import { isTrustedSender, urlMatchesKind, type WindowKind } from '../../../src/main/security';
import { createSettingsStore } from '../../../src/main/store/settingsStore';
import type { JsonStore } from '../../../src/main/store/jsonStore';
import type { SimEvent } from '../../../src/shared/sim';
import { manualTimers, memoryLogger } from './helpers';

function memoryJsonStore(): JsonStore {
  let value: unknown = null;
  return {
    filePath: 'mem://settings.json',
    backupPath: 'mem://settings.json.bak',
    read: () => ({ status: value === null ? 'missing' : 'ok', value, quarantinedTo: null }),
    readBackup: () => ({ ok: false }),
    quarantine: () => null,
    writeSync: (v) => {
      value = v;
      return true;
    },
    write: (v) => {
      value = v;
      return Promise.resolve(true);
    },
  };
}

function setup() {
  const timers = manualTimers();
  const settings = createSettingsStore({ store: memoryJsonStore(), logger: memoryLogger(), setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
  settings.load();
  const calls: string[] = [];
  const events: SimEvent[] = [];
  const deferred: Array<() => void> = [];
  const targets: ActionTargets = {
    setPaused: (p) => calls.push(`paused:${p}`),
    setHidden: (h) => calls.push(`hidden:${h}`),
    callCat: () => calls.push('callCat'),
    enqueue: (ev) => events.push(ev),
    catAnchor: () => ({ x: 10, y: 20 }),
    resetPersonality: () => calls.push('resetPersonality'),
    clearHistory: () => calls.push('clearHistory'),
    exportDiagnostics: () => Promise.resolve({ ok: true, message: 'saved' }),
    openLogsFolder: () => Promise.resolve({ ok: true }),
    openSettings: () => calls.push('openSettings'),
    setLaunchAtLogin: (on) => (calls.push(`launch:${on}`), { ok: true }),
    dismissLaunchNotice: () => (calls.push('dismissNotice'), { ok: true }),
    quit: () => calls.push('quit'),
  };
  const runner = createActionRunner({
    targets,
    settings,
    logger: memoryLogger(),
    now: () => new Date('2026-10-28T10:00:00.000Z'),
    defer: (fn) => deferred.push(fn),
  });
  return { runner, settings, calls, events, deferred };
}

describe('actions', () => {
  it('records consent timestamps in main and revokes cleanly', async () => {
    const { runner, settings } = setup();
    expect(await runner.run('grantLocalStatsConsent')).toEqual({ ok: true });
    expect(settings.get().perception).toMatchObject({ visualMode: 'local-stats', consentAt: '2026-10-28T10:00:00.000Z' });
    await runner.run('grantAiConsent');
    expect(settings.get().perception.visualMode).toBe('ai');
    await runner.run('revokeConsent');
    expect(settings.get().perception).toMatchObject({ visualMode: 'off', consentAt: null });
    expect(consentPatch('revokeConsent', new Date(0))).toEqual({ perception: { visualMode: 'off', consentAt: null } });
  });

  it('routes pause/hide/privacy/first-run/interactions', async () => {
    const { runner, settings, calls } = setup();
    await runner.run('pause');
    await runner.run('resume');
    await runner.run('hide');
    await runner.run('show');
    await runner.run('privacyPause');
    expect(settings.get().perception.paused).toBe(true);
    await runner.run('privacyResume');
    expect(settings.get().perception.paused).toBe(false);
    await runner.run('completeFirstRun');
    expect(settings.get().general.firstRunCompleted).toBe(true);
    await runner.run('toggleInteractions');
    expect(settings.get().interaction.enabled).toBe(false);
    await runner.run('toggleInteractions');
    expect(settings.get().interaction.enabled).toBe(true);
    expect(calls).toEqual(['paused:true', 'paused:false', 'hidden:true', 'hidden:false']);
  });

  it('turns menu actions into sim events and defers quit until the reply is sent', async () => {
    const { runner, events, calls, deferred } = setup();
    await runner.run('pet');
    await runner.run('play');
    await runner.run('sleep');
    await runner.run('wake');
    expect(events).toEqual([{ type: 'pointer.pet', at: { x: 10, y: 20 }, strength: 1 }, { type: 'command.play' }, { type: 'command.sleep' }, { type: 'command.wake' }]);
    expect(await runner.run('quit')).toEqual({ ok: true });
    expect(calls).not.toContain('quit');
    deferred.forEach((fn) => fn());
    expect(calls).toContain('quit');
    expect(await runner.run('exportDiagnostics')).toEqual({ ok: true, message: 'saved' });
  });

  it('contains failures from targets', async () => {
    const { runner } = setup();
    const broken = createActionRunner({
      targets: { ...({} as ActionTargets), openLogsFolder: () => Promise.reject(new Error('nope')) },
      settings: createSettingsStore({ store: memoryJsonStore(), logger: memoryLogger() }),
      logger: memoryLogger(),
    });
    expect((await broken.run('openLogsFolder')).ok).toBe(false);
    expect((await runner.run('callCat')).ok).toBe(true);
  });
});

describe('rate limiter and throttle', () => {
  it('allows up to N per window per sender', () => {
    const rl = createRateLimiter(240, 1000);
    let allowed = 0;
    for (let i = 0; i < 300; i++) if (rl.allow(1, 500)) allowed++;
    expect(allowed).toBe(240);
    expect(rl.takeDropped(1)).toBe(60);
    expect(rl.allow(2, 500)).toBe(true);
    expect(rl.allow(1, 1500)).toBe(true);
  });

  it('throttles to one run per interval with a trailing call', () => {
    const timers = manualTimers();
    let runs = 0;
    const th = createThrottle(() => runs++, 250, () => timers.now, timers.setTimeout, timers.clearTimeout);
    th.trigger();
    th.trigger();
    th.trigger();
    expect(runs).toBe(1);
    timers.advance(249);
    expect(runs).toBe(1);
    timers.advance(1);
    expect(runs).toBe(2);
    timers.advance(1000);
    th.trigger();
    expect(runs).toBe(3);
  });
});

describe('sender verification', () => {
  const registry = (kind: WindowKind | null) => ({ kindOf: (id: number) => (id === 7 ? kind : null) });
  const ev = (url: string, id = 7, parent: unknown = null) => ({ sender: { id }, senderFrame: { url, parent } });

  it('accepts only main frames of known windows showing the matching page', () => {
    expect(isTrustedSender(ev('desktop-cat://app/renderer/overlay/index.html?display=1'), registry('overlay'), 'overlay')).toBe(true);
    expect(isTrustedSender(ev('desktop-cat://app/renderer/settings/index.html#welcome'), registry('settings'), 'settings')).toBe(true);
    expect(isTrustedSender(ev('desktop-cat://app/renderer/settings/index.html'), registry('settings'), 'overlay')).toBe(false);
    expect(isTrustedSender(ev('desktop-cat://app/renderer/overlay/index.html'), registry('settings'), 'overlay')).toBe(false);
    expect(isTrustedSender(ev('https://evil.example/renderer/overlay/'), registry('overlay'), 'overlay')).toBe(false);
    expect(isTrustedSender(ev('desktop-cat://app/renderer/overlay/index.html', 8), registry('overlay'), 'overlay')).toBe(false);
    expect(isTrustedSender(ev('desktop-cat://app/renderer/overlay/index.html', 7, {}), registry('overlay'), 'overlay')).toBe(false);
    expect(isTrustedSender({ sender: { id: 7 }, senderFrame: null }, registry('overlay'), 'overlay')).toBe(false);
    expect(urlMatchesKind('desktop-cat://app/renderer/overlayx/index.html', 'overlay')).toBe(false);
  });
});

describe('view state helpers', () => {
  it('only passes image previews that are data:image URLs', () => {
    expect(toPerceptionPreview({ ok: true, imageDataUrl: 'javascript:alert(1)' }).imageDataUrl).toBeUndefined();
    expect(toPerceptionPreview({ ok: true, imageDataUrl: 'data:image/png;base64,AAAA' }).imageDataUrl).toBe('data:image/png;base64,AAAA');
    expect(toPerceptionPreview({ ok: false, blockedReason: 'no consent' })).toEqual({ ok: false, blockedReason: 'no consent' });
  });
});
