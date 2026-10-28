// End to end: where the mover holds a dragged cat and where the renderer draws its
// scruff agree, so the cat hangs from the cursor instead of an empty point.
import { describe, expect, it } from 'vitest';
import type { CatRenderState } from '../../../src/shared/cat';
import type { WorldGeometry } from '../../../src/shared/world';
import { Mover } from '../../../src/core/movement';
import { HELD_SCRUFF_DIP, HELD_SETTLE_MS } from '../../../src/core/interaction/held';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import { applyMatX, applyMatY } from '../../../src/renderer/overlay/cat/rig';
import { CatScene } from '../../../src/renderer/overlay/scene';

const WORLD: WorldGeometry = {
  version: 1,
  displays: [
    {
      id: '1',
      primary: true,
      scaleFactor: 1,
      boundsPx: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaPx: { x: 0, y: 0, width: 1920, height: 1040 },
      boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaDip: { x: 0, y: 0, width: 1920, height: 1040 },
    },
  ],
};

describe('held cat: mover and renderer agree on the scruff', () => {
  for (const facing of [1, -1] as const) {
    it(`draws the scruff under the cursor (facing ${facing})`, () => {
      const size = 1.5;
      const m = new Mover(WORLD, { size, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true }, { displayId: '1', xFrac: 0.5 });
      m.facing = facing;
      // Grabbed near the feet: the worst case before the fix (scruff ~50 DIP above the hand).
      m.startDrag({ x: m.x, y: m.y - 5 });
      const cursor = { x: 900, y: 400 };
      const scene = new CatScene(seededRandom(2));
      for (let t = 0; t <= HELD_SETTLE_MS + 400; t += 16) {
        m.step({ now: t, dtMs: 16, dragCursor: cursor, getWindowRect: () => null, movingWindowIds: new Set() });
        const s: CatRenderState = {
          seq: t,
          t,
          x: m.x,
          y: m.y,
          snap: false,
          scale: size,
          facing: m.facing,
          state: 'held',
          clip: 'held',
          clipStartedAt: 0,
          speed: 0,
          vy: 0,
          look: null,
          arousal: 0.5,
          contentment: 0.4,
          emote: null,
          emoteStartedAt: 0,
          opacity: 1,
          visible: true,
          skin: 'ginger',
          style: 'smooth',
          shadow: true,
          animSpeed: 1,
        };
        scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : 16, snapped: t === 0 });
      }
      // The posed scruff in overlay DIP (scale-1 display: DIP = px).
      const mat = scene.puppet.rig.m;
      const sx = HELD_SCRUFF_DIP.x;
      const sy = HELD_SCRUFF_DIP.y;
      const X = m.x + facing * size * applyMatX(mat, sx, sy);
      const Y = m.y + size * applyMatY(mat, sx, sy);
      expect(Math.abs(X - cursor.x)).toBeLessThan(1.5);
      expect(Math.abs(Y - cursor.y)).toBeLessThan(1.5);
    });
  }
});
