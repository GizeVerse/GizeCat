// Generates the app and tray icons from the cat rig:
//   build/icon.png (512), build/icon.ico (16..256, PNG-in-ICO),
//   assets/tray/tray(.png|@2x.png), tray-paused(...), tray-vision(...).
//
//   node scripts/with-lock.mjs icons -- npx electron scripts/gen-icons.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pageSrc = path.join(__dirname, 'preview-page');
const pageOut = path.join(root, 'out', 'icons-page');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-icons-'));
app.setPath('userData', tmp);
app.disableHardwareAcceleration();

const killer = setTimeout(() => {
  console.error('gen-icons: timed out');
  app.exit(2);
}, 120000);

/** PNG-in-ICO container (Windows Vista+): ICONDIR, ICONDIRENTRY[n], PNG payloads. */
function buildIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

function pngSize(buf) {
  // IHDR width/height (big endian) at bytes 16..23.
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

async function main() {
  const esbuild = require('esbuild');
  fs.mkdirSync(pageOut, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(pageSrc, 'icons.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome150',
    outfile: path.join(pageOut, 'icons.js'),
    logLevel: 'warning',
  });
  fs.writeFileSync(
    path.join(pageOut, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>icons</title></head><body><script src="icons.js"></script></body></html>',
  );
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(pageOut, 'index.html'));
  const render = async (size, variant) => {
    const url = await win.webContents.executeJavaScript(`window.__icons.render(${size}, ${JSON.stringify(variant)})`);
    const png = Buffer.from(String(url).slice(String(url).indexOf(',') + 1), 'base64');
    const [w, h] = pngSize(png);
    if (w !== size || h !== size) throw new Error(`icon ${variant}@${size} has size ${w}x${h}`);
    return png;
  };
  const write = (rel, buf) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    console.log(`gen-icons: ${rel} (${buf.length} bytes)`);
  };

  write('build/icon.png', await render(512, 'app'));
  const icoImages = [];
  for (const size of ICO_SIZES) icoImages.push({ size, png: await render(size, 'app') });
  write('build/icon.ico', buildIco(icoImages));
  for (const [name, variant] of [
    ['tray', 'tray'],
    ['tray-paused', 'paused'],
    ['tray-vision', 'vision'],
  ]) {
    write(`assets/tray/${name}.png`, await render(16, variant));
    write(`assets/tray/${name}@2x.png`, await render(32, variant));
  }
  // Contact sheet of every variant for visual review (not shipped).
  const sheetDir = path.join(root, 'out', 'preview');
  fs.mkdirSync(sheetDir, { recursive: true });
  await win.webContents.executeJavaScript('window.__icons.sheet()');
  let sheet = null;
  for (let i = 0; i < 100 && !sheet; i++) {
    sheet = await win.webContents.executeJavaScript('window.__iconsSheet || null');
    if (!sheet) await new Promise((r) => setTimeout(r, 50));
  }
  if (!sheet) throw new Error('icon review sheet did not render');
  const file = path.join(sheetDir, 'icons-sheet.png');
  fs.writeFileSync(file, Buffer.from(String(sheet).slice(String(sheet).indexOf(',') + 1), 'base64'));
  console.log(`gen-icons: ${path.relative(root, file)} (review only)`);
}

function finish(code) {
  clearTimeout(killer);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* Chromium may still hold files in the temp profile. */
  }
  app.exit(code);
}

main().then(
  () => finish(0),
  (err) => {
    console.error('gen-icons: failed:', err && err.stack ? err.stack : err);
    finish(1);
  },
);
