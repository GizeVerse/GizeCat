// The floating cat's "stage" (Living Companion): world events put small props on the floor away from
// the cat, and the laser dot can sit anywhere the cat's touch window or the app's own window reported
// a pointer. The visual window is normally only the cat and its margins (overlaySurface.ts), so for
// as long as props or the dot exist it widens into one wide, short strip that holds the cat, the
// props and the dot, and shrinks back once they are gone.
//
// Rules, all in screen dp (the world's own unit on this host):
// - the stage is the union of the cat's normal window, the padded props and dot bounds and some slack,
//   with everything but the cat's own window clipped to the physical screen (the normal window may
//   hang over an edge, so it is never cut);
// - it is STICKY: while props exist it only grows, and a frame whose needs already fit changes
//   nothing, so the window is not re-placed (and the origin does not move) while the cat and the props
//   wander inside it. Slack makes the few growth steps rare;
// - it shrinks back only after the props and the dot have been gone for STAGE_HOLD_MS (so a quick
//   succession of events does not thrash the WindowManager), or at once when the cat has left it;
// - the window's origin moves only when the stage appears, grows to the left or top, or disappears:
//   `reorigin` says so, and the host forces a snap on that frame because every overlay-local
//   coordinate shifts with the origin (overlayDisplay.ts);
// - the size never exceeds the protocol's stage caps (floatingProtocol.ts); the touch window is not
//   part of this at all.
//
// Pure: no DOM types, no globals, no clock of its own.
import type { Rect } from '../shared/geometry';
import { STAGE_MAX_H_DP, STAGE_MAX_W_DP } from './floatingProtocol';

/** Room around the props' and the dot's own bounds, dp. */
export const STAGE_PAD_DP = 12;
/** Extra room added in every direction when the stage has to grow, dp: so the next few steps of the cat or a prop fit already. */
export const STAGE_SLACK_DP = 96;
/** The stage lingers this long after the last prop and the dot are gone, ms. */
export const STAGE_HOLD_MS = 1500;

const EPS = 1e-6;

const finite = (n: number): boolean => Number.isFinite(n);
const valid = (r: Rect | null | undefined): r is Rect => r !== null && r !== undefined && finite(r.x) && finite(r.y) && finite(r.width) && finite(r.height) && r.width > 0 && r.height > 0;

export function unionRects(rects: readonly (Rect | null | undefined)[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (!valid(r)) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

export function growRect(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by };
}

/** The overlap of two rectangles, or null when they do not overlap. */
export function intersectRects(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** True when `inner` lies inside `outer` (to a tiny tolerance). */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;
}

/** Widens outward to whole device pixels (`density` px per dp), so the window and the page agree to the pixel. */
export function snapRectOut(r: Rect, density: number): Rect {
  const d = finite(density) && density > 0 ? density : 1;
  const x0 = Math.floor(r.x * d + EPS) / d;
  const y0 = Math.floor(r.y * d + EPS) / d;
  const x1 = Math.ceil((r.x + r.width) * d - EPS) / d;
  const y1 = Math.ceil((r.y + r.height) * d - EPS) / d;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Cuts one axis down to `cap`, keeping the span [keepLo, keepHi] (the cat's own window, never larger
 * than the cap) inside it and as much of the rest as fits around it.
 */
function capAxis(lo: number, size: number, cap: number, keepLo: number, keepHi: number): { lo: number; size: number } {
  if (size <= cap) return { lo, size };
  const minLo = keepHi - cap;
  const maxLo = keepLo;
  return { lo: Math.min(maxLo, Math.max(minLo, lo)), size: cap };
}

/** Never larger than the protocol's stage caps; the cat's own window stays inside whatever is cut. */
export function capStage(r: Rect, cat: Rect): Rect {
  const cx = capAxis(r.x, r.width, STAGE_MAX_W_DP, cat.x, cat.x + cat.width);
  const cy = capAxis(r.y, r.height, STAGE_MAX_H_DP, cat.y, cat.y + cat.height);
  return { x: cx.lo, y: cy.lo, width: cx.size, height: cy.size };
}

/**
 * What the stage must hold right now: the cat's window plus `pad` around every extra, the extras
 * clipped to the screen. Just the cat's window (null extras) when there is nothing else to hold.
 */
export function stageNeed(cat: Rect, extras: readonly (Rect | null | undefined)[], screen: Rect, pad: number): Rect {
  const e = unionRects(extras.filter(valid).map((r) => growRect(r, pad)));
  if (!e) return cat;
  const clipped = intersectRects(e, screen);
  const u = unionRects([cat, clipped]);
  return capStage(u ?? cat, cat);
}

export interface StageInput {
  /** The page's monotonic clock, ms. */
  now: number;
  /** The cat's normal window (windowRectFor), whole device pixels. */
  catWin: Rect;
  /** Props bounds and the laser dot's bounds, world dp; null or invalid entries are ignored. */
  extras: readonly (Rect | null | undefined)[];
  /** The physical screen, dp: {0, 0, width, height}. */
  screen: Rect;
  density: number;
}

export interface StageResult {
  /** The visual window to ask native for. */
  rect: Rect;
  /** The window is wider than the cat's normal one. */
  extended: boolean;
  /** The window's origin moved discontinuously (appeared, moved or went away): force a snap on this frame. */
  reorigin: boolean;
}

export interface StageTracker {
  plan(input: StageInput): StageResult;
  /** Drops the stage (the cat is gone, or the screen changed under it). The next plan is a fresh start. */
  reset(): void;
  readonly extended: boolean;
}

export function createStageTracker(holdMs: number = STAGE_HOLD_MS): StageTracker {
  let stage: Rect | null = null;
  let lastNeedAt = Number.NEGATIVE_INFINITY;
  let last: { rect: Rect; extended: boolean } | null = null;

  return {
    plan(input) {
      const { now, catWin, screen, density } = input;
      const wanted = input.extras.some(valid);
      if (wanted) lastNeedAt = now;
      let rect: Rect;
      if (wanted) {
        const need = stageNeed(catWin, input.extras, screen, STAGE_PAD_DP);
        if (stage && containsRect(stage, need)) {
          rect = stage;
        } else {
          // Grow with slack, never shrink while props exist.
          const roomy = stageNeed(catWin, input.extras, screen, STAGE_PAD_DP + STAGE_SLACK_DP);
          const catRoom = intersectRects(growRect(catWin, STAGE_SLACK_DP), screen);
          const target = unionRects([stage, roomy, catRoom, catWin]) ?? catWin;
          rect = snapRectOut(capStage(target, catWin), density);
          stage = rect;
        }
      } else if (stage && now - lastNeedAt < holdMs && containsRect(stage, catWin)) {
        rect = stage;
      } else {
        stage = null;
        rect = catWin;
      }
      const extended = stage !== null;
      // In the normal mode the window follows the cat every frame (the cat is drawn at a constant spot of it),
      // so only the switch between the two modes and a move of the fixed stage are discontinuities.
      const reorigin = last !== null && (last.extended !== extended || (extended && (last.rect.x !== rect.x || last.rect.y !== rect.y)));
      last = { rect, extended };
      return { rect, extended, reorigin };
    },
    reset() {
      stage = null;
      lastNeedAt = Number.NEGATIVE_INFINITY;
      last = null;
    },
    get extended() {
      return stage !== null;
    },
  };
}
