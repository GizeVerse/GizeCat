// index.ts before 'ready': a startup failure must end the process, never leave a
// windowless one holding the single-instance lock (later launches would exit silently).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeDir, tempDir } from './helpers';

const h = vi.hoisted(() => {
  const state = {
    userData: '',
    /** app.getPath('appData'); '' makes getPath('appData') throw, so no test writes beside the repo. */
    appData: '',
    /** setPath calls, in order. getPath returns the last value set, else userData. */
    setPaths: [] as Array<[string, string]>,
    /** The data passed to requestSingleInstanceLock, per call. */
    lockData: [] as unknown[],
    /** Calls into the fake Electron app, in order. */
    order: [] as string[],
    failAt: null as string | null,
    resolveReady: (): void => undefined,
    ready: Promise.resolve(),
    processHandlers: new Map<string, (err: unknown) => void>(),
    /** Chromium switches the fake process was started with (GizeVerse boot decisions). */
    switches: new Map<string, string>(),
  };
  const step = (name: string) => () => {
    state.order.push(name);
    if (state.failAt === name) throw new Error(`${name} failed (simulated)`);
  };
  const setPathStep = step('setPath');
  const app = {
    setPath: (name: string, value: string) => {
      setPathStep();
      state.setPaths.push([name, value]);
    },
    getPath: (name: string) => {
      if (name === 'appData') {
        if (!state.appData) throw new Error('appData is not set up in this test');
        return state.appData;
      }
      return state.setPaths.filter(([n]) => n === name).at(-1)?.[1] ?? state.userData;
    },
    setAppUserModelId: step('setAppUserModelId'),
    requestSingleInstanceLock: (data?: unknown) => {
      state.order.push('lock');
      state.lockData.push(data);
      return true;
    },
    on: (event: string) => {
      state.order.push(`on:${event}`);
    },
    enableSandbox: step('enableSandbox'),
    disableHardwareAcceleration: step('disableHardwareAcceleration'),
    whenReady: () => {
      state.order.push('whenReady');
      return state.ready;
    },
    exit: (code: number) => {
      state.order.push(`exit:${code}`);
    },
    relaunch: step('relaunch'),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    commandLine: {
      hasSwitch: (name: string) => state.switches.has(name),
      getSwitchValue: (name: string) => state.switches.get(name) ?? '',
    },
  };
  return {
    state,
    app,
    dialog: { showErrorBox: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    startApp: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: h.app, dialog: h.dialog, protocol: h.protocol }));
vi.mock('../../../src/main/app', () => ({ startApp: h.startApp }));

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('startup (index.ts)', () => {
  beforeEach(() => {
    h.state.userData = tempDir();
    h.state.setPaths = [];
    h.state.lockData = [];
    h.state.order = [];
    h.state.failAt = null;
    h.state.processHandlers.clear();
    h.state.switches.clear();
    h.app.isPackaged = false;
    h.state.ready = new Promise<void>((r) => (h.state.resolveReady = r));
    h.dialog.showErrorBox.mockClear();
    h.startApp.mockReset();
    h.startApp.mockReturnValue({ onSecondInstance: () => undefined });
    // The logger's flush timer must not outlive the test's folder.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (err: unknown) => void) => {
      if (event === 'uncaughtException' || event === 'unhandledRejection') {
        h.state.processHandlers.set(event, listener);
        return process;
      }
      return realOn(event, listener);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    removeDir(h.state.userData);
  });

  async function boot(test: boolean): Promise<void> {
    vi.resetModules();
    vi.stubEnv('DESKTOP_CAT_USER_DATA', h.state.userData);
    vi.stubEnv('DESKTOP_CAT_TEST', test ? '1' : '0');
    await import('../../../src/main/index');
  }

  const exits = () => h.state.order.filter((s) => s.startsWith('exit:'));

  it('a stale settings temp that cannot be deleted does not stop startup', async () => {
    // A directory stands in for a temp another program holds open without delete sharing.
    const held = path.join(h.state.userData, 'settings.json.4242.1.tmp');
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, 'x'), 'x');
    await boot(false);
    expect(h.state.order).toContain('whenReady');
    expect(exits()).toEqual([]);
    h.state.resolveReady();
    await tick();
    expect(h.startApp).toHaveBeenCalledTimes(1);
    expect(exits()).toEqual([]);
  });

  it('a failure before ready exits with code 1 and tells the user; second-instance is registered first', async () => {
    h.state.failAt = 'enableSandbox';
    await boot(false);
    const order = h.state.order;
    expect(order.indexOf('on:second-instance')).toBeGreaterThan(order.indexOf('lock'));
    expect(order.indexOf('on:second-instance')).toBeLessThan(order.indexOf('enableSandbox'));
    expect(order).not.toContain('whenReady');
    expect(exits()).toEqual(['exit:1']);
    expect(h.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    // The product name (ADR 0004 §9).
    expect(h.dialog.showErrorBox.mock.calls[0]![0]).toBe('GizeCat could not start');
    expect(String(h.dialog.showErrorBox.mock.calls[0]![1])).toMatch(/^GizeCat ran into a problem while starting and has closed\./);
  });

  it('under test, the failure exits without a blocking dialog', async () => {
    // enableSandbox runs on every OS (setAppUserModelId is Windows-only since GizeVerse).
    h.state.failAt = 'enableSandbox';
    await boot(true);
    expect(exits()).toEqual(['exit:1']);
    expect(h.dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('startApp throwing after ready exits with code 1', async () => {
    h.startApp.mockImplementation(() => {
      throw new Error('tray exploded');
    });
    await boot(false);
    h.state.resolveReady();
    await tick();
    expect(exits()).toEqual(['exit:1']);
    expect(h.dialog.showErrorBox).toHaveBeenCalledTimes(1);
  });

  it('an uncaught error before startApp has run exits; once started, one error only logs', async () => {
    await boot(false);
    h.state.processHandlers.get('uncaughtException')!(new Error('before ready'));
    expect(exits()).toEqual(['exit:1']);

    h.state.order = [];
    h.state.ready = new Promise<void>((r) => (h.state.resolveReady = r));
    await boot(false);
    h.state.resolveReady();
    await tick();
    expect(h.startApp).toHaveBeenCalled();
    h.state.processHandlers.get('uncaughtException')!(new Error('after start'));
    expect(exits()).toEqual([]);
  });
});

describe('startup (index.ts): GizeVerse boot decisions (ADR 0004 §6)', () => {
  beforeEach(() => {
    h.state.userData = tempDir();
    h.state.setPaths = [];
    h.state.lockData = [];
    h.state.order = [];
    h.state.failAt = null;
    h.state.switches.clear();
    h.app.isPackaged = false;
    h.dialog.showErrorBox.mockClear();
    h.startApp.mockReset();
    h.startApp.mockReturnValue({ onSecondInstance: () => undefined });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // index.ts installs crash handlers: keep them off the test worker.
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
  });

  afterEach(() => {
    h.app.isPackaged = false;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    removeDir(h.state.userData);
  });

  async function bootPackaged(): Promise<void> {
    vi.resetModules();
    vi.stubEnv('DESKTOP_CAT_USER_DATA', h.state.userData);
    vi.stubEnv('DESKTOP_CAT_TEST', '0');
    await import('../../../src/main/index');
  }

  it('a packaged build started with --no-sandbox tells the user and exits before taking the lock', async () => {
    h.app.isPackaged = true;
    h.state.switches.set('no-sandbox', '');
    await bootPackaged();
    expect(h.state.order).toEqual(['exit:1']);
    expect(h.dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(String(h.dialog.showErrorBox.mock.calls[0]![1])).toMatch(/--no-sandbox/);
    expect(h.startApp).not.toHaveBeenCalled();
  });

  it('a packaged build with the sandbox starts normally', async () => {
    h.app.isPackaged = true;
    await bootPackaged();
    expect(h.state.order).toContain('lock');
    expect(h.state.order).toContain('whenReady');
    expect(h.state.order.filter((s) => s.startsWith('exit:'))).toEqual([]);
  });

  it('the AppUserModelID is set on Windows only', async () => {
    await bootPackaged();
    expect(h.state.order.includes('setAppUserModelId')).toBe(process.platform === 'win32');
  });
});

describe('startup (index.ts): the userData folder is pinned (ADR 0004 §9)', () => {
  const root = path.resolve(__dirname, '..', '..', '..');

  beforeEach(() => {
    h.state.appData = tempDir();
    h.state.userData = tempDir();
    h.state.setPaths = [];
    h.state.lockData = [];
    h.state.order = [];
    h.state.failAt = null;
    h.state.switches.clear();
    h.app.isPackaged = true;
    h.dialog.showErrorBox.mockClear();
    h.startApp.mockReset();
    h.startApp.mockReturnValue({ onSecondInstance: () => undefined });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(process, 'on').mockImplementation((() => process) as never);
  });

  afterEach(() => {
    h.app.isPackaged = false;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    removeDir(h.state.appData);
    removeDir(h.state.userData);
    h.state.appData = '';
  });

  /** Boots index.ts with DESKTOP_CAT_USER_DATA set to `override` ('' = no override) and extra argv. */
  async function bootWith(override: string, argv: readonly string[] = []): Promise<void> {
    vi.resetModules();
    vi.stubEnv('DESKTOP_CAT_USER_DATA', override);
    vi.stubEnv('DESKTOP_CAT_TEST', '0');
    const saved = process.argv;
    process.argv = [...saved, ...argv];
    try {
      await import('../../../src/main/index');
    } finally {
      process.argv = saved;
    }
  }

  const userDataSets = (): string[] => h.state.setPaths.filter(([name]) => name === 'userData').map(([, value]) => value);

  it('without an override, userData is <appData>\\Desktop Cat (today’s default), set and created before the lock', async () => {
    await bootWith('');
    const pinned = path.join(h.state.appData, 'Desktop Cat');
    expect(userDataSets()).toEqual([pinned]);
    // Electron's default is <appData>/<productName>: the pin moves nothing.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { productName: string };
    expect(pinned).toBe(path.join(h.state.appData, pkg.productName));
    expect(fs.statSync(pinned).isDirectory()).toBe(true);
    expect(h.state.order.indexOf('setPath')).toBeLessThan(h.state.order.indexOf('lock'));
    expect(h.state.lockData).toEqual([{ kind: 'desktop-cat:second-instance' }]);
    expect(h.state.order).toContain('whenReady');
    expect(h.state.order.filter((s) => s.startsWith('exit:'))).toEqual([]);
  });

  it('DESKTOP_CAT_USER_DATA still wins over the pin', async () => {
    await bootWith(h.state.userData);
    expect(userDataSets()).toEqual([path.resolve(h.state.userData)]);
    expect(fs.existsSync(path.join(h.state.appData, 'Desktop Cat'))).toBe(false);
  });

  it('--user-data-dir= still wins over the pin', async () => {
    await bootWith('', [`--user-data-dir=${h.state.userData}`]);
    expect(userDataSets()).toEqual([path.resolve(h.state.userData)]);
    expect(fs.existsSync(path.join(h.state.appData, 'Desktop Cat'))).toBe(false);
  });

  it('a user-data-dir switch Chromium parsed in another spelling is left to Electron, as before', async () => {
    h.state.switches.set('user-data-dir', h.state.userData);
    await bootWith('');
    expect(userDataSets()).toEqual([]);
    expect(fs.existsSync(path.join(h.state.appData, 'Desktop Cat'))).toBe(false);
  });
});
