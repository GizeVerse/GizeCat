// Pure mapping from the simulation's world-space output (physical px) to the
// per-overlay render snapshot (overlay-local DIP), and the presence test that
// decides which overlays draw the cat.
import type { CatRenderState } from '../../shared/cat';
import { rectIntersection, type Point, type Rect } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import type { SimOutput } from '../../shared/sim';
import type { DisplayGeometry } from '../../shared/world';

/**
 * Room around the nominal footprint (CAT_BASE_* DIP, `boundsPx`) that the renderer may
 * draw into, DIP at size 1: tail and paws reach past the sides (crouch, run), the held
 * cat hangs its head and ears above the footprint and its legs below it, a cat climbing
 * a wall reaches about one body length up and lets its tail hang below its hind paws
 * (to ~37 DIP while climbing, pixel style), and pixel style rounds every edge out to whole
 * blocks. An overlay draws the cat whenever this rect touches its display, so nothing is
 * clipped at a monitor seam (tests/unit/renderer/presence.test.ts measures the drawn
 * extent of every clip).
 */
export const BODY_MARGIN_SIDE_DIP = 32;
export const BODY_MARGIN_TOP_DIP = 36;
export const BODY_MARGIN_BOTTOM_DIP = 40;
/** Top margin while emotes are enabled (an emote floats above the held cat's head). */
export const EMOTE_MARGIN_TOP_DIP = 64;

export type Appearance = Settings['appearance'];

export interface RenderMapContext {
  seq: number;
  /** Overlay-local DIP conversion for the target overlay's display. */
  toLocalDip: (p: Point) => Point;
  /** Scale factor of the target overlay's display (px per DIP). */
  scaleFactor: number;
  /** Force snap (first frame on this overlay, recreated overlay, display change). */
  forceSnap: boolean;
  /** Cat hidden by the user: the renderer draws nothing. */
  hidden: boolean;
  simNow: number;
  /** settings.behavior.movementSpeed (the renderer times its wall-transition fades with it); absent = 1. */
  movementSpeed?: number;
}

/** Cat bounds plus emote/body margins, physical px. */
export function presenceRectPx(out: SimOutput, appearance: Appearance, scaleFactor: number): Rect {
  const k = appearance.size * scaleFactor;
  const top = (appearance.emotes ? EMOTE_MARGIN_TOP_DIP : BODY_MARGIN_TOP_DIP) * k;
  const side = BODY_MARGIN_SIDE_DIP * k;
  const bottom = BODY_MARGIN_BOTTOM_DIP * k;
  const b = out.boundsPx;
  return { x: b.x - side, y: b.y - top, width: b.width + side * 2, height: b.height + top + bottom };
}

/** Ids of displays whose overlay must draw the cat this tick. */
export function displaysShowingCat(out: SimOutput, displays: readonly DisplayGeometry[], appearance: Appearance, hidden: boolean): Set<string> {
  const ids = new Set<string>();
  if (hidden || !out.visible) return ids;
  for (const d of displays) {
    if (rectIntersection(presenceRectPx(out, appearance, d.scaleFactor), d.workAreaPx)) ids.add(d.id);
  }
  return ids;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const finiteOr = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

export function mapRenderState(out: SimOutput, appearance: Appearance, ctx: RenderMapContext): CatRenderState {
  const anchor = ctx.toLocalDip({ x: out.x, y: out.y });
  const look = out.look ? ctx.toLocalDip(out.look) : null;
  const sf = ctx.scaleFactor > 0 ? ctx.scaleFactor : 1;
  return {
    seq: ctx.seq,
    t: ctx.simNow,
    x: finiteOr(anchor.x, 0),
    y: finiteOr(anchor.y, 0),
    snap: out.snap || ctx.forceSnap,
    scale: appearance.size,
    facing: out.facing,
    state: out.state,
    clip: out.clip,
    clipStartedAt: out.clipStartedAt,
    speed: finiteOr(out.speed, 0),
    vy: finiteOr(out.vy / sf, 0),
    look: look && Number.isFinite(look.x) && Number.isFinite(look.y) ? { x: look.x, y: look.y } : null,
    arousal: clamp01(out.arousal),
    contentment: clamp01(out.contentment),
    emote: appearance.emotes ? out.emote : null,
    emoteStartedAt: out.emoteStartedAt,
    // The simulation's opacity already includes appearance.opacity (times its fade).
    opacity: clamp01(out.opacity),
    visible: out.visible && !ctx.hidden,
    skin: appearance.skin,
    style: appearance.style,
    shadow: appearance.shadow,
    animSpeed: appearance.animationSpeed,
    reaction: out.reaction ? { kind: out.reaction.kind, at: out.reaction.at } : null,
    ...(ctx.movementSpeed !== undefined && Number.isFinite(ctx.movementSpeed) && ctx.movementSpeed > 0 ? { movementSpeed: ctx.movementSpeed } : {}),
  };
}

/** Final "nothing to draw" frame for an overlay the cat just left. */
export function hiddenRenderState(previous: CatRenderState, seq: number, simNow: number): CatRenderState {
  return { ...previous, seq, t: simNow, visible: false, emote: null, snap: true };
}
