import { describe, expect, it } from 'vitest';
import type { CatRenderState } from '../../../src/shared/cat';
import { SnapshotInterpolator, type InterpSample } from '../../../src/renderer/overlay/interpolation';

function snap(seq: number, t: number, x: number, extra: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq,
    t,
    x,
    y: 500,
    snap: false,
    scale: 1,
    facing: 1,
    state: 'walking',
    clip: 'walk',
    clipStartedAt: 0,
    speed: 0.5,
    vy: 0,
    look: null,
    arousal: 0,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...extra,
  };
}

const out = (): InterpSample => ({ x: 0, y: 0, state: snap(0, 0, 0), simTime: 0, snapped: false });

/** Feeds snapshots every 33 ms of sim time, delivered at the same local times. */
function feed(interp: SnapshotInterpolator, n: number, xAt: (i: number) => number, t0 = 10000, local0 = 500): void {
  for (let i = 0; i < n; i++) interp.push(snap(i + 1, t0 + i * 33, xAt(i)), local0 + i * 33);
}

describe('snapshot interpolation', () => {
  it('returns false before any snapshot', () => {
    expect(new SnapshotInterpolator().sample(100, out())).toBe(false);
  });

  it('interpolates between the snapshots around the (delayed) render time', () => {
    const interp = new SnapshotInterpolator();
    feed(interp, 6, (i) => i * 10);
    const s = out();
    // Sample at the arrival time of the last snapshot: the render time is ~one interval behind.
    expect(interp.sample(500 + 5 * 33, s)).toBe(true);
    expect(s.x).toBeGreaterThan(30);
    expect(s.x).toBeLessThan(50);
    // Positions are a smooth function of time: halfway between two samples is halfway in x.
    const s2 = out();
    interp.sample(500 + 5 * 33 + 16.5, s2);
    expect(s2.x - s.x).toBeGreaterThan(3);
    expect(s2.x - s.x).toBeLessThan(7);
  });

  it('never extrapolates past the newest snapshot and keeps the clock running', () => {
    const interp = new SnapshotInterpolator();
    feed(interp, 4, (i) => i * 10);
    const s = out();
    interp.sample(100000, s);
    expect(s.x).toBe(30);
    const t1 = s.simTime;
    interp.sample(100500, s);
    expect(s.simTime).toBeGreaterThan(t1);
  });

  it('render time is monotonic under jittery delivery', () => {
    const interp = new SnapshotInterpolator();
    let last = -Infinity;
    const s = out();
    for (let i = 0; i < 200; i++) {
      const jitter = (i * 7919) % 23;
      interp.push(snap(i + 1, 1000 + i * 33, i), 200 + i * 33 + jitter);
      interp.sample(200 + i * 33 + jitter + 5, s);
      expect(s.simTime).toBeGreaterThanOrEqual(last);
      last = s.simTime;
    }
  });

  it('rejects duplicate and out-of-order sequence numbers', () => {
    const interp = new SnapshotInterpolator();
    expect(interp.push(snap(5, 1000, 0), 0)).toBe(true);
    expect(interp.push(snap(5, 1033, 50), 33)).toBe(false);
    expect(interp.push(snap(4, 1033, 50), 33)).toBe(false);
    expect(interp.push(snap(6, 1033, 10), 33)).toBe(true);
    expect(interp.size).toBe(2);
    expect(interp.newest()!.x).toBe(10);
  });

  it('rejects non-finite snapshots', () => {
    const interp = new SnapshotInterpolator();
    expect(interp.push(snap(1, Number.NaN, 0), 0)).toBe(false);
    expect(interp.push(snap(1, 0, Number.POSITIVE_INFINITY), 0)).toBe(false);
    expect(interp.size).toBe(0);
  });

  it('accepts a restarted sender (sequence reset far below)', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(50000, 1000, 0), 0);
    expect(interp.push(snap(1, 5, 300), 10)).toBe(true);
    expect(interp.size).toBe(1);
    expect(interp.newest()!.x).toBe(300);
  });

  it('honours snap=true: no interpolation across a teleport, reported once', () => {
    const interp = new SnapshotInterpolator();
    feed(interp, 4, (i) => i * 10);
    interp.push(snap(5, 10000 + 4 * 33, 900, { snap: true }), 500 + 4 * 33);
    interp.push(snap(6, 10000 + 5 * 33, 905), 500 + 5 * 33);
    const s = out();
    let seenSnap = 0;
    for (let now = 500 + 3 * 33; now < 500 + 8 * 33; now += 4) {
      interp.sample(now, s);
      // Never a value between the old path (<=30) and the teleport target (>=900).
      expect(s.x <= 30 || s.x >= 900, `x=${s.x}`).toBe(true);
      if (s.snapped) seenSnap++;
    }
    expect(seenSnap).toBe(1);
  });

  it('treats implausible speeds as teleports even without snap', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, 1000, 0), 0);
    interp.push(snap(2, 1033, 5000), 33);
    const s = out();
    for (let now = 0; now < 120; now += 3) {
      interp.sample(now, s);
      expect(s.x === 0 || s.x === 5000, `x=${s.x}`).toBe(true);
    }
  });

  it('never runs the render clock backwards when the sim clock runs slower than local time', () => {
    // A host that advances sim time 250 ms per 500 ms tick (clamped dt): sleeping with zzz emotes.
    const interp = new SnapshotInterpolator();
    const s = out();
    let simT = 50_000;
    let seq = 0;
    let emote = { at: simT + 2000, shownFor: 0, toggles: 0, visible: false };
    let last = -Infinity;
    let maxLead = 0;
    for (let now = 0; now < 20_000; now += 1000 / 60) {
      if (Math.floor(now / 500) !== Math.floor((now - 1000 / 60) / 500) || now === 0) {
        simT += 250;
        interp.push(snap(++seq, simT, 0, { state: 'sleeping', clip: 'sleep', emote: 'zzz', emoteStartedAt: emote.at }), now);
      }
      interp.sample(now, s);
      expect(s.simTime, `now=${now}`).toBeGreaterThanOrEqual(last);
      last = s.simTime;
      maxLead = Math.max(maxLead, s.simTime - interp.newest()!.t);
      // The zzz bubble (1.6 s) is visible for render ages in [0, 1600).
      const age = s.simTime - s.state.emoteStartedAt;
      const visible = age >= 0 && age < 1600;
      if (visible !== emote.visible) emote.toggles++;
      emote.visible = visible;
      // A new emote every 4 s of sim time.
      if (simT - emote.at > 4000) emote = { at: simT, shownFor: 0, toggles: 0, visible: false };
      expect(emote.toggles, `emote at ${emote.at} replayed`).toBeLessThanOrEqual(2);
    }
    // The render time stays near the data instead of running ~1.1 s ahead of it.
    expect(maxLead).toBeLessThan(600);
  });

  it('absorbs a step of the sim clock (main stall) without jumping back, then converges', () => {
    const interp = new SnapshotInterpolator();
    const s = out();
    let simT = 10_000;
    let seq = 0;
    let last = -Infinity;
    let nextPush = 0;
    for (let now = 0; now < 9000; now += 1000 / 60) {
      // Snapshots every 33 ms, except while main is stalled (2-4 s). The host clamps the
      // stalled tick's dt, so sim time advances by only 250 ms across the stall.
      if (now >= nextPush && (now < 2000 || now >= 4000)) {
        simT += nextPush === 4000 ? 250 : 33;
        interp.push(snap(++seq, simT, 0), now);
        nextPush += 33;
      } else if (now >= 2000 && now < 4000) {
        nextPush = 4000;
      }
      // The renderer keeps drawing frames throughout.
      interp.sample(now, s);
      expect(s.simTime, `now=${now}`).toBeGreaterThanOrEqual(last);
      last = s.simTime;
    }
    // Back behind the newest snapshot by about the normal delay.
    const lag = interp.newest()!.t - s.simTime;
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThan(150);
  });

  it('uses discrete fields from the snapshot at the render time', () => {
    const interp = new SnapshotInterpolator();
    interp.push(snap(1, 1000, 0, { clip: 'walk' }), 0);
    interp.push(snap(2, 1033, 2, { clip: 'sit' }), 33);
    const s = out();
    interp.sample(34, s);
    expect(s.state.clip).toBe('walk');
    interp.sample(400, s);
    expect(s.state.clip).toBe('sit');
  });
});
