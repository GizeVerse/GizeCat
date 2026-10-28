// index.ts before 'ready': a startup failure must end the process, never leave a
// windowless one holding the single-instance lock (later launches would exit silently).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeDir, tempDir } from './helpers';

const h = vi.hoisted(() => {
  const state = {
    userData: '',
    /** Calls into the fake Electron app, in order. */
    order: [] as string[],
    failAt: null as string | null,
    resolveReady: (): void => undefined,
    ready: Promise.resolve(),
    processHandlers: new Map<string, (err: unknown) => void>(),
  };
  const step = (name: string) => () => {
    state.order.push(name);
    if (state.failAt === name) throw new Error(`${name} failed (simulated)`);
  };
  const app = {
    setPath: step('setPath'),
    getPath: () => state.userData,
    setAppUserModelId: step('setAppUserModelId'),
    requestSingleInstanceLock: () => {
      state.order.push('lock');
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
    h.state.order = [];
    h.state.failAt = null;
    h.state.processHandlers.clear();
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
  });

  it('under test, the failure exits without a blocking dialog', async () => {
    h.state.failAt = 'setAppUserModelId';
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
