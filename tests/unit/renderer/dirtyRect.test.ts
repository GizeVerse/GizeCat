// Dirty-rect invariant of the overlay renderer: everything CatScene.draw paints lies
// inside CatScene.deviceRect. The runtime clears the union of the previous and the
// current deviceRect before drawing (and the previous one when the cat leaves), so any
// pixel painted outside it would stay on the desktop as a ghost.
import { describe, expect, it } from 'vitest';
import { EMOTES, type AnimClip, type CatRenderState, type Emote, type RenderStyle, type SkinId } from '../../../src/shared/cat';
import { drawEmote, EMOTE_RADIUS, EMOTE_SIZE, emoteFrame, type EmoteFrame } from '../../../src/renderer/overlay/cat/emotes';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { CatScene, type DeviceRect, type Layer } from '../../../src/renderer/overlay/scene';
import { boxInside, createExtentCtx, type Box } from './extentCtx';

interface Case {
  style: RenderStyle;
  skin: SkinId;
  scale: number;
  dpr: number;
  clip: AnimClip;
  emote: Emote | null;
  opacity: number;
}

function state(c: Case, t: number, x: number): CatRenderState {
  return {
    seq: Math.round(t),
    t,
    x,
    y: 700,
    snap: false,
    scale: c.scale,
    facing: 1,
    state: c.clip === 'sleep' ? 'sleeping' : 'idle',
    clip: c.clip,
    clipStartedAt: 0,
    speed: c.clip === 'run' ? 2.5 : 0,
    vy: 0,
    look: null,
    arousal: 0.9,
    contentment: 0.5,
    emote: c.emote,
    emoteStartedAt: 200,
    opacity: c.opacity,
    visible: true,
    skin: c.skin,
    style: c.style,
    shadow: true,
    animSpeed: 1,
  };
}

/** Draws a cat moving right over 1.6 s; returns the first violation or null. */
function check(c: Case): string | null {
  const scene = new CatScene(seededRandom(5));
  const main = createExtentCtx();
  const lay = createExtentCtx();
  let layerSize = { w: 0, h: 0 };
  const layer: Layer = { canvas: {} as CanvasImageSource, ctx: lay.ctx };
  const rect: DeviceRect = { x: 0, y: 0, w: 0, h: 0 };
  for (let t = 0; t <= 1600; t += 100) {
    const s = state(c, t, 600 + t * 0.13);
    scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : 100, snapped: t === 0 });
    main.reset();
    lay.reset();
    scene.deviceRect(c.dpr, rect);
    scene.draw(main.ctx, c.dpr, (w, h) => {
      layerSize = { w, h };
      return layer;
    });
    const tag = `${c.style}/${c.skin}/${c.clip}/${c.emote}/s${c.scale}/dpr${c.dpr}/o${c.opacity} t=${t}`;
    // Anti-aliasing touches every pixel the geometry overlaps: compare whole pixels.
    const px = (b: Box): Box => ({ x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) });
    const box = px(main.box);
    if (!boxInside(box, rect)) {
      return `${tag}: painted ${JSON.stringify(box)} outside dirty rect ${JSON.stringify(rect)}`;
    }
    const lb = px(lay.box);
    if (main.images.length > 0 && !boxInside(lb, { x: 0, y: 0, w: layerSize.w, h: layerSize.h })) {
      return `${tag}: layer content ${JSON.stringify(lb)} clipped by layer ${layerSize.w}x${layerSize.h}`;
    }
  }
  return null;
}

describe('emote extent', () => {
  it('every emote stays within EMOTE_RADIUS of its origin over its whole life', () => {
    for (const emote of EMOTES) {
      const f: EmoteFrame = { scale: 0, alpha: 0, rise: 0, wobble: 0, age: 0 };
      for (let age = 0; age < 1600; age += 10) {
        if (!emoteFrame(age, f)) continue;
        const x = createExtentCtx();
        drawEmote(x.ctx, emote, EMOTE_SIZE, f);
        const b = x.box;
        const r = Math.max(-b.x0, -b.y0, b.x1, b.y1);
        expect(r, `${emote}@${age}`).toBeLessThanOrEqual(EMOTE_RADIUS);
      }
    }
  });
});

describe('dirty rect covers everything drawn', () => {
  it('pixel style with the halo skins, emotes, sizes and DPRs (blocks reach past the bounds)', () => {
    const failures: string[] = [];
    for (const skin of ['black', 'tuxedo', 'ginger'] as const) {
      for (const scale of [1, 1.5, 2.5]) {
        for (const dpr of [1, 1.25, 1.5, 2]) {
          for (const clip of ['stand', 'run', 'hide', 'held', 'sleep'] as const) {
            for (const emote of [null, 'zzz'] as const) {
              const f = check({ style: 'pixel', skin, scale, dpr, clip, emote, opacity: 1 });
              if (f) failures.push(f);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('smooth style, opaque and translucent', () => {
    const failures: string[] = [];
    for (const skin of ['black', 'ginger'] as const) {
      for (const scale of [0.5, 1, 2.5]) {
        for (const dpr of [1, 1.25, 2]) {
          for (const clip of ['stand', 'run', 'held', 'crouch'] as const) {
            for (const opacity of [1, 0.5]) {
              const f = check({ style: 'smooth', skin, scale, dpr, clip, emote: 'zzz', opacity });
              if (f) failures.push(f);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});
