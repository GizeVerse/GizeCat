import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCrashGuard, readRelaunchHistory } from '../../../src/main/lifecycle/crashGuard';
import { hasFlag, parseTimeScale, parseUserDataOverride } from '../../../src/main/lifecycle/launchArgs';
import { createLoginItemController } from '../../../src/main/lifecycle/loginItem';
import { createQuitSequence } from '../../../src/main/lifecycle/quitSequence';
import { createShortcutManager } from '../../../src/main/lifecycle/shortcuts';
import { manualTimers, memoryLogger, removeDir, tempDir } from './helpers';

describe('quit sequence', () => {
  function setup(notify: () => Promise<void>) {
    const timers = manualTimers();
    const calls: string[] = [];
    const seq = createQuitSequence({
      notifySim: () => {
        calls.push('notify');
        return notify();
      },
      saveSync: () => calls.push('save'),
      dispose: () => {
        calls.push('dispose');
      },
      exit: (code) => calls.push(`exit:${code}`),
      logger: memoryLogger(),
      simTimeoutMs: 1500,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout,
    });
    return { seq, calls, timers };
  }

  it('prevents the first before-quit, waits for quitReady, saves, disposes, exits 0', async () => {
    let ready!: () => void;
    const { seq, calls } = setup(() => new Promise<void>((r) => (ready = r)));
    let prevented = 0;
    seq.onBeforeQuit({ preventDefault: () => prevented++ });
    seq.onBeforeQuit({ preventDefault: () => prevented++ });
    expect(prevented).toBe(2);
    expect(calls).toEqual(['notify']);
    ready();
    await seq.run();
    expect(calls).toEqual(['notify', 'save', 'dispose', 'exit:0']);
    expect(seq.phase).toBe('done');
    seq.onBeforeQuit({ preventDefault: () => prevented++ });
    expect(prevented).toBe(2);
  });

  it('gives up waiting for the sim after the timeout', async () => {
    const { seq, calls, timers } = setup(() => new Promise<void>(() => undefined));
    const done = seq.run();
    await Promise.resolve();
    expect(calls).toEqual(['notify']);
    timers.advance(1499);
    await Promise.resolve();
    expect(calls).toEqual(['notify']);
    timers.advance(1);
    await done;
    expect(calls).toEqual(['notify', 'save', 'dispose', 'exit:0']);
  });

  it('still saves and exits when the sim rejects or throws', async () => {
    const { seq, calls } = setup(() => Promise.reject(new Error('sim gone')));
    await seq.run();
    expect(calls).toEqual(['notify', 'save', 'dispose', 'exit:0']);
    const thrower = setup(() => {
      throw new Error('sync throw');
    });
    await thrower.seq.run();
    expect(thrower.calls).toEqual(['notify', 'save', 'dispose', 'exit:0']);
  });
});

describe('crash guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => removeDir(dir));

  function setup(t0: number) {
    let t = t0;
    const actions: string[] = [];
    const guard = createCrashGuard({
      historyFile: path.join(dir, 'relaunch-history.json'),
      now: () => t,
      relaunch: () => actions.push('relaunch'),
      exit: (code) => actions.push(`exit:${code}`),
    });
    guard.setLogger(memoryLogger());
    guard.setSaver(() => actions.push('save'));
    return { guard, actions, advance: (ms: number) => (t += ms) };
  }

  it('saves on every error and relaunches only after more than 3 errors within 60 s', () => {
    const { guard, actions, advance } = setup(1_000_000);
    for (let i = 0; i < 3; i++) {
      guard.handle('uncaughtException', new Error(`e${i}`));
      advance(10_000);
    }
    expect(actions).toEqual(['save', 'save', 'save']);
    guard.handle('unhandledRejection', 'boom');
    expect(actions).toEqual(['save', 'save', 'save', 'save', 'relaunch', 'exit:0']);
    expect(guard.escalated).toBe(true);
    expect(readRelaunchHistory(path.join(dir, 'relaunch-history.json'))).toEqual([1_030_000]);
  });

  it('errors spread out over more than 60 s never escalate', () => {
    const { guard, actions, advance } = setup(0);
    for (let i = 0; i < 10; i++) {
      guard.handle('uncaughtException', new Error('slow'));
      advance(25_000);
    }
    expect(actions.filter((a) => a !== 'save')).toEqual([]);
  });

  it('exits instead of relaunching after 3 relaunches within 10 minutes', () => {
    const file = path.join(dir, 'relaunch-history.json');
    fs.writeFileSync(file, JSON.stringify([100_000, 200_000, 300_000]));
    const { guard, actions } = setup(400_000);
    for (let i = 0; i < 4; i++) guard.handle('uncaughtException', new Error('x'));
    expect(actions.slice(-1)).toEqual(['exit:1']);
    expect(actions).not.toContain('relaunch');
  });

  it('old relaunches fall out of the 10 minute budget', () => {
    fs.writeFileSync(path.join(dir, 'relaunch-history.json'), JSON.stringify([0, 1, 2]));
    const { guard, actions } = setup(11 * 60_000);
    for (let i = 0; i < 4; i++) guard.handle('uncaughtException', new Error('x'));
    expect(actions.slice(-2)).toEqual(['relaunch', 'exit:0']);
  });
});

describe('launch arguments', () => {
  it('prefers the env override over --user-data-dir', () => {
    expect(parseUserDataOverride({ DESKTOP_CAT_USER_DATA: 'C:\\tmp\\a' }, ['--user-data-dir=C:\\tmp\\b'])).toBe(path.resolve('C:\\tmp\\a'));
    expect(parseUserDataOverride({}, ['x', '--user-data-dir="C:\\tmp\\b"'])).toBe(path.resolve('C:\\tmp\\b'));
    expect(parseUserDataOverride({ DESKTOP_CAT_USER_DATA: '  ' }, [])).toBeNull();
  });

  it('parses flags and a bounded time scale', () => {
    expect(hasFlag(['a', '--dev'], '--dev')).toBe(true);
    expect(parseTimeScale({})).toBe(1);
    expect(parseTimeScale({ DESKTOP_CAT_TIME_SCALE: '20' })).toBe(20);
    expect(parseTimeScale({ DESKTOP_CAT_TIME_SCALE: '1000' })).toBe(1);
    expect(parseTimeScale({ DESKTOP_CAT_TIME_SCALE: 'fast' })).toBe(1);
  });
});

describe('shortcut manager', () => {
  function fakeApi(taken: string[] = []) {
    const registered = new Map<string, () => void>();
    return {
      registered,
      register: (acc: string, cb: () => void) => {
        if (acc === 'Bogus+') throw new Error('invalid accelerator');
        if (taken.includes(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc: string) => registered.delete(acc),
      unregisterAll: () => registered.clear(),
    };
  }

  it('registers, re-registers on change, and reports conflicts', () => {
    const api = fakeApi(['Control+Alt+X']);
    let toggles = 0;
    const m = createShortcutManager(api, memoryLogger(), () => toggles++);
    expect(m.apply(true, 'Control+Alt+Shift+C')).toBe(true);
    api.registered.get('Control+Alt+Shift+C')!();
    expect(toggles).toBe(1);
    expect(m.apply(true, 'Control+Alt+X')).toBe(false);
    expect(m.registered).toBe(false);
    expect(m.lastError).toContain('already used');
    expect(api.registered.size).toBe(0);
    expect(m.apply(true, 'Bogus+')).toBe(false);
    expect(m.lastError).toContain('Invalid');
    expect(m.apply(true, 'Control+Alt+Shift+C')).toBe(true);
    expect(m.apply(false, 'Control+Alt+Shift+C')).toBe(false);
    expect(api.registered.size).toBe(0);
    m.dispose();
  });
});

describe('login item', () => {
  it('reads state but writes only on an explicit change, never in test mode', () => {
    const writes: unknown[] = [];
    const api = {
      getLoginItemSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: false }),
      setLoginItemSettings: (s: unknown) => writes.push(s),
    };
    const ctl = createLoginItemController({ api, logger: memoryLogger(), execPath: 'C:\\app\\DesktopCat.exe', appPathArg: null, writesEnabled: true });
    expect(ctl.isActive()).toBe(false);
    expect(writes).toEqual([]);
    ctl.onSettingChanged(true);
    expect(writes).toEqual([{ openAtLogin: true, path: 'C:\\app\\DesktopCat.exe', args: ['--launched-at-login'] }]);

    const dev = createLoginItemController({ api, logger: memoryLogger(), execPath: 'electron.exe', appPathArg: 'C:\\src\\cat', writesEnabled: false });
    dev.onSettingChanged(true);
    expect(writes).toHaveLength(1);
  });
});
