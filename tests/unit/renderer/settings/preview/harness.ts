// Visual preview harness for the settings window. Runs the REAL preload
// (src/preload/settings.ts) and the real page against a fake, in-memory main
// process, then saves screenshots of every page in light and dark mode.
//
// Run from the repository root (one line):
//   node scripts/with-lock.mjs settings-preview -- "npx esbuild src/renderer/settings/main.ts --bundle --format=esm
//     --platform=browser --target=chrome150 --outfile=out/preview/harness/app/renderer/settings/main.js
//   && npx esbuild src/preload/settings.ts --bundle --format=cjs --platform=browser --target=chrome150
//     --external:electron --outfile=out/preview/harness/preload.cjs
//   && npx esbuild tests/unit/renderer/settings/preview/harness.ts --bundle --format=cjs --platform=node
//     --target=node24 --external:electron --outfile=out/preview/harness/main.cjs
//   && npx electron out/preview/harness/main.cjs"
// Screenshots land in out/preview/settings-*.png. This file lives in the web
// tsconfig, which has no Node/Electron typings on purpose, so the few Electron and
// Node APIs it needs are typed locally below.
import type { SettingsAction, SettingsViewState } from '../../../../../src/shared/ipc';
import { IPC } from '../../../../../src/shared/ipc';
import { applySettingsPatch } from '../../../../../src/shared/settings';
import { previewBehaviorProfile, previewSurfaceDiagnostics, previewView } from './fixture';

// ---------------------------------------------------------------------------
// Minimal local typings

interface NativeImage {
  toPNG(): Uint8Array;
  toDataURL(): string;
  getSize(): { width: number; height: number };
}
interface WebContents {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(rect?: undefined, opts?: { stayHidden?: boolean }): Promise<NativeImage>;
  send(channel: string, payload: unknown): void;
  on(event: 'console-message', cb: (e: { level: string; message: string; lineNumber: number; sourceId: string }) => void): void;
  on(event: 'preload-error', cb: (e: unknown, path: string, error: Error) => void): void;
}
interface BrowserWindowInstance {
  webContents: WebContents;
  loadURL(url: string): Promise<void>;
  setContentSize(w: number, h: number): void;
  getContentSize(): [number, number];
  destroy(): void;
}
interface ElectronMain {
  app: {
    setPath(name: string, value: string): void;
    whenReady(): Promise<void>;
    exit(code: number): void;
    on(event: string, cb: () => void): void;
  };
  BrowserWindow: new (opts: Record<string, unknown>) => BrowserWindowInstance;
  nativeTheme: { themeSource: 'system' | 'light' | 'dark' };
  ipcMain: { handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void };
  protocol: {
    registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void;
    handle(scheme: string, handler: (req: { url: string }) => Response): void;
  };
  nativeImage: { createFromBitmap(buffer: Uint8Array, opts: { width: number; height: number }): NativeImage };
}
interface NodeFs {
  mkdirSync(p: string, o: { recursive: true }): void;
  writeFileSync(p: string, data: Uint8Array | string): void;
  readFileSync(p: string): Uint8Array;
  copyFileSync(a: string, b: string): void;
  existsSync(p: string): boolean;
  mkdtempSync(prefix: string): string;
  rmSync(p: string, o: { recursive: true; force: true }): void;
}
interface NodePath {
  join(...p: string[]): string;
  resolve(...p: string[]): string;
  extname(p: string): string;
  normalize(p: string): string;
  sep: string;
}
declare const require: (id: string) => unknown;
declare const process: { cwd(): string; versions: Record<string, string | undefined>; argv: string[] };
declare const Buffer: { from(data: Uint8Array): Uint8Array<ArrayBuffer> };

const electron = require('electron') as ElectronMain;
const fs = require('node:fs') as NodeFs;
const path = require('node:path') as NodePath;
const os = require('node:os') as { tmpdir(): string };
const { app, BrowserWindow, nativeTheme, ipcMain, protocol, nativeImage } = electron;

// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const HARNESS = path.join(ROOT, 'out', 'preview', 'harness');
const SERVE = path.join(HARNESS, 'app');
const SHOTS = path.join(ROOT, 'out', 'preview');
const PAGES = [
  'welcome',
  'companion',
  'general',
  'appearance',
  'personality',
  'behavior',
  'interaction',
  'audio',
  'accessibility',
  'journal',
  'privacy',
  'ai',
  'diagnostics',
  'about',
] as const;
const WIDTH = 1040;
const HEIGHT = 760;
const MAX_HEIGHT = 3200;
const MIN_W = 760;
const MIN_H = 560;
const NOW = Date.now();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-settings-preview-'));
app.setPath('userData', tmp);
protocol.registerSchemesAsPrivileged([{ scheme: 'desktop-cat', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const watchdog = setTimeout(() => {
  console.error('harness: watchdog timeout');
  app.exit(2);
}, 180_000);

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

let view: SettingsViewState = previewView(NOW, { electron: process.versions.electron ?? '?', chrome: process.versions.chrome ?? '?', node: process.versions.node ?? '?' });
let win: BrowserWindowInstance | null = null;
const problems: string[] = [];
const updates: unknown[] = [];
const REJECTED_SHORTCUT = 'Control+Alt+Shift+X';

function broadcast(): void {
  win?.webContents.send(IPC.settingsStateChanged, view);
}

function previewImage(): string {
  const w = 192;
  const h = 108;
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = 40 + (x * 60) / w;
      let g = 70 + (y * 50) / h;
      let b = 120 + (x * 40) / w;
      const inWindow = x > 20 && x < 130 && y > 14 && y < 84;
      if (inWindow) [r, g, b] = y < 24 ? [60, 60, 66] : [235, 236, 240];
      if (inWindow && y > 30 && y % 8 < 2 && x > 28 && x < 28 + ((y * 7) % 80)) [r, g, b] = [120, 130, 150];
      const masked = x > 140 && x < 176 && y > 70 && y < 100;
      if (masked) [r, g, b] = [128, 128, 128];
      px[i] = b;
      px[i + 1] = g;
      px[i + 2] = r;
      px[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(Buffer.from(px), { width: w, height: h }).toDataURL();
}

function act(action: SettingsAction): { ok: boolean; message?: string } {
  const s = view.settings;
  const st = view.status;
  switch (action) {
    case 'pause':
    case 'resume':
      st.paused = action === 'pause';
      break;
    case 'hide':
    case 'show':
      st.visible = action === 'show';
      break;
    case 'privacyPause':
    case 'privacyResume':
      s.perception.paused = action === 'privacyPause';
      st.perception.paused = s.perception.paused;
      break;
    case 'grantLocalStatsConsent':
      s.perception.visualMode = 'local-stats';
      s.perception.consentAt = new Date(NOW).toISOString();
      st.perception.mode = 'local-stats';
      break;
    case 'grantAiConsent':
      s.perception.visualMode = 'ai';
      s.perception.consentAt = new Date(NOW).toISOString();
      st.perception.mode = s.ai.provider === 'anthropic' ? 'ai-cloud' : 'ai-local';
      break;
    case 'revokeConsent':
      s.perception.visualMode = 'off';
      s.perception.consentAt = null;
      st.perception.mode = 'off';
      break;
    case 'completeFirstRun':
      s.general.firstRunCompleted = true;
      break;
    case 'exportDiagnostics':
      return { ok: true, message: 'Saved to C:\\Users\\preview\\Desktop\\desktop-cat-diagnostics.zip' };
    case 'showSurfaceOutlines':
    case 'hideSurfaceOutlines':
      st.surfaceOutlines = action === 'showSurfaceOutlines';
      break;
    case 'startLaserMode':
    case 'stopLaserMode':
      if (view.companion) view.companion.laserActive = action === 'startLaserMode';
      break;
    case 'pauseEvents':
    case 'resumeEvents':
      if (view.companion) view.companion.eventsPaused = action === 'pauseEvents';
      break;
    case 'clearJournal':
      journal.length = 0;
      break;
    case 'resetPersonality':
    case 'clearHistory':
    case 'openLogsFolder':
    case 'callCat':
    case 'quit':
      break;
  }
  broadcast();
  return { ok: true };
}

/** Living Companion preview data: three journal lines (oldest first, as main returns them) and a live status. */
const journal: Array<{ id: string; at: number; outcome: string }> = [
  { id: 'butterflyEncounter', at: NOW - 3 * 24 * 3_600_000, outcome: 'watched' },
  { id: 'boxAppears', at: NOW - 26 * 3_600_000, outcome: 'entered' },
  { id: 'miniTsunami', at: NOW - 2 * 3_600_000, outcome: 'hopped' },
];

function previewCompanion(): NonNullable<SettingsViewState['companion']> {
  return { mood: 'relaxed', activity: 'resting', personality: 'curious', personalityIsAuto: true, event: null, nextEventInMs: 14 * 60_000, eventsPaused: false, laserActive: false };
}

function installIpc(): void {
  ipcMain.handle(IPC.settingsGetJournal, () => [...journal]);
  ipcMain.handle(IPC.settingsGetState, () => view);
  ipcMain.handle(IPC.settingsUpdate, (_e, patch) => {
    updates.push(patch);
    if ((patch as { general?: { toggleShortcut?: string } }).general?.toggleShortcut === REJECTED_SHORTCUT) return { ok: false, error: 'shortcut already in use' };
    const res = applySettingsPatch(view.settings, patch);
    if (res.ok) {
      view = { ...view, settings: res.settings };
      broadcast();
    }
    return res;
  });
  ipcMain.handle(IPC.settingsAction, (_e, a) => act(a as SettingsAction));
  ipcMain.handle(IPC.settingsSetApiKey, (_e, payload) => {
    const p = payload as { provider: string; key: string | null };
    if (p.provider === 'anthropic') view.apiKeys.anthropic = p.key !== null;
    else view.apiKeys.openaiCompatible = p.key !== null;
    broadcast();
    return { ok: true };
  });
  ipcMain.handle(IPC.settingsTestAi, () => ({
    ok: true,
    message: '',
    latencyMs: 1240,
    report: { scene: 'code', energy: 'calm', interest: 0.4, reaction: 'sit_nearby', caption: 'A code editor with a dark theme' },
  }));
  ipcMain.handle(IPC.settingsListModels, () => ({ ok: true, models: ['example-vision-a', 'example-vision-b:small'] }));
  ipcMain.handle(IPC.settingsGetSurfaceDiagnostics, () => previewSurfaceDiagnostics(NOW));
  ipcMain.handle(IPC.settingsGetBehaviorProfile, () => previewBehaviorProfile(NOW));
  ipcMain.handle(IPC.settingsPreviewPerception, () => ({
    ok: true,
    imageDataUrl: previewImage(),
    features: { brightness: 0.62, contrast: 0.41, colorfulness: 0.28, edgeDensity: 0.17, changeFraction: 0.08, motion: 0.03, changeBox: null },
    events: ['bright', 'quiet'],
  }));
}

function serve(): void {
  const dir = path.join(SERVE, 'renderer', 'settings');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['index.html', 'styles.css']) fs.copyFileSync(path.join(ROOT, 'src', 'renderer', 'settings', f), path.join(dir, f));
  protocol.handle('desktop-cat', (req) => {
    const url = new URL(req.url);
    const file = path.normalize(path.join(SERVE, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SERVE + path.sep) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Buffer.from(fs.readFileSync(file)), { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' } });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function js<T>(code: string): Promise<T> {
  if (!win) throw new Error('no window');
  return (await win.webContents.executeJavaScript(code)) as T;
}

async function shot(name: string, fullHeight: boolean): Promise<void> {
  if (!win) return;
  await sleep(200);
  if (fullHeight) {
    const h = await js<number>(`(() => { const c = document.querySelector('.content'); return c ? c.scrollHeight : document.body.scrollHeight; })()`);
    win.setContentSize(WIDTH, Math.min(MAX_HEIGHT, Math.max(HEIGHT, Math.ceil(h))));
    await sleep(250);
  }
  const img = await win.webContents.capturePage(undefined, { stayHidden: true });
  fs.writeFileSync(path.join(SHOTS, `settings-${name}.png`), Buffer.from(img.toPNG()));
  const size = img.getSize();
  console.log(`harness: wrote settings-${name}.png ${size.width}x${size.height}`);
  if (fullHeight) {
    win.setContentSize(WIDTH, HEIGHT);
    await sleep(100);
  }
}

async function goto(page: string): Promise<void> {
  await js(`location.hash = '#${page}'`);
  await sleep(120);
}

async function openWindow(theme: 'light' | 'dark', w: number, h: number): Promise<void> {
  nativeTheme.themeSource = theme;
  view = previewView(NOW, { electron: process.versions.electron ?? '?', chrome: process.versions.chrome ?? '?', node: process.versions.node ?? '?' });
  view.companion = previewCompanion();
  win = new BrowserWindow({
    show: false,
    width: w,
    height: h,
    useContentSize: true,
    backgroundColor: theme === 'dark' ? '#202020' : '#f3f3f3',
    webPreferences: { preload: path.join(HARNESS, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') problems.push(`[${theme}] console ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on('preload-error', (_e, p, err) => problems.push(`[${theme}] preload error ${p}: ${err.message}`));
  await win.loadURL('desktop-cat://app/renderer/settings/index.html#welcome');
  await sleep(400);
  // Proves the console oracle works before trusting "0 problems".
  await js(`console.error('harness-selfcheck')`);
  await sleep(100);
  const idx = problems.findIndex((p) => p.includes('harness-selfcheck'));
  if (idx >= 0) problems.splice(idx, 1);
  else problems.push(`[${theme}] console capture is not working`);
  const bridge = await js<string>(`typeof window.desktopCatSettings + ':' + Object.keys(window).filter((k) => k.startsWith('desktopCat')).join(',')`);
  if (bridge !== 'object:desktopCatSettings') problems.push(`[${theme}] unexpected bridge surface: ${bridge}`);
}

async function overflowCheck(theme: 'light' | 'dark'): Promise<void> {
  await openWindow(theme, MIN_W, MIN_H);
  for (const p of PAGES) {
    await goto(p);
    const r = await js<{ doc: number; win: number; content: number; contentClient: number; offenders: string[] }>(`(() => {
      const c = document.querySelector('.content');
      const limit = c.getBoundingClientRect().right + 0.5;
      const offenders = [...document.querySelectorAll('.page:not([hidden]) *')]
        .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > limit; })
        .slice(0, 5).map((el) => el.tagName.toLowerCase() + '.' + String(el.className));
      return { doc: document.documentElement.scrollWidth, win: window.innerWidth, content: c.scrollWidth, contentClient: c.clientWidth, offenders };
    })()`);
    const over = r.doc > r.win || r.content > r.contentClient || r.offenders.length > 0;
    console.log(`harness: ${theme} ${MIN_W}x${MIN_H} ${p}: ${over ? 'OVERFLOW ' + JSON.stringify(r) : 'ok'}`);
    if (over) problems.push(`overflow on ${p} at ${MIN_W}px: ${JSON.stringify(r)}`);
  }
  await goto('general');
  await shot(`min-general-${theme}`, false);
  await goto('privacy');
  await shot(`min-privacy-${theme}`, false);
  win?.destroy();
  win = null;
}

/** End-to-end behaviour through the real preload: slider debounce and revert on rejection. */
async function behaviourChecks(): Promise<void> {
  await goto('appearance');
  updates.length = 0;
  await js(`(() => {
    const s = document.querySelector('.page:not([hidden]) .slider-input');
    for (const v of ['1.1', '1.2', '1.3', '1.4', '1.5']) { s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(80);
  const before = updates.length;
  await sleep(400);
  const sizePatches = JSON.stringify(updates);
  const debounced = before === 0 && updates.length === 1 && sizePatches === JSON.stringify([{ appearance: { size: 1.5 } }]);
  console.log(`harness: debounce check ${debounced ? 'ok' : 'FAILED'} (${before} before 150 ms, then ${sizePatches})`);
  if (!debounced) problems.push(`slider debounce: ${sizePatches}`);
  if (view.settings.appearance.size !== 1.5) problems.push('slider value did not reach main');

  await goto('general');
  updates.length = 0;
  await js(`(() => {
    const input = [...document.querySelectorAll('.page:not([hidden]) .text-input')].find((i) => i.value.includes('+'));
    input.focus(); input.value = '${REJECTED_SHORTCUT}'; input.dispatchEvent(new Event('change', { bubbles: true })); input.blur();
  })()`);
  await sleep(300);
  const after = await js<{ value: string; error: string; invalid: boolean }>(`(() => {
    const input = [...document.querySelectorAll('.page:not([hidden]) .text-input')].find((i) => i.placeholder.includes('+'));
    const row = input.closest('.row');
    return { value: input.value, error: row.querySelector('.row-error').textContent, invalid: input.getAttribute('aria-invalid') === 'true' };
  })()`);
  const reverted = after.value === 'Control+Alt+Shift+C' && after.error.includes('shortcut already in use') && after.invalid;
  console.log(`harness: reject/revert check ${reverted ? 'ok' : 'FAILED'} ${JSON.stringify(after)}`);
  if (!reverted) problems.push(`revert on rejection: ${JSON.stringify(after)}`);

  // v1.2 Personality: a preset card sends one multi-section patch; a governed slider sends its
  // value with activityPreset 'custom', and the Custom card names the closest preset.
  await goto('behavior');
  updates.length = 0;
  await js(`document.querySelector('.page:not([hidden]) .preset-calm').click()`);
  await sleep(300);
  const presetPatches = JSON.stringify(updates);
  const presetOk =
    updates.length === 1 &&
    view.settings.behavior.activityPreset === 'calm' &&
    view.settings.behavior.autonomy === 0.35 &&
    view.settings.interaction.reactionIntensity === 0.35 &&
    (await js<string>(`document.querySelector('.page:not([hidden]) .preset-calm').getAttribute('aria-checked')`)) === 'true';
  console.log(`harness: preset check ${presetOk ? 'ok' : 'FAILED'} ${presetPatches}`);
  if (!presetOk) problems.push(`preset card: ${presetPatches}`);
  updates.length = 0;
  await js(`(() => {
    const s = document.querySelector('.page:not([hidden]) .slider-input');
    s.value = '0.5'; s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  const custom = await js<{ checked: string | null; title: string }>(`(() => {
    const c = document.querySelector('.page:not([hidden]) .preset-custom');
    return { checked: c.getAttribute('aria-checked'), title: c.querySelector('.option-title').textContent };
  })()`);
  const customOk =
    JSON.stringify(updates) === JSON.stringify([{ behavior: { autonomy: 0.5, activityPreset: 'custom' } }]) &&
    view.settings.behavior.activityPreset === 'custom' &&
    custom.checked === 'true' &&
    custom.title === 'Custom (closest: Calm)';
  console.log(`harness: custom check ${customOk ? 'ok' : 'FAILED'} ${JSON.stringify(updates)} ${JSON.stringify(custom)}`);
  if (!customOk) problems.push(`custom preset: ${JSON.stringify(updates)} ${JSON.stringify(custom)}`);
  await js(`document.querySelector('.page:not([hidden]) .preset-playful').click()`);
  await sleep(300);
  if (view.settings.behavior.activityPreset !== 'playful') problems.push('back to Playful failed');
}

async function run(theme: 'light' | 'dark'): Promise<void> {
  await openWindow(theme, WIDTH, HEIGHT);
  for (const p of PAGES) {
    await goto(p);
    await shot(`${p}-${theme}`, true);
  }
  // v1.2: the Behaviour page with Fine-tune open.
  await goto('behavior');
  await js(`document.querySelector('.page:not([hidden]) .fine-tune').open = true`);
  await shot(`behavior-finetune-${theme}`, true);
  await js(`document.querySelector('.page:not([hidden]) .fine-tune').open = false`);
  if (theme === 'light') await behaviourChecks();
  // Consent dialog for local statistics.
  await goto('privacy');
  await js(`document.querySelector('.option-local-stats').click()`);
  await sleep(250);
  await shot(`privacy-consent-${theme}`, false);
  await js(`document.querySelector('dialog.modal .btn-accent').click()`);
  await sleep(300);
  // Cloud AI state with a preview.
  view.settings.ai.provider = 'anthropic';
  view.settings.perception.visualMode = 'ai';
  view.settings.perception.consentAt = new Date(NOW - 3 * 60_000).toISOString();
  view.status.perception = {
    mode: 'ai-cloud',
    paused: false,
    blockedReason: null,
    lastCaptureAt: NOW - 95_000,
    capturesThisHour: 4,
    aiProviderLabel: 'Anthropic (claude-haiku-5-5)',
    lastError: null,
  };
  broadcast();
  await sleep(150);
  await js(`document.querySelector('.preview')?.closest('.row')?.querySelector('.btn-accent')?.click()`);
  await sleep(400);
  await shot(`privacy-cloud-${theme}`, true);
  // AI page with cloud provider, a stored key and a test result.
  view.apiKeys.anthropic = true;
  broadcast();
  await goto('ai');
  await js(`[...document.querySelectorAll('.page:not([hidden]) .btn-accent')].find((b) => b.textContent.includes('Test'))?.click()`);
  await sleep(400);
  await shot(`ai-cloud-${theme}`, true);
  win?.destroy();
  win = null;
}

async function main(): Promise<void> {
  await app.whenReady();
  installIpc();
  serve();
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) await run(theme);
  for (const theme of ['light', 'dark'] as const) await overflowCheck(theme);
}

app.on('window-all-closed', () => undefined);
main()
  .then(() => {
    for (const p of problems) console.log(`harness: PROBLEM ${p}`);
    console.log(`harness: done, ${problems.length} problem(s)`);
    clearTimeout(watchdog);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Chromium may still hold files in the temp profile; the OS temp cleaner removes it.
    }
    app.exit(problems.length === 0 ? 0 : 1);
  })
  .catch((e: unknown) => {
    console.error('harness: failed', e);
    app.exit(1);
  });
