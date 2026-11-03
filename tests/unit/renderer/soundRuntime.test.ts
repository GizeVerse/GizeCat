// v1.2 (ADR 0003 §10): the overlay runtime plays the cue a snapshot carries through the browser's
// AudioContext (here a stub global), once, only while the cat is shown, and closes the context
// after 10 s of silence and when the overlay goes away. Without a cue it never creates one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatRenderState, CatSoundCue } from '../../../src/shared/cat';
import type { OverlayApi } from '../../../src/shared/ipc';
import { OverlayRuntime } from '../../../src/renderer/overlay/runtime';
import { IDLE_CLOSE_MS } from '../../../src/renderer/overlay/sound';
import { createMockCtx } from './mockCtx';

/** Minimal AudioContext stand-in counting what the runtime's player does with it. */
class StubAudio {
  static made: StubAudio[] = [];
  currentTime = 0;
  readonly sampleRate = 8000;
  state = 'running';
  starts = 0;
  closed = 0;
  readonly destination = { connect: () => undefined, disconnect: () => undefined };
  constructor() {
    StubAudio.made.push(this);
  }
  private param() {
    return { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
  }
  private node() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createOscillator() {
    return { ...this.node(), type: '', frequency: this.param(), start: () => this.starts++, stop: () => undefined };
  }
  createBufferSource() {
    return { ...this.node(), buffer: null, loop: false, start: () => this.starts++, stop: () => undefined };
  }
  createGain() {
    return { ...this.node(), gain: this.param() };
  }
  createBiquadFilter() {
    return { ...this.node(), type: '', frequency: this.param(), Q: this.param() };
  }
  createBuffer(_c: number, length: number) {
    const d = new Float32Array(length);
    return { getChannelData: () => d };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed++;
    return Promise.resolve();
  }
}

function snapshot(seq: number, t: number, visible: boolean, sound?: CatSoundCue): CatRenderState {
  return {
    seq,
    t,
    x: 400,
    y: 300,
    snap: seq === 1,
    scale: 1,
    facing: 1,
    state: 'idle',
    clip: 'stand',
    clipStartedAt: 0,
    speed: 0,
    vy: 0,
    look: null,
    arousal: 0.2,
    contentment: 0.5,
    emote: null,
    emoteStartedAt: 0,
    opacity: 1,
    visible,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    ...(sound ? { sound } : {}),
  };
}

describe('overlay runtime sound', () => {
  let onRender: ((s: CatRenderState) => void) | null = null;
  let runtime: OverlayRuntime;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    StubAudio.made = [];
    vi.stubGlobal('AudioContext', StubAudio);
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const mock = createMockCtx(800, 600);
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => mock.ctx,
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

  it('creates no AudioContext for snapshots without a cue', () => {
    for (let i = 1; i < 30; i++) onRender!(snapshot(i, 10_000 + i * 33, true));
    expect(StubAudio.made).toHaveLength(0);
  });

  it('plays a cue once although several snapshots carry it, never while the cat is hidden', () => {
    const c: CatSoundCue = { kind: 'chirp', at: 10_000, volume: 0.5 };
    onRender!(snapshot(1, 10_000, false, c));
    expect(StubAudio.made, 'hidden').toHaveLength(0);
    onRender!(snapshot(2, 10_033, true, c));
    onRender!(snapshot(3, 10_066, true, c));
    onRender!(snapshot(3, 10_066, true, c));
    expect(StubAudio.made).toHaveLength(1);
    const a = StubAudio.made[0]!;
    const starts = a.starts;
    expect(starts).toBeGreaterThan(0);
    vi.advanceTimersByTime(2000);
    onRender!(snapshot(4, 12_100, true, c));
    expect(a.starts).toBe(starts);
  });

  it('closes the context after 10 s of silence, and on dispose', () => {
    onRender!(snapshot(1, 10_000, true, { kind: 'meow', at: 10_000 }));
    const a = StubAudio.made[0]!;
    vi.advanceTimersByTime(IDLE_CLOSE_MS + 1500);
    expect(a.closed).toBe(1);
    vi.advanceTimersByTime(1000);
    onRender!(snapshot(2, 30_000, true, { kind: 'trill', at: 30_000 }));
    const b = StubAudio.made[1]!;
    expect(b.closed).toBe(0);
    runtime.dispose();
    expect(b.closed).toBe(1);
  });
});
