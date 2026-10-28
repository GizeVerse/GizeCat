import { describe, expect, it } from 'vitest';
import { ANIM_CLIPS, CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, EMOTES, SKINS, type AnimClip, type CatRenderState } from '../../../src/shared/cat';
import type { HitRegion } from '../../../src/shared/cat';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { HitRegionReporter } from '../../../src/renderer/overlay/hitRegion';
import { CatScene, type Layer } from '../../../src/renderer/overlay/scene';
import { createMockCtx } from './mockCtx';

function state(clip: AnimClip, t: number, extra: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq: Math.round(t),
    t,
    x: 400,
    y: 300,
    snap: false,
    scale: 1,
    facing: 1,
    state: clip === 'sleep' ? 'sleeping' : 'idle',
    clip,
    clipStartedAt: 0,
    speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : 0,
    vy: clip === 'jump' ? -300 : clip === 'fall' ? 300 : 0,
    look: { x: 450, y: 250 },
    arousal: 0.3,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...extra,
  };
}

function run(scene: CatScene, clip: AnimClip, ms: number, extra: Partial<CatRenderState> = {}): void {
  const dt = 1000 / 60;
  for (let t = 0; t <= ms; t += dt) {
    const s = state(clip, t, extra);
    scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : dt, snapped: t === 0 });
  }
}

describe('hit region of every clip', () => {
  it('is non-empty, inside a sane box around the anchor, and inside the drawn bounds', () => {
    for (const clip of ANIM_CLIPS) {
      for (const phase of [200, 700, 1300, 2600]) {
        const scene = new CatScene(seededRandom(3));
        run(scene, clip, phase);
        expect(scene.hitCount, `${clip}@${phase}`).toBeGreaterThanOrEqual(2);
        let area = 0;
        for (let i = 0; i < scene.hitCount; i++) {
          const r = scene.hitRects[i]!;
          expect(r.width, `${clip} w`).toBeGreaterThan(2);
          expect(r.height, `${clip} h`).toBeGreaterThan(2);
          area += r.width * r.height;
          // Within ~1.6 footprints of the anchor (400, 300).
          expect(r.x).toBeGreaterThan(400 - CAT_BASE_WIDTH_DIP * 1.6);
          expect(r.x + r.width).toBeLessThan(400 + CAT_BASE_WIDTH_DIP * 1.6);
          expect(r.y).toBeGreaterThan(300 - CAT_BASE_HEIGHT_DIP * 2);
          expect(r.y + r.height).toBeLessThan(300 + CAT_BASE_HEIGHT_DIP * 0.8);
          const b = scene.bounds;
          expect(r.x).toBeGreaterThanOrEqual(b.x);
          expect(r.y).toBeGreaterThanOrEqual(b.y);
          expect(r.x + r.width).toBeLessThanOrEqual(b.x + b.width + 1e-6);
          expect(r.y + r.height).toBeLessThanOrEqual(b.y + b.height + 1e-6);
        }
        // Grab-able: at least a few hundred DIP² of cat, not the whole screen.
        expect(area, `${clip} area`).toBeGreaterThan(400);
        expect(area, `${clip} area`).toBeLessThan(CAT_BASE_WIDTH_DIP * CAT_BASE_HEIGHT_DIP * 2.5);
      }
    }
  });

  it('scales with size and mirrors with facing', () => {
    const a = new CatScene(() => 0.99);
    const b = new CatScene(() => 0.99);
    const c = new CatScene(() => 0.99);
    run(a, 'stand', 1000);
    run(b, 'stand', 1000, { scale: 2 });
    run(c, 'stand', 1000, { facing: -1 });
    const w = (s: CatScene): number => s.bounds.width;
    expect(w(b) / w(a)).toBeGreaterThan(1.8);
    expect(w(b) / w(a)).toBeLessThan(2.2);
    // Facing right puts the head (rect 0) right of the anchor; facing left, left of it.
    const headA = a.hitRects[0]!;
    const headC = c.hitRects[0]!;
    expect(headA.x + headA.width / 2).toBeGreaterThan(400);
    expect(headC.x + headC.width / 2).toBeLessThan(400);
  });

  it('excludes the thin tail tip', () => {
    const scene = new CatScene(() => 0.99);
    run(scene, 'stand', 1500);
    const tail = scene.puppet.tail;
    const tipX = 400 + tail.x[tail.count - 1]!;
    const tipY = 300 + tail.y[tail.count - 1]!;
    for (let i = 0; i < scene.hitCount; i++) {
      const r = scene.hitRects[i]!;
      const inside = tipX > r.x && tipX < r.x + r.width && tipY > r.y && tipY < r.y + r.height;
      expect(inside, `tip inside rect ${i}`).toBe(false);
    }
  });
});

describe('scene drawing', () => {
  const layerMock = createMockCtx(512, 512);
  const layer: Layer = { canvas: {} as CanvasImageSource, ctx: layerMock.ctx };

  it('draws every skin in both styles with finite canvas calls', () => {
    for (const skin of SKINS) {
      for (const style of ['smooth', 'pixel'] as const) {
        for (const opacity of [1, 0.5]) {
          const scene = new CatScene(seededRandom(1));
          run(scene, 'walk', 600, { skin, style, opacity, emote: 'heart', emoteStartedAt: 300 });
          const m = createMockCtx();
          scene.draw(m.ctx, 1.25, () => layer);
          expect(m.nonFinite, `${skin}/${style}`).toEqual([]);
          expect(layerMock.nonFinite).toEqual([]);
          const drewImage = m.calls.some((c) => c.name === 'drawImage');
          expect(drewImage, `${skin}/${style}/${opacity} uses a layer`).toBe(style === 'pixel' || opacity < 1);
        }
      }
    }
  });

  it('draws every emote', () => {
    for (const emote of EMOTES) {
      const scene = new CatScene(seededRandom(1));
      run(scene, 'sit', 900, { emote, emoteStartedAt: 400 });
      const m = createMockCtx();
      scene.draw(m.ctx, 1, null);
      expect(m.nonFinite, emote).toEqual([]);
      expect(m.depth()).toBe(0);
    }
  });

  it('draws nothing when invisible', () => {
    const scene = new CatScene(seededRandom(1));
    run(scene, 'stand', 300, { visible: false });
    const m = createMockCtx();
    scene.draw(m.ctx, 1, null);
    expect(m.calls.length).toBe(0);
    expect(scene.isVisible).toBe(false);
  });

  it('turns with a squash instead of an instant mirror, unless snapped', () => {
    const width = (scene: CatScene): number => {
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let i = 0; i < scene.hitCount; i++) {
        const r = scene.hitRects[i]!;
        x0 = Math.min(x0, r.x);
        x1 = Math.max(x1, r.x + r.width);
      }
      return x1 - x0;
    };
    const scene = new CatScene(() => 0.99);
    run(scene, 'stand', 500);
    const before = width(scene);
    const s = state('stand', 600, { facing: -1 });
    scene.update({ x: 400, y: 300, state: s, simTime: 600, dtMs: 60, snapped: false });
    // Mid-turn the cat is visibly narrower than either end pose.
    expect(width(scene)).toBeLessThan(before * 0.9);
    scene.update({ x: 400, y: 300, state: s, simTime: 800, dtMs: 200, snapped: false });
    expect(width(scene)).toBeGreaterThan(before * 0.9);
    // Snapped: the mirror is immediate.
    const other = new CatScene(() => 0.99);
    run(other, 'stand', 500);
    other.update({ x: 400, y: 300, state: state('stand', 600, { facing: -1 }), simTime: 600, dtMs: 16, snapped: true });
    expect(width(other)).toBeGreaterThan(before * 0.9);
    expect(other.hitRects[0]!.x + other.hitRects[0]!.width / 2).toBeLessThan(400);
  });

  it('reports quiet only while asleep and still', () => {
    const scene = new CatScene(() => 0.99);
    run(scene, 'sleep', 2000);
    expect(scene.isQuiet).toBe(true);
    run(scene, 'walk', 300);
    expect(scene.isQuiet).toBe(false);
  });

  it('produces integer device rects covering the bounds', () => {
    const scene = new CatScene(() => 0.99);
    run(scene, 'stand', 500);
    const r = scene.deviceRect(1.5, { x: 0, y: 0, w: 0, h: 0 });
    for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
    expect(r.x).toBeLessThanOrEqual(scene.bounds.x * 1.5);
    expect(r.x + r.w).toBeGreaterThanOrEqual((scene.bounds.x + scene.bounds.width) * 1.5);
  });
});

describe('hit region reporter', () => {
  const rect = (x: number) => ({ x, y: 10, width: 30, height: 20 });

  it('sends on change > tolerance, at most ~15 Hz, and catches up later', () => {
    const sent: HitRegion[] = [];
    const rep = new HitRegionReporter((r) => sent.push(r));
    expect(rep.update([rect(0)], 1, 0)).toBe(true);
    expect(rep.update([rect(1.5)], 1, 100)).toBe(false); // within tolerance
    expect(rep.update([rect(10)], 1, 120)).toBe(true);
    expect(rep.update([rect(20)], 1, 150)).toBe(false); // rate limited
    expect(rep.update([rect(20)], 1, 190)).toBe(true); // caught up
    expect(sent.map((s) => s.rects[0]!.x)).toEqual([0, 10, 20]);
  });

  it('clears immediately and only once', () => {
    const sent: HitRegion[] = [];
    const rep = new HitRegionReporter((r) => sent.push(r));
    rep.update([rect(0)], 1, 0);
    expect(rep.clear(5)).toBe(true);
    expect(rep.clear(6)).toBe(false);
    expect(sent[1]!.rects).toEqual([]);
    expect(rep.update([rect(0)], 1, 200)).toBe(true);
  });

  it('drops invalid rects and caps the count at 8', () => {
    const sent: HitRegion[] = [];
    const rep = new HitRegionReporter((r) => sent.push(r));
    const rects = [
      { x: Number.NaN, y: 0, width: 5, height: 5 },
      { x: 0, y: 0, width: -5, height: 5 },
      ...Array.from({ length: 12 }, (_, i) => rect(i * 50)),
    ];
    rep.update(rects, rects.length, 0);
    expect(sent[0]!.rects.length).toBeLessThanOrEqual(8);
    for (const r of sent[0]!.rects) expect(Number.isFinite(r.x) && r.width > 0).toBe(true);
  });

  it('survives a throwing sender', () => {
    const rep = new HitRegionReporter(() => {
      throw new Error('bridge gone');
    });
    expect(rep.update([rect(0)], 1, 0)).toBe(false);
  });
});
