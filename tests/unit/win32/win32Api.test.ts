import { describe, expect, it, vi } from 'vitest';
import type { RawWinEvent } from '../../../src/main/contracts';
import { createKoffiWin32Api, createUnavailableWin32Api, hasWin32Extensions, idleFromTicks, parseWindowId } from '../../../src/main/win32/win32Api';
import { createTestLogger, FakeNative, PRIMARY_MONITOR, raw } from './fakes';

const OWN = 4242;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_APPWINDOW = 0x40000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_POPUP = 0x80000000;

function setup(opts: Parameters<typeof createKoffiWin32Api>[2] = {}) {
  const native = new FakeNative(OWN);
  const logger = createTestLogger();
  let t = 0;
  const api = createKoffiWin32Api(native, logger, { now: () => t, ...opts });
  return { native, logger, api, advance: (ms: number) => (t += ms) };
}

const INFO_KEYS = ['category', 'excluded', 'fullscreen', 'id', 'maximized', 'minimized', 'processName', 'rect'];

describe('describeWindow', () => {
  it('describes a normal app window without exposing its title', () => {
    const { native, api } = setup();
    native.add(100n, { pid: 7, title: 'Quarterly report', frame: raw(10, 20, 800, 600) }, 'C:\\Program Files\\Microsoft VS Code\\Code.exe');
    const info = api.describeWindow('100');
    expect(info).not.toBeNull();
    expect(Object.keys(info!).sort()).toEqual(INFO_KEYS);
    expect(info).toMatchObject({ id: '100', rect: { x: 10, y: 20, width: 800, height: 600 }, processName: 'code.exe', category: 'code', minimized: false, excluded: false });
    expect(JSON.stringify(info)).not.toContain('Quarterly');
  });

  it.each([
    ['invisible', { visible: false }],
    ['tool window', { exStyle: WS_EX_TOOLWINDOW }],
    ['no-activate popup', { exStyle: WS_EX_NOACTIVATE }],
    ['cloaked (other virtual desktop)', { cloaked: 2 }],
    ['child window', { root: 1n }],
    ['desktop', { className: 'Progman' }],
    ['taskbar', { className: 'Shell_TrayWnd' }],
    ['too small', { frame: raw(0, 0, 100, 50) }],
    ['empty rect', { frame: raw(0, 0, 0, 0) }],
  ])('rejects a %s', (_label, patch) => {
    const { native, api } = setup();
    native.add(1n, { pid: 9 });
    native.add(200n, { pid: 7, ...patch });
    expect(api.describeWindow('200')).toBeNull();
  });

  it('accepts a tool window that opts in with WS_EX_APPWINDOW', () => {
    const { native, api } = setup();
    native.add(200n, { pid: 7, exStyle: WS_EX_TOOLWINDOW | WS_EX_APPWINDOW });
    expect(api.describeWindow('200')).not.toBeNull();
  });

  it('applies the owner rule (visible owner hides, invisible owner or APPWINDOW does not)', () => {
    const { native, api } = setup();
    native.add(1n, { pid: 7 });
    native.add(2n, { pid: 7, visible: false });
    native.add(10n, { pid: 7, owner: 1n });
    native.add(11n, { pid: 7, owner: 2n });
    native.add(12n, { pid: 7, owner: 1n, exStyle: WS_EX_APPWINDOW });
    expect(api.describeWindow('10')).toBeNull();
    expect(api.describeWindow('11')).not.toBeNull();
    expect(api.describeWindow('12')).not.toBeNull();
  });

  it('excludes our own process unless explicitly included', () => {
    const own = setup();
    own.native.add(300n, { pid: OWN });
    expect(own.api.describeWindow('300')).toBeNull();
    expect(own.api.listAppWindows()).toEqual([]);
    const probe = setup({ includeOwnProcess: true });
    probe.native.add(300n, { pid: OWN, title: 'secret' });
    expect(probe.api.describeWindow('300')).not.toBeNull();
    // Titles of our own windows are never read (WM_GETTEXT could hang).
    expect(probe.native.titleReads).toEqual([]);
  });

  it('rejects shell surfaces such as the Start menu host', () => {
    const { native, api } = setup();
    native.add(400n, { pid: 50 }, 'C:\\Windows\\SystemApps\\StartMenuExperienceHost.exe');
    expect(api.describeWindow('400')).toBeNull();
  });

  it('reports minimized windows with their last visible rect', () => {
    const { native, api } = setup();
    native.add(500n, { pid: 7, frame: raw(50, 60, 700, 500) });
    expect(api.describeWindow('500')?.rect).toEqual({ x: 50, y: 60, width: 700, height: 500 });
    const w = native.windows.get(500n)!;
    w.iconic = true;
    w.frame = raw(-32000, -32000, 160, 28);
    const info = api.describeWindow('500');
    expect(info).toMatchObject({ minimized: true, maximized: false, fullscreen: false, rect: { x: 50, y: 60, width: 700, height: 500 } });
  });

  it('detects borderless fullscreen but not maximized framed windows', () => {
    const { native, api } = setup();
    const full = PRIMARY_MONITOR.monitor;
    native.add(600n, { pid: 7, style: WS_POPUP, frame: full, windowRect: full });
    native.add(601n, { pid: 8, zoomed: true, style: 0x00cf0000, frame: raw(0, 0, 1920, 1152), windowRect: raw(-8, -8, 1936, 1216) });
    expect(api.describeWindow('600')).toMatchObject({ fullscreen: true, maximized: false });
    expect(api.describeWindow('601')).toMatchObject({ fullscreen: false, maximized: true });
  });

  it('attributes UWP frame windows to the hosted app process', () => {
    const { native, api } = setup();
    native.add(700n, { pid: 60, coreChild: 701n }, 'C:\\Windows\\System32\\ApplicationFrameHost.exe');
    native.windows.set(701n, { pid: 61, visible: true, root: 700n });
    native.processes.set(61, 'C:\\Program Files\\WindowsApps\\Spotify.exe');
    expect(api.describeWindow('700')).toMatchObject({ processName: 'spotify.exe', category: 'media' });
  });

  it('returns null for malformed or unknown ids', () => {
    const { api } = setup();
    for (const id of ['', 'abc', '-5', '0', '1.5', '99999999999999999999999', '123']) expect(api.describeWindow(id)).toBeNull();
  });
});

describe('exclusions', () => {
  it('flags default sensitive processes without reading the title', () => {
    const { native, api } = setup();
    native.add(800n, { pid: 70, title: 'Vault' }, 'C:\\Program Files\\KeePassXC\\KeePassXC.exe');
    expect(api.describeWindow('800')).toMatchObject({ excluded: true, category: 'sensitive' });
    expect(native.titleReads).toEqual([]);
  });

  it('matches title patterns case-insensitively, in memory only', () => {
    const { native, api, logger } = setup();
    native.add(801n, { pid: 71, title: 'My BANK - Online Banking' }, 'C:\\Browser\\chrome.exe');
    native.add(802n, { pid: 72, title: 'Recipes' }, 'C:\\Browser\\firefox.exe');
    expect(api.describeWindow('801')?.excluded).toBe(true);
    expect(api.describeWindow('802')?.excluded).toBe(false);
    expect(JSON.stringify(logger.entries)).not.toMatch(/BANK|Recipes/);
  });

  it('uses the configured lists and skips title reads when there are no patterns', () => {
    const { native, api } = setup();
    native.add(803n, { pid: 73, title: 'password reset' }, 'C:\\x\\notes.exe');
    api.setExclusions(['Notes'], []);
    expect(api.describeWindow('803')?.excluded).toBe(true);
    api.setExclusions([], []);
    native.titleReads = [];
    expect(api.describeWindow('803')?.excluded).toBe(false);
    expect(native.titleReads).toEqual([]);
  });

  it('isWindowExcluded checks any root window with a fresh process lookup', () => {
    const { native, api } = setup();
    native.add(804n, { pid: 74, exStyle: WS_EX_TOOLWINDOW }, 'C:\\x\\bitwarden.exe');
    expect(api.describeWindow('804')).toBeNull();
    const before = native.imageLookups;
    expect(api.isWindowExcluded('804')).toBe(true);
    expect(api.isWindowExcluded('804')).toBe(true);
    expect(native.imageLookups - before).toBe(2);
    expect(api.isWindowExcluded('999')).toBeNull();
    native.add(805n, { pid: 75 });
    native.processes.delete(75);
    expect(api.isWindowExcluded('805')).toBeNull();
  });

  it('exposes the extension capability', () => {
    expect(hasWin32Extensions(setup().api)).toBe(true);
    expect(hasWin32Extensions(createUnavailableWin32Api())).toBe(true);
  });
});

describe('process name cache', () => {
  it('caches per pid with a TTL', () => {
    const { native, api, advance } = setup({ processCacheTtlMs: 1000 });
    native.add(900n, { pid: 80 });
    native.add(901n, { pid: 80 });
    api.listAppWindows();
    api.listAppWindows();
    expect(native.imageLookups).toBe(1);
    advance(1500);
    api.describeWindow('900');
    expect(native.imageLookups).toBe(2);
  });
});

describe('queries', () => {
  it('lists app windows in z-order', () => {
    const { native, api } = setup();
    native.add(3n, { pid: 1 });
    native.add(4n, { pid: 2, visible: false });
    native.add(5n, { pid: 3 });
    expect(api.listAppWindows().map((w) => w.id)).toEqual(['3', '5']);
  });

  it('getWindowRect is null for gone, hidden, minimized or cloaked windows', () => {
    const { native, api } = setup();
    native.add(10n, { pid: 1, frame: raw(1, 2, 300, 200) });
    native.add(11n, { pid: 1, iconic: true });
    native.add(12n, { pid: 1, cloaked: 1 });
    native.add(13n, { pid: 1, visible: false });
    native.add(14n, { pid: 1, frame: null, windowRect: raw(5, 5, 200, 100) });
    expect(api.getWindowRect('10')).toEqual({ x: 1, y: 2, width: 300, height: 200 });
    expect(api.getWindowRect('14')).toEqual({ x: 5, y: 5, width: 200, height: 100 });
    for (const id of ['11', '12', '13', '77', 'x']) expect(api.getWindowRect(id)).toBeNull();
  });

  it('windowIdAtPoint resolves the root window and drops our own', () => {
    const { native, api } = setup();
    native.add(20n, { pid: 1 });
    native.windows.set(21n, { pid: 1, visible: true, root: 20n });
    native.pointWindow = 21n;
    expect(api.windowIdAtPoint({ x: 5, y: 5 })).toBe('20');
    native.add(22n, { pid: OWN });
    native.pointWindow = 22n;
    expect(api.windowIdAtPoint({ x: 5, y: 5 })).toBeNull();
    expect(api.windowIdAtPoint({ x: NaN, y: 5 })).toBeNull();
  });

  it('foreground id excludes our own windows', () => {
    const { native, api } = setup();
    native.add(30n, { pid: 1 });
    native.add(31n, { pid: OWN });
    native.foreground = 30n;
    expect(api.getForegroundWindowId()).toBe('30');
    native.foreground = 31n;
    expect(api.getForegroundWindowId()).toBeNull();
    native.foreground = null;
    expect(api.getForegroundWindowId()).toBeNull();
  });

  it('computes idle time across the 32-bit tick wrap', () => {
    expect(idleFromTicks(5, 0xfffffff0)).toBe(21);
    expect(idleFromTicks(2000, 1500)).toBe(500);
    expect(idleFromTicks(1000, 1001)).toBe(0);
    const { native, api } = setup();
    native.tick = 10;
    native.lastInputTick = 0xffffffff;
    expect(api.getIdleMs()).toBe(11);
    native.lastInputTick = null;
    expect(api.getIdleMs()).toBeNull();
  });

  it('reads only the primary mouse button, honouring swapped buttons', () => {
    const { native, api } = setup();
    native.keyState.set(0x01, -32768);
    expect(api.isLeftButtonDown()).toBe(true);
    native.swapButtons = true;
    expect(api.isLeftButtonDown()).toBe(false);
    native.keyState.set(0x02, -32767);
    expect(api.isLeftButtonDown()).toBe(true);
  });

  it('maps the user notification state', () => {
    const { native, api } = setup();
    const cases: Array<[number | null, string]> = [
      [1, 'unknown'],
      [2, 'busy'],
      [3, 'd3d-fullscreen'],
      [4, 'presentation'],
      [5, 'normal'],
      [6, 'normal'],
      [7, 'fullscreen'],
      [null, 'unknown'],
      [42, 'unknown'],
    ];
    for (const [v, expected] of cases) {
      native.quns = v;
      expect(api.getNotificationState()).toBe(expected);
    }
  });

  it('logs the thread DPI awareness once at startup', () => {
    const ok = setup();
    expect(ok.logger.entries.filter((e) => e.msg === 'thread DPI awareness')).toHaveLength(1);
    const native = new FakeNative(OWN);
    native.dpi = 0;
    const logger = createTestLogger();
    createKoffiWin32Api(native, logger);
    expect(logger.entries.some((e) => e.level === 'warn' && e.msg.includes('not per-monitor'))).toBe(true);
  });
});

describe('WinEvent hooks', () => {
  it('installs one out-of-context hook per range and skips our own process', () => {
    const { native, api } = setup();
    const off = api.subscribeWinEvents(() => undefined);
    expect(off).toBeTypeOf('function');
    const ranges = [...native.hooks.values()].map((h) => [h.min, h.max]);
    expect(ranges).toEqual([
      [0x3, 0x3],
      [0xa, 0xb],
      [0x16, 0x17],
      [0x8001, 0x8003],
      [0x8017, 0x8018],
    ]);
    expect([...native.hooks.values()].every((h) => h.flags === 2)).toBe(true);
    const probe = setup({ includeOwnProcess: true });
    probe.api.subscribeWinEvents(() => undefined);
    expect([...probe.native.hooks.values()].every((h) => h.flags === 0)).toBe(true);
  });

  it('filters to root-window object events and maps kinds', () => {
    const { native, api, advance } = setup();
    native.add(40n, { pid: 1 });
    native.windows.set(41n, { pid: 1, visible: true, root: 40n });
    const got: RawWinEvent[] = [];
    api.subscribeWinEvents((ev) => got.push(ev));
    advance(5);
    native.fire(0x8002, 40n);
    native.fire(0x8002, 40n, -4); // OBJID_CLIENT
    native.fire(0x8002, 40n, 0, 3); // child element
    native.fire(0x8002, null);
    native.fire(0x8002, 41n); // non-root
    native.fire(0x800c, 40n); // NAMECHANGE is not subscribed
    native.fire(0x0003, 40n);
    native.fire(0x000a, 40n);
    native.fire(0x000b, 40n);
    native.fire(0x0016, 40n);
    native.fire(0x0017, 40n);
    native.fire(0x8003, 40n);
    native.fire(0x8017, 40n);
    native.fire(0x8018, 40n);
    expect(got.map((e) => e.kind)).toEqual(['show', 'foreground', 'moveStart', 'moveEnd', 'minimizeStart', 'minimizeEnd', 'hide', 'cloaked', 'uncloaked']);
    expect(got.every((e) => e.id === '40' && e.at === 5)).toBe(true);
  });

  it('passes DESTROY only for windows previously seen as app windows', () => {
    const { native, api } = setup();
    native.add(50n, { pid: 1 });
    const got: RawWinEvent[] = [];
    api.subscribeWinEvents((ev) => got.push(ev));
    native.fire(0x8001, 51n);
    native.fire(0x8001, 50n);
    expect(got).toEqual([]);
    api.listAppWindows();
    native.windows.delete(50n);
    native.fire(0x8001, 50n);
    expect(got.map((e) => [e.kind, e.id])).toEqual([['destroy', '50']]);
  });

  it('never lets a handler exception escape into native code', () => {
    const { native, api, logger } = setup();
    native.add(60n, { pid: 1 });
    api.subscribeWinEvents(() => {
      throw new Error('handler bug');
    });
    expect(() => native.fire(0x8002, 60n)).not.toThrow();
    expect(logger.entries.some((e) => e.level === 'warn' && e.data?.op === 'winEventHandler')).toBe(true);
  });

  it('unsubscribe unhooks every range and unregisters the callback once', () => {
    const { native, api } = setup();
    const off = api.subscribeWinEvents(() => undefined)!;
    off();
    off();
    expect(native.unhooked).toHaveLength(5);
    expect(native.unregistered).toHaveLength(1);
    expect(native.hooks.size).toBe(0);
  });

  it('returns null and unregisters when no hook can be installed', () => {
    const { native, api, logger } = setup();
    for (const min of [0x3, 0xa, 0x16, 0x8001, 0x8017]) native.failHooks.add(min);
    expect(api.subscribeWinEvents(() => undefined)).toBeNull();
    expect(native.unregistered).toHaveLength(1);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('dispose releases all subscriptions and refuses new ones', () => {
    const { native, api } = setup();
    api.subscribeWinEvents(() => undefined);
    api.subscribeWinEvents(() => undefined);
    api.dispose();
    expect(native.hooks.size).toBe(0);
    expect(native.unregistered).toHaveLength(2);
    expect(api.subscribeWinEvents(() => undefined)).toBeNull();
  });
});

describe('error safety', () => {
  it('maps native failures to safe values and rate-limits the warning', () => {
    const { native, api, logger } = setup();
    native.throwOn.add('getCursorPos');
    native.throwOn.add('enumTopLevelWindows');
    for (let i = 0; i < 10; i++) {
      expect(api.getCursorPos()).toBeNull();
      expect(api.listAppWindows()).toEqual([]);
    }
    const warns = logger.entries.filter((e) => e.level === 'warn' && e.msg === 'native call failed');
    expect(warns).toHaveLength(6);
  });

  it('a window that fails mid-enumeration does not drop the list', () => {
    const { native, api } = setup();
    native.add(70n, { pid: 1 });
    native.add(71n, { pid: 2 });
    const spy = vi.spyOn(native, 'getWindowProcessId').mockImplementation((h) => {
      if (h === 70n) throw new Error('gone');
      return native.windows.get(h)?.pid ?? 0;
    });
    expect(api.listAppWindows().map((w) => w.id)).toEqual(['71']);
    spy.mockRestore();
  });
});

describe('parseWindowId', () => {
  it('accepts decimal 64-bit handles only', () => {
    expect(parseWindowId('131234')).toBe(131234n);
    expect(parseWindowId('18446744073709551615')).toBe(18446744073709551615n);
    expect(parseWindowId('18446744073709551616')).toBeNull();
    expect(parseWindowId('0')).toBeNull();
    expect(parseWindowId(' 12')).toBeNull();
    expect(parseWindowId('0x10')).toBeNull();
  });
});

describe('unavailable fallback', () => {
  it('is inert and never throws', () => {
    const api = createUnavailableWin32Api();
    expect(api.available).toBe(false);
    expect(api.getCursorPos()).toBeNull();
    expect(api.getIdleMs()).toBeNull();
    expect(api.isLeftButtonDown()).toBe(false);
    expect(api.getForegroundWindowId()).toBeNull();
    expect(api.describeWindow('1')).toBeNull();
    expect(api.getWindowRect('1')).toBeNull();
    expect(api.listAppWindows()).toEqual([]);
    expect(api.windowIdAtPoint({ x: 0, y: 0 })).toBeNull();
    expect(api.getNotificationState()).toBe('unknown');
    expect(api.subscribeWinEvents(() => undefined)).toBeNull();
    expect(api.isWindowExcluded('1')).toBeNull();
    expect(() => api.dispose()).not.toThrow();
  });
});
