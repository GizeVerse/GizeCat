// The installable web app's icons (1.4.0), generated from the committed rig renders with Node
// built-ins only (node:zlib, node:fs): no image library, no Electron, nothing downloaded.
//
//   icons/icon-512.png        build/icon.png byte for byte (512x512, transparent; manifest "any")
//   icons/icon-192.png        area-averaged from it in premultiplied alpha (transparent; "any")
//   icons/maskable-512.png    opaque #f6f1e7, the cat scaled to MASKABLE_SCALE and centred, so it
//   icons/maskable-192.png    stays inside the maskable safe zone (a circle of 40% of the size)
//   icons/apple-touch-icon.png 180x180, opaque #f6f1e7, cat at APPLE_SCALE (iOS shows
//                             transparency as black)
//   icons/favicon-32.png      the 32 px entry of build/icon.ico byte for byte (rendered natively
//                             from the rig by scripts/gen-icons.cjs, no resampling)
//
// The PNG decoder accepts exactly what build/icon.png is (8-bit RGBA, non-interlaced) and fails
// loudly on anything else. Used by scripts/build.mjs for out/web and out/web-test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The page's --bg token (src/web/web.css) and the manifest's background_color. */
export const ICON_BACKGROUND = '#f6f1e7';
/** The cat's farthest opaque pixel is 276.5 px from the centre of the 512 source: x0.70 puts it at ~194 of the 204.8 px safe radius. */
export const MASKABLE_SCALE = 0.7;
/** The apple-touch icon has no safe zone of its own; iOS rounds the corners, so a little margin. */
export const APPLE_SCALE = 0.84;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------- CRC-32

let crcTable = null;
/** zlib.crc32 (Node 22.2+), else a table-driven CRC-32 (the same polynomial). */
export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------- PNG

/** Width, height, bit depth, colour type and interlace of a PNG (from IHDR). */
export function pngInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('web-icons: not a PNG');
  if (buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('web-icons: PNG without IHDR first');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/** Decodes an 8-bit RGBA, non-interlaced PNG into { width, height, data: Uint8Array (RGBA, straight alpha) }. */
export function decodePng(buf) {
  const info = pngInfo(buf);
  if (info.bitDepth !== 8 || info.colorType !== 6 || info.interlace !== 0 || buf[26] !== 0 || buf[27] !== 0) {
    throw new Error(`web-icons: only 8-bit RGBA non-interlaced PNGs are supported (got depth ${info.bitDepth}, colour type ${info.colorType}, interlace ${info.interlace})`);
  }
  const { width, height } = info;
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error(`web-icons: unsupported size ${width}x${height}`);
  const idat = [];
  let pos = 8;
  let ended = false;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > buf.length) throw new Error(`web-icons: truncated ${type} chunk`);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (crc32(buf.subarray(pos + 4, pos + 8 + len)) !== buf.readUInt32BE(pos + 8 + len)) throw new Error(`web-icons: bad CRC in ${type}`);
    if (type === 'IDAT') idat.push(body);
    if (type === 'IEND') {
      ended = true;
      break;
    }
    pos = end;
  }
  if (!ended || idat.length === 0) throw new Error('web-icons: PNG without image data or IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error(`web-icons: image data is ${raw.length} bytes, expected ${height * (stride + 1)}`);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= 4 ? out[dst + x - 4] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[dst - stride + x - 4] : 0;
      let p;
      switch (filter) {
        case 0:
          p = 0;
          break;
        case 1:
          p = a;
          break;
        case 2:
          p = b;
          break;
        case 3:
          p = (a + b) >> 1;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`web-icons: unknown PNG filter ${filter} on row ${y}`);
      }
      out[dst + x] = (v + p) & 0xff;
    }
  }
  return { width, height, data: out };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes RGBA pixels (straight alpha) as an 8-bit RGBA PNG (opaque icons too, alpha 255: decodePng reads every icon back). */
export function encodePng({ width, height, data }) {
  const ch = 4;
  const stride = width * ch;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    // Filter 1 (Sub) per row: smaller than None for these smooth images, and trivially decodable.
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < ch; k++) {
        const v = data[(y * width + x) * 4 + k];
        const left = x > 0 ? data[(y * width + x - 1) * 4 + k] : 0;
        raw[row + 1 + x * ch + k] = (v - left) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------- resampling

/** 1-D box-filter weights from `n` source samples to `m` (m <= n): for each target sample, [index, weight] pairs summing to 1. */
function boxWeights(n, m) {
  const scale = n / m;
  const out = [];
  for (let i = 0; i < m; i++) {
    const s0 = i * scale;
    const s1 = (i + 1) * scale;
    const w = [];
    for (let j = Math.floor(s0); j < Math.min(n, Math.ceil(s1)); j++) {
      const overlap = Math.min(s1, j + 1) - Math.max(s0, j);
      if (overlap > 1e-9) w.push([j, overlap / scale]);
    }
    out.push(w);
  }
  return out;
}

/**
 * Area-averages an RGBA image down to `tw` x `th` in premultiplied alpha (so transparent pixels
 * do not darken the edges). Returns premultiplied floats: Float32Array(tw*th*4), colour and alpha in 0..1.
 */
export function downscalePremultiplied(img, tw, th) {
  const { width: w, height: h, data } = img;
  if (tw > w || th > h || tw < 1 || th < 1) throw new Error(`web-icons: cannot area-average ${w}x${h} to ${tw}x${th}`);
  const pre = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = (data[i * 4] / 255) * a;
    pre[i * 4 + 1] = (data[i * 4 + 1] / 255) * a;
    pre[i * 4 + 2] = (data[i * 4 + 2] / 255) * a;
    pre[i * 4 + 3] = a;
  }
  const wx = boxWeights(w, tw);
  const wy = boxWeights(h, th);
  const mid = new Float32Array(tw * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4;
      for (const [j, k] of wx[x]) {
        const s = (y * w + j) * 4;
        mid[o] += pre[s] * k;
        mid[o + 1] += pre[s + 1] * k;
        mid[o + 2] += pre[s + 2] * k;
        mid[o + 3] += pre[s + 3] * k;
      }
    }
  }
  const out = new Float32Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4;
      for (const [j, k] of wy[y]) {
        const s = (j * tw + x) * 4;
        out[o] += mid[s] * k;
        out[o + 1] += mid[s + 1] * k;
        out[o + 2] += mid[s + 2] * k;
        out[o + 3] += mid[s + 3] * k;
      }
    }
  }
  return out;
}

const to8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Premultiplied floats back to straight-alpha RGBA bytes. */
function unpremultiply(pre, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = pre[i * 4 + 3];
    if (a > 1e-6) {
      out[i * 4] = to8(pre[i * 4] / a);
      out[i * 4 + 1] = to8(pre[i * 4 + 1] / a);
      out[i * 4 + 2] = to8(pre[i * 4 + 2] / a);
    }
    out[i * 4 + 3] = to8(a);
  }
  return out;
}

/** The image area-averaged to `size` x `size`, transparent where the source is. */
export function resizeTransparent(img, size) {
  return { width: size, height: size, data: unpremultiply(downscalePremultiplied(img, size, size), size, size) };
}

function parseHex(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`web-icons: bad colour ${hex}`);
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/**
 * An opaque `size` x `size` icon: `background` everywhere, with the whole (square) source scaled
 * to `scale` of the size and centred over it.
 */
export function composeOnBackground(img, size, scale, background = ICON_BACKGROUND) {
  if (img.width !== img.height) throw new Error('web-icons: the icon source must be square');
  const side = Math.max(1, Math.min(size, Math.round(size * scale)));
  const off = Math.floor((size - side) / 2);
  const pre = downscalePremultiplied(img, side, side);
  const [br, bg, bb] = parseHex(background);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const sx = x - off;
      const sy = y - off;
      let r = br;
      let g = bg;
      let b = bb;
      if (sx >= 0 && sy >= 0 && sx < side && sy < side) {
        const s = (sy * side + sx) * 4;
        const a = pre[s + 3];
        r = pre[s] + br * (1 - a);
        g = pre[s + 1] + bg * (1 - a);
        b = pre[s + 2] + bb * (1 - a);
      }
      out[o] = to8(r);
      out[o + 1] = to8(g);
      out[o + 2] = to8(b);
      out[o + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

/**
 * The largest distance (px) from the image centre of a pixel that differs from `background` by more
 * than `tolerance` in any channel (opaque icons), or whose alpha exceeds `tolerance` (transparent ones).
 */
export function contentRadius(img, { background = null, tolerance = 8 } = {}) {
  const { width: w, height: h, data } = img;
  const bgc = background ? parseHex(background).map((v) => Math.round(v * 255)) : null;
  const cx = w / 2;
  const cy = h / 2;
  let max = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const content = bgc
        ? Math.abs(data[o] - bgc[0]) > tolerance || Math.abs(data[o + 1] - bgc[1]) > tolerance || Math.abs(data[o + 2] - bgc[2]) > tolerance
        : data[o + 3] > tolerance;
      if (!content) continue;
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > max) max = d;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------- ICO

/** The PNG stored for `size` px in an ICO file (byte for byte), or throws. */
export function extractIcoPng(ico, size) {
  if (!Buffer.isBuffer(ico) || ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('web-icons: not an ICO file');
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 16 > ico.length) break;
    const w = ico[e] || 256;
    const h = ico[e + 1] || 256;
    const len = ico.readUInt32LE(e + 8);
    const off = ico.readUInt32LE(e + 12);
    if (w !== size || h !== size) continue;
    if (off + len > ico.length) throw new Error(`web-icons: ICO entry ${size} is truncated`);
    const png = ico.subarray(off, off + len);
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`web-icons: ICO entry ${size} is not a PNG`);
    return Buffer.from(png);
  }
  throw new Error(`web-icons: ICO has no ${size}x${size} entry`);
}

// ---------------------------------------------------------------------------- output

/** The icons as { 'icons/<name>.png': Buffer }, from the committed sources. */
export function renderWebIcons({ iconPng = path.join(root, 'build', 'icon.png'), iconIco = path.join(root, 'build', 'icon.ico') } = {}) {
  const srcPng = fs.readFileSync(iconPng);
  const src = decodePng(srcPng);
  if (src.width !== 512 || src.height !== 512) throw new Error(`web-icons: ${iconPng} must be 512x512 (is ${src.width}x${src.height})`);
  return {
    'icons/icon-512.png': Buffer.from(srcPng),
    'icons/icon-192.png': encodePng(resizeTransparent(src, 192)),
    'icons/maskable-512.png': encodePng(composeOnBackground(src, 512, MASKABLE_SCALE)),
    'icons/maskable-192.png': encodePng(composeOnBackground(src, 192, MASKABLE_SCALE)),
    'icons/apple-touch-icon.png': encodePng(composeOnBackground(src, 180, APPLE_SCALE)),
    'icons/favicon-32.png': extractIcoPng(fs.readFileSync(iconIco), 32),
  };
}

/** Writes the icons into `<outDir>/icons/`; returns [{ file, bytes }]. The same bytes every time for the same sources. */
export function writeWebIcons(outDir, sources) {
  const icons = renderWebIcons(sources);
  const written = [];
  for (const [rel, bytes] of Object.entries(icons)) {
    const file = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    written.push({ file: rel, bytes: bytes.length });
  }
  return written;
}
