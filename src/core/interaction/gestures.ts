// Pointer gesture recognition for the cat (pure). Input positions are px, times ms
// (monotonic per recogniser; call reset() when the event source changes).
// Context-menu events are handled by the host and ignored here.
import type { Point } from '../../shared/geometry';
import type { SimEvent } from '../../shared/sim';

export type GesturePointerKind = 'down' | 'move' | 'up' | 'enter' | 'leave' | 'context' | 'cancel';

export interface GesturePointerEvent {
  kind: GesturePointerKind;
  x: number;
  y: number;
  t: number;
  /** Button that changed (0 = primary) for down/up. */
  button: number;
  /** Bitmask of held buttons (1 = primary). */
  buttons: number;
}

export interface GestureThresholds {
  /** Press + movement beyond this starts a drag (px). */
  dragThresholdPx: number;
  /** A press held longer than this without dragging is not a tap (ms). */
  tapMaxDurationMs: number;
  doubleTapMs: number;
  doubleTapDistancePx: number;
  /** Samples this old (relative to release) feed the release velocity (ms). */
  velocityWindowMs: number;
  maxReleaseSpeed: number;
  /** Movement in the new direction needed to register a stroke reversal (px). */
  petReversalPx: number;
  minStrokePx: number;
  /** Stroke length that earns full strength (px). */
  fullStrokePx: number;
  /** A pause longer than this between moves discards the current stroke (ms). */
  strokeTimeoutMs: number;
  minPetIntervalMs: number;
  /** A stroke whose vertical extent exceeds length * ratio is not horizontal. */
  maxStrokeVerticalRatio: number;
}

export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
  dragThresholdPx: 6,
  tapMaxDurationMs: 600,
  doubleTapMs: 350,
  doubleTapDistancePx: 16,
  velocityWindowMs: 100,
  maxReleaseSpeed: 6000,
  petReversalPx: 6,
  minStrokePx: 18,
  fullStrokePx: 90,
  strokeTimeoutMs: 400,
  minPetIntervalMs: 250,
  maxStrokeVerticalRatio: 0.8,
};

export interface GestureRecognizer {
  feed(e: GesturePointerEvent): SimEvent[];
  readonly dragging: boolean;
  readonly hovering: boolean;
  /** Clears all state without emitting events (feed a 'cancel' first to end a drag cleanly). */
  reset(): void;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Stroke {
  dir: -1 | 0 | 1;
  startX: number;
  extremeX: number;
  startT: number;
  extremeT: number;
  minY: number;
  maxY: number;
}

const PRIMARY = 0;
const PRIMARY_MASK = 1;
const MAX_DRAG_SAMPLES = 32;
/** Tiny wobble before a stroke has a direction. */
const STROKE_DIRECTION_PX = 3;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createGestureRecognizer(opts: Partial<GestureThresholds> = {}): GestureRecognizer {
  const th: GestureThresholds = { ...DEFAULT_GESTURE_THRESHOLDS, ...opts };

  let hovering = false;
  let press: Sample | null = null;
  let dragging = false;
  let dragSamples: Sample[] = [];
  let lastTap: Sample | null = null;
  let stroke: Stroke | null = null;
  let lastMoveT = -Infinity;
  let lastPetAt = -Infinity;
  let lastT = -Infinity;

  const at = (e: { x: number; y: number }): Point => ({ x: e.x, y: e.y });

  function resetStroke(): void {
    stroke = null;
  }

  function releaseVelocity(up: Sample): Point {
    const samples = [...dragSamples, up].filter((s) => up.t - s.t <= th.velocityWindowMs);
    const first = samples[0];
    if (!first || samples.length < 2) return { x: 0, y: 0 };
    const dt = up.t - first.t;
    if (dt < 8) return { x: 0, y: 0 };
    let vx = ((up.x - first.x) / dt) * 1000;
    let vy = ((up.y - first.y) / dt) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed > th.maxReleaseSpeed) {
      vx *= th.maxReleaseSpeed / speed;
      vy *= th.maxReleaseSpeed / speed;
    }
    return { x: vx, y: vy };
  }

  function endDrag(e: Sample, withVelocity: boolean, out: SimEvent[]): void {
    out.push({ type: 'pointer.dragEnd', at: at(e), velocity: withVelocity ? releaseVelocity(e) : { x: 0, y: 0 } });
    dragging = false;
    dragSamples = [];
    press = null;
  }

  function release(e: Sample, out: SimEvent[]): void {
    if (dragging) {
      endDrag(e, true, out);
      return;
    }
    const p = press;
    press = null;
    if (!p || e.t - p.t > th.tapMaxDurationMs) return;
    const sinceTap = lastTap ? e.t - lastTap.t : Infinity;
    const isDouble =
      lastTap !== null && sinceTap >= 0 && sinceTap <= th.doubleTapMs && Math.hypot(e.x - lastTap.x, e.y - lastTap.y) <= th.doubleTapDistancePx;
    if (isDouble) {
      out.push({ type: 'pointer.doubleTap', at: at(e) });
      lastTap = null;
    } else {
      out.push({ type: 'pointer.tap', at: at(e) });
      lastTap = { x: e.x, y: e.y, t: e.t };
    }
  }

  function strokeStrength(s: Stroke): number {
    const len = Math.abs(s.extremeX - s.startX);
    const lenScore = clamp01((len - th.minStrokePx) / Math.max(1, th.fullStrokePx - th.minStrokePx));
    const dur = Math.max(1, s.extremeT - s.startT);
    const speed = (len / dur) * 1000;
    // Gentle strokes are the nicest; frantic wiggles and near-stationary creeping count less.
    const speedScore = speed > 3000 ? 0.4 : speed > 1800 ? 0.7 : speed < 40 ? 0.6 : 1;
    return clamp01((0.3 + 0.7 * lenScore) * speedScore);
  }

  function trackStroke(e: Sample, out: SimEvent[]): void {
    if (e.t - lastMoveT > th.strokeTimeoutMs) resetStroke();
    lastMoveT = e.t;
    if (!stroke) {
      stroke = { dir: 0, startX: e.x, extremeX: e.x, startT: e.t, extremeT: e.t, minY: e.y, maxY: e.y };
      return;
    }
    const s = stroke;
    s.minY = Math.min(s.minY, e.y);
    s.maxY = Math.max(s.maxY, e.y);
    if (s.dir === 0) {
      if (Math.abs(e.x - s.startX) >= STROKE_DIRECTION_PX) {
        s.dir = e.x > s.startX ? 1 : -1;
        s.extremeX = e.x;
        s.extremeT = e.t;
      }
      return;
    }
    if ((e.x - s.extremeX) * s.dir > 0) {
      s.extremeX = e.x;
      s.extremeT = e.t;
      return;
    }
    if ((s.extremeX - e.x) * s.dir < th.petReversalPx) return;
    // Direction reversed: the stroke that just ended is one pet.
    const len = Math.abs(s.extremeX - s.startX);
    const horizontal = s.maxY - s.minY <= len * th.maxStrokeVerticalRatio;
    if (len >= th.minStrokePx && horizontal && e.t - lastPetAt >= th.minPetIntervalMs) {
      out.push({ type: 'pointer.pet', at: at(e), strength: strokeStrength(s) });
      lastPetAt = e.t;
    }
    stroke = { dir: s.dir === 1 ? -1 : 1, startX: s.extremeX, extremeX: e.x, startT: s.extremeT, extremeT: e.t, minY: e.y, maxY: e.y };
  }

  function feed(e: GesturePointerEvent): SimEvent[] {
    const out: SimEvent[] = [];
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.t)) return out;
    if (e.t < lastT) {
      // The time base went backwards (e.g. another overlay's clock): forget timing-dependent state.
      lastTap = null;
      lastMoveT = -Infinity;
      lastPetAt = -Infinity;
      resetStroke();
    }
    lastT = e.t;
    const s: Sample = { x: e.x, y: e.y, t: e.t };

    switch (e.kind) {
      case 'enter':
        if (!hovering) {
          hovering = true;
          resetStroke();
          out.push({ type: 'pointer.hoverStart', at: at(e) });
        }
        break;
      case 'leave':
        if (hovering) {
          hovering = false;
          resetStroke();
          out.push({ type: 'pointer.hoverEnd' });
        }
        break;
      case 'down':
        if (e.button === PRIMARY && !press) {
          press = s;
          dragSamples = [];
          resetStroke();
        }
        break;
      case 'move':
        if (press) {
          if ((e.buttons & PRIMARY_MASK) === 0) {
            // The release was lost (e.g. outside the window): treat this as the release.
            release(s, out);
            break;
          }
          if (!dragging && Math.hypot(e.x - press.x, e.y - press.y) > th.dragThresholdPx) {
            dragging = true;
            lastTap = null;
            out.push({ type: 'pointer.dragStart', at: at(press) });
            dragSamples = [press];
          }
          if (dragging) {
            dragSamples.push(s);
            if (dragSamples.length > MAX_DRAG_SAMPLES) dragSamples.shift();
          }
        } else if (hovering && e.buttons === 0) {
          trackStroke(s, out);
        } else {
          resetStroke();
        }
        break;
      case 'up':
        if (e.button === PRIMARY && press) release(s, out);
        break;
      case 'cancel':
        if (dragging) endDrag(s, false, out);
        press = null;
        resetStroke();
        break;
      case 'context':
        break;
    }
    return out;
  }

  return {
    feed,
    get dragging() {
      return dragging;
    },
    get hovering() {
      return hovering;
    },
    reset() {
      hovering = false;
      press = null;
      dragging = false;
      dragSamples = [];
      lastTap = null;
      stroke = null;
      lastMoveT = -Infinity;
      lastPetAt = -Infinity;
      lastT = -Infinity;
    },
  };
}
