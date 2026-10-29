// Adaptive taskbar sampling cadence (ADR 0002 §2): GetWindowRect costs ~0.6 µs, so sampling
// at 4 Hz idle and 60 Hz while something may be moving stays far below 0.1 ms/s.
import type { Point } from '../../../shared/geometry';
import type { TaskbarEdge } from '../../../shared/surfaces';
import type { RawRect } from '../native';
import { distanceFromEdge } from './geometry';

export const IDLE_SAMPLE_MS = 250;
export const BURST_SAMPLE_MS = 16;
/** Keep bursting this long after the last observed geometry change. */
export const BURST_AFTER_CHANGE_MS = 300;
/** Cursor distance (DIP, scaled per monitor) from an auto-hide edge that starts a burst. */
export const CURSOR_EDGE_DIP = 6;

export interface CadenceTaskbar {
  autoHide: boolean;
  edge: TaskbarEdge;
  monitor: RawRect;
  /** DPI scale of the taskbar's monitor (1 when unknown). */
  scale: number;
  /** px of the taskbar revealed on screen (0 while hidden): the cursor over a revealed taskbar keeps it revealed. */
  revealedPx: number;
  /** Geometry is being eased across an unobserved jump. */
  easing: boolean;
}

export interface CadenceInput {
  now: number;
  cursor: Point | null;
  catNear: boolean;
  /** Host time of the last observed geometry change (null: none yet). */
  lastChangeAt: number | null;
  taskbars: readonly CadenceTaskbar[];
}

export type BurstReason = 'cat-near' | 'recent-change' | 'easing' | 'cursor-at-edge';

export interface CadenceDecision {
  delayMs: number;
  reason: BurstReason | null;
}

/** True when the cursor is within the scaled edge band of an auto-hide taskbar (or over the revealed part of it). */
export function cursorAtAutoHideEdge(cursor: Point, t: CadenceTaskbar): boolean {
  if (!t.autoHide) return false;
  const d = distanceFromEdge(cursor, t.monitor, t.edge);
  return d !== null && d <= Math.ceil(CURSOR_EDGE_DIP * t.scale) + t.revealedPx;
}

export function nextSampleDelay(input: CadenceInput): CadenceDecision {
  if (input.taskbars.length === 0) return { delayMs: IDLE_SAMPLE_MS, reason: null };
  if (input.catNear) return { delayMs: BURST_SAMPLE_MS, reason: 'cat-near' };
  if (input.lastChangeAt !== null && input.now - input.lastChangeAt < BURST_AFTER_CHANGE_MS) return { delayMs: BURST_SAMPLE_MS, reason: 'recent-change' };
  if (input.taskbars.some((t) => t.easing)) return { delayMs: BURST_SAMPLE_MS, reason: 'easing' };
  const c = input.cursor;
  if (c !== null && Number.isFinite(c.x) && Number.isFinite(c.y) && input.taskbars.some((t) => cursorAtAutoHideEdge(c, t))) {
    return { delayMs: BURST_SAMPLE_MS, reason: 'cursor-at-edge' };
  }
  return { delayMs: IDLE_SAMPLE_MS, reason: null };
}
