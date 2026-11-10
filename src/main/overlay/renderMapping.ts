// Pure mapping from the simulation's world-space output (physical px) to the
// per-overlay render snapshot (overlay-local DIP), and the presence test that
// decides which overlays draw the cat.
import type { CatRenderState } from '../../shared/cat';
import { MAX_PROPS, type RenderProp } from '../../shared/companion';
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
 * extent of every clip). v1.2 (ADR 0003 §8.2): larger, so every clip (the stretch, the
 * sprint, the slip's hanging body, the flight poses) keeps at least 6 DIP of headroom.
 */
export const BODY_MARGIN_SIDE_DIP = 44;
export const BODY_MARGIN_TOP_DIP = 60;
export const BODY_MARGIN_BOTTOM_DIP = 48;
/** Top margin while emotes are enabled (an emote floats above the held cat's head). */
export const EMOTE_MARGIN_TOP_DIP = 84;

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
  /**
   * v1.2: this overlay holds the cat's anchor, so it alone gets the sound cue (a cat straddling two
   * overlays must not play a sound twice). Absent/false: no sound in this snapshot.
   */
  soundOwner?: boolean;
  /** v1.2: settings.sound.volume, carried on the cue. */
  soundVolume?: number;
  /**
   * Living Companion: the target overlay's display bounds (physical px, the same space as SimOutput).
   * With it, only the props that reach this display are sent and the laser dot goes only to the
   * display that holds it; without it every prop is sent and the laser is passed through as given.
   */
  displayBoundsPx?: Rect;
  /** Living Companion: the cursor position in world px while Laser Mode is on; null/absent = no dot. */
  laser?: Point | null;
  /** Living Companion: the user's reduced-motion choice, carried to the renderer (absent = not sent). */
  reducedMotion?: boolean;
}

/**
 * How far past a prop's anchor (in px, from its nominal width) its drawing can reach: just over one
 * size in any direction plus slack for the outline. The renderer's propsBounds pads the same.
 */
const propReachPx = (size: number): number => (Number.isFinite(size) ? Math.max(0, size) * 1.1 + 16 : 16);

/** True when the prop's drawn extent (world px) touches `bounds`. Non-finite positions never do. */
export function propTouchesBounds(p: RenderProp, bounds: Rect): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const r = propReachPx(p.size);
  return p.x + r >= bounds.x && p.x - r <= bounds.x + bounds.width && p.y + r >= bounds.y && p.y - r <= bounds.y + bounds.height;
}

/** Ids of displays that show at least one of the sim's props, whether or not the cat is there. */
export function displaysShowingProps(out: SimOutput, displays: readonly DisplayGeometry[], hidden: boolean): Set<string> {
  const ids = new Set<string>();
  if (hidden || !out.props || out.props.length === 0) return ids;
  for (const d of displays) {
    for (let i = 0; i < out.props.length && i < MAX_PROPS; i++) {
      if (propTouchesBounds(out.props[i]!, d.workAreaPx)) {
        ids.add(d.id);
        break;
      }
    }
  }
  return ids;
}

/** The props for one overlay: world px to overlay-local DIP (sizes divide by the scale factor), at most MAX_PROPS. */
export function mapProps(props: readonly RenderProp[], ctx: Pick<RenderMapContext, 'toLocalDip' | 'scaleFactor' | 'displayBoundsPx'>): RenderProp[] {
  const sf = ctx.scaleFactor > 0 ? ctx.scaleFactor : 1;
  const out: RenderProp[] = [];
  for (let i = 0; i < props.length && out.length < MAX_PROPS; i++) {
    const p = props[i]!;
    if (ctx.displayBoundsPx && !propTouchesBounds(p, ctx.displayBoundsPx)) continue;
    const at = ctx.toLocalDip({ x: p.x, y: p.y });
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    out.push({ id: p.id, kind: p.kind, x: at.x, y: at.y, size: finiteOr(p.size / sf, 0), dir: p.dir, alpha: clamp01(p.alpha), p: clamp01(p.p), rot: finiteOr(p.rot, 0), variant: p.variant });
  }
  return out;
}

/** The laser dot in this overlay's local DIP, or null when it is off, broken, or on another display. */
export function mapLaser(laser: Point | null | undefined, ctx: Pick<RenderMapContext, 'toLocalDip' | 'displayBoundsPx'>): Point | null {
  if (!laser || !Number.isFinite(laser.x) || !Number.isFinite(laser.y)) return null;
  const b = ctx.displayBoundsPx;
  if (b && !(laser.x >= b.x && laser.x < b.x + b.width && laser.y >= b.y && laser.y < b.y + b.height)) return null;
  const at = ctx.toLocalDip(laser);
  return Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x, y: at.y } : null;
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
    // v1.2 render hints: only when the sim sets them (snapshots of a v1.1.1 sim are unchanged).
    ...(out.jumpKind !== undefined ? { jumpKind: out.jumpKind } : {}),
    ...(out.impact !== undefined && Number.isFinite(out.impact) ? { impact: clamp01(out.impact) } : {}),
    ...(out.balance !== undefined && Number.isFinite(out.balance) ? { balance: clamp01(out.balance) } : {}),
    ...(ctx.soundOwner === true && out.sound
      ? { sound: { kind: out.sound.kind, at: out.sound.at, ...(ctx.soundVolume !== undefined && Number.isFinite(ctx.soundVolume) ? { volume: clamp01(ctx.soundVolume) } : {}) } }
      : {}),
    // Living Companion: only the fields the sim/host gave, so a snapshot without them is unchanged.
    ...(out.props !== undefined ? { props: mapProps(out.props, ctx) } : {}),
    ...(out.mood !== undefined ? { mood: out.mood } : {}),
    ...(out.sleepDepth !== undefined && Number.isFinite(out.sleepDepth) ? { sleepDepth: clamp01(out.sleepDepth) } : {}),
    ...(ctx.laser !== undefined ? { laser: mapLaser(ctx.laser, ctx) } : {}),
    ...(ctx.reducedMotion !== undefined ? { reducedMotion: ctx.reducedMotion === true } : {}),
  };
}

/** Final "nothing to draw" frame for an overlay the cat just left. */
export function hiddenRenderState(previous: CatRenderState, seq: number, simNow: number): CatRenderState {
  // Props and the laser dot go with the cat: the overlay draws nothing and keeps no residue.
  return {
    ...previous,
    seq,
    t: simNow,
    visible: false,
    emote: null,
    snap: true,
    ...(previous.props !== undefined ? { props: [] } : {}),
    ...(previous.laser !== undefined ? { laser: null } : {}),
  };
}
