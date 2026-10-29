// The presence rect main uses to decide which overlays draw the cat must contain
// everything the renderer can paint, or a sliver of tail, ears or emote is clipped at
// a monitor seam (the neighbouring overlay is not drawing yet).
import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, type CatRenderState, type Emote, type RenderStyle } from '../../../src/shared/cat';
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

describe('presence rect covers the drawn cat', () => {
  it('for every clip and facing, in both styles, with and without emotes', () => {
    const failures: string[] = [];
    for (const style of ['smooth', 'pixel'] as RenderStyle[]) {
      for (const emote of [null, 'zzz', 'heart'] as (Emote | null)[]) {
        for (const size of [1, 2.5]) {
          for (const sf of [1, 1.5]) {
            const appearance = { ...defaultSettings().appearance, size, emotes: emote !== null, style };
            const p = presenceRectPx(simOutput(size, sf), appearance, sf);
            for (const clip of ANIM_CLIPS) {
              for (const facing of [1, -1] as const) {
                const scene = new CatScene(seededRandom(11));
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
                    speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : 0,
                    vy: clip === 'jump' ? -300 : clip === 'fall' ? 300 : 0,
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
                  };
                  scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : 250, snapped: t === 0 });
                  // Overlay-local DIP * dpr: with the overlay at the origin this is px (dpr = scale factor).
                  const b = paintedBox(scene, sf);
                  if (!Number.isFinite(b.x0)) continue;
                  const tol = 1;
                  if (b.x0 < p.x - tol || b.y0 < p.y - tol || b.x1 > p.x + p.width + tol || b.y1 > p.y + p.height + tol) {
                    failures.push(`${style}/${clip}/f${facing}/${emote}/size${size}/sf${sf} t=${t}: ${JSON.stringify(b)} vs ${JSON.stringify(p)}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  }, 120_000);
});
