import type { ElectronApplication } from '@playwright/test';
import { expect, hook, launchApp, quitApp, test, waitForCat } from './fixtures';
import { win32Probe, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT } from './win32Probe';

const center = (r: { x: number; y: number; width: number; height: number }) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function cursorOverCat(app: ElectronApplication): Promise<boolean> {
  const out = await hook(app, 'getSimOutput');
  const cursor = await app.evaluate(({ screen }) => screen.dipToScreenPoint(screen.getCursorScreenPoint()));
  if (!out) return false;
  const b = out.boundsPx;
  return cursor.x >= b.x - 20 && cursor.x <= b.x + b.width + 20 && cursor.y >= b.y - 20 && cursor.y <= b.y + b.height + 20;
}

test.describe('overlay windows', () => {
  test('one transparent, non-focusable, topmost, click-through overlay per display', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({ id: String(d.id), workArea: d.workArea })));
      const overlays = await hook(app, 'getOverlays');
      expect(overlays).toHaveLength(displays.length);
      const overCat = await cursorOverCat(app);
      const probe = win32Probe();
      for (const o of overlays) {
        const d = displays.find((x) => x.id === o.displayId);
        expect(d, `display for overlay ${o.displayId}`).toBeTruthy();
        expect(o.bounds).toEqual(d!.workArea);
        expect(o.visible).toBe(true);
        expect(o.focusable).toBe(false);
        expect(o.alwaysOnTop).toBe(true);
        expect(o.backgroundColor.toLowerCase()).toMatch(/^#0{6}(00)?$|^#00000000$/);
        if (!overCat) expect(o.ignoreMouse).toBe(true);
        const ex = probe.exStyle(o.hwnd);
        expect(ex & WS_EX_TOOLWINDOW, 'hidden from Alt-Tab').toBe(WS_EX_TOOLWINDOW);
        expect(ex & WS_EX_NOACTIVATE, 'never takes focus').toBe(WS_EX_NOACTIVATE);
        expect(ex & WS_EX_TOPMOST, 'topmost').toBe(WS_EX_TOPMOST);
        if (!overCat) expect(ex & WS_EX_TRANSPARENT, 'click-through').toBe(WS_EX_TRANSPARENT);
      }
      // Overlay windows are bundled pages on our scheme only.
      const urls = app.windows().map((p) => p.url());
      for (const u of urls) expect(u.startsWith('desktop-cat://app/renderer/')).toBe(true);
    } finally {
      await quitApp(app);
    }
  });

  test('OS hit-testing passes through the overlay except where the cat is interactive', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSimOutput'))?.visible ?? false, { timeout: 20_000 }).toBe(true);
      const out = (await hook(app, 'getSimOutput'))!;
      const overlays = await hook(app, 'getOverlays');
      const ours = new Set(overlays.map((o) => o.hwnd));
      const home = overlays.find((o) => o.displayId === out.displayId) ?? overlays.find((o) => o.active)!;
      const probe = win32Probe();

      // A point on the cat's overlay far away from the cat.
      const cat = center(out.boundsPx);
      const b = home.boundsPx;
      const far = { x: cat.x < b.x + b.width / 2 ? b.x + b.width - 30 : b.x + 30, y: cat.y < b.y + b.height / 2 ? b.y + b.height - 30 : b.y + 30 };
      await hook(app, 'forceInteractive', false);
      await expect.poll(() => ours.has(probe.rootWindowAt(far.x, far.y) ?? '')).toBe(false);
      await expect.poll(() => ours.has(probe.rootWindowAt(cat.x, cat.y) ?? '')).toBe(false);

      await hook(app, 'forceInteractive', true);
      await expect.poll(() => ours.has(probe.rootWindowAt(cat.x, cat.y) ?? '')).toBe(true);
      await expect.poll(() => probe.rootWindowAt(far.x, far.y)).toBe(home.hwnd);
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => !o.ignoreMouse)).toBe(true);

      await hook(app, 'forceInteractive', null);
      // Back to routing: far from the cat the desktop underneath receives the mouse again.
      await expect.poll(() => ours.has(probe.rootWindowAt(far.x, far.y) ?? '')).toBe(false);
    } finally {
      await quitApp(app);
    }
  });

  test('interactions disabled keeps every overlay click-through even when forced routing is off', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      expect((await hook(app, 'patchSettings', { interaction: { enabled: false } })).ok).toBe(true);
      await expect.poll(async () => (await hook(app, 'getOverlays')).every((o) => o.ignoreMouse)).toBe(true);
      expect((await hook(app, 'getStatus')).interactionsEnabled).toBe(false);
    } finally {
      await quitApp(app);
    }
  });
});
