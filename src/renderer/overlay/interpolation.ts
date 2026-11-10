// Snapshot interpolation for CatRenderState: renders about one snapshot interval in
// the past so positions can be interpolated between the two snapshots around the
// render time. Honours `snap`, rejects stale/out-of-order snapshots and keeps the
// render clock monotonic and running even when snapshots pause. When the simulation
// clock falls behind local time (a stalled or slowed host) the render clock slows
// down until it is back behind the data instead of jumping back: clip phases and
// emote ages derive from it and must never replay.
import type { CatRenderState } from '../../shared/cat';

const CAPACITY = 6;
const MIN_DELAY_MS = 16;
const MAX_DELAY_MS = 150;
/** A clock disagreement larger than this resets the sim<->local offset. */
const OFFSET_RESET_MS = 1000;
/** While ahead of its target the render clock runs slower: down to this rate at SLEW_FULL_MS ahead. */
const SLEW_MIN_RATE = 0.25;
const SLEW_FULL_MS = 500;
/** Longest local gap between two samples the render clock advances by. */
const MAX_SAMPLE_GAP_MS = 250;
/** Implied speeds above this (DIP/s) are treated as teleports even without `snap`. */
const MAX_INTERP_SPEED = 20000;
/** A sequence number this far below the last one means the sender restarted. */
const SEQ_RESET_GAP = 10000;

export interface InterpSample {
  x: number;
  y: number;
  /** Snapshot whose discrete fields (clip, facing, emote...) apply at the render time. */
  state: CatRenderState;
  /** Estimated simulation time being rendered (ms). */
  simTime: number;
  /** True on the first sample after a discontinuity (snap/teleport). */
  snapped: boolean;
  /**
   * Living Companion: the snapshot after `state` and the 0..1 position between them, set only when
   * the render time lies between two snapshots (world-event props interpolate by id across them).
   * Absent or null: no later snapshot to blend with.
   */
  next?: CatRenderState | null;
  k?: number;
}

function finiteState(s: CatRenderState): boolean {
  return Number.isFinite(s.seq) && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y);
}

export class SnapshotInterpolator {
  private readonly buf: (CatRenderState | null)[] = new Array<CatRenderState | null>(CAPACITY).fill(null);
  private count = 0;
  private head = 0; // index of the newest
  private lastSeq = Number.NEGATIVE_INFINITY;
  private offset = Number.NaN;
  private interval = 33;
  private renderSim = Number.NEGATIVE_INFINITY;
  private lastSampleAt = Number.NaN;
  private usedSeq = Number.NaN;

  get size(): number {
    return this.count;
  }

  newest(): CatRenderState | null {
    return this.count > 0 ? this.buf[this.head]! : null;
  }

  clear(): void {
    this.buf.fill(null);
    this.count = 0;
    this.head = 0;
    this.lastSeq = Number.NEGATIVE_INFINITY;
    this.offset = Number.NaN;
    this.renderSim = Number.NEGATIVE_INFINITY;
    this.lastSampleAt = Number.NaN;
    this.usedSeq = Number.NaN;
  }

  /** How far behind the newest data the render time runs. */
  private get delay(): number {
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, this.interval * 1.1));
  }

  /** Adds a snapshot received at local time `now` (ms). Returns false if it was rejected. */
  push(s: CatRenderState, now: number): boolean {
    if (!finiteState(s) || !Number.isFinite(now)) return false;
    const restarted = s.seq < this.lastSeq - SEQ_RESET_GAP;
    if (s.seq <= this.lastSeq && !restarted) return false;
    const prev = this.newest();
    if (restarted || (prev !== null && s.t < prev.t)) {
      // Sender restarted or its clock went backwards: start over from this snapshot.
      this.clear();
    }
    const last = this.newest();
    if (last !== null) {
      const dt = s.t - last.t;
      if (dt > 0) this.interval += (Math.min(500, Math.max(8, dt)) - this.interval) * 0.2;
    }
    this.lastSeq = s.seq;
    this.head = (this.head + 1) % CAPACITY;
    this.buf[this.head] = s;
    if (this.count < CAPACITY) this.count++;

    const sample = s.t - now;
    // Re-anchor at once when the render time would already be past this newest snapshot
    // (the sim clock fell behind local time): averaging would keep it ahead of the data.
    const ahead = sample < this.offset - this.delay;
    if (!Number.isFinite(this.offset) || s.snap || ahead || Math.abs(sample - this.offset) > OFFSET_RESET_MS) {
      this.offset = sample;
    } else {
      this.offset += (sample - this.offset) * 0.15;
    }
    return true;
  }

  /** Interpolated state at local time `now`; false when nothing has been received. */
  sample(now: number, out: InterpSample): boolean {
    if (this.count === 0 || !Number.isFinite(now)) return false;
    const target = now + this.offset - this.delay;
    if (!Number.isFinite(this.renderSim) || target >= this.renderSim) {
      this.renderSim = target;
    } else if (Number.isFinite(this.lastSampleAt)) {
      // Ahead of the target: never run backwards, run slower until the target catches up.
      const lead = this.renderSim - target;
      const rate = Math.max(SLEW_MIN_RATE, 1 - lead / SLEW_FULL_MS);
      this.renderSim += Math.min(MAX_SAMPLE_GAP_MS, Math.max(0, now - this.lastSampleAt)) * rate;
    }
    this.lastSampleAt = now;
    const tr = this.renderSim;

    // Walk from the oldest to the newest to find a <= tr < b.
    const oldestIdx = (this.head - this.count + 1 + CAPACITY) % CAPACITY;
    let a = this.buf[oldestIdx]!;
    let chosen = a;
    let x = a.x;
    let y = a.y;
    let next: CatRenderState | null = null;
    let nextK = 0;
    if (tr >= a.t) {
      let found = false;
      for (let i = 1; i < this.count; i++) {
        const b = this.buf[(oldestIdx + i) % CAPACITY]!;
        if (tr < b.t) {
          const span = b.t - a.t;
          let k = span > 0 ? (tr - a.t) / span : 1;
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          if (b.snap || (span > 0 && (dist / span) * 1000 > MAX_INTERP_SPEED)) k = 0;
          x = a.x + (b.x - a.x) * k;
          y = a.y + (b.y - a.y) * k;
          chosen = a;
          next = b;
          nextK = Math.min(1, Math.max(0, k));
          found = true;
          break;
        }
        a = b;
      }
      if (!found) {
        chosen = a;
        x = a.x;
        y = a.y;
      }
    }
    const snapped = chosen.seq !== this.usedSeq && chosen.snap;
    this.usedSeq = chosen.seq;
    out.x = x;
    out.y = y;
    out.state = chosen;
    out.simTime = tr;
    out.snapped = snapped;
    out.next = next;
    out.k = nextK;
    return true;
  }
}
