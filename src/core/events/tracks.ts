// Closed-form prop motion for the world-event engine. A Track is a prop's whole visible life as a few
// timed segments (straight leg + parabolic arc + sideways sway), evaluated from the event clock alone:
// no per-prop integration, so a long frame (or a half-speed clock under reducedMotion) can never
// tunnel a prop through the stage or leave it in a state the next tick cannot explain. Pure and
// platform-agnostic (src/core): no DOM, no clock, no randomness (the builders draw once, up front).
import type { PropKind, RenderProp } from '../../shared/companion';

export type Ease = 'lin' | 'out' | 'in' | 'inout';

/** One leg of a prop's path, in event-clock ms and world px. y grows downwards; `arc` lifts the middle of the leg UP by that many px. */
export interface Seg {
  t0: number;
  t1: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  arc: number;
  /** Sideways wobble amplitude (px), perpendicular to the dominant direction of travel, zero at both ends of the leg. */
  sway: number;
  swayHz: number;
  ease: Ease;
}

export interface Track {
  kind: PropKind;
  size: number;
  variant: number;
  /** Visible life, event clock ms. */
  t0: number;
  t1: number;
  segs: Seg[];
  fadeIn: number;
  fadeOut: number;
  /** Peak alpha 0..1. */
  peak: number;
  /** 'heading': nose along the path; 'sway': gentle rocking; 'spin': `spinTurns` full turns over the life; 'none'. */
  tilt: 'none' | 'heading' | 'sway' | 'spin';
  spinTurns: number;
  /** `p` is the life fraction ('life') or a repeating animation phase at `hz` ('phase'). */
  pMode: 'life' | 'phase';
  hz: number;
  /** Alpha twinkle frequency (0 = steady). */
  blinkHz: number;
  /** Size multiplier at the start and at the end of the life (linear in between). */
  growFrom: number;
  growTo: number;
  /** 0..1: how much of the cat's horizontal displacement since the event began the prop follows (smoothed by the run). */
  follow: number;
  /** > 0: the legs repeat every `loopMs` (rain); the prop is invisible between the end of the legs and the next repeat. */
  loopMs: number;
  /** Phase offset for loops and twinkles (ms). */
  phaseMs: number;
}

export type TrackInit = Partial<Track> & Pick<Track, 'kind' | 'size' | 't0' | 't1' | 'segs'>;

export function makeTrack(init: TrackInit): Track {
  return {
    variant: 0,
    fadeIn: 300,
    fadeOut: 300,
    peak: 1,
    tilt: 'none',
    spinTurns: 0,
    pMode: 'life',
    hz: 0,
    blinkHz: 0,
    growFrom: 1,
    growTo: 1,
    follow: 0,
    loopMs: 0,
    phaseMs: 0,
    ...init,
  };
}

/** A leg from (x0,y0) to (x1,y1) over [t0, t0+dur]. */
export function seg(t0: number, dur: number, x0: number, y0: number, x1: number, y1: number, o: Partial<Seg> = {}): Seg {
  return { t0, t1: t0 + Math.max(1, dur), x0, y0, x1, y1, arc: 0, sway: 0, swayHz: 0.6, ease: 'lin', ...o };
}

/** A stationary stretch (hover, rest) at a point. */
export function hold(t0: number, dur: number, x: number, y: number, o: Partial<Seg> = {}): Seg {
  return seg(t0, dur, x, y, x, y, o);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function ease(e: Ease, v: number): number {
  switch (e) {
    case 'out':
      return 1 - (1 - v) * (1 - v);
    case 'in':
      return v * v;
    case 'inout':
      return v * v * (3 - 2 * v);
    default:
      return v;
  }
}

/** Latest end time among a set of tracks (the run is over when the clock passes it). */
export function tracksEnd(tracks: readonly Track[]): number {
  let end = 0;
  for (const t of tracks) if (t.t1 > end) end = t.t1;
  return end;
}

export interface TrackPose {
  x: number;
  y: number;
  dir: 1 | -1;
  rot: number;
  /** 0..1 along the life. */
  u: number;
}

/** Position and heading of a track at clock time t, or null outside its life (or in a loop's gap). */
export function poseAt(tr: Track, t: number): TrackPose | null {
  if (!(tr.t1 > tr.t0) || t < tr.t0 || t > tr.t1 || tr.segs.length === 0) return null;
  const first = tr.segs[0];
  const last = tr.segs[tr.segs.length - 1];
  if (!first || !last) return null;
  let lt = t;
  if (tr.loopMs > 0) {
    lt = first.t0 + ((((t - tr.t0 + tr.phaseMs) % tr.loopMs) + tr.loopMs) % tr.loopMs);
    if (lt > last.t1) return null;
  }
  let s: Seg = first;
  let before = true;
  if (lt >= first.t0) {
    before = false;
    s = last;
    for (const c of tr.segs) {
      if (lt <= c.t1) {
        s = c;
        break;
      }
    }
  }
  let x: number;
  let y: number;
  const vx = s.x1 - s.x0;
  let vy = s.y1 - s.y0;
  if (before) {
    x = s.x0;
    y = s.y0;
  } else if (lt >= s.t1) {
    x = s.x1;
    y = s.y1;
  } else {
    const v = clamp01((lt - s.t0) / (s.t1 - s.t0));
    const e = ease(s.ease, v);
    x = s.x0 + (s.x1 - s.x0) * e;
    y = s.y0 + (s.y1 - s.y0) * e;
    const lift = s.arc * 4 * v * (1 - v);
    y -= lift;
    vy -= s.arc * 4 * (1 - 2 * v);
    if (s.sway !== 0) {
      const sw = s.sway * Math.sin((2 * Math.PI * s.swayHz * (lt - s.t0)) / 1000) * Math.sin(Math.PI * v);
      if (Math.abs(vy) > Math.abs(vx)) x += sw;
      else y += sw;
    }
  }
  let dir: 1 | -1 = 1;
  if (vx < -1e-6) dir = -1;
  else if (vx <= 1e-6) dir = firstDir(tr);
  let rot = 0;
  const u = clamp01((t - tr.t0) / (tr.t1 - tr.t0));
  if (tr.tilt === 'heading') {
    rot = Math.abs(vx) + Math.abs(vy) < 1e-6 ? 0 : Math.max(-1.2, Math.min(1.2, Math.atan2(vy, Math.abs(vx))));
  } else if (tr.tilt === 'sway') {
    rot = 0.28 * Math.sin((2 * Math.PI * (tr.hz > 0 ? tr.hz : 0.8) * (t - tr.t0)) / 1000);
  } else if (tr.tilt === 'spin') {
    rot = tr.spinTurns * 2 * Math.PI * u;
  }
  return { x, y, dir, rot, u };
}

function firstDir(tr: Track): 1 | -1 {
  for (const s of tr.segs) {
    if (s.x1 - s.x0 < -1e-6) return -1;
    if (s.x1 - s.x0 > 1e-6) return 1;
  }
  return 1;
}

/** The drawable prop for a track at clock time t (alpha already includes its own fades), or null when not visible. */
export function evalTrack(tr: Track, t: number, id: number, followDx: number): RenderProp | null {
  const pose = poseAt(tr, t);
  if (!pose) return null;
  const age = t - tr.t0;
  const left = tr.t1 - t;
  const fin = tr.fadeIn > 0 ? clamp01(age / tr.fadeIn) : 1;
  const fout = tr.fadeOut > 0 ? clamp01(left / tr.fadeOut) : 1;
  let alpha = tr.peak * fin * fout;
  if (tr.blinkHz > 0) alpha *= 0.55 + 0.45 * Math.sin((2 * Math.PI * tr.blinkHz * (age + tr.phaseMs)) / 1000);
  if (alpha <= 0.004) return null;
  const size = tr.size * (tr.growFrom + (tr.growTo - tr.growFrom) * pose.u);
  const p = tr.pMode === 'life' ? pose.u : (((tr.hz * age) / 1000) % 1 + 1) % 1;
  return {
    id,
    kind: tr.kind,
    x: pose.x + tr.follow * followDx,
    y: pose.y,
    size,
    dir: pose.dir,
    alpha: clamp01(alpha),
    p,
    rot: pose.rot,
    variant: tr.variant & 3,
  };
}
