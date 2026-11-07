// 1.4.0: OverlayRuntime's optional third parameter (the web host's hooks). Without it the runtime
// behaves as before (window.innerWidth/innerHeight, the browser's AudioContext); with it the canvas
// follows the host's viewport and the sound player uses the host's AudioContext maker; a broken host
// viewport falls back to the window's. MOCKED: window, canvas and audio are stubs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatRenderState } from '../../../src/shared/cat';
import type { OverlayApi } from '../../../src/shared/ipc';
import { OverlayRuntime, type OverlayRuntimeOptions } from '../../../src/renderer/overlay/runtime';
import type { AudioContextLike } from '../../../src/renderer/overlay/sound';
import { createMockCtx } from './mockCtx';

function stubAudio(made: string[], tag: string): AudioContextLike {
  made.push(tag);
  const param = () => ({ value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined });
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  return {
    currentTime: 0,
    sampleRate: 8000,
    state: 'running',
    destination: node(),
    createOscillator: () => ({ ...node(), type: '', frequency: param(), start: () => undefined, stop: () => undefined }),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
    createBuffer: (_c, length) => {
      const d = new Float32Array(length);
      return { getChannelData: () => d };
    },
    createBufferSource: () => ({ ...node(), buffer: null, loop: false, start: () => undefined, stop: () => undefined }),
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function snapshot(seq: number, t: number): CatRenderState {
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
    visible: true,
    skin: 'ginger',
    style: 'smooth',
    shadow: true,
    animSpeed: 1,
    sound: { kind: 'chirp', at: t, volume: 0.5 },
  };
}

describe('overlay runtime options (1.4.0)', () => {
  let onRender: ((s: CatRenderState) => void) | null = null;
  let canvas: { width: number; height: number };
  let runtime: OverlayRuntime | null = null;
  const made: string[] = [];

  function start(options?: OverlayRuntimeOptions): void {
    const mock = createMockCtx(800, 600);
    const c = {
      width: 1,
      height: 1,
      getContext: () => mock.ctx,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      setPointerCapture: () => undefined,
    };
    canvas = c;
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
    runtime = options === undefined ? new OverlayRuntime(c as unknown as HTMLCanvasElement, api) : new OverlayRuntime(c as unknown as HTMLCanvasElement, api, options);
    runtime.start();
  }

  beforeEach(() => {
    made.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', { devicePixelRatio: 2, innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          return stubAudio(made, 'global');
        }
      },
    );
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('without options: the window size and the browser AudioContext, as before', () => {
    start();
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    onRender!(snapshot(1, 10_000));
    expect(made).toEqual(['global']);
  });

  it("with options: the host's viewport sizes the canvas and the host's maker makes the AudioContext", () => {
    start({ viewport: () => ({ width: 500, height: 400 }), audio: () => stubAudio(made, 'host') });
    expect([canvas.width, canvas.height]).toEqual([1000, 800]);
    onRender!(snapshot(1, 10_000));
    expect(made).toEqual(['host']);
  });

  it("a host viewport that throws or is broken falls back to the window's", () => {
    start({
      viewport: () => {
        throw new Error('gone');
      },
    });
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    runtime?.dispose();
    start({ viewport: () => ({ width: Number.NaN, height: 10 }) });
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
  });
});
