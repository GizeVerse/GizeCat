// The floating cat's stage (src/web/stageWindow.ts): the union of the cat's window, the props and the
// laser dot, its stickiness, the shrink hysteresis, the caps and the re-origin flag. Pure math, no DOM.
// Written for the Living Companion sprint and NOT RUN by the agent that wrote it (owner rule: no tests).
import { describe, expect, it } from 'vitest';
import { STAGE_MAX_H_DP, STAGE_MAX_W_DP } from '../../../src/web/floatingProtocol';
import { capStage, containsRect, createStageTracker, intersectRects, snapRectOut, STAGE_HOLD_MS, STAGE_PAD_DP, STAGE_SLACK_DP, stageNeed, unionRects } from '../../../src/web/stageWindow';

const SCREEN = { x: 0, y: 0, width: 1280, height: 800 };
const CAT = { x: 600, y: 600, width: 172, height: 172 };
const MOUSE = { x: 100, y: 700, width: 60, height: 40 };

describe('stage rectangle math', () => {
  it('unions valid rectangles and ignores broken ones', () => {
    expect(unionRects([{ x: 0, y: 0, width: 10, height: 10 }, null, { x: 20, y: 5, width: 10, height: 10 }, { x: Number.NaN, y: 0, width: 1, height: 1 }])).toEqual({ x: 0, y: 0, width: 30, height: 15 });
    expect(unionRects([null, undefined])).toBeNull();
  });

  it('intersects and tests containment', () => {
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 })).toBeNull();
    expect(containsRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 1, width: 9, height: 9 })).toBe(true);
    expect(containsRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 1, y: 1, width: 10, height: 9 })).toBe(false);
  });

  it('widens outward to whole device pixels', () => {
    const r = snapRectOut({ x: 10.1, y: 20.1, width: 50.2, height: 30.2 }, 2.625);
    for (const v of [r.x, r.y, r.x + r.width, r.y + r.height]) expect(v * 2.625).toBeCloseTo(Math.round(v * 2.625), 6);
    expect(containsRect(r, { x: 10.1, y: 20.1, width: 50.2, height: 30.2 })).toBe(true);
  });

  it('needs only the cat window when there is nothing else, and the union with padded extras otherwise', () => {
    expect(stageNeed(CAT, [null, null], SCREEN, STAGE_PAD_DP)).toEqual(CAT);
    const need = stageNeed(CAT, [MOUSE], SCREEN, STAGE_PAD_DP);
    expect(need.x).toBe(MOUSE.x - STAGE_PAD_DP);
    expect(need.x + need.width).toBe(CAT.x + CAT.width);
    expect(containsRect(need, CAT)).toBe(true);
    expect(containsRect(need, MOUSE)).toBe(true);
  });

  it('clips the extras to the screen but never cuts the cat window that hangs over an edge', () => {
    const hanging = { x: -40, y: 600, width: 172, height: 172 };
    const need = stageNeed(hanging, [{ x: -500, y: 700, width: 60, height: 40 }], SCREEN, STAGE_PAD_DP);
    expect(need.x).toBe(-40);
    // An extra entirely off screen adds nothing.
    expect(stageNeed(CAT, [{ x: 5000, y: 5000, width: 10, height: 10 }], SCREEN, STAGE_PAD_DP)).toEqual(CAT);
  });

  it('caps the size at the protocol limits and keeps the cat window inside', () => {
    const huge = { x: -10_000, y: -10_000, width: 30_000, height: 30_000 };
    const cat = { x: 500, y: 500, width: 172, height: 172 };
    const capped = capStage(huge, cat);
    expect(capped.width).toBe(STAGE_MAX_W_DP);
    expect(capped.height).toBe(STAGE_MAX_H_DP);
    expect(containsRect(capped, cat)).toBe(true);
  });
});

describe('stage tracker', () => {
  const plan = (t: ReturnType<typeof createStageTracker>, now: number, extras: ({ x: number; y: number; width: number; height: number } | null)[], cat = CAT) =>
    t.plan({ now, catWin: cat, extras, screen: SCREEN, density: 2 });

  it('is the cat window when nothing else exists', () => {
    const t = createStageTracker();
    const r = plan(t, 0, [null]);
    expect(r.rect).toEqual(CAT);
    expect(r.extended).toBe(false);
    expect(r.reorigin).toBe(false);
  });

  it('widens when a prop appears away from the cat, with slack, and flags the re-origin once', () => {
    const t = createStageTracker();
    plan(t, 0, [null]);
    const r = plan(t, 16, [MOUSE]);
    expect(r.extended).toBe(true);
    expect(r.reorigin).toBe(true);
    expect(containsRect(r.rect, CAT)).toBe(true);
    expect(containsRect(r.rect, MOUSE)).toBe(true);
    // Slack beyond the padded need (clipped to the screen's left edge here).
    expect(r.rect.x).toBeLessThan(MOUSE.x - STAGE_PAD_DP);
    expect(r.rect.width).toBeGreaterThan(CAT.x + CAT.width - (MOUSE.x - STAGE_PAD_DP));
    expect(STAGE_SLACK_DP).toBeGreaterThan(0);
    const again = plan(t, 32, [MOUSE]);
    expect(again.rect).toEqual(r.rect);
    expect(again.reorigin).toBe(false);
  });

  it('holds still while the cat and the props move inside it (no re-origin, no new rectangle)', () => {
    const t = createStageTracker();
    const first = plan(t, 0, [MOUSE]);
    const moved = plan(t, 16, [{ ...MOUSE, x: MOUSE.x + 20 }], { ...CAT, x: CAT.x - 10 });
    expect(moved.rect).toEqual(first.rect);
    expect(moved.reorigin).toBe(false);
  });

  it('only grows while props exist, and re-origins when it grows upwards', () => {
    const t = createStageTracker();
    const first = plan(t, 0, [MOUSE]);
    const tall = plan(t, 16, [{ x: 300, y: 50, width: 36, height: 36 }]);
    expect(tall.rect.y).toBeLessThan(first.rect.y);
    expect(containsRect(tall.rect, first.rect)).toBe(true);
    expect(tall.reorigin).toBe(true);
    // The smaller need again: the stage does not shrink while props exist.
    const narrow = plan(t, 32, [MOUSE]);
    expect(narrow.rect).toEqual(tall.rect);
    expect(narrow.reorigin).toBe(false);
  });

  it('shrinks back only after the hold, and flags the re-origin then', () => {
    const t = createStageTracker();
    const first = plan(t, 0, [MOUSE]);
    const during = plan(t, STAGE_HOLD_MS - 1, [null]);
    expect(during.extended).toBe(true);
    expect(during.rect).toEqual(first.rect);
    expect(during.reorigin).toBe(false);
    const after = plan(t, STAGE_HOLD_MS + 1, [null]);
    expect(after.extended).toBe(false);
    expect(after.rect).toEqual(CAT);
    expect(after.reorigin).toBe(true);
  });

  it('a prop that returns during the hold keeps the same stage (no thrash)', () => {
    const t = createStageTracker();
    const first = plan(t, 0, [MOUSE]);
    plan(t, 800, [null]);
    const back = plan(t, 1200, [MOUSE]);
    expect(back.rect).toEqual(first.rect);
    expect(back.reorigin).toBe(false);
    // The hold counts from the last time something was needed.
    expect(plan(t, 1200 + STAGE_HOLD_MS - 1, [null]).extended).toBe(true);
  });

  it('drops the stage at once when the cat leaves it', () => {
    const t = createStageTracker();
    plan(t, 0, [MOUSE]);
    const away = plan(t, 100, [null], { x: 10_000, y: 600, width: 172, height: 172 });
    expect(away.extended).toBe(false);
    expect(away.reorigin).toBe(true);
  });

  it('a laser dot far from the cat is held too, and reset forgets the stage', () => {
    const t = createStageTracker();
    const dot = { x: 1000, y: 100, width: 36, height: 36 };
    const r = plan(t, 0, [dot]);
    expect(containsRect(r.rect, dot)).toBe(true);
    t.reset();
    expect(t.extended).toBe(false);
    expect(plan(t, 10, [null]).rect).toEqual(CAT);
  });

  it('never exceeds the stage caps', () => {
    const t = createStageTracker();
    const r = t.plan({ now: 0, catWin: CAT, extras: [{ x: -9000, y: -9000, width: 20_000, height: 20_000 }], screen: { x: -9000, y: -9000, width: 20_000, height: 20_000 }, density: 1 });
    expect(r.rect.width).toBeLessThanOrEqual(STAGE_MAX_W_DP);
    expect(r.rect.height).toBeLessThanOrEqual(STAGE_MAX_H_DP);
    expect(containsRect(r.rect, CAT)).toBe(true);
  });
});
