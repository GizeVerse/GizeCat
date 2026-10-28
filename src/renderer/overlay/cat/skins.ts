// Coat definitions. A skin is a palette plus a list of marks placed in body-part
// coordinates, so adding a coat is data only. Regions:
//   torso  – (u, v) in torso units (u along the body, +v towards the belly)
//   head   – head-local DIP (facing right, origin at the head centre)
//   haunch – (u, v) in haunch radii
import type { SkinId } from '../../../shared/cat';

export type MarkRegion = 'torso' | 'head' | 'haunch';

export interface EllipseMark {
  kind: 'ellipse';
  region: MarkRegion;
  x: number;
  y: number;
  rx: number;
  ry: number;
  /** Rotation, canvas radians. */
  rot: number;
  color: string;
  alpha: number;
}

export interface StripeMark {
  kind: 'stripe';
  region: MarkRegion;
  /** Quadratic stroke from (x0,y0) through control (cx,cy) to (x1,y1). */
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  width: number;
  color: string;
  alpha: number;
}

export type Mark = EllipseMark | StripeMark;

export interface Skin {
  id: SkinId;
  coat: string;
  /** Far legs and far ear: a slightly darker coat. */
  shade: string;
  outline: string;
  /** Belly / chest / muzzle highlight. */
  light: string;
  lightAlpha: number;
  earInner: string;
  nose: string;
  iris: string;
  pupil: string;
  whisker: string;
  mouth: string;
  tongue: string;
  /** Opaque light rim outside the outline so dark coats read on dark wallpapers. */
  halo: string | null;
  /** Rim highlight along the top of head and back (dark coats). */
  rim: string | null;
  tail: {
    color: string;
    /** Darker/lighter tip covering `tipFrac` of the tail. */
    tip: string | null;
    tipFrac: number;
    /** Tabby rings. */
    rings: string | null;
  };
  /** Paws and lower legs (socks / points). */
  socks: string | null;
  /** 0..1 of the lower leg covered by socks. */
  sockLen: number;
  /** Ear colour overrides (back, front), e.g. siamese points or calico patches. */
  ears: readonly [string | null, string | null];
  /** Eyelid colour where it differs from the coat around the eyes (siamese mask). */
  lid: string | null;
  /** Base cheek blush alpha (0..1); the pose adds to it. */
  blush: number;
  /** Pixel-style eye colour when the pupil would vanish into a dark coat. */
  pixelEye?: string;
  /** Leg bands for tabbies. */
  legBands: string | null;
  marks: readonly Mark[];
}

const e = (region: MarkRegion, x: number, y: number, rx: number, ry: number, rot: number, color: string, alpha = 1): EllipseMark => ({
  kind: 'ellipse',
  region,
  x,
  y,
  rx,
  ry,
  rot,
  color,
  alpha,
});

const s = (
  region: MarkRegion,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  width: number,
  color: string,
  alpha = 1,
): StripeMark => ({ kind: 'stripe', region, x0, y0, cx, cy, x1, y1, width, color, alpha });

/** Mackerel tabby stripes: across the back, on the thigh, forehead "M" and cheeks. */
function tabbyMarks(color: string, alpha: number): Mark[] {
  return [
    s('torso', 0.66, -1.05, 0.6, -0.55, 0.62, -0.12, 2.6, color, alpha),
    s('torso', 0.34, -1.1, 0.26, -0.5, 0.3, 0.05, 2.8, color, alpha),
    s('torso', 0.0, -1.1, -0.08, -0.45, -0.02, 0.12, 2.8, color, alpha),
    s('torso', -0.34, -1.1, -0.42, -0.5, -0.36, 0.06, 2.6, color, alpha),
    s('torso', -0.66, -0.95, -0.76, -0.55, -0.74, -0.18, 2.4, color, alpha),
    s('torso', 0.8, -0.82, 0.2, -1.04, -0.8, -0.84, 1.6, color, alpha * 0.55),
    s('haunch', -0.2, -0.95, -0.45, -0.35, -0.75, 0.1, 2.4, color, alpha),
    s('haunch', 0.25, -0.75, 0.0, -0.15, -0.3, 0.45, 2.2, color, alpha),
    s('head', -1.2, -13.8, -0.8, -10.5, -0.2, -7.2, 1.7, color, alpha),
    s('head', 3.8, -13.6, 4.0, -10.2, 4.2, -7.0, 1.7, color, alpha),
    s('head', -5.8, -12.6, -5.2, -10.2, -4.2, -8.0, 1.5, color, alpha),
    s('head', 8.8, -12.4, 8.6, -10.2, 8.0, -8.2, 1.5, color, alpha),
    s('head', -17.6, 1.5, -14.5, 1.2, -12.2, 2.2, 1.5, color, alpha),
    s('head', -17.2, 5.5, -14.8, 5.4, -12.8, 6.4, 1.4, color, alpha),
  ];
}

const GINGER: Skin = {
  id: 'ginger',
  coat: '#f2a04e',
  shade: '#d9853b',
  outline: '#6e3a17',
  light: '#ffe2bb',
  lightAlpha: 1,
  earInner: '#f6b3a8',
  nose: '#ee8c8a',
  iris: '#b6d65a',
  pupil: '#2b1b12',
  whisker: '#fff4e4',
  mouth: '#6d2a2c',
  tongue: '#f28d94',
  halo: null,
  rim: null,
  tail: { color: '#f2a04e', tip: null, tipFrac: 0, rings: '#cf6f2c' },
  socks: null,
  sockLen: 0,
  ears: [null, null],
  lid: null,
  blush: 0.14,
  legBands: '#cf6f2c',
  marks: tabbyMarks('#cf6f2c', 0.9),
};

const GRAY: Skin = {
  id: 'gray',
  coat: '#9aa0a9',
  shade: '#7f858f',
  outline: '#363a42',
  light: '#e1e3e7',
  lightAlpha: 1,
  earInner: '#e8b4b4',
  nose: '#d98f95',
  iris: '#ecc24a',
  pupil: '#1d1d22',
  whisker: '#f6f6f6',
  mouth: '#5e2a31',
  tongue: '#ef8f99',
  halo: null,
  rim: null,
  tail: { color: '#9aa0a9', tip: '#5d636d', tipFrac: 0.14, rings: '#646a74' },
  socks: null,
  sockLen: 0,
  ears: [null, null],
  lid: null,
  blush: 0.12,
  legBands: '#646a74',
  marks: tabbyMarks('#646a74', 0.85),
};

const BLACK: Skin = {
  id: 'black',
  coat: '#2e2d35',
  shade: '#222128',
  outline: '#0b0a0e',
  light: '#3d3c46',
  lightAlpha: 1,
  earInner: '#6a4a55',
  nose: '#4a3a42',
  iris: '#f2c53d',
  pixelEye: '#f2c53d',
  pupil: '#0d0c10',
  whisker: '#d9d9de',
  mouth: '#4c1e27',
  tongue: '#e9868f',
  halo: '#8d8b99',
  rim: 'rgba(170,182,220,0.42)',
  tail: { color: '#2e2d35', tip: null, tipFrac: 0, rings: null },
  socks: null,
  sockLen: 0,
  ears: [null, null],
  lid: null,
  blush: 0,
  legBands: null,
  marks: [],
};

const TUXEDO: Skin = {
  id: 'tuxedo',
  coat: '#2f2e36',
  shade: '#232229',
  outline: '#0b0a0e',
  light: '#f7f5f0',
  lightAlpha: 1,
  earInner: '#d79aa5',
  nose: '#e48f9a',
  iris: '#9fd25a',
  pixelEye: '#b5e06a',
  pupil: '#0d0c10',
  whisker: '#f4f4f4',
  mouth: '#5a2230',
  tongue: '#ef8f99',
  halo: '#8d8b99',
  rim: 'rgba(170,182,220,0.38)',
  tail: { color: '#2f2e36', tip: null, tipFrac: 0, rings: null },
  socks: '#f7f5f0',
  sockLen: 0.55,
  ears: [null, null],
  lid: null,
  blush: 0,
  legBands: null,
  marks: [
    // White bib: chest and belly.
    e('torso', 0.62, 0.42, 0.62, 0.72, 0, '#f7f5f0'),
    e('torso', 0.05, 0.95, 0.75, 0.42, 0, '#f7f5f0'),
    // Muzzle, chin and a blaze between the eyes.
    e('head', 4.6, 7.4, 8.6, 6.2, 0, '#f7f5f0'),
    e('head', 4.0, 12.5, 7.5, 3.2, 0, '#f7f5f0'),
    s('head', 4.0, -5.5, 4.2, -1.0, 4.4, 3.0, 3.2, '#f7f5f0'),
  ],
};

const CALICO: Skin = {
  id: 'calico',
  coat: '#fbf7ef',
  shade: '#e4ddcf',
  outline: '#5b4a3d',
  light: '#ffffff',
  lightAlpha: 1,
  earInner: '#f3b2ab',
  nose: '#ec9b9a',
  iris: '#e6ad3a',
  pupil: '#231914',
  whisker: '#8f7f72',
  mouth: '#6a2c2f',
  tongue: '#f08d95',
  halo: null,
  rim: null,
  tail: { color: '#ec9844', tip: '#38323a', tipFrac: 0.4, rings: null },
  socks: null,
  sockLen: 0,
  ears: ['#ec9844', '#38323a'],
  lid: null,
  blush: 0.16,
  legBands: null,
  marks: [
    e('torso', -0.45, -0.62, 0.55, 0.5, 0.25, '#ec9844'),
    e('torso', 0.3, -0.78, 0.36, 0.34, -0.2, '#38323a'),
    e('torso', -0.05, -0.95, 0.22, 0.2, 0, '#ec9844'),
    e('haunch', -0.25, -0.5, 0.85, 0.65, 0.3, '#38323a'),
    e('haunch', 0.35, -0.75, 0.4, 0.35, 0, '#ec9844'),
    // Head: orange over the back ear, black over the front ear.
    e('head', -10.5, -9.5, 9.2, 7.6, 0.4, '#ec9844'),
    e('head', 9.5, -10.5, 6.8, 5.6, -0.3, '#38323a'),
  ],
};

const SIAMESE: Skin = {
  id: 'siamese',
  coat: '#f4e8d4',
  shade: '#e3d2b8',
  outline: '#4f3a2f',
  light: '#fff7ea',
  lightAlpha: 1,
  earInner: '#8a6457',
  nose: '#5b4035',
  iris: '#62b4f2',
  pupil: '#1b1414',
  whisker: '#e8dccb',
  mouth: '#4e2426',
  tongue: '#e88690',
  halo: null,
  rim: null,
  tail: { color: '#7a5b4b', tip: '#4d382e', tipFrac: 0.6, rings: null },
  socks: '#6a4d3f',
  sockLen: 1,
  ears: ['#5d4538', '#5d4538'],
  lid: '#6e5243',
  blush: 0,
  legBands: null,
  marks: [
    // Soft darker back saddle.
    e('torso', -0.1, -0.85, 0.9, 0.36, 0, '#d9c3a2', 0.7),
    e('haunch', -0.1, -0.2, 0.9, 0.85, 0, '#d9c3a2', 0.55),
    // Face mask around the muzzle and eyes.
    e('head', 4.4, 4.0, 12.2, 9.8, 0, '#6e5243', 0.4),
    e('head', 4.4, 4.6, 10.0, 8.0, 0, '#6e5243', 0.85),
  ],
};

const CREAM: Skin = {
  id: 'cream',
  coat: '#f5dcae',
  shade: '#e7c58e',
  outline: '#7d5a38',
  light: '#fff3dc',
  lightAlpha: 1,
  earInner: '#f6b9ab',
  nose: '#eea199',
  iris: '#e29a3c',
  pupil: '#2a1d14',
  whisker: '#fffaf0',
  mouth: '#6d2c2f',
  tongue: '#f28d94',
  halo: null,
  rim: null,
  tail: { color: '#f5dcae', tip: null, tipFrac: 0, rings: '#e3bb7f' },
  socks: null,
  sockLen: 0,
  ears: [null, null],
  lid: null,
  blush: 0.16,
  legBands: null,
  marks: tabbyMarks('#e2b878', 0.75),
};

export const SKIN_DEFS: Readonly<Record<SkinId, Skin>> = {
  ginger: GINGER,
  gray: GRAY,
  black: BLACK,
  tuxedo: TUXEDO,
  calico: CALICO,
  siamese: SIAMESE,
  cream: CREAM,
};

export function getSkin(id: string): Skin {
  return (SKIN_DEFS as Readonly<Record<string, Skin | undefined>>)[id] ?? GINGER;
}
