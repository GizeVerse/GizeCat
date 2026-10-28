// The overlay renderer's heartbeat: while main shows the cat on this overlay the hit
// region is re-reported periodically, so main can tell a hung renderer from an idle one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatRenderState, HitRegion } from '../../../src/shared/cat';
import type { OverlayApi } from '../../../src/shared/ipc';
import { HIT_REFRESH_MS, HitRegionReporter } from '../../../src/renderer/overlay/hitRegion';
import { OverlayRuntime } from '../../../src/renderer/overlay/runtime';
import { createMockCtx } from './mockCtx';

const rect = (x: number) => ({ x, y: 10, width: 30, height: 20 });

describe('hit region refresh', () => {
  it('re-sends the last region once nothing was sent for the refresh period', () => {
    const sent: HitRegion[] = [];
    const rep = new HitRegionReporter((r) => sent.push(r));
    expect(rep.refresh(0)).toBe(true);
    expect(sent[0]!.rects).toEqual([]);
    rep.update([rect(5)], 1, 100);
    expect(rep.refresh(100 + HIT_REFRESH_MS - 1)).toBe(false);
    expect(rep.refresh(100 + HIT_REFRESH_MS)).toBe(true);
    expect(sent.map((s) => s.rects[0]?.x ?? null)).toEqual([null, 5, 5]);
  });
});

function snapshot(seq: number, t: number, visible: boolean): CatRenderState {
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
  };
}

describe('overlay runtime heartbeat', () => {
  let frames: FrameRequestCallback[] = [];
  let onRender: ((s: CatRenderState) => void) | null = null;
  let sentAt: number[] = [];
  let runtime: OverlayRuntime;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    frames = [];
    sentAt = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
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
      ready: () => undefined,
      sendPointer: () => undefined,
      sendHitRegion: () => sentAt.push(performance.now()),
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

  /** Advances time by `ms`, running animation frames at ~60 Hz. */
  function advance(ms: number): void {
    for (let t = 0; t < ms; t += 16) {
      vi.advanceTimersByTime(16);
      const due = frames.splice(0);
      for (const f of due) f(performance.now());
    }
  }

  it('reports at least every ~0.75 s while the cat is shown, even when nothing changes, and stops when hidden', () => {
    advance(2000);
    expect(sentAt).toEqual([]);
    const t0 = performance.now();
    onRender!(snapshot(1, 10_000, true));
    advance(5000);
    const shown = sentAt.filter((t) => t >= t0);
    expect(shown.length).toBeGreaterThanOrEqual(6);
    const gaps = shown.slice(1).map((t, i) => t - shown[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(HIT_REFRESH_MS * 1.5 + 20);
    expect(performance.now() - shown.at(-1)!).toBeLessThanOrEqual(HIT_REFRESH_MS * 1.5 + 20);

    onRender!(snapshot(2, 15_000, false));
    advance(500);
    const n = sentAt.length;
    advance(5000);
    expect(sentAt.length).toBe(n);
  });
});
