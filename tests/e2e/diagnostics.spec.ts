import fs from 'node:fs';
import path from 'node:path';
import { expect, hook, launchApp, quitApp, readLogLines, settingsPage, test, waitForCat } from './fixtures';

// A syntactically key-like value that is not a real credential.
const FAKE_KEY = 'sk-ant-e2e-NOT-A-REAL-KEY-0123456789abcdef';

test.describe('secrets and diagnostics', () => {
  test('an API key is stored encrypted, never echoed, logged or exported', async ({ userData }) => {
    const app = await launchApp(userData);
    try {
      await waitForCat(app);
      const page = await settingsPage(app);
      await page.waitForFunction(() => 'desktopCatSettings' in globalThis);
      const result = await page.evaluate(async (key) => {
        const api = (globalThis as unknown as { desktopCatSettings: { setApiKey(p: string, k: string | null): Promise<{ ok: boolean; message?: string }>; getState(): Promise<unknown> } }).desktopCatSettings;
        const set = await api.setApiKey('anthropic', key);
        const state = await api.getState();
        return { set, state: JSON.stringify(state) };
      }, FAKE_KEY);
      const encryption = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
      if (encryption) {
        expect(result.set.ok).toBe(true);
        const file = fs.readFileSync(path.join(userData, 'secrets.json'), 'utf8');
        expect(file).not.toContain(FAKE_KEY);
        expect(JSON.parse(result.state).apiKeys).toEqual({ anthropic: true, openaiCompatible: false });
      } else {
        expect(result.set.ok).toBe(false);
        expect(result.set.message).toContain('not available');
      }
      expect(result.state).not.toContain(FAKE_KEY);
      const report = JSON.stringify(await hook(app, 'getDiagnosticsReport'));
      expect(report).not.toContain(FAKE_KEY);
      expect(report).toContain('"kind":"desktop-cat-diagnostics"');
    } finally {
      await quitApp(app);
    }
    const logText = readLogLines(userData)
      .map((l) => JSON.stringify(l))
      .join('\n');
    expect(logText).not.toContain(FAKE_KEY);
    expect(logText).not.toContain('NOT-A-REAL-KEY');
  });
});
