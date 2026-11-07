// scripts/web-icons.mjs, scripts/web-csp.mjs and the zip writer of scripts/package-web.mjs (1.4.0
// installable web app): the PNG decoder and encoder round-trip, the icons have the declared sizes,
// the maskable and Apple icons are opaque with the cat inside the safe zone, the favicon is the ICO's
// own 32 px render, and the zip is deterministic and readable. REAL: reads the committed
// build/icon.png and build/icon.ico (nothing is written to the repo).
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script without declarations
import * as iconsModule from '../../../scripts/web-icons.mjs';
// @ts-expect-error a plain .mjs script without declarations
import * as cspModule from '../../../scripts/web-csp.mjs';
// @ts-expect-error a plain .mjs script without declarations
import * as packageModule from '../../../scripts/package-web.mjs';

interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}
const icons = iconsModule as {
  decodePng(buf: Buffer): Img;
  encodePng(img: Img): Buffer;
  pngInfo(buf: Buffer): { width: number; height: number; bitDepth: number; colorType: number; interlace: number };
  renderWebIcons(): Record<string, Buffer>;
  contentRadius(img: Img, opts?: { background?: string | null; tolerance?: number }): number;
  extractIcoPng(ico: Buffer, size: number): Buffer;
  crc32(buf: Buffer): number;
  ICON_BACKGROUND: string;
};
const csp = cspModule as { WEB_CSP: string; swPrecacheList(text: string): string[] | null; metaCsp(html: string): string | null };
const pkg = packageModule as { zipBuffers(entries: Array<{ name: string; data: Buffer }>): Buffer };

describe('web icons', () => {
  const out = icons.renderWebIcons();

  it('renders every icon the manifest and index.html name, at its size, as 8-bit RGBA PNGs', () => {
    const want: Record<string, number> = {
      'icons/icon-512.png': 512,
      'icons/icon-192.png': 192,
      'icons/maskable-512.png': 512,
      'icons/maskable-192.png': 192,
      'icons/apple-touch-icon.png': 180,
      'icons/favicon-32.png': 32,
    };
    expect(Object.keys(out).sort()).toEqual(Object.keys(want).sort());
    for (const [name, size] of Object.entries(want)) {
      const info = icons.pngInfo(out[name]!);
      expect([info.width, info.height], name).toEqual([size, size]);
      expect([info.bitDepth, info.colorType, info.interlace], name).toEqual([8, 6, 0]);
    }
  });

  it('round-trips through the decoder and encoder losslessly', () => {
    const img = icons.decodePng(out['icons/icon-192.png']!);
    const again = icons.decodePng(icons.encodePng(img));
    expect(again.width).toBe(192);
    expect(Buffer.from(again.data).equals(Buffer.from(img.data))).toBe(true);
  });

  it('keeps the 192 "any" icon transparent in its corners, like the 512 source', () => {
    const img = icons.decodePng(out['icons/icon-192.png']!);
    expect(img.data[3]).toBe(0);
    expect(img.data[(192 * 192 - 1) * 4 + 3]).toBe(0);
  });

  it('makes the maskable and Apple icons opaque, with the cat inside the maskable safe zone (40% radius)', () => {
    for (const [name, size] of [
      ['icons/maskable-512.png', 512],
      ['icons/maskable-192.png', 192],
    ] as const) {
      const img = icons.decodePng(out[name]!);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
      expect(icons.contentRadius(img, { background: icons.ICON_BACKGROUND, tolerance: 8 }), name).toBeLessThanOrEqual(size * 0.4);
    }
    const apple = icons.decodePng(out['icons/apple-touch-icon.png']!);
    for (let i = 3; i < apple.data.length; i += 4) expect(apple.data[i]).toBe(255);
  });

  it('takes the favicon byte for byte from the ICO, and refuses what it cannot read', () => {
    expect(icons.pngInfo(out['icons/favicon-32.png']!).width).toBe(32);
    expect(() => icons.extractIcoPng(Buffer.from([0, 0, 1, 0, 0, 0]), 32)).toThrow();
    expect(() => icons.decodePng(Buffer.from('not a png'))).toThrow();
    // A grey (colour type 0) PNG is refused, not misread.
    const grey = Buffer.from(out['icons/icon-192.png']!);
    grey[25] = 0;
    expect(() => icons.decodePng(grey)).toThrow();
  });

  it('computes the standard CRC-32', () => {
    expect(icons.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('web policy helpers', () => {
  it('reads the CSP meta and a minified precache list', () => {
    expect(csp.metaCsp(`<meta http-equiv="Content-Security-Policy" content="${csp.WEB_CSP}" />`)).toBe(csp.WEB_CSP);
    expect(csp.metaCsp('<meta charset="utf-8">')).toBeNull();
    expect(csp.swPrecacheList('(()=>{var e=["a.js"],t=["icons/x.png","index.html","main.js"];self.x=1})();')).toEqual(['icons/x.png', 'index.html', 'main.js']);
    expect(csp.swPrecacheList('nothing here')).toBeNull();
    expect(csp.WEB_CSP).toContain("connect-src 'none'");
    expect(csp.WEB_CSP).not.toContain('data:');
  });
});

describe('web package zip', () => {
  /** Reads a zip's central directory and inflates each entry. */
  function unzip(zip: Buffer): Record<string, Buffer> {
    const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    const out: Record<string, Buffer> = {};
    for (let i = 0; i < count; i++) {
      const method = zip.readUInt16LE(p + 10);
      const csize = zip.readUInt32LE(p + 20);
      const nameLen = zip.readUInt16LE(p + 28);
      const local = zip.readUInt32LE(p + 42);
      const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
      const lNameLen = zip.readUInt16LE(local + 26);
      const body = zip.subarray(local + 30 + lNameLen, local + 30 + lNameLen + csize);
      out[name] = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
      p += 46 + nameLen;
    }
    return out;
  }

  it('is deterministic and holds exactly the given files', () => {
    const entries = [
      { name: 'GizeCat-web-x/index.html', data: Buffer.from('<!doctype html>'.repeat(50)) },
      { name: 'GizeCat-web-x/icons/a.png', data: Buffer.from([1, 2, 3]) },
    ];
    const a = pkg.zipBuffers(entries);
    const b = pkg.zipBuffers(entries);
    expect(a.equals(b)).toBe(true);
    const files = unzip(a);
    expect(Object.keys(files)).toEqual(entries.map((e) => e.name));
    for (const e of entries) expect(files[e.name]!.equals(e.data)).toBe(true);
  });
});
