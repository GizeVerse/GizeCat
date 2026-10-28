// Icon page for scripts/gen-icons.cjs: draws the cat's head with the real rig art at
// each target size (not downscaled), so small sizes get pixel-snapped eyes and a
// one-pixel outline.
import { drawHeadIcon } from '../../src/renderer/overlay/cat/draw';
import { createPose } from '../../src/renderer/overlay/cat/pose';
import { getSkin, type Skin } from '../../src/renderer/overlay/cat/skins';

type Variant = 'app' | 'tray' | 'paused' | 'vision';

/** Head extent in head-local units (incl. ears and outline). */
const HEAD_TOP = -26;
const HEAD_BOTTOM = 15;
const HEAD_HALF_W = 19.5;

function headSkin(size: number): Skin {
  const base = getSkin('ginger');
  // Tiny icons: forehead stripes would turn into noise.
  return size <= 32 ? { ...base, marks: base.marks.filter((m) => m.region !== 'head'), blush: 0 } : base;
}

function render(size: number, variant: Variant): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const pad = variant === 'app' ? 0.06 : 0.02;
  const fit = (size * (1 - pad * 2)) / Math.max(HEAD_BOTTOM - HEAD_TOP, HEAD_HALF_W * 2);
  const pose = createPose();
  pose.faceTurn = -0.7;
  pose.pupilX = 0.05;
  pose.pupilY = 0.15;
  pose.pupilSize = 0.78;
  pose.blush = variant === 'app' ? 0.5 : 0;
  const outline = Math.max(1.6, 1.15 / fit);
  ctx.setTransform(fit, 0, 0, fit, size / 2 - 0.6 * fit, size / 2 - ((HEAD_TOP + HEAD_BOTTOM) / 2) * fit);
  drawHeadIcon(ctx, pose, headSkin(size), outline, fit);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (variant === 'paused') {
    // Dim and desaturate only the cat (filter on a copy keeps the background transparent),
    // then two pause bars.
    const copy = document.createElement('canvas');
    copy.width = size;
    copy.height = size;
    const cc = copy.getContext('2d');
    if (!cc) throw new Error('no 2d context');
    cc.drawImage(canvas, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.filter = 'grayscale(1) opacity(0.6)';
    ctx.drawImage(copy, 0, 0);
    ctx.filter = 'none';
    const bw = Math.max(2, Math.round(size * 0.14));
    const bh = Math.max(5, Math.round(size * 0.44));
    const gap = Math.max(1, Math.round(size * 0.08));
    const x0 = size - bw * 2 - gap - Math.max(0, Math.round(size * 0.02));
    const y0 = size - bh;
    const o = Math.max(1, Math.round(size / 16));
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(x0 - o, y0 - o, bw * 2 + gap + o * 2, bh + o);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, bw, bh - o);
    ctx.fillRect(x0 + bw + gap, y0, bw, bh - o);
  } else if (variant === 'vision') {
    // A small blue eye badge: screen perception is active.
    const r = Math.max(3, size * 0.24);
    const cx = size - r - Math.max(0, size * 0.01);
    const cy = size - r - Math.max(0, size * 0.01);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2f7cf6';
    ctx.beginPath();
    ctx.arc(cx, cy, r - Math.max(1, size / 16), 0, Math.PI * 2);
    ctx.fill();
    if (size >= 24) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 0.55, r * 0.34, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#123a7a';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, 2, 2);
    }
  }
  return canvas.toDataURL('image/png');
}

/** Review sheet: every tray variant at 16 and 32 px, magnified 8x (nearest) on light and dark tiles. */
function sheet(): string {
  const variants: Variant[] = ['tray', 'paused', 'vision', 'app'];
  const sizes = [16, 32];
  const zoom = 8;
  const cell = 32 * zoom + 16;
  const canvas = document.createElement('canvas');
  canvas.width = variants.length * cell;
  canvas.height = sizes.length * 2 * cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = false;
  const pending: Promise<void>[] = [];
  let row = 0;
  for (const bg of ['#f3f3f3', '#202020']) {
    for (const size of sizes) {
      variants.forEach((v, col) => {
        ctx.fillStyle = bg;
        ctx.fillRect(col * cell, row * cell, cell, cell);
        const img = new Image();
        const x = col * cell + 8;
        const y = row * cell + 8;
        pending.push(
          new Promise<void>((resolve) => {
            img.onload = () => {
              ctx.drawImage(img, x, y, size * zoom, size * zoom);
              resolve();
            };
            img.onerror = () => resolve();
          }),
        );
        img.src = render(size, v);
      });
      row++;
    }
  }
  void Promise.all(pending).then(() => {
    window.__iconsSheet = canvas.toDataURL('image/png');
  });
  return 'pending';
}

declare global {
  interface Window {
    __icons: { render(size: number, variant: Variant): string; sheet(): string };
    __iconsSheet?: string;
  }
}

window.__icons = { render, sheet };
