// Shared helpers for the Electron E2E suite. Every test gets its own userData
// directory (which also isolates the single-instance lock) and talks to the app
// through the DESKTOP_CAT_TEST hook object in the main process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { DesktopCatTestApi } from '../../src/main/testHooks';

export const ROOT = path.resolve(__dirname, '..', '..');
/** DESKTOP_CAT_E2E_MAIN points the suite at another build (e.g. a scratch out/ directory). */
export const MAIN_ENTRY = process.env.DESKTOP_CAT_E2E_MAIN ? path.resolve(process.env.DESKTOP_CAT_E2E_MAIN) : path.join(ROOT, 'out', 'main', 'index.js');
export const OVERLAY_PRELOAD = path.join(path.dirname(MAIN_ENTRY), '..', 'preload', 'overlay.js');

export function electronBinary(): string {
  const rel = fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  return path.join(ROOT, 'node_modules', 'electron', 'dist', rel);
}

export function testEnv(userData: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, DESKTOP_CAT_TEST: '1', DESKTOP_CAT_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '0', ...extra };
}

export async function launchApp(userData: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  if (!fs.existsSync(MAIN_ENTRY)) throw new Error(`${MAIN_ENTRY} missing: run "npm run build" first`);
  return electron.launch({ args: [MAIN_ENTRY], cwd: ROOT, env: testEnv(userData, extraEnv), timeout: 45_000 });
}

type Api = Omit<DesktopCatTestApi, 'installedAt'>;
type ApiFn<K extends keyof Api> = Api[K] extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;

/** Calls a test hook in the main process. */
export async function hook<K extends keyof Api>(app: ElectronApplication, name: K, ...args: ApiFn<K>['args']): Promise<ApiFn<K>['result']> {
  const call: { name: string; args: unknown[] } = { name, args };
  const result: unknown = await app.evaluate(async (_electron, c: { name: string; args: unknown[] }) => {
    const api = (globalThis as Record<string, unknown>)['__desktopCatTest'] as Record<string, (...a: unknown[]) => unknown> | undefined;
    if (!api) throw new Error('test hooks not installed (DESKTOP_CAT_TEST=1?)');
    const fn = api[c.name];
    if (typeof fn !== 'function') throw new Error(`no test hook ${c.name}`);
    return await fn(...c.args);
  }, call);
  return result;
}

/** Waits until every display has a ready overlay and the cat has produced output. */
export async function waitForCat(app: ElectronApplication): Promise<void> {
  const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().length);
  await expect
    .poll(async () => {
      const overlays = await hook(app, 'getOverlays');
      const out = await hook(app, 'getSimOutput');
      return overlays.length === displays && overlays.every((o) => o.ready && o.visible) && out !== null;
    }, { timeout: 30_000 })
    .toBe(true);
}

/** Quits through the normal quit path and resolves with the exit code. */
export async function quitApp(app: ElectronApplication, timeoutMs = 15_000): Promise<number | null> {
  const proc = app.process();
  if (proc.exitCode !== null) return proc.exitCode;
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  // The evaluate may never resolve because the process exits underneath it.
  void hook(app, 'quit').catch(() => undefined);
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))]);
  if (code === 'timeout') {
    proc.kill();
    throw new Error('app did not exit within the quit timeout');
  }
  return code;
}

export async function settingsPage(app: ElectronApplication): Promise<Page> {
  const existing = app.windows().find((p) => p.url().includes('/renderer/settings/'));
  if (existing) return existing;
  const next = app.waitForEvent('window', { predicate: (p) => p.url().includes('/renderer/settings/'), timeout: 15_000 });
  await hook(app, 'openSettings');
  const page = await next;
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export interface LogLine {
  t: string;
  l: 'error' | 'warn' | 'info' | 'debug';
  s: string;
  m: string;
  d?: unknown;
}

export function readLogLines(userData: string): LogLine[] {
  const file = path.join(userData, 'logs', 'main.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}

export const test = base.extend<{ userData: string }>({
  // eslint-disable-next-line no-empty-pattern
  userData: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  },
});

export { expect };
