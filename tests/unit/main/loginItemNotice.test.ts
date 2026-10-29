// The one-time "Desktop Cat now starts with Windows" notification (startup#8): shown outside
// Settings when startup was turned on by default or by the v1 migration, marked as shown only
// once Windows displayed it, never in test mode or at a sign-in boot. MOCKED: the tray surface
// (tray.test.ts covers the Electron balloon), FakeWindowsLogin instead of the registry.
import { describe, expect, it } from 'vitest';
import { createLoginItemService, UNINSTALLER_FILE } from '../../../src/main/lifecycle/loginItem';
import { announceLaunchAtLogin, LAUNCH_NOTICE, type LaunchNoticeOptions, type NoticeHandlers, type NoticeSurface } from '../../../src/main/lifecycle/loginItemNotice';
import type { LoginItemStatus } from '../../../src/shared/ipc';
import { migrateSettings, type Settings } from '../../../src/shared/settings';
import { memoryLogger } from './helpers';
import { FakeWindowsLogin, memoryFs, memorySettings } from './loginItemFakes';

const DIR = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\Desktop Cat';
const EXE = `${DIR}\\DesktopCat.exe`;

/** A notification area that records requests; `display()` plays Windows showing the latest one. */
function fakeSurface(accept = true): NoticeSurface & { asked: Array<{ title: string; body: string }>; display(): void; click(): void } {
  let handlers: NoticeHandlers | null = null;
  const asked: Array<{ title: string; body: string }> = [];
  return {
    asked,
    notify(notice, h) {
      asked.push(notice);
      handlers = h;
      return accept;
    },
    display: () => handlers?.onShown(),
    click: () => handlers?.onClick(),
  };
}

const due: LoginItemStatus = { enabled: true, preference: 'unset', disabledBy: null, active: true, writable: true, reason: null, showNotice: true };

function options(over: Partial<LaunchNoticeOptions> = {}) {
  const calls = { marked: 0, opened: 0 };
  const o: LaunchNoticeOptions = {
    status: due,
    test: false,
    launchedAtLogin: false,
    surface: fakeSurface(),
    markShown: () => void calls.marked++,
    openSettings: () => void calls.opened++,
    logger: memoryLogger(),
    ...over,
  };
  return { o, calls };
}

describe('announceLaunchAtLogin', () => {
  it('asks Windows for one notification saying startup is on and where to change it', () => {
    const surface = fakeSurface();
    const { o, calls } = options({ surface });
    expect(announceLaunchAtLogin(o)).toBe(true);
    expect(surface.asked).toEqual([LAUNCH_NOTICE]);
    expect(LAUNCH_NOTICE.title).toMatch(/starts with Windows/);
    expect(LAUNCH_NOTICE.body).toMatch(/sign in/);
    expect(LAUNCH_NOTICE.body).toMatch(/Settings › General/);
    // Not marked until Windows displays it (Do not disturb may hold it back).
    expect(calls.marked).toBe(0);
    surface.display();
    surface.display();
    expect(calls).toEqual({ marked: 1, opened: 0 });
  });

  it('a click opens Settings › General and counts as seen', () => {
    const surface = fakeSurface();
    const { o, calls } = options({ surface });
    announceLaunchAtLogin(o);
    surface.click();
    expect(calls).toEqual({ marked: 1, opened: 1 });
    surface.display();
    expect(calls.marked).toBe(1);
  });

  it('is never shown in test mode, at a sign-in boot, when not due, or without a tray icon', () => {
    for (const over of [
      { test: true },
      { launchedAtLogin: true },
      { test: true, launchedAtLogin: true },
      { status: { ...due, showNotice: false } },
      { surface: null },
    ] satisfies Array<Partial<LaunchNoticeOptions>>) {
      const surface = fakeSurface();
      const { o, calls } = options({ surface, ...over });
      expect(announceLaunchAtLogin(o)).toBe(false);
      expect(surface.asked).toEqual([]);
      expect(calls).toEqual({ marked: 0, opened: 0 });
    }
  });

  it('a surface that cannot ask, or throws, is logged and leaves the notice due', () => {
    const log = memoryLogger();
    const { o, calls } = options({ surface: fakeSurface(false), logger: log });
    expect(announceLaunchAtLogin(o)).toBe(false);
    const throwing: NoticeSurface = {
      notify: () => {
        throw new Error('shell not ready');
      },
    };
    expect(announceLaunchAtLogin({ ...o, surface: throwing })).toBe(false);
    expect(calls.marked).toBe(0);
    expect(log.entries.filter((e) => e.level === 'warn')).toHaveLength(2);
  });
});

describe('the notice end to end with the login-item service', () => {
  function service(initial: Settings) {
    const win = new FakeWindowsLogin();
    const settings = memorySettings(initial);
    const fs = memoryFs({ [`${DIR}\\${UNINSTALLER_FILE}`]: '' });
    let t = 0;
    const boot = (launchedAtLogin = false) => {
      const svc = createLoginItemService({
        writer: win,
        registry: win.readerFor(),
        settings,
        logger: memoryLogger(),
        execPath: EXE,
        userData: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Desktop Cat',
        logDir: null,
        packaged: true,
        test: false,
        launchedAtLogin,
        env: {},
        settingsLoadStatus: 'ok',
        clock: () => (t += 10),
        fs,
      });
      svc.reconcileAtStartup();
      return svc;
    };
    return { settings, boot };
  }

  /** What app.ts does at the end of startApp. */
  function announce(svc: ReturnType<ReturnType<typeof service>['boot']>, surface: ReturnType<typeof fakeSurface>, launchedAtLogin = false): boolean {
    return announceLaunchAtLogin({
      status: svc.status(),
      test: false,
      launchedAtLogin,
      surface,
      markShown: () => void svc.dismissNotice(),
      openSettings: () => undefined,
      logger: memoryLogger(),
    });
  }

  it('a v1 upgrader whose ambiguous false became on is told once, without opening Settings', () => {
    const r = service(migrateSettings({ schemaVersion: 1, general: { launchAtLogin: false } }));
    const surface = fakeSurface();
    // Do not disturb held the first one back: offered again at the next start by the user.
    expect(announce(r.boot(), surface)).toBe(true);
    // Sign-in boots wait for a start by the user.
    expect(announce(r.boot(true), surface, true)).toBe(false);
    expect(announce(r.boot(), surface)).toBe(true);
    surface.display();
    expect(r.settings.get().loginItem.noticeShown).toBe(true);
    expect(announce(r.boot(), surface)).toBe(false);
    expect(surface.asked).toHaveLength(2);
  });

  it('a new install is told too; an explicit v1 opt-in is not (startup was already on)', () => {
    const fresh = service(migrateSettings({}));
    const surface = fakeSurface();
    expect(announce(fresh.boot(), surface)).toBe(true);

    const optedIn = service(migrateSettings({ schemaVersion: 1, general: { launchAtLogin: true } }));
    const other = fakeSurface();
    expect(announce(optedIn.boot(), other)).toBe(false);
    expect(other.asked).toEqual([]);
  });
});
