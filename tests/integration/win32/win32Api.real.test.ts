// REAL Win32 calls through koffi in plain Node. Assertions are structural only and are
// written so that a failure never prints window titles or process names: values are
// reduced to booleans or key lists before they reach `expect`.
// Note: plain Node is not per-monitor DPI aware, so coordinates may be DPI-virtualised.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFiniteRect } from '../../../src/shared/geometry';
import { APP_CATEGORIES } from '../../../src/shared/world';
import type { WindowInfo } from '../../../src/shared/world';
import { createActivityMonitor, createWin32Api, createWindowTracker } from '../../../src/main/win32';
import type { ExtendedWin32Api } from '../../../src/main/win32';
import { createTestLogger } from '../../unit/win32/fakes';

const INFO_KEYS = ['category', 'excluded', 'fullscreen', 'id', 'maximized', 'minimized', 'processName', 'rect'];
const ID = /^[1-9][0-9]{0,19}$/;
const NOTIFICATION_STATES = ['fullscreen', 'presentation', 'd3d-fullscreen', 'busy', 'normal', 'unknown'];

function wellFormed(w: WindowInfo): boolean {
  return (
    Object.keys(w).sort().join(',') === INFO_KEYS.join(',') &&
    ID.test(w.id) &&
    isFiniteRect(w.rect) &&
    w.rect.width >= 0 &&
    w.rect.height >= 0 &&
    typeof w.processName === 'string' &&
    w.processName === w.processName.toLowerCase() &&
    !w.processName.includes('\\') &&
    (APP_CATEGORIES as readonly string[]).includes(w.category) &&
    [w.minimized, w.maximized, w.fullscreen, w.excluded].every((b) => typeof b === 'boolean') &&
    (w.minimized || (w.rect.width >= 120 && w.rect.height >= 60))
  );
}

describe.runIf(process.platform === 'win32')('Win32Api (real koffi)', () => {
  const logger = createTestLogger();
  let api: ExtendedWin32Api;

  beforeAll(() => {
    api = createWin32Api(logger);
  });
  afterAll(() => api.dispose());

  it('loads koffi and the system DLLs', () => {
    expect(api.available).toBe(true);
  });

  it('reads cursor, idle time and the primary button', () => {
    const c = api.getCursorPos();
    expect(c !== null && Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
    const idle = api.getIdleMs();
    expect(idle !== null && Number.isFinite(idle) && idle >= 0).toBe(true);
    expect(typeof api.isLeftButtonDown()).toBe('boolean');
  });

  it('lists well-formed app windows without titles', () => {
    const list = api.listAppWindows();
    expect(Array.isArray(list)).toBe(true);
    expect(list.every(wellFormed)).toBe(true);
    expect(new Set(list.map((w) => w.id)).size).toBe(list.length);
  });

  it('describes listed windows consistently and returns finite rects', () => {
    for (const w of api.listAppWindows().slice(0, 25)) {
      const d = api.describeWindow(w.id);
      expect(d === null || (wellFormed(d) && d.id === w.id)).toBe(true);
      const r = api.getWindowRect(w.id);
      expect(r === null || (isFiniteRect(r) && r.width > 0 && r.height > 0)).toBe(true);
      expect([true, false, null].includes(api.isWindowExcluded(w.id))).toBe(true);
    }
  });

  it('answers point, foreground and notification queries', () => {
    const c = api.getCursorPos() ?? { x: 0, y: 0 };
    const at = api.windowIdAtPoint(c);
    expect(at === null || ID.test(at)).toBe(true);
    const fg = api.getForegroundWindowId();
    expect(fg === null || ID.test(fg)).toBe(true);
    expect(NOTIFICATION_STATES.includes(api.getNotificationState())).toBe(true);
  });

  it('rejects garbage ids without throwing', () => {
    for (const id of ['', '0', 'x', '-1', '18446744073709551616', '12345']) {
      expect(api.describeWindow(id)).toBeNull();
      expect(api.getWindowRect(id)).toBeNull();
    }
  });

  it('installs and removes WinEvent hooks (delivery needs a message pump; see the Electron probe)', () => {
    const off = api.subscribeWinEvents(() => undefined);
    expect(typeof off).toBe('function');
    off?.();
    off?.();
  });

  it('never logs window titles', () => {
    const titlesSeen = logger.entries.some((e) => 'title' in (e.data ?? {}));
    expect(titlesSeen).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('tracker and activity monitor on real Win32', () => {
  it('tracks windows and computes platforms structurally', () => {
    const logger = createTestLogger();
    const api = createWin32Api(logger);
    const tracker = createWindowTracker(api, logger);
    tracker.start();
    try {
      expect(tracker.mode).toBe('event-hooks');
      expect(Array.isArray(tracker.drainEvents())).toBe(true);
      const platforms = tracker.getPlatforms(0);
      expect(platforms.every((p) => ID.test(p.windowId) && Number.isFinite(p.y) && p.x1 - p.x0 >= 80)).toBe(true);
      const c = api.getCursorPos() ?? { x: 0, y: 0 };
      expect(typeof tracker.isExcludedAt(c)).toBe('boolean');
      const fg = tracker.getForeground();
      expect(fg === null || wellFormed(fg)).toBe(true);
      const world = { version: 1, displays: [] };
      expect(tracker.getFullscreenDisplayIds(world)).toEqual([]);
    } finally {
      tracker.stop();
      api.dispose();
    }
  });

  it('samples idle time', () => {
    const logger = createTestLogger();
    const api = createWin32Api(logger);
    const monitor = createActivityMonitor(api, logger);
    monitor.start();
    monitor.sample(0, api.getCursorPos());
    monitor.sample(33, api.getCursorPos());
    expect(Number.isFinite(monitor.idleMs) && monitor.idleMs >= 0).toBe(true);
    monitor.stop();
    api.dispose();
  });
});
