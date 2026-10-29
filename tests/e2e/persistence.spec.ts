import fs from 'node:fs';
import path from 'node:path';
import { expect, hook, launchApp, quitApp, readLogLines, test, waitForCat } from './fixtures';

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

test.describe('persistence', () => {
  test('settings persist across a restart', async ({ userData }) => {
    let app = await launchApp(userData);
    try {
      await waitForCat(app);
      const r = await hook(app, 'patchSettings', { appearance: { size: 1.7 }, general: { catName: 'Pixel', firstRunCompleted: true } });
      expect(r.ok).toBe(true);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    expect((readJson(path.join(userData, 'settings.json')).general as { catName: string }).catName).toBe('Pixel');

    app = await launchApp(userData);
    try {
      await waitForCat(app);
      const s = await hook(app, 'getSettings');
      expect(s.appearance.size).toBe(1.7);
      expect(s.general.catName).toBe('Pixel');
      // First run completed: no welcome window this time.
      expect(app.windows().some((p) => p.url().includes('/renderer/settings/'))).toBe(false);
    } finally {
      await quitApp(app);
    }
  });

  test('a v1 settings file is migrated to the current schema (v3) and saved with the main-owned loginItem section', async ({ userData }) => {
    // v1 wrote the whole object, launchAtLogin included; true was an explicit opt-in.
    fs.writeFileSync(
      path.join(userData, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, general: { catName: 'Pixel', launchAtLogin: true, firstRunCompleted: true, startupState: 'visible' }, appearance: { size: 1.3 } }),
    );
    let app = await launchApp(userData);
    try {
      await waitForCat(app);
      const s = await hook(app, 'getSettings');
      expect(s.schemaVersion).toBe(3);
      expect(s.general).not.toHaveProperty('launchAtLogin');
      expect(s.general.catName).toBe('Pixel');
      expect(s.appearance.size).toBe(1.3);
      expect(s.loginItem).toEqual({ preference: 'enabled', decidedBy: 'migration', disabledBy: null, registeredPath: null, v1Value: true, noticeShown: false });
      expect((await hook(app, 'getStatus')).loginItem).toMatchObject({ enabled: true, preference: 'enabled', writable: false, showNotice: false });
      // Any saved change writes the migrated file.
      expect((await hook(app, 'patchSettings', { appearance: { size: 1.4 } })).ok).toBe(true);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    const saved = readJson(path.join(userData, 'settings.json'));
    expect(saved.schemaVersion).toBe(3);
    expect(saved.general as Record<string, unknown>).not.toHaveProperty('launchAtLogin');
    expect(saved.loginItem).toEqual({ preference: 'enabled', decidedBy: 'migration', disabledBy: null, registeredPath: null, v1Value: true, noticeShown: false });

    // The v2 file reads back unchanged (no second migration).
    app = await launchApp(userData);
    try {
      await waitForCat(app);
      expect((await hook(app, 'getSettings')).loginItem).toEqual(saved.loginItem);
      expect((await hook(app, 'getStartup')).settingsLoad).toBe('ok');
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
  });

  test('quit saves the cat and a restart restores its position', async ({ userData }) => {
    let app = await launchApp(userData);
    const before = { x: 0, displayId: null as string | null };
    const startedAt = Date.now();
    try {
      await waitForCat(app);
      await expect.poll(async () => (await hook(app, 'getSimOutput'))?.visible ?? false, { timeout: 20_000 }).toBe(true);
      const out = (await hook(app, 'getSimOutput'))!;
      before.x = out.x;
      before.displayId = out.displayId;
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    const saved = readJson(path.join(userData, 'cat-state.json'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.savedAt as number).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(saved.lastPosition).not.toBeNull();

    app = await launchApp(userData);
    try {
      await waitForCat(app);
      const out = (await hook(app, 'getSimOutput'))!;
      const startup = await hook(app, 'getStartup');
      expect(startup.catLoad).toEqual({ recovered: false, source: 'file' });
      const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => ({ id: String(d.id), width: screen.dipToScreenRect(null, d.workArea).width })));
      const width = displays.find((d) => d.id === before.displayId)?.width ?? 1920;
      expect(out.displayId).toBe(before.displayId);
      expect(Math.abs(out.x - before.x)).toBeLessThan(width * 0.05 + 50);
    } finally {
      await quitApp(app);
    }
  });

  test('corrupt settings and cat files are quarantined and the app still starts', async ({ userData }) => {
    fs.writeFileSync(path.join(userData, 'settings.json'), '{"schemaVersion":1, "general": {"catName": "Bro');
    fs.writeFileSync(path.join(userData, 'cat-state.json'), '\u0000\u0001garbage');
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const startup = await hook(app, 'getStartup');
      expect(startup.settingsLoad).toBe('corrupt');
      expect(startup.catLoad.recovered).toBe(true);
      expect((await hook(app, 'getSettings')).general.catName).toBe('Miso');
      expect((await hook(app, 'getOverlays')).length).toBeGreaterThan(0);
    } finally {
      expect(await quitApp(app)).toBe(0);
    }
    const files = fs.readdirSync(userData);
    expect(files.some((f) => f.startsWith('settings.corrupt-'))).toBe(true);
    expect(files.some((f) => f.startsWith('cat-state.corrupt-'))).toBe(true);
    const rewritten = readJson(path.join(userData, 'settings.json'));
    expect(rewritten.schemaVersion).toBe(3);
    // Damaged settings: this session decided and wrote nothing about launch at sign-in.
    expect(rewritten.loginItem).toMatchObject({ preference: 'unset', decidedBy: 'default', registeredPath: null });
    const reconciled = readLogLines(userData).filter((l) => l.m === 'login item reconciled');
    expect(reconciled.map((l) => (l.d as { rule: string; settings: string }).settings)).toEqual(['corrupt']);
    expect(readJson(path.join(userData, 'cat-state.json')).schemaVersion).toBe(1);
  });

  test('a truncated cat file falls back to the last good backup', async ({ userData }) => {
    let app = await launchApp(userData);
    try {
      await waitForCat(app);
      await hook(app, 'saveNow');
      await hook(app, 'saveNow');
    } finally {
      await quitApp(app);
    }
    const catId = readJson(path.join(userData, 'cat-state.json')).catId as string;
    expect(fs.existsSync(path.join(userData, 'cat-state.json.bak'))).toBe(true);
    fs.writeFileSync(path.join(userData, 'cat-state.json'), '{"schemaVersion":1,"catId":"');

    app = await launchApp(userData);
    try {
      await waitForCat(app);
      const startup = await hook(app, 'getStartup');
      expect(startup.catLoad).toEqual({ recovered: true, source: 'backup' });
    } finally {
      await quitApp(app);
    }
    expect(readJson(path.join(userData, 'cat-state.json')).catId).toBe(catId);
  });
});
