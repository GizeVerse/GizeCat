// Adversarial lifecycle stress: rapid pause/resume/hide/show cycles and repeated
// close/reopen must not leak timers, handles or listeners, duplicate overlays, or log
// errors.
import { expect, hook, launchApp, quitApp, readLogLines, test, waitForCat } from './fixtures';
import type { ElectronApplication } from '@playwright/test';

async function resources(app: ElectronApplication) {
  return app.evaluate(({ ipcMain, powerMonitor, screen }) => {
    const info = process.getActiveResourcesInfo();
    return {
      timers: info.filter((r) => r === 'Timeout').length,
      handles: info.length,
      ipcListeners: ipcMain.eventNames().reduce((n, e) => n + ipcMain.listenerCount(e), 0),
      powerListeners: powerMonitor.eventNames().reduce((n, e) => n + powerMonitor.listenerCount(e), 0),
      screenListeners: screen.eventNames().reduce((n, e) => n + screen.listenerCount(e), 0),
    };
  });
}

test.describe('stress', () => {
  test('25 rapid pause/resume/hide/show cycles leave resources and overlays unchanged', async ({ userData }) => {
    test.setTimeout(120_000);
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const overlaysBefore = (await hook(app, 'getOverlays')).length;
      // Let startup timers settle before taking the baseline.
      await new Promise((r) => setTimeout(r, 1500));
      const before = await resources(app);
      for (let i = 0; i < 25; i++) {
        await hook(app, 'runAction', 'pause');
        await hook(app, 'runAction', 'hide');
        await hook(app, 'runAction', 'show');
        await hook(app, 'runAction', 'resume');
      }
      await new Promise((r) => setTimeout(r, 1500));
      const after = await resources(app);
      const status = await hook(app, 'getStatus');
      expect(status).toMatchObject({ visible: true, paused: false });
      expect((await hook(app, 'getOverlays')).length).toBe(overlaysBefore);
      expect(after.ipcListeners).toBe(before.ipcListeners);
      expect(after.powerListeners).toBe(before.powerListeners);
      expect(after.screenListeners).toBe(before.screenListeners);
      // Timers/handles may differ by the one or two in flight at sampling time, never grow with the cycle count.
      expect(after.timers).toBeLessThanOrEqual(before.timers + 2);
      expect(after.handles).toBeLessThanOrEqual(before.handles + 2);
      const problems = await hook(app, 'getLogProblems');
      expect(problems.error).toBe(0);
      expect(await hook(app, 'getHostDebug')).toMatchObject({ tickErrors: 0 });
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
  });

  test('close and reopen three times: one cat, clean exits, no error log lines', async ({ userData }) => {
    test.setTimeout(150_000);
    for (let round = 0; round < 3; round++) {
      const app = await launchApp(userData);
      await waitForCat(app);
      const overlays = await hook(app, 'getOverlays');
      const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().length);
      expect(overlays.length).toBe(displays);
      expect(await quitApp(app)).toBe(0);
    }
    const errors = readLogLines(userData).filter((l) => l.l === 'error');
    expect(errors.map((e) => `${e.s}: ${e.m}`)).toEqual([]);
  });
});
