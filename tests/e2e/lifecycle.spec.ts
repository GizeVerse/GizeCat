import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { electronBinary, expect, hook, launchApp, MAIN_ENTRY, quitApp, readLogLines, ROOT, settingsPage, testEnv, test, waitForCat } from './fixtures';

const savedGeneral = (userData: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')) as { general: Record<string, unknown> }).general;

/** Switches the settings window to a page (navigation is hash-based). */
async function showPage(page: Page, id: string): Promise<void> {
  await page.evaluate((hash) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = hash;
  }, `#${id}`);
}

test.describe('lifecycle', () => {
  test('first run opens the welcome page; pause, hide, show, resume and quit work', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(() => app.windows().some((p) => p.url().includes('/renderer/settings/') && p.url().endsWith('#welcome'))).toBe(true);

      await hook(app, 'runAction', 'pause');
      await expect.poll(async () => (await hook(app, 'getStatus')).paused).toBe(true);
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => o.ignoreMouse)).toBe(true);

      await hook(app, 'runAction', 'hide');
      await expect.poll(async () => (await hook(app, 'getStatus')).visible).toBe(false);
      // Windows are never hidden; the renderer just stops drawing the cat.
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => o.visible && !o.active)).toBe(true);

      await hook(app, 'runAction', 'show');
      await hook(app, 'runAction', 'resume');
      await expect.poll(async () => {
        const s = await hook(app, 'getStatus');
        return s.visible && !s.paused;
      }).toBe(true);
      await expect.poll(async () => (await hook(app, 'getOverlays')).some((o) => o.active), { timeout: 20_000 }).toBe(true);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    const lines = readLogLines(userData);
    expect(lines.some((l) => l.m === 'shutdown complete')).toBe(true);
    expect(lines.filter((l) => l.l === 'error')).toEqual([]);
  });

  test('perception is off by default and never captures', async ({ userData }) => {
    const app = await launchApp(userData, { DESKTOP_CAT_TIME_SCALE: '10' });
    try {
      await waitForCat(app);
      const s = await hook(app, 'getSettings');
      expect(s.perception.visualMode).toBe('off');
      expect(s.perception.consentAt).toBeNull();
      expect(s.ai.provider).toBe('none');
      // Let the (sped-up) cat live for a while; nothing may be captured.
      await new Promise((r) => setTimeout(r, 4000));
      const p = await hook(app, 'getPerceptionStatus');
      expect(p).not.toBeNull();
      expect(p!.mode).toBe('off');
      expect(p!.lastCaptureAt).toBeNull();
      expect(p!.capturesThisHour).toBe(0);
      expect((await hook(app, 'getHostDebug')).timeScale).toBe(10);
    } finally {
      await quitApp(app);
    }
  });

  test('a second launch exits with code 0 and surfaces the running cat', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await hook(app, 'runAction', 'completeFirstRun');
      for (const p of app.windows()) if (p.url().includes('/renderer/settings/')) await p.close();
      await hook(app, 'runAction', 'hide');
      await expect.poll(async () => (await hook(app, 'getStatus')).visible).toBe(false);

      const second = spawn(electronBinary(), [MAIN_ENTRY], { cwd: ROOT, env: testEnv(userData), stdio: 'ignore', windowsHide: true });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          second.kill();
          reject(new Error('second instance did not exit'));
        }, 20_000);
        second.once('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(0);

      // First instance: still alive, cat shown again, settings window opened.
      await expect.poll(async () => (await hook(app, 'getStatus')).visible).toBe(true);
      await expect.poll(() => app.windows().some((p) => p.url().includes('/renderer/settings/'))).toBe(true);
      expect(app.process().exitCode).toBeNull();
    } finally {
      await quitApp(app);
    }
  });

  test('"Hidden" chosen under When Desktop Cat starts keeps the cat hidden after a restart', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const page = await settingsPage(app);
      await showPage(page, 'general');
      const choice = page.getByRole('radiogroup', { name: 'When Desktop Cat starts' });
      await choice.getByRole('radio', { name: 'Hidden' }).click();
      await expect.poll(async () => (await hook(app, 'getSettings')).general.startupState).toBe('hidden');
      await expect(choice.getByRole('radio', { name: 'Hidden' })).toHaveAttribute('aria-checked', 'true');

      await showPage(page, 'behavior');
      const chase = page.getByRole('slider', { name: 'Chase length' });
      await expect(chase).toHaveAttribute('min', '1');
      await expect(chase).toHaveAttribute('max', '20');
      await expect(chase).toHaveAttribute('aria-valuetext', '4.5 s');
      await chase.fill('8');
      await expect.poll(async () => (await hook(app, 'getSettings')).behavior.chaseDurationSec).toBe(8);

      await hook(app, 'runAction', 'completeFirstRun');
      // The choice applies at the next start; this session's cat stays where it is.
      expect((await hook(app, 'getStatus')).visible).toBe(true);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    expect(savedGeneral(userData)['startupState']).toBe('hidden');

    const again = await launchApp(userData);
    try {
      await waitForCat(again);
      const s = await hook(again, 'getStatus');
      expect([s.visible, s.paused]).toEqual([false, false]);
      // The cat was hidden before the first tick: no overlay ever starts drawing it.
      await new Promise((r) => setTimeout(r, 1500));
      expect((await hook(again, 'getOverlays')).every((o) => o.visible && !o.active)).toBe(true);
      expect((await hook(again, 'getSettings')).behavior.chaseDurationSec).toBe(8);
    } finally {
      expect(await quitApp(again)).toBe(0);
    }
    const lines = readLogLines(userData);
    expect(lines.filter((l) => l.m === 'started').map((l) => (l.d as { startState?: string } | undefined)?.startState)).toEqual(['visible', 'hidden']);
    expect(lines.filter((l) => l.l === 'error')).toEqual([]);
  });

  test('Start with Windows: the Startup section shows main’s state and only the dedicated actions change it', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      // An unpackaged test build never writes the registry, whatever the real HKCU Run holds.
      const status = (await hook(app, 'getStatus')).loginItem;
      expect(status).toMatchObject({ writable: false, preference: 'unset', enabled: true, disabledBy: null, showNotice: false });

      const page = await settingsPage(app);
      await page.waitForFunction(() => 'desktopCatSettings' in globalThis);
      await showPage(page, 'general');
      const startup = page.getByRole('switch', { name: 'Start with Windows' });
      // The visible switch is the input's label (the input itself is transparent, under the track).
      const startupToggle = startup.locator('xpath=..');
      await expect(startup).toBeChecked();
      await expect(page.getByText('Not available in this build (development or portable).')).toBeVisible();
      await expect(page.getByText('Desktop Cat now starts with Windows')).toBeHidden();

      // The section is main-owned: a renderer patch is refused, malformed actions are rejected.
      const refused = await page.evaluate(async () => {
        const api = (globalThis as unknown as { desktopCatSettings: Record<string, (...a: unknown[]) => Promise<unknown>> }).desktopCatSettings;
        return {
          patch: await api.update!({ loginItem: { preference: 'disabled' } }),
          mixed: await api.update!({ general: { catName: 'Pixel' }, loginItem: { noticeShown: true } }),
          badAction: await api.action!('setLaunchAtLogin'),
        };
      });
      expect(refused).toEqual({
        patch: { ok: false, error: 'loginItem can only be changed through its dedicated actions' },
        mixed: { ok: false, error: 'loginItem can only be changed through its dedicated actions' },
        badAction: { ok: false, message: 'Unknown action.' },
      });
      expect((await hook(app, 'getSettings')).general.catName).toBe('Miso');

      // The switch runs disableLaunchAtLogin: the choice is saved, nothing is written in this build.
      await startupToggle.click();
      await expect.poll(async () => (await hook(app, 'getSettings')).loginItem).toMatchObject({ preference: 'disabled', decidedBy: 'user', disabledBy: 'user' });
      await expect(startup).not.toBeChecked();
      await expect(startup).toBeEnabled();
      await startupToggle.click();
      await expect.poll(async () => (await hook(app, 'getSettings')).loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', disabledBy: null });
      await expect(startup).toBeChecked();

      const dismissed = await page.evaluate(() =>
        (globalThis as unknown as { desktopCatSettings: { action(a: string): Promise<unknown> } }).desktopCatSettings.action('dismissLaunchNotice'),
      );
      expect(dismissed).toEqual({ ok: true });
      expect((await hook(app, 'getSettings')).loginItem.noticeShown).toBe(true);
      await hook(app, 'runAction', 'completeFirstRun');
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    const lines = readLogLines(userData);
    const reconciled = lines.filter((l) => l.m === 'login item reconciled').map((l) => l.d as { rule: string; write: unknown; gate: string[] });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ rule: 'gate-closed', write: null });
    expect(reconciled[0]!.gate).toEqual(expect.arrayContaining(['unpackaged', 'test']));
    expect(lines.filter((l) => l.m === 'login item written' || l.m.startsWith('writing the login item'))).toEqual([]);
    expect(lines.filter((l) => l.l === 'error')).toEqual([]);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')) as { schemaVersion: number; loginItem: Record<string, unknown> };
    expect(saved.schemaVersion).toBe(2);
    expect(saved.loginItem).toMatchObject({ preference: 'enabled', decidedBy: 'user', disabledBy: null, noticeShown: true, registeredPath: null });
  });

  test('"As I left it" brings a paused cat back paused after a restart', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      expect((await hook(app, 'patchSettings', { general: { startupState: 'remember', firstRunCompleted: true } })).ok).toBe(true);
      await hook(app, 'runAction', 'pause');
      await expect.poll(async () => (await hook(app, 'getSettings')).general.rememberedState).toBe('paused');
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    expect(savedGeneral(userData)).toMatchObject({ startupState: 'remember', rememberedState: 'paused' });

    const again = await launchApp(userData);
    try {
      await waitForCat(again);
      const s = await hook(again, 'getStatus');
      expect([s.visible, s.paused]).toEqual([true, true]);
      await hook(again, 'runAction', 'resume');
      await expect.poll(async () => (await hook(again, 'getSettings')).general.rememberedState).toBe('visible');
    } finally {
      expect(await quitApp(again)).toBe(0);
    }
    expect(savedGeneral(userData)['rememberedState']).toBe('visible');
  });

  test('injected sim events and time scale are accepted by the test surface only', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await hook(app, 'injectEvent', { type: 'command.wake' });
      await hook(app, 'setTimeScale', 5);
      expect((await hook(app, 'getHostDebug')).timeScale).toBe(5);
      await expect(hook(app, 'injectEvent', 'nonsense' as never)).rejects.toThrow();
    } finally {
      await quitApp(app);
    }
  });

  test('without DESKTOP_CAT_TEST the test surface does not exist', async ({ userData }) => {
    const app = await launchApp(userData, { DESKTOP_CAT_TEST: '0' });
    try {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
      expect(await app.evaluate(() => '__desktopCatTest' in globalThis)).toBe(false);
    } finally {
      const proc = app.process();
      const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
      await app.evaluate(({ app: electronApp }) => electronApp.quit());
      expect(await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 15_000))])).toBe(0);
    }
  });
});
