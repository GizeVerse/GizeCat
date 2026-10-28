#!/usr/bin/env node
// Desktop compositing QA: launches the real app (test mode, temp userData), puts an
// opaque magenta backdrop window of our own under the cat, lets the overlay stay on
// top, and saves ONLY the backdrop region of the screen to out/qa/*.png. This proves
// real OS-level transparency + topmost rendering without capturing the user's screen.
//
//   node scripts/with-lock.mjs qa -- node scripts/qa-desktop.mjs [--shots=6] [--interval=2500]
import { _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const shots = arg('shots', 6);
const interval = arg('interval', 2500);
const outDir = path.join(root, 'out', 'qa');
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-qa-'));
const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());

const app = await electron.launch({
  executablePath: exe,
  args: [path.join(root, 'out', 'main', 'index.js')],
  cwd: root,
  env: { ...process.env, DESKTOP_CAT_TEST: '1', DESKTOP_CAT_USER_DATA: userData },
  timeout: 45000,
});
const hook = (name, ...args) =>
  app.evaluate(async (_e, c) => globalThis.__desktopCatTest[c.name](...c.args), { name, args });

const report = { shots: [], problems: null, states: [] };
try {
  for (let i = 0; i < 60; i++) {
    const out = await hook('getSimOutput');
    const ov = await hook('getOverlays');
    if (out && ov.length && ov.every((o) => o.ready)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (let i = 0; i < shots; i++) {
    const out = await hook('getSimOutput');
    report.states.push({ state: out.state, clip: out.clip, x: Math.round(out.x), y: Math.round(out.y), visible: out.visible });
    const res = await app.evaluate(
      async ({ BrowserWindow, desktopCapturer, screen }, { cx, cy, idx }) => {
        const dipPt = screen.screenToDipPoint({ x: cx, y: cy });
        const d = screen.getDisplayNearestPoint(dipPt);
        const w = 360;
        const h = 220;
        const x = Math.round(Math.min(Math.max(dipPt.x - w / 2, d.workArea.x), d.workArea.x + d.workArea.width - w));
        const y = Math.round(Math.min(Math.max(dipPt.y - h + 30, d.workArea.y), d.workArea.y + d.workArea.height - h));
        const g = globalThis;
        if (!g.__qaBackdrop) {
          // No URL is loaded (the app's hardening blocks non-app schemes); the window
          // paints its background colour only.
          g.__qaBackdrop = new BrowserWindow({ x, y, width: w, height: h, frame: false, show: false, focusable: false, skipTaskbar: true, backgroundColor: '#ff00ff', alwaysOnTop: true });
          g.__qaBackdrop.setAlwaysOnTop(true, 'floating');
          g.__qaBackdrop.showInactive();
        } else {
          g.__qaBackdrop.setBounds({ x, y, width: w, height: h });
        }
        // Overlays must stay above the backdrop (both topmost; re-raise the overlays).
        for (const bw of BrowserWindow.getAllWindows()) {
          if (bw !== g.__qaBackdrop && bw.webContents.getURL().includes('/renderer/overlay/')) bw.moveTop();
        }
        await new Promise((r) => setTimeout(r, 700));
        const phys = screen.dipToScreenRect(null, { x, y, width: w, height: h });
        const physDisplay = screen.dipToScreenRect(null, d.bounds);
        const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physDisplay.width, height: physDisplay.height } });
        const src = srcs.find((s) => s.display_id === String(d.id)) ?? srcs[0];
        const crop = src.thumbnail.crop({ x: phys.x - physDisplay.x, y: phys.y - physDisplay.y, width: phys.width, height: phys.height });
        const bmp = crop.toBitmap();
        let magenta = 0;
        let black = 0;
        let other = 0;
        for (let p = 0; p < bmp.length; p += 4) {
          const b = bmp[p];
          const gg = bmp[p + 1];
          const r = bmp[p + 2];
          if (r > 230 && b > 230 && gg < 30) magenta++;
          else if (r < 20 && gg < 20 && b < 20) black++;
          else other++;
        }
        return { png: crop.toPNG().toString('base64'), idx, magenta, black, other };
      },
      { cx: out.x, cy: out.y - 30, idx: i },
    );
    const file = path.join(outDir, `cat-on-backdrop-${i}.png`);
    fs.writeFileSync(file, Buffer.from(res.png, 'base64'));
    report.shots.push({ file: path.relative(root, file), magenta: res.magenta, black: res.black, other: res.other });
    if (i === 1) await hook('injectEvent', { type: 'command.play' });
    if (i === 3) await hook('injectEvent', { type: 'pointer.pet', at: { x: out.x, y: out.y - 30 }, strength: 1 });
    await new Promise((r) => setTimeout(r, interval));
  }
  report.problems = await hook('getLogProblems');
  report.hostDebug = await hook('getHostDebug');
  report.overlays = await hook('getOverlays');
  report.status = await hook('getStatus');
} finally {
  const proc = app.process();
  const exited = new Promise((r) => proc.once('exit', (c) => r(c)));
  void hook('quit').catch(() => undefined);
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
  if (code === 'timeout') proc.kill();
  report.exitCode = code;
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(JSON.stringify(report, null, 1));
