// Privacy coverage of the real Win32 layer (createKoffiWin32Api over FakeNative, then the
// window tracker): masks, the foreground check and point checks must see every shown
// top-level window, not only Alt-Tab app windows; titles are read only while screen
// analysis is on; this app's own windows never count as private.
import { describe, expect, it } from 'vitest';
import { decideCapture } from '../../../src/core/perception/privacy';
import { rectIntersection } from '../../../src/shared/geometry';
import type { Rect } from '../../../src/shared/geometry';
import { DEFAULT_EXCLUDED_PROCESSES, DEFAULT_EXCLUDED_TITLE_PATTERNS, defaultSettings } from '../../../src/shared/settings';
import type { Settings } from '../../../src/shared/settings';
import type { DisplayGeometry, WorldGeometry } from '../../../src/shared/world';
import { sameWindowExclusions, titleChecksActive, windowExclusionsFor } from '../../../src/main/win32/exclusionPolicy';
import type { Hwnd } from '../../../src/main/win32/native';
import { createKoffiWin32Api } from '../../../src/main/win32/win32Api';
import { createWindowTracker } from '../../../src/main/win32/windowTracker';
import { createTestLogger, FakeNative, raw } from './fakes';
import type { FakeWindow } from './fakes';

const OWN = 4242;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_LAYERED = 0x80000;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_POPUP = 0x80000000;
const OVERLAY_EX = WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED;

const APP = {
  sevenZip: 'C:\\Program Files\\7-Zip\\7zFM.exe',
  onePassword: 'C:\\Program Files\\1Password\\1Password.exe',
  chrome: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
  outlook: 'C:\\Program Files\\Microsoft Office\\OUTLOOK.EXE',
  broker: 'C:\\Windows\\System32\\CredentialUIBroker.exe',
  keepass: 'C:\\Program Files\\KeePass\\KeePass.exe',
  word: 'C:\\Program Files\\Microsoft Office\\WINWORD.EXE',
  notes: 'C:\\Windows\\notepad.exe',
  explorer: 'C:\\Windows\\explorer.exe',
};

const toRaw = (r: Rect) => raw(r.x, r.y, r.width, r.height);
const R = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

function consented(patch: Partial<Settings['perception']> = {}): Settings {
  const s = defaultSettings();
  s.perception = { ...s.perception, visualMode: 'local-stats', consentAt: '2026-10-01T00:00:00.000Z', ...patch };
  return s;
}

/** A real koffi-layer API and tracker over a fake desktop. Windows are added top of the z-order first. */
function desktop(settings: Settings = consented()) {
  const native = new FakeNative(OWN);
  native.hitTest = true;
  const logger = createTestLogger();
  let t = 1000;
  const api = createKoffiWin32Api(native, logger, { now: () => t });
  const tracker = createWindowTracker(api, logger, { now: () => t });
  const ex = windowExclusionsFor(settings);
  tracker.setExclusions(ex.processes, ex.titlePatterns);
  const add = (h: Hwnd, r: Rect, w: Partial<FakeWindow> & { pid: number }, path?: string) => native.add(h, { frame: toRaw(r), ...w }, path);
  return { native, api, tracker, logger, add, advance: (ms: number) => (t += ms) };
}

const sortRects = (rs: readonly Rect[]) => [...rs].sort((a, b) => a.x - b.x || a.y - b.y);

describe('privacy masks cover every shown private window (privacy#1, win32#0)', () => {
  it('masks owned dialogs, tool windows, small windows and dialogs of private windows', () => {
    const { add, tracker } = desktop();
    const enterPassword = R(1400, 620, 300, 200);
    const quickAccess = R(600, 880, 300, 180);
    const signIn = R(200, 200, 110, 55);
    const bank = R(0, 0, 1200, 900);
    const saveAs = R(300, 300, 500, 400);
    add(1n, enterPassword, { pid: 10, owner: 5n, title: 'Enter password' }, APP.sevenZip);
    add(2n, quickAccess, { pid: 11, exStyle: WS_EX_TOOLWINDOW, title: 'Quick Access' }, APP.onePassword);
    add(3n, signIn, { pid: 12, title: 'Sign in' }, APP.notes);
    add(4n, saveAs, { pid: 13, owner: 6n, title: 'Save As' }, APP.chrome);
    add(5n, R(0, 0, 1920, 1152), { pid: 10, title: '7-Zip' }, APP.sevenZip);
    add(6n, bank, { pid: 13, title: 'My Bank - Online Banking' }, APP.chrome);
    tracker.start();
    expect(sortRects(tracker.getExcludedRects())).toEqual(sortRects([enterPassword, quickAccess, signIn, saveAs, bank]));
  });

  it('masks a shown window whose process cannot be identified', () => {
    const { add, native, tracker } = desktop();
    add(1n, R(10, 10, 400, 300), { pid: 20 });
    native.processes.delete(20);
    expect(tracker.getExcludedRects()).toEqual([R(10, 10, 400, 300)]);
  });

  it('masks a window whose owner chain cannot be resolved (cycle or gone owner)', () => {
    const { add, tracker } = desktop();
    add(1n, R(10, 10, 300, 200), { pid: 21, owner: 2n });
    add(2n, R(500, 10, 300, 200), { pid: 21, owner: 1n });
    add(3n, R(10, 500, 300, 200), { pid: 22, owner: 99n });
    expect(sortRects(tracker.getExcludedRects())).toEqual(sortRects([R(10, 10, 300, 200), R(500, 10, 300, 200), R(10, 500, 300, 200)]));
  });

  it('ignores hidden, minimized and cloaked private windows and this app’s own windows', () => {
    const { add, native, tracker } = desktop();
    add(1n, R(0, 0, 300, 200), { pid: 30, visible: false }, APP.keepass);
    add(2n, R(0, 0, 300, 200), { pid: 30, iconic: true }, APP.keepass);
    add(3n, R(0, 0, 300, 200), { pid: 30, cloaked: 2 }, APP.keepass);
    add(4n, R(0, 0, 900, 640), { pid: OWN, title: 'Desktop Cat password settings' });
    add(5n, R(0, 0, 1920, 1152), { pid: 31, title: 'Notes' }, APP.notes);
    expect(tracker.getExcludedRects()).toEqual([]);
    expect(native.titleReads).not.toContain(4n);
  });

  it('masks everything when private windows cannot be located', () => {
    const region = R(0, 0, 1920, 1200);
    const failing = desktop();
    failing.native.throwOn.add('enumTopLevelWindows');
    const rects = failing.tracker.getExcludedRects();
    expect(rects).toHaveLength(1);
    expect(rectIntersection(rects[0]!, region)).toEqual(region);

    const lost = desktop();
    lost.add(1n, R(0, 0, 300, 200), { pid: 30, windowRect: null, frame: null }, APP.keepass);
    expect(rectIntersection(lost.tracker.getExcludedRects()[0]!, region)).toEqual(region);
  });
});

describe('excluded foreground covers any kind of foreground window (win32#1)', () => {
  it('flags an owned credential dialog in front even though it is not an app window', () => {
    const { add, native, tracker } = desktop();
    add(1n, R(700, 400, 500, 360), { pid: 40, owner: 2n, title: 'Windows Security' }, APP.broker);
    add(2n, R(0, 0, 1920, 1152), { pid: 41, title: 'Inbox - Outlook' }, APP.outlook);
    native.foreground = 1n;
    tracker.start();
    expect(tracker.getForeground()).toBeNull();
    expect(tracker.isForegroundExcluded()).toBe(true);
  });

  it('flags an owned dialog by its owner chain and a private tool window', () => {
    const { add, native, tracker } = desktop();
    add(1n, R(300, 300, 500, 400), { pid: 42, owner: 3n, title: 'Save As' }, APP.chrome);
    add(2n, R(600, 880, 300, 180), { pid: 43, exStyle: WS_EX_TOOLWINDOW }, APP.onePassword);
    add(3n, R(0, 0, 1200, 900), { pid: 42, title: 'My Bank - Online Banking' }, APP.chrome);
    add(4n, R(0, 0, 100, 40), { pid: 44, title: 'Enter password' }, APP.sevenZip);
    for (const h of [1n, 2n, 4n]) {
      native.foreground = h;
      expect(tracker.isForegroundExcluded()).toBe(true);
    }
  });

  it('clears ordinary windows and this app’s own windows; fails closed otherwise', () => {
    const { add, native, tracker } = desktop();
    add(1n, R(0, 0, 900, 640), { pid: OWN });
    add(2n, R(0, 0, 1920, 1152), { pid: 50, title: 'Notes' }, APP.notes);
    add(3n, R(0, 0, 400, 300), { pid: 51 });
    native.processes.delete(51);
    native.foreground = 1n;
    expect(tracker.isForegroundExcluded()).toBe(false);
    native.foreground = 2n;
    expect(tracker.isForegroundExcluded()).toBe(false);
    native.foreground = 3n;
    expect(tracker.isForegroundExcluded()).toBe(true);
    native.foreground = null;
    expect(tracker.isForegroundExcluded()).toBe(true);
    native.throwOn.add('getWindowProcessId');
    native.foreground = 2n;
    expect(tracker.isForegroundExcluded()).toBe(true);
  });
});

describe('window titles are read only while screen analysis is on (security#2, privacy#4, lifecycle#2, win32#3)', () => {
  const world: WorldGeometry = {
    version: 1,
    displays: [{ id: '1', primary: true, scaleFactor: 1, boundsDip: R(0, 0, 1920, 1200), workAreaDip: R(0, 0, 1920, 1152), boundsPx: R(0, 0, 1920, 1200), workAreaPx: R(0, 0, 1920, 1152) }],
  };

  function exercise(settings: Settings) {
    const d = desktop(settings);
    d.add(1n, R(100, 100, 800, 600), { pid: 60, title: 'My Bank - account' }, APP.chrome);
    d.add(2n, R(300, 300, 800, 600), { pid: 61, title: 'Quarterly report' }, APP.word);
    d.native.foreground = 1n;
    d.tracker.start();
    d.advance(3000);
    d.tracker.drainEvents();
    d.tracker.getPlatforms(0);
    d.tracker.getFullscreenDisplayIds(world);
    return d;
  }

  it('reads no title with the default settings (analysis off)', () => {
    const { native, tracker } = exercise(defaultSettings());
    expect(tracker.getForeground()?.excluded).toBe(false);
    expect(native.titleReads).toEqual([]);
  });

  it('reads no title before the host installs patterns', () => {
    const native = new FakeNative(OWN);
    native.add(1n, { pid: 60, title: 'Enter password' }, APP.chrome);
    const api = createKoffiWin32Api(native, createTestLogger());
    api.listAppWindows();
    api.describeWindow('1');
    expect(native.titleReads).toEqual([]);
  });

  it('matches titles once analysis is enabled with consent', () => {
    const { native, tracker } = exercise(consented());
    expect(tracker.getForeground()?.excluded).toBe(true);
    expect(native.titleReads.length).toBeGreaterThan(0);
  });

  it('installs title patterns only with a mode, consent and no privacy pause', () => {
    const off = defaultSettings();
    const noConsent = consented({ consentAt: null });
    const paused = consented({ paused: true });
    for (const s of [off, noConsent, paused]) {
      expect(titleChecksActive(s)).toBe(false);
      expect(windowExclusionsFor(s)).toEqual({ processes: s.perception.excludedProcesses, titlePatterns: [] });
    }
    const on = consented({ visualMode: 'ai' });
    expect(titleChecksActive(on)).toBe(true);
    expect(windowExclusionsFor(on)).toEqual({ processes: DEFAULT_EXCLUDED_PROCESSES, titlePatterns: DEFAULT_EXCLUDED_TITLE_PATTERNS });
  });

  it('reports a change when consent, mode or pause flips, so the host re-applies them', () => {
    const before = windowExclusionsFor(defaultSettings());
    expect(sameWindowExclusions(before, windowExclusionsFor(defaultSettings()))).toBe(true);
    expect(sameWindowExclusions(before, windowExclusionsFor(consented()))).toBe(false);
    expect(sameWindowExclusions(windowExclusionsFor(consented()), windowExclusionsFor(consented({ paused: true })))).toBe(false);
    expect(sameWindowExclusions(before, { ...before, processes: ['other.exe'] })).toBe(false);
  });
});

describe('this app’s windows are not private windows (privacy#6)', () => {
  const settings = consented({ region: 'display' });

  it('lets the Settings window be captured instead of blocking every preview', () => {
    const { add, tracker } = desktop(settings);
    add(1n, R(510, 220, 900, 640), { pid: OWN });
    add(2n, R(0, 0, 1920, 1080), { pid: 70, title: 'Notes' }, APP.notes);
    tracker.start();
    expect(tracker.isExcludedAt({ x: 960, y: 540 })).toBe(false);
    const decision = decideCapture({ settings, paused: false, locked: false, foreground: tracker.getForeground(), region: R(0, 0, 1920, 1080), isExcludedAt: (p) => tracker.isExcludedAt(p) });
    expect(decision).toEqual({ allowed: true });
  });

  it('judges the window under an interactive cat overlay, not the overlay', () => {
    const { add, tracker } = desktop(settings);
    add(1n, R(0, 0, 1920, 1152), { pid: OWN, exStyle: OVERLAY_EX, style: WS_POPUP });
    add(2n, R(1200, 100, 500, 400), { pid: 71 }, APP.keepass);
    add(3n, R(0, 0, 1920, 1152), { pid: 72, title: 'Notes' }, APP.notes);
    expect(tracker.isExcludedAt({ x: 300, y: 300 })).toBe(false);
    expect(tracker.isExcludedAt({ x: 1300, y: 200 })).toBe(true);
  });

  it('sees through click-through windows and still fails closed where nothing is found', () => {
    const { add, tracker } = desktop(settings);
    add(1n, R(0, 0, 1920, 1152), { pid: OWN, exStyle: OVERLAY_EX | WS_EX_TRANSPARENT, style: WS_POPUP });
    add(2n, R(1200, 100, 500, 400), { pid: 71 }, APP.keepass);
    add(3n, R(0, 0, 1000, 1000), { pid: 72 }, APP.notes);
    expect(tracker.isExcludedAt({ x: 300, y: 300 })).toBe(false);
    expect(tracker.isExcludedAt({ x: 1300, y: 200 })).toBe(true);
    expect(tracker.isExcludedAt({ x: 1100, y: 1100 })).toBe(true);
  });
});

describe('platform occlusion counts every shown window (win32#4)', () => {
  const edgesOf = (platforms: readonly { windowId: string; x0: number; x1: number }[], id: string) => platforms.filter((p) => p.windowId === id).map((p) => [p.x0, p.x1]);

  it('cuts edges under owned dialogs, topmost tool windows and the Settings window', () => {
    const { add, tracker } = desktop();
    add(1n, R(0, 0, 1920, 1152), { pid: OWN, exStyle: OVERLAY_EX, style: WS_POPUP }); // interactive cat overlay
    add(2n, R(0, 0, 1920, 1152), { pid: 80, exStyle: WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW, style: WS_POPUP }); // click-through HUD
    add(3n, R(900, 350, 200, 100), { pid: 81, exStyle: WS_EX_TOOLWINDOW }); // topmost mini-player
    add(4n, R(1150, 380, 100, 50), { pid: OWN }); // Settings window
    add(5n, R(300, 250, 500, 400), { pid: 82, owner: 6n }, APP.word); // Word "Options"
    add(6n, R(1300, 0, 600, 300), { pid: 82 }, APP.word);
    add(7n, R(100, 400, 1600, 600), { pid: 83 }, APP.chrome);
    add(8n, R(0, 0, 1920, 1200), { pid: 84, className: 'Progman' }, APP.explorer);
    tracker.start();
    expect(edgesOf(tracker.getPlatforms(0), '7')).toEqual([
      [100, 300],
      [800, 900],
      [1250, 1700],
    ]);
    expect(edgesOf(tracker.getPlatforms(0), '6')).toEqual([[1300, 1900]]);
  });
});

describe('fullscreen detection with an auto-hide taskbar (win32#2)', () => {
  const MONITOR = raw(0, 0, 1920, 1200);
  const d: DisplayGeometry = { id: '1', primary: true, scaleFactor: 1, boundsDip: R(0, 0, 1920, 1200), workAreaDip: R(0, 0, 1920, 1200), boundsPx: R(0, 0, 1920, 1200), workAreaPx: R(0, 0, 1920, 1200) };
  const world: WorldGeometry = { version: 1, displays: [d] };
  const FRAMELESS = WS_POPUP | 0x00080000 | 0x00020000 | 0x00010000;

  it('does not hide the cat for a maximized frameless window', () => {
    const { native, api, tracker } = desktop();
    native.add(1n, { pid: 90, style: FRAMELESS, zoomed: true, frame: MONITOR, windowRect: MONITOR, monitor: { monitor: MONITOR, work: MONITOR } });
    native.foreground = 1n;
    expect(api.describeWindow('1')).toMatchObject({ maximized: true, fullscreen: false });
    tracker.start();
    expect(tracker.getFullscreenDisplayIds(world)).toEqual([]);
  });

  it('still detects a borderless fullscreen window there', () => {
    const { native, tracker } = desktop();
    native.add(1n, { pid: 90, style: WS_POPUP, frame: MONITOR, windowRect: MONITOR, monitor: { monitor: MONITOR, work: MONITOR } });
    native.foreground = 1n;
    tracker.start();
    expect(tracker.getFullscreenDisplayIds(world)).toEqual(['1']);
  });
});
