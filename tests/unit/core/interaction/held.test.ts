// The dragged cat hangs from its scruff: the mover slides the grab point there over the
// renderer's cross-fade into `held`, so the cursor ends up holding the drawn scruff.
import { describe, expect, it } from 'vitest';
import type { Point } from '../../../../src/shared/geometry';
import type { WorldGeometry } from '../../../../src/shared/world';
import { Mover, type MoverConfig } from '../../../../src/core/movement';
import { HELD_SCRUFF_DIP, HELD_SETTLE_MS, heldScruffOffset } from '../../../../src/core/interaction/held';
import { crossFadeMs, HELD_SCRUFF } from '../../../../src/renderer/overlay/cat/clips';

function world(scale: number): WorldGeometry {
  const px = { x: 0, y: 0, width: 1920, height: 1080 };
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const dip = (r: typeof px) => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  return { version: 1, displays: [{ id: '1', primary: true, scaleFactor: scale, boundsPx: px, workAreaPx: wa, boundsDip: dip(px), workAreaDip: dip(wa) }] };
}

const CFG: MoverConfig = { size: 1.5, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };

function hold(m: Mover, cursor: Point, ms: number, t0 = 0): Point[] {
  const anchors: Point[] = [];
  for (let t = t0; t <= t0 + ms; t += 16) {
    m.step({ now: t, dtMs: 16, dragCursor: cursor, getWindowRect: () => null, movingWindowIds: new Set() });
    anchors.push({ x: m.x, y: m.y });
  }
  return anchors;
}

describe('held cat scruff alignment', () => {
  it('shares one scruff point and settle time with the renderer clip', () => {
    expect(HELD_SCRUFF).toEqual(HELD_SCRUFF_DIP);
    expect(HELD_SETTLE_MS).toBe(crossFadeMs('stand', 'held'));
  });

  for (const scale of [1, 1.5]) {
    it(`slides a grab on the back to the scruff under the cursor (display scale ${scale})`, () => {
      const m = new Mover(world(scale), CFG, { displayId: '1', xFrac: 0.5 });
      const unit = CFG.size * scale;
      // Grab the standing cat on its back, ~25 DIP above its feet.
      const grab = { x: m.x - 5 * unit, y: m.y - 25 * unit };
      m.startDrag(grab);
      const cursor = { x: grab.x + 40, y: grab.y - 200 };
      const anchors = hold(m, cursor, HELD_SETTLE_MS + 100);
      // First held step: the grabbed point stays under the cursor (no jump).
      expect(anchors[0]!.x - cursor.x).toBeCloseTo(5 * unit, 6);
      expect(anchors[0]!.y - cursor.y).toBeCloseTo(25 * unit, 6);
      // Settled: anchor = cursor + scruff offset, i.e. the scruff is under the cursor.
      const want = heldScruffOffset(m.facing, unit);
      const end = anchors.at(-1)!;
      expect(end.x - cursor.x).toBeCloseTo(want.x, 6);
      expect(end.y - cursor.y).toBeCloseTo(want.y, 6);
      expect(end.y - cursor.y).toBeCloseTo(-HELD_SCRUFF_DIP.y * unit, 6);
      // Smoothly: no step larger than the grab-to-scruff distance / 4.
      const total = Math.hypot(want.x - 5 * unit, want.y - 25 * unit);
      for (let i = 1; i < anchors.length; i++) {
        expect(Math.hypot(anchors[i]!.x - anchors[i - 1]!.x, anchors[i]!.y - anchors[i - 1]!.y)).toBeLessThan(total / 4);
      }
    });
  }

  it('mirrors the scruff with facing and keeps it through the release correction', () => {
    const m = new Mover(world(1), CFG, { displayId: '1', xFrac: 0.5 });
    m.facing = -1;
    m.startDrag({ x: m.x, y: m.y - 10 });
    const cursor = { x: 700, y: 500 };
    hold(m, cursor, HELD_SETTLE_MS + 50);
    expect(m.x - cursor.x).toBeCloseTo(-HELD_SCRUFF_DIP.x * -1 * CFG.size, 6);
    // Releasing at the cursor keeps the cat where it is drawn.
    const x = m.x;
    const y = m.y;
    m.endDrag(cursor, { x: 0, y: 0 }, 1000, false);
    expect(m.x).toBeCloseTo(x, 6);
    expect(m.y).toBeCloseTo(y, 6);
  });
});
