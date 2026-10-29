import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCrashGuard, readRelaunchHistory } from '../../../src/main/lifecycle/crashGuard';
import { hasFlag, parseTimeScale, parseUserDataOverride } from '../../../src/main/lifecycle/launchArgs';
import { LOGIN_ITEM_NAME, UNINSTALL_MARKER_FILE, UNINSTALLER_FILE, uninstallerFileFor } from '../../../src/main/lifecycle/loginItem';
import { createQuitSequence } from '../../../src/main/lifecycle/quitSequence';
import { createSessionEndSaver, type SessionEndKind } from '../../../src/main/lifecycle/sessionEnd';
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

  function setup(t0: number, historyFile = path.join(dir, 'relaunch-history.json'), started = true) {
    let t = t0;
    const actions: string[] = [];
    const guard = createCrashGuard({
      historyFile,
      now: () => t,
      relaunch: () => actions.push('relaunch'),
      exit: (code) => actions.push(`exit:${code}`),
    });
    guard.setLogger(memoryLogger());
    guard.setSaver(() => actions.push('save'));
    if (started) guard.setStarted();
    return { guard, actions, advance: (ms: number) => (t += ms) };
  }

  it('an error before startup finished exits at once instead of leaving a windowless process', () => {
    const { guard, actions } = setup(0, undefined, false);
    guard.handle('uncaughtException', new Error('EPERM: stale temp'));
    expect(actions).toEqual(['exit:1']);
    expect(guard.escalated).toBe(true);
    guard.handle('uncaughtException', new Error('again'));
    expect(actions).toEqual(['exit:1']);
  });

  it('never relaunches when the relaunch history cannot be saved (no endless restart loop)', () => {
    // The history file's parent is a regular file, so it can never be written.
    fs.writeFileSync(path.join(dir, 'not-a-folder'), 'x');
    const historyFile = path.join(dir, 'not-a-folder', 'relaunch-history.json');
    const all: string[] = [];
    for (let generation = 0; generation < 5; generation++) {
      const { guard, actions } = setup(1_000_000 + generation * 60_000, historyFile);
      for (let i = 0; i < 4; i++) guard.handle('uncaughtException', new Error('recurring'));
      all.push(...actions.filter((a) => a !== 'save'));
    }
    expect(all).not.toContain('relaunch');
    expect(all).toEqual(Array.from({ length: 5 }, () => 'exit:1'));
  });

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
    const attempts: string[] = [];
    return {
      registered,
      attempts,
      register: (acc: string, cb: () => void) => {
        attempts.push(acc);
        if (acc === 'Control+Alt+F24') throw new Error('invalid accelerator');
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
    expect(m.apply(true, 'Control+Alt+F24')).toBe(false);
    expect(m.lastError).toContain('Invalid');
    expect(m.apply(true, 'Control+Alt+Shift+C')).toBe(true);
    expect(m.apply(false, 'Control+Alt+Shift+C')).toBe(false);
    expect(api.registered.size).toBe(0);
    m.dispose();
  });

  it.each(['A', 'Space', 'Shift+A', 'Enter', 'Alt+F4', 'Control+Alt+Delete', 'Bogus+', 'control+alt+k'])(
    'never hands "%s" to globalShortcut (bare, reserved, invalid or not canonical)',
    (accelerator) => {
      const api = fakeApi();
      const m = createShortcutManager(api, memoryLogger(), () => undefined);
      expect(m.apply(true, accelerator)).toBe(false);
      expect(api.attempts).toEqual([]);
      expect(m.registered).toBe(false);
      expect(m.lastError).toContain('not a safe global shortcut');
    },
  );
});

describe('session-end saver', () => {
  function fakeWindow() {
    let listener: ((kind: SessionEndKind) => void) | null = null;
    const w = {
      destroyed: false,
      onSessionEnd: (l: (kind: SessionEndKind) => void) => {
        listener = l;
      },
      destroy: () => {
        w.destroyed = true;
      },
      fire: (kind: SessionEndKind) => listener?.(kind),
    };
    return w;
  }

  it('saves at logoff through its own hidden window, even when no overlay exists', () => {
    const win = fakeWindow();
    let saves = 0;
    const s = createSessionEndSaver({ save: () => saves++, logger: memoryLogger(), createWindow: () => win, clock: () => 0 });
    expect(s.watching).toBe(true);
    win.fire('query-session-end');
    expect(saves).toBe(1);
    s.dispose();
    expect(win.destroyed).toBe(true);
    expect(s.watching).toBe(false);
  });

  it('saves once per burst although every window reports each message', () => {
    let t = 0;
    let saves = 0;
    const win = fakeWindow();
    const s = createSessionEndSaver({ save: () => saves++, logger: memoryLogger(), createWindow: () => win, clock: () => t, coalesceMs: 1000 });
    win.fire('query-session-end');
    s.notify('overlay');
    s.notify('overlay');
    t += 300;
    win.fire('session-end');
    s.notify('overlay');
    expect(saves).toBe(1);
    t += 5000;
    win.fire('session-end');
    expect(saves).toBe(2);
  });

  it('a receiver window that cannot be created, or a failing save, is contained', () => {
    const log = memoryLogger();
    const s = createSessionEndSaver({
      save: () => {
        throw new Error('disk gone');
      },
      logger: log,
      createWindow: () => {
        throw new Error('no window');
      },
    });
    expect(s.watching).toBe(false);
    expect(() => s.notify('overlay')).not.toThrow();
    expect(log.entries.filter((e) => e.level === 'error').map((e) => e.msg)).toEqual([
      'session-end window unavailable; only overlay windows will report logoff and shutdown',
      'session-end save failed',
    ]);
    s.dispose();
  });
});

describe('login item names shared with the installer', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');

  it('the uninstaller removes the Run and StartupApproved values under the fixed value name, only on a real uninstall', () => {
    expect(nsh).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(nsh).toContain(`DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${LOGIN_ITEM_NAME}"`);
    expect(nsh).toMatch(/\$\{ifNot\} \$\{isUpdated\}/);
  });

  it('the uninstall marker the app looks for is the one the uninstaller writes, in the userData folder', () => {
    expect(nsh).toContain(`$APPDATA\\Desktop Cat\\${UNINSTALL_MARKER_FILE}`);
    // Electron's userData folder is %APPDATA%\<productName>.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { productName: string };
    expect(pkg.productName).toBe('Desktop Cat');
  });

  it('the write gate looks for the uninstaller electron-builder really writes (Uninstall <productFilename>.exe)', () => {
    // app-builder-lib appInfo: productFilename = win.executableName when set, else the product name;
    // the exe is <productFilename>.exe and the uninstaller "Uninstall <productFilename>.exe" (common.nsh).
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    const executableName = /^\s+executableName:\s*(\S+)\s*$/m.exec(yml)?.[1];
    expect(executableName).toBe('DesktopCat');
    expect(UNINSTALLER_FILE).toBe(`Uninstall ${executableName}.exe`);
    expect(uninstallerFileFor(`C:\\Users\\Ada\\AppData\\Local\\Programs\\DesktopCat\\${executableName}.exe`)).toBe(UNINSTALLER_FILE);
    expect(uninstallerFileFor('C:\\Users\\Ada Lovelace\\dcat install 1\\DesktopCat.exe')).toBe('Uninstall DesktopCat.exe');
    // A dev run (electron.exe) can never find one.
    expect(uninstallerFileFor('C:\\src\\cat\\node_modules\\electron\\dist\\electron.exe')).toBe('Uninstall electron.exe');
  });

  it('the value name equals the AppUserModelID (Electron defaults the name to it)', () => {
    const index = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
    expect(index).toContain(`APP_USER_MODEL_ID = '${LOGIN_ITEM_NAME}'`);
  });
});
