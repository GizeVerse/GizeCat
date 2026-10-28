// Pure mapping from the simulation's world-space output (physical px) to the
// per-overlay render snapshot (overlay-local DIP), and the presence test that
// decides which overlays draw the cat.
import type { CatRenderState } from '../../shared/cat';
import { rectIntersection, type Point, type Rect } from '../../shared/geometry';
import type { Settings } from '../../shared/settings';
import type { SimOutput } from '../../shared/sim';
import type { DisplayGeometry } from '../../shared/world';

/** Extra room above the head for emotes and around the body for tail/ears, DIP at size 1. */
export const EMOTE_MARGIN_TOP_DIP = 56;
export const BODY_MARGIN_DIP = 16;

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
}

/** Cat bounds plus emote/body margins, physical px. */
export function presenceRectPx(out: SimOutput, appearance: Appearance, scaleFactor: number): Rect {
  const k = appearance.size * scaleFactor;
  const top = (appearance.emotes ? EMOTE_MARGIN_TOP_DIP : BODY_MARGIN_DIP) * k;
  const side = BODY_MARGIN_DIP * k;
  const b = out.boundsPx;
  return { x: b.x - side, y: b.y - top, width: b.width + side * 2, height: b.height + top + side };
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
    opacity: clamp01(out.opacity * appearance.opacity),
    visible: out.visible && !ctx.hidden,
    skin: appearance.skin,
    style: appearance.style,
    shadow: appearance.shadow,
    animSpeed: appearance.animationSpeed,
  };
}

/** Final "nothing to draw" frame for an overlay the cat just left. */
export function hiddenRenderState(previous: CatRenderState, seq: number, simNow: number): CatRenderState {
  return { ...previous, seq, t: simNow, visible: false, emote: null, snap: true };
}
