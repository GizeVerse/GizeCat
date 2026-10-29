// Frame-rate policy of the overlay renderer: full display rate only while the cat moves
// fast (locomotion, held/airborne, quick clips, a lashing tail, a turn, a reaction), ~30
// fps while it is calm, ~20 fps asleep and still. Animations stay time-based.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimClip, CatRenderState } from '../../../src/shared/cat';
import type { OverlayApi } from '../../../src/shared/ipc';
import { seededRandom } from '../../../src/renderer/overlay/cat/math';
import {
  CALM_FRAME_MS,
  FAST_HOLD_MS,
  FAST_POSE_DIP_S,
  FramePacer,
  frameIntervalMs,
  FULL_RATE_MS,
  QUIET_FRAME_MS,
  type FrameMotion,
} from '../../../src/renderer/overlay/frameRate';
import type { Ctx2D } from '../../../src/renderer/overlay/cat/draw';
import { OverlayRuntime } from '../../../src/renderer/overlay/runtime';
import { CatScene } from '../../../src/renderer/overlay/scene';

const calm: FrameMotion = { clip: 'sit', state: 'idle', speed: 0, vy: 0, moved: false, transition: false, poseSpeed: 40, quiet: false };
const LONG_AGO = 10_000;

describe('frame interval policy', () => {
  it('draws a calm cat at ~30 fps and a sleeping, still one at ~20 fps', () => {
    expect(frameIntervalMs(calm, LONG_AGO)).toBe(CALM_FRAME_MS);
    expect(CALM_FRAME_MS).toBeCloseTo(1000 / 30, 6);
    expect(frameIntervalMs({ ...calm, clip: 'sleep', state: 'sleeping', quiet: true, poseSpeed: 5 }, LONG_AGO)).toBe(QUIET_FRAME_MS);
    for (const clip of ['stand', 'sit', 'loaf', 'sleep', 'groom', 'petted', 'meow', 'yawn', 'wake', 'hide'] as AnimClip[]) {
      expect(frameIntervalMs({ ...calm, clip }, LONG_AGO), clip).toBe(CALM_FRAME_MS);
    }
  });

  it('uses the full display rate for locomotion, held/airborne and quick clips', () => {
    for (const clip of ['walk', 'run', 'crouch', 'jump', 'fall', 'land', 'startle', 'annoyed', 'pawAt', 'held', 'rollOver'] as AnimClip[]) {
      expect(frameIntervalMs({ ...calm, clip }, LONG_AGO), clip).toBe(FULL_RATE_MS);
    }
    for (const state of ['held', 'jumping', 'falling', 'landing'] as const) expect(frameIntervalMs({ ...calm, state }, LONG_AGO), state).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, speed: 0.4 }, LONG_AGO)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, vy: -120 }, LONG_AGO)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, moved: true }, LONG_AGO)).toBe(FULL_RATE_MS);
  });

  it('uses the full rate for a lashing tail, turns, cross-fades and reactions, and briefly after them', () => {
    expect(frameIntervalMs({ ...calm, poseSpeed: FAST_POSE_DIP_S }, LONG_AGO)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs({ ...calm, poseSpeed: FAST_POSE_DIP_S - 1 }, LONG_AGO)).toBe(CALM_FRAME_MS);
    expect(frameIntervalMs({ ...calm, transition: true }, LONG_AGO)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs(calm, FAST_HOLD_MS - 1)).toBe(FULL_RATE_MS);
    expect(frameIntervalMs(calm, FAST_HOLD_MS)).toBe(CALM_FRAME_MS);
  });
});

describe('frame pacer', () => {
  const rate = (displayHz: number, interval: number, jitter = 0): number => {
    const pacer = new FramePacer();
    const rnd = seededRandom(1);
    let drawn = 0;
    const frames = displayHz * 10;
    for (let i = 0; i < frames; i++) {
      const now = (i * 1000) / displayHz + (rnd() - 0.5) * jitter;
      if (pacer.shouldDraw(now, interval)) drawn++;
    }
    return drawn / 10;
  };

  it('keeps ~30 fps on 60, 75 and 144 Hz displays, even with timestamp jitter', () => {
    for (const hz of [60, 75, 144]) {
      for (const jitter of [0, 2]) {
        const fps = rate(hz, CALM_FRAME_MS, jitter);
        expect(fps, `${hz} Hz jitter ${jitter}`).toBeGreaterThanOrEqual(28.5);
        expect(fps, `${hz} Hz jitter ${jitter}`).toBeLessThanOrEqual(31);
      }
    }
  });

  it('draws every display frame at the full rate, ~20 fps when quiet, and restarts after a pause', () => {
    expect(rate(60, FULL_RATE_MS)).toBe(60);
    expect(rate(144, FULL_RATE_MS)).toBe(144);
    const quiet = rate(60, QUIET_FRAME_MS);
    expect(quiet).toBeGreaterThanOrEqual(19);
    expect(quiet).toBeLessThanOrEqual(21.5);
    const pacer = new FramePacer();
    expect(pacer.shouldDraw(0, CALM_FRAME_MS)).toBe(true);
    expect(pacer.shouldDraw(16, CALM_FRAME_MS)).toBe(false);
    // After a long gap the next frame is drawn at once, without a burst to catch up.
    expect(pacer.shouldDraw(5000, CALM_FRAME_MS)).toBe(true);
    expect(pacer.shouldDraw(5016, CALM_FRAME_MS)).toBe(false);
    expect(pacer.shouldDraw(5033, CALM_FRAME_MS)).toBe(true);
    // Switching to the full rate draws the very next frame.
    expect(pacer.shouldDraw(5050, FULL_RATE_MS)).toBe(true);
  });
});

function state(clip: AnimClip, t: number, extra: Partial<CatRenderState> = {}): CatRenderState {
  return {
    seq: Math.round(t),
    t,
    x: 400,
    y: 300,
    snap: false,
    scale: 1,
    facing: 1,
    state: clip === 'sleep' ? 'sleeping' : clip === 'held' ? 'held' : 'idle',
    clip,
    clipStartedAt: 0,
    speed: clip === 'walk' ? 0.7 : clip === 'run' ? 2.5 : clip === 'climb' ? 0.5 : 0,
    vy: clip === 'jump' ? -300 : clip === 'fall' ? 300 : 0,
    look: null,
    arousal: 0.3,
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

/** Runs a scene at 60 Hz like the runtime does (interval judged before each update); returns the intervals after `fromMs`. */
function intervals(clip: AnimClip, ms: number, extra: (t: number) => Partial<CatRenderState> = () => ({}), fromMs = 1500): { t: number; v: number }[] {
  const scene = new CatScene(seededRandom(3));
  const dt = 1000 / 60;
  const out: { t: number; v: number }[] = [];
  for (let t = 0; t <= ms; t += dt) {
    const s = state(clip, t, extra(t));
    const v = t === 0 ? FULL_RATE_MS : scene.frameIntervalMs(s.x, s.y, s);
    if (t >= fromMs) out.push({ t, v });
    scene.update({ x: s.x, y: s.y, state: s, simTime: t, dtMs: t === 0 ? 0 : dt, snapped: t === 0 });
  }
  return out;
}
const share = (xs: { v: number }[], v: number): number => xs.filter((x) => x.v === v).length / xs.length;

describe('scene motion classification', () => {
  it('calm poses run at ~30 fps even with an excited tail sway; sleep at ~20 fps', () => {
    for (const arousal of [0.2, 0.9]) {
      for (const clip of ['stand', 'sit', 'loaf', 'petted', 'hide', 'meow', 'yawn'] as AnimClip[]) {
        expect(share(intervals(clip, 8000, () => ({ arousal })), CALM_FRAME_MS), `${clip} arousal ${arousal}`).toBeGreaterThan(0.95);
      }
      expect(share(intervals('sleep', 8000, () => ({ arousal })), QUIET_FRAME_MS), `sleep arousal ${arousal}`).toBeGreaterThan(0.95);
      // Clinging still to a wall (glances, a re-grip, the hanging tail's sway) is calm too.
      expect(share(intervals('climb', 9000, () => ({ arousal, speed: 0 })), CALM_FRAME_MS), `clinging arousal ${arousal}`).toBeGreaterThan(0.95);
    }
  });

  it('locomotion, held, airborne, lashing and quick clips always run at the full rate', () => {
    for (const clip of ['walk', 'run', 'crouch', 'annoyed', 'pawAt', 'held', 'jump', 'fall', 'rollOver', 'climb'] as AnimClip[]) {
      expect(share(intervals(clip, 4000), FULL_RATE_MS), clip).toBe(1);
    }
    // A calm clip whose anchor moves (riding a moving window, carried) is not calm.
    expect(share(intervals('sit', 4000, (t) => ({ x: 400 + t * 0.05 })), FULL_RATE_MS)).toBe(1);
  });

  it('a reaction on a calm cat runs at the full rate while it plays, then the rate drops again', () => {
    const at = 3000;
    const xs = intervals('sit', 6000, (t) => (t >= at ? { reaction: { kind: 'tailFlick', at } } : {}));
    expect(share(xs.filter((x) => x.t < at), CALM_FRAME_MS)).toBe(1);
    expect(share(xs.filter((x) => x.t >= at && x.t < at + 400 + FAST_HOLD_MS), FULL_RATE_MS)).toBe(1);
    expect(share(xs.filter((x) => x.t >= at + 1500), CALM_FRAME_MS)).toBe(1);
  });

  it('a pending clip change or turn is drawn at once', () => {
    const scene = new CatScene(seededRandom(3));
    const dt = 1000 / 60;
    let t = 0;
    for (; t < 3000; t += dt) scene.update({ x: 400, y: 300, state: state('sit', t), simTime: t, dtMs: t === 0 ? 0 : dt, snapped: t === 0 });
    expect(scene.frameIntervalMs(400, 300, state('sit', t))).toBe(CALM_FRAME_MS);
    expect(scene.frameIntervalMs(400, 300, state('stand', t, { clipStartedAt: t }))).toBe(FULL_RATE_MS);
    expect(scene.frameIntervalMs(400, 300, state('sit', t, { facing: -1 }))).toBe(FULL_RATE_MS);
    expect(scene.frameIntervalMs(401, 300, state('sit', t))).toBe(FULL_RATE_MS);
    expect(scene.frameIntervalMs(400, 300, state('sit', t, { reaction: { kind: 'earFlick', at: t } }))).toBe(FULL_RATE_MS);
  });

  it('fewer frames do not change the animation: the same pose at the same sim time at 30 and 60 fps', () => {
    const run = (fps: number): Map<number, number> => {
      const scene = new CatScene(() => 0.99);
      const dt = 1000 / fps;
      const at = new Map<number, number>();
      for (let i = 0; i * dt <= 6000; i++) {
        const t = i * dt;
        scene.update({ x: 400, y: 300, state: state('stand', t), simTime: t, dtMs: i === 0 ? 0 : dt, snapped: i === 0 });
        if (i % (fps / 30) === 0) at.set(Math.round(t), scene.puppet.pose.bodyH);
      }
      return at;
    };
    const a = run(60);
    const b = run(30);
    for (const [t, v] of b) expect(a.get(t), `t=${t}`).toBeCloseTo(v, 9);
  });
});

/** A 2D context that only counts full clears of the dirty region (one per drawn frame). */
function countingCtx(): { ctx: Ctx2D; clears: () => number } {
  let clears = 0;
  const props: Record<string | symbol, unknown> = { globalAlpha: 1, lineWidth: 1, canvas: { width: 800, height: 600 } };
  const ctx = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_t, key) {
        if (key in props) return props[key];
        return (..._args: unknown[]) => {
          if (key === 'clearRect') clears++;
          if (key === 'getTransform') return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
          return undefined;
        };
      },
      set(_t, key, value) {
        props[key] = value;
        return true;
      },
    },
  ) as unknown as Ctx2D;
  return { ctx, clears: () => clears };
}

describe('overlay runtime frame rate', () => {
  let frames: FrameRequestCallback[] = [];
  let onRender: ((s: CatRenderState) => void) | null = null;
  let runtime: OverlayRuntime;
  let counter: ReturnType<typeof countingCtx>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    frames = [];
    counter = countingCtx();
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => counter.ctx,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setPointerCapture: () => undefined,
    } as unknown as HTMLCanvasElement;
    const api: OverlayApi = {
      onRender: (cb) => {
        onRender = cb;
        return () => undefined;
      },
      onConfig: () => () => undefined,
      onSurfaceLines: () => () => undefined,
      ready: () => undefined,
      sendPointer: () => undefined,
      sendHitRegion: () => undefined,
      reportError: () => undefined,
    };
    runtime = new OverlayRuntime(canvas, api);
    runtime.start();
  });

  afterEach(() => {
    runtime.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Feeds 30 Hz snapshots and ~60 Hz display frames; returns drawn frames per second after a 1 s warm-up. */
  function drawnPerSecond(make: (seq: number, t: number) => CatRenderState): number {
    const t0 = performance.now();
    let seq = 0;
    let nextSnapshot = 0;
    let base = 0;
    for (let ms = 0; ms < 3000; ms += 16) {
      if (ms >= nextSnapshot) {
        onRender!(make(++seq, 10_000 + performance.now() - t0));
        nextSnapshot += 33;
      }
      if (ms === 1008) base = counter.clears();
      vi.advanceTimersByTime(16);
      for (const f of frames.splice(0)) f(performance.now());
    }
    return (counter.clears() - base) / 2;
  }

  it('draws a calm cat at ~30 fps', () => {
    const sitting = drawnPerSecond((seq, t) => ({ ...state('sit', t), seq, snap: seq === 1, clipStartedAt: 9000, arousal: 0.2 }));
    expect(sitting).toBeGreaterThanOrEqual(28);
    expect(sitting).toBeLessThanOrEqual(32);
  });

  it('draws a walking cat at the display rate', () => {
    const walking = drawnPerSecond((seq, t) => ({ ...state('walk', t), seq, snap: seq === 1, x: 100 + (t - 10_000) * 0.05, state: 'walking', clipStartedAt: 9000 }));
    expect(walking).toBeGreaterThanOrEqual(60);
  });

  it('draws a sleeping, still cat at ~20 fps', () => {
    const sleeping = drawnPerSecond((seq, t) => ({ ...state('sleep', t), seq, snap: seq === 1, clipStartedAt: 9000 }));
    expect(sleeping).toBeGreaterThanOrEqual(18);
    expect(sleeping).toBeLessThanOrEqual(22);
  });
});
