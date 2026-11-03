// The presence rect main uses to decide which overlays draw the cat must contain
// everything the renderer can paint, or a sliver of tail, ears or emote is clipped at
// a monitor seam (the neighbouring overlay is not drawing yet). v1.2 (ADR 0003 §8.2): with
// at least 6 DIP of headroom on every side, for every clip and render hint.
import { describe, expect, it } from 'vitest';
import {
  ANIM_CLIPS,
  CAT_BASE_HEIGHT_DIP,
  CAT_BASE_WIDTH_DIP,
  JUMP_KINDS,
  type AnimClip,
  type CatRenderState,
  type Emote,
  type JumpKind,
  type RenderStyle,
} from '../../../src/shared/cat';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimOutput } from '../../../src/shared/sim';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { CatScene, type Layer } from '../../../src/renderer/overlay/scene';
import { presenceRectPx } from '../../../src/main/overlay/renderMapping';
import { createExtentCtx, emptyBox, type Box } from './extentCtx';

const ANCHOR = { x: 1200, y: 900 };

/** Device-space box of what one frame paints (pixel style: whole blocks of painted layer pixels). */
function paintedBox(scene: CatScene, dpr: number): Box {
  const main = createExtentCtx();
  const lay = createExtentCtx();
  const layer: Layer = { canvas: {} as CanvasImageSource, ctx: lay.ctx };
  let lw = 0;
  scene.draw(main.ctx, dpr, (w) => {
    lw = w;
    return layer;
  });
  if (main.images.length === 0) return { ...main.box };
  const img = main.images[0]!;
  const block = (img.x1 - img.x0) / lw;
  const lb = lay.box;
  if (!Number.isFinite(lb.x0)) return emptyBox();
  return {
    x0: img.x0 + Math.floor(lb.x0) * block,
    y0: img.y0 + Math.floor(lb.y0) * block,
    x1: img.x0 + Math.ceil(lb.x1) * block,
    y1: img.y0 + Math.ceil(lb.y1) * block,
  };
}

function simOutput(size: number, sf: number): SimOutput {
  const bw = CAT_BASE_WIDTH_DIP * size * sf;
  const bh = CAT_BASE_HEIGHT_DIP * size * sf;
  const ax = ANCHOR.x * sf;
  const ay = ANCHOR.y * sf;
  return {
    x: ax,
    y: ay,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.9,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    snap: false,
    displayId: '1',
    support: { kind: 'floor', displayId: '1' },
    boundsPx: { x: ax - bw / 2, y: ay - bh, width: bw, height: bh },
    nextTickMs: 33,
    requests: [],
  };
}

/** ADR 0003 §8.2: every painted pixel stays this far (DIP at size 1) inside the presence rect. */
const HEADROOM_DIP = 6;

interface Hints {
  jumpKind?: JumpKind | null;
  impact?: number;
  balance?: number;
}

const speedOf = (clip: AnimClip): number =>
  clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : clip === 'stalk' ? 0.3 : clip === 'slink' ? 1 : clip === 'sprint' ? 4.3 : 0;
const vyOf = (clip: AnimClip, t: number): number =>
  clip === 'jump' || clip === 'pounce' ? (t < 1500 ? -300 : 300) : clip === 'fall' ? 300 : 0;

/**
 * Smallest headroom (DIP at size 1) between what a clip paints over 3 s and the presence rect, for
 * one style/emote/size/scale-factor/facing combination; `where` names the frame it happened at.
 */
function headroom(
  clip: AnimClip,
  opts: { style: RenderStyle; emote: Emote | null; size: number; sf: number; facing: 1 | -1; hints?: Hints },
): { dip: number; where: string } {
  const { style, emote, size, sf, facing } = opts;
  const appearance = { ...defaultSettings().appearance, size, emotes: emote !== null, style };
  const p = presenceRectPx(simOutput(size, sf), appearance, sf);
  const scene = new CatScene(seededRandom(11));
  let dip = Infinity;
  let where = '';
  for (let t = 0; t <= 3000; t += 250) {
    const s: CatRenderState = {
      seq: t,
      t,
      x: ANCHOR.x,
      y: ANCHOR.y,
      snap: false,
      scale: size,
      facing,
      state: clip === 'sleep' ? 'sleeping' : 'idle',
      clip,
      clipStartedAt: 0,
      speed: speedOf(clip),
      vy: vyOf(clip, t),
      look: { x: ANCHOR.x + 60 * facing, y: ANCHOR.y - 60 },
      arousal: 0.9,
      contentment: 0.5,
      emote,
      emoteStartedAt: 100,
      opacity: 1,
      visible: true,
      skin: 'black',
      style,
      shadow: true,
      animSpeed: 1,
      ...opts.hints,
    };
    scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : 250, snapped: t === 0 });
    // Overlay-local DIP * dpr: with the overlay at the origin this is px (dpr = scale factor).
    const b = paintedBox(scene, sf);
    if (!Number.isFinite(b.x0)) continue;
    const px = Math.min(b.x0 - p.x, b.y0 - p.y, p.x + p.width - b.x1, p.y + p.height - b.y1);
    const d = px / (size * sf);
    if (d < dip) {
      dip = d;
      where = `t=${t}: ${JSON.stringify(b)} vs ${JSON.stringify(p)}`;
    }
  }
  return { dip, where };
}

describe('presence rect covers the drawn cat', () => {
  it('with >= 6 DIP of headroom for every clip and facing, in both styles, with and without emotes', () => {
    const failures: string[] = [];
    let least = Infinity;
    for (const style of ['smooth', 'pixel'] as RenderStyle[]) {
      for (const emote of [null, 'zzz', 'heart'] as (Emote | null)[]) {
        for (const size of [1, 2.5]) {
          for (const sf of [1, 1.5]) {
            for (const clip of ANIM_CLIPS) {
              for (const facing of [1, -1] as const) {
                const h = headroom(clip, { style, emote, size, sf, facing });
                least = Math.min(least, h.dip);
                if (h.dip < HEADROOM_DIP) failures.push(`${style}/${clip}/f${facing}/${emote}/size${size}/sf${sf} headroom ${h.dip.toFixed(2)} DIP ${h.where}`);
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    expect(least).toBeGreaterThanOrEqual(HEADROOM_DIP);
  }, 120_000);

  it('with >= 6 DIP of headroom under every v1.2 render hint (flight kinds, hard landings, balance)', () => {
    const cases: Array<[AnimClip, Hints]> = [];
    for (const kind of [...JUMP_KINDS, null]) {
      cases.push(['jump', { jumpKind: kind }], ['fall', { jumpKind: kind }]);
    }
    for (const impact of [0, 1]) for (const clip of ['land', 'impact', 'landRecover'] as const) cases.push([clip, { impact }]);
    for (const balance of [0, 1]) for (const clip of ['balance', 'climb'] as const) cases.push([clip, { balance }]);
    const failures: string[] = [];
    for (const style of ['smooth', 'pixel'] as RenderStyle[]) {
      for (const emote of [null, 'heart'] as (Emote | null)[]) {
        for (const [size, sf] of [
          [1, 1],
          [2.5, 1.5],
        ] as const) {
          for (const [clip, hints] of cases) {
            for (const facing of [1, -1] as const) {
              const h = headroom(clip, { style, emote, size, sf, facing, hints });
              if (h.dip < HEADROOM_DIP) failures.push(`${style}/${clip} ${JSON.stringify(hints)}/f${facing}/${emote}/size${size}/sf${sf} headroom ${h.dip.toFixed(2)} DIP ${h.where}`);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 120_000);
});
