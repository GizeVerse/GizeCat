import { expect, hook, launchApp, OVERLAY_PRELOAD, quitApp, readLogLines, settingsPage, test, waitForCat } from './fixtures';

test.describe('IPC validation', () => {
  test('malformed settings calls are rejected and nothing secret is echoed', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const page = await settingsPage(app);
      await page.waitForFunction(() => 'desktopCatSettings' in globalThis);
      const results = await page.evaluate(async () => {
        const api = (globalThis as unknown as { desktopCatSettings: Record<string, (...a: unknown[]) => Promise<unknown>> }).desktopCatSettings;
        const settle = async (p: () => Promise<unknown>) => {
          try {
            return { value: await p() };
          } catch (e) {
            return { error: String(e) };
          }
        };
        return {
          badRange: await settle(() => api.update!({ appearance: { size: 999 } })),
          badShape: await settle(() => api.update!('not a patch')),
          unknownSection: await settle(() => api.update!({ evil: { x: 1 } })),
          protoPollution: await settle(() => api.update!(JSON.parse('{"__proto__":{"polluted":true}}'))),
          badAction: await settle(() => api.action!('format-c')),
          badKeyProvider: await settle(() => api.setApiKey!('evil-provider', 'abcdefghijk')),
          shortKey: await settle(() => api.setApiKey!('anthropic', 'x')),
          good: await settle(() => api.update!({ behavior: { autonomy: 0.25 } })),
          state: await settle(() => api.getState!()),
        };
      });
      expect(results.badRange).toEqual({ value: { ok: false, error: 'invalid value for appearance.size' } });
      expect((results.badShape as { value: { ok: boolean } }).value.ok).toBe(false);
      expect((results.unknownSection as { value: { ok: boolean } }).value.ok).toBe(false);
      expect((results.badAction as { value: { ok: boolean } }).value.ok).toBe(false);
      expect((results.badKeyProvider as { value: { ok: boolean } }).value.ok).toBe(false);
      expect((results.shortKey as { value: { ok: boolean } }).value.ok).toBe(false);
      expect((results.good as { value: { ok: boolean } }).value.ok).toBe(true);
      const state = (results.state as { value: { apiKeys: unknown; settings: { behavior: { autonomy: number } } } }).value;
      expect(state.apiKeys).toEqual({ anthropic: false, openaiCompatible: false });
      expect(state.settings.behavior.autonomy).toBe(0.25);
      expect(await app.evaluate(() => ({} as Record<string, unknown>)['polluted'] ?? null)).toBeNull();
      expect((await hook(app, 'getSettings')).appearance.size).toBe(1);
    } finally {
      await quitApp(app);
    }
  });

  test('malformed and flooding overlay messages are dropped without crashing', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const overlay = app.windows().find((p) => p.url().includes('/renderer/overlay/'));
      expect(overlay).toBeTruthy();
      await overlay!.waitForFunction(() => 'desktopCat' in globalThis);
      await overlay!.evaluate(() => {
        const api = (globalThis as unknown as { desktopCat: Record<string, (...a: unknown[]) => void> }).desktopCat;
        const tryCall = (fn: () => void) => {
          try {
            fn();
          } catch {
            /* a preload-side rejection is also acceptable */
          }
        };
        tryCall(() => api.sendPointer!({ kind: 'explode', x: 'NaN', y: null, button: 9, buttons: -1, t: -5 }));
        tryCall(() => api.sendPointer!({ kind: 'move', x: 1e12, y: 0, button: 0, buttons: 0, t: 1, extra: true }));
        tryCall(() => api.sendHitRegion!({ rects: Array.from({ length: 50 }, () => ({ x: 0, y: 0, width: 1, height: 1 })) }));
        tryCall(() => api.sendHitRegion!({ rects: [{ x: 0, y: 0, width: -10, height: 'big' }] }));
        tryCall(() => api.reportError!('x'.repeat(10_000)));
        for (let i = 0; i < 2000; i++) tryCall(() => api.sendPointer!({ kind: 'move', x: i % 500, y: 10, button: -1, buttons: 0, t: performance.now() }));
      });
      // Still alive and responsive.
      await expect.poll(async () => (await hook(app, 'getHostDebug')).ticks).toBeGreaterThan(0);
      const before = (await hook(app, 'getHostDebug')).ticks;
      await expect.poll(async () => (await hook(app, 'getHostDebug')).ticks, { timeout: 5000 }).toBeGreaterThan(before);
      expect((await hook(app, 'getLogProblems')).error).toBe(0);
    } finally {
      await quitApp(app);
    }
  });

  test('IPC from a window main did not register is refused', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const rogue = app.waitForEvent('window', { predicate: (p) => p.url().includes('rogue=1'), timeout: 15_000 });
      await app.evaluate(({ BrowserWindow }, preload) => {
        const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
        void w.loadURL('desktop-cat://app/renderer/overlay/index.html?rogue=1');
      }, OVERLAY_PRELOAD);
      const page = await rogue;
      await page.waitForFunction(() => 'desktopCat' in globalThis);
      await page.evaluate(() => {
        const api = (globalThis as unknown as { desktopCat: Record<string, (...a: unknown[]) => void> }).desktopCat;
        api.ready!();
        api.sendPointer!({ kind: 'down', x: 10, y: 10, button: 0, buttons: 1, t: 1 });
      });
      await expect
        .poll(async () => (await hook(app, 'getRecentLogs', 200)).some((e) => e.msg.includes('untrusted sender')), { timeout: 10_000 })
        .toBe(true);
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('rogue=1')) w.destroy();
      });
    } finally {
      await quitApp(app);
    }
    expect(readLogLines(userData).filter((l) => l.l === 'error')).toEqual([]);
  });
});
