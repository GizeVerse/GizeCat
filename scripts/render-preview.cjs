// Visual QA for the overlay renderer.
//
// Contact sheets (every clip, skin, style, scale, light/dark, faces, emotes, transitions):
//   node scripts/with-lock.mjs preview -- npx electron scripts/render-preview.cjs [--only=faces,clips-1] [--dpr=1] [--bench]
//
// End-to-end overlay smoke (the real preload + overlay runtime in an offscreen window,
// fed with synthetic CatRenderState snapshots; checks hit-region IPC and captures frames):
//   node scripts/with-lock.mjs preview -- npx electron scripts/render-preview.cjs --overlay
//
// Writes PNGs to out/preview/. Uses a temporary userData dir and software rendering, never
// sends OS input, and always exits (hard timeout).
'use strict';
const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const pageSrc = path.join(__dirname, 'preview-page');
const pageOut = path.join(root, 'out', 'preview-page');
const overlayOut = path.join(root, 'out', 'preview-overlay');
const outDir = path.join(root, 'out', 'preview');
const SCHEME = 'dcat-preview';

const argv = process.argv.slice(2);
const arg = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const only = (arg('only') || '').split(',').filter(Boolean);
const dpr = Number(arg('dpr') || '1') || 1;
const doBench = argv.includes('--bench');
const doOverlay = argv.includes('--overlay');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-preview-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const killer = setTimeout(() => {
  console.error('render-preview: timed out');
  app.exit(2);
}, 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bundleSheets() {
  const esbuild = require('esbuild');
  fs.mkdirSync(pageOut, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(pageSrc, 'preview.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome150',
    outfile: path.join(pageOut, 'preview.js'),
    define: { __DEV__: 'true', __APP_VERSION__: '"preview"' },
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(pageSrc, 'index.html'), path.join(pageOut, 'index.html'));
}

async function renderSheets() {
  await bundleSheets();
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[page] ${e.message}`);
  });
  await win.loadFile(path.join(pageOut, 'index.html'));
  const names = await win.webContents.executeJavaScript('window.__preview.list()');
  for (const name of names) {
    if (only.length && !only.includes(name)) continue;
    const t0 = Date.now();
    const url = await win.webContents.executeJavaScript(`window.__preview.render(${JSON.stringify(name)}, ${dpr})`);
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(String(url).slice(String(url).indexOf(',') + 1), 'base64'));
    console.log(`render-preview: ${path.relative(root, file)} (${Date.now() - t0} ms)`);
  }
  if (doBench) {
    for (const style of ['smooth', 'pixel']) {
      const r = await win.webContents.executeJavaScript(`window.__preview.bench(1200, ${JSON.stringify(style)})`);
      console.log(`render-preview: bench ${style} (software raster) avg ${r.avgMs.toFixed(3)} ms, p95 ${r.p95Ms.toFixed(3)} ms per frame`);
    }
  }
  win.destroy();
}

// ---------------------------------------------------------------------------
// Overlay smoke

async function bundleOverlay() {
  const esbuild = require('esbuild');
  fs.rmSync(overlayOut, { recursive: true, force: true });
  await esbuild.build({
    entryPoints: { 'preload/overlay': path.join(root, 'src/preload/overlay.ts') },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'chrome150',
    external: ['electron'],
    outdir: overlayOut,
    logLevel: 'warning',
  });
  await esbuild.build({
    entryPoints: { 'renderer/overlay/main': path.join(root, 'src/renderer/overlay/main.ts') },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome150',
    outdir: overlayOut,
    logLevel: 'warning',
  });
  for (const f of ['index.html', 'overlay.css']) {
    fs.copyFileSync(path.join(root, 'src/renderer/overlay', f), path.join(overlayOut, 'renderer/overlay', f));
  }
}

function makeState(seq, t, over) {
  return {
    seq,
    t,
    x: 120,
    y: 300,
    snap: false,
    scale: 1.5,
    facing: 1,
    state: 'walking',
    clip: 'walk',
    clipStartedAt: 0,
    speed: 0.7,
    vy: 0,
    look: null,
    arousal: 0.3,
    contentment: 0.6,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...over,
  };
}

function checkRegion(region) {
  if (!region || !Array.isArray(region.rects) || region.rects.length > 8) return 'bad shape';
  for (const r of region.rects) {
    for (const k of ['x', 'y', 'width', 'height']) if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) return `non-finite ${k}`;
    if (r.width < 0 || r.height < 0 || r.width > 5000 || r.height > 5000) return 'size out of range';
  }
  return null;
}

async function overlaySmoke() {
  await bundleOverlay();
  protocol.handle(SCHEME, (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(overlayOut, rel));
    if (!file.startsWith(overlayOut)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(overlayOut, 'preload/overlay.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setFrameRate(60);
  const regions = [];
  const errors = [];
  const consoleErrors = [];
  let ready = false;
  const fromWin = (e) => e.sender === win.webContents;
  ipcMain.on('overlay:ready', (e) => {
    if (fromWin(e)) ready = true;
  });
  ipcMain.on('overlay:hit-region', (e, r) => {
    if (fromWin(e)) regions.push({ at: Date.now(), r });
  });
  ipcMain.on('overlay:error', (e, m) => {
    if (fromWin(e)) errors.push(m);
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') consoleErrors.push(e.message);
  });

  await win.loadURL(`${SCHEME}://app/renderer/overlay/index.html`);
  for (let i = 0; i < 100 && !ready; i++) await sleep(20);
  if (!ready) throw new Error('overlay never sent overlay:ready');
  const exposed = await win.webContents.executeJavaScript(
    "JSON.stringify({ keys: Object.keys(window.desktopCat || {}).sort(), ipc: typeof window.ipcRenderer, req: typeof window.require, proc: typeof window.process })",
  );
  win.webContents.send('overlay:config', { displayId: 'smoke', scaleFactor: 1, debug: false });

  const t0 = Date.now();
  let seq = 0;
  const shots = [];
  const send = (over) => {
    const t = Date.now() - t0 + 10000;
    win.webContents.send('overlay:render', makeState(++seq, t, over));
  };
  const capture = async (name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, `overlay-smoke-${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    shots.push(path.relative(root, file));
  };
  // Phase 1: walk right for 1.4 s at 30 Hz; phase 2: sit with a heart; phase 3: debug + pixel; phase 4: hide.
  const startWalk = Date.now();
  while (Date.now() - startWalk < 1400) {
    const k = (Date.now() - startWalk) / 1400;
    send({ x: 120 + 300 * k, clip: 'walk', clipStartedAt: 10000 });
    await sleep(33);
  }
  await capture('walk');
  const sitAt = Date.now() - t0 + 10000;
  for (let i = 0; i < 25; i++) {
    send({ x: 420, clip: 'sit', state: 'idle', speed: 0, clipStartedAt: sitAt, emote: 'heart', emoteStartedAt: sitAt + 200, look: { x: 520, y: 200 } });
    await sleep(33);
  }
  await capture('sit-heart');
  win.webContents.send('overlay:config', { displayId: 'smoke', scaleFactor: 1, debug: true });
  for (let i = 0; i < 15; i++) {
    send({ x: 420, clip: 'sit', state: 'idle', speed: 0, clipStartedAt: sitAt, style: 'pixel', skin: 'calico', opacity: 0.8 });
    await sleep(33);
  }
  await capture('pixel-debug');
  const visibleRegions = regions.length;
  const lastVisible = regions.at(-1);
  for (let i = 0; i < 10; i++) {
    send({ x: 420, clip: 'sit', visible: false, opacity: 0 });
    await sleep(33);
  }
  await sleep(300);
  const lastAfterHide = regions.at(-1);

  const problems = [];
  if (visibleRegions === 0) problems.push('no hit region while visible');
  for (const { r } of regions) {
    const bad = checkRegion(r);
    if (bad) problems.push(`invalid hit region: ${bad}`);
  }
  if (!lastVisible || lastVisible.r.rects.length === 0) problems.push('last visible hit region is empty');
  if (!lastAfterHide || lastAfterHide.r.rects.length !== 0) problems.push('hit region not cleared after hide');
  // Rate limit: no two sends closer than ~60 ms (15 Hz) except the immediate clear.
  let minGap = Infinity;
  for (let i = 1; i < regions.length; i++) if (regions[i].r.rects.length > 0) minGap = Math.min(minGap, regions[i].at - regions[i - 1].at);
  if (minGap < 55) problems.push(`hit region sent too often (min gap ${minGap} ms)`);
  const api = JSON.parse(exposed);
  const expectedKeys = ['onConfig', 'onRender', 'ready', 'reportError', 'sendHitRegion', 'sendPointer'];
  if (JSON.stringify(api.keys) !== JSON.stringify(expectedKeys)) problems.push(`unexpected API surface ${api.keys.join(',')}`);
  if (api.ipc !== 'undefined' || api.req !== 'undefined' || api.proc !== 'undefined') problems.push('Node/IPC globals leaked into the page');
  if (errors.length) problems.push(`overlay reported errors: ${JSON.stringify(errors)}`);
  if (consoleErrors.length) problems.push(`console errors: ${JSON.stringify(consoleErrors)}`);

  console.log(
    `render-preview: overlay smoke: ${regions.length} hit-region messages (${visibleRegions} while visible), min gap ${minGap} ms, ` +
      `last visible rects ${lastVisible ? lastVisible.r.rects.length : 0}, after hide ${lastAfterHide ? lastAfterHide.r.rects.length : 'n/a'}; ` +
      `api [${api.keys.join(', ')}]; shots ${shots.join(', ')}`,
  );
  win.destroy();
  if (problems.length) throw new Error(`overlay smoke failed:\n  - ${problems.join('\n  - ')}`);
  console.log('render-preview: overlay smoke passed');
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(outDir, { recursive: true });
  if (doOverlay) await overlaySmoke();
  else await renderSheets();
}

function finish(code) {
  clearTimeout(killer);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Chromium may still hold files in the temp profile; the OS cleans %TEMP%. */
  }
  app.exit(code);
}

main().then(
  () => finish(0),
  (err) => {
    console.error('render-preview: failed:', err && err.stack ? err.stack : err);
    finish(1);
  },
);
