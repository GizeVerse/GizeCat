// v1.1.1 surface outlines in the overlay renderer: colour and dash by role, drawn back to
// front, one draw per frame from main (no animation loop), a 1x1 bitmap whenever nothing
// is shown, and lines that vanish when main stops sending.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceDebugLine } from '../../../src/shared/surfaceDiagnostics';
import { ROLE_ORDER, ROLE_STYLE, SURFACE_LINES_STALE_MS, SurfaceLayer, type LayerCanvas } from '../../../src/renderer/overlay/surfaceLayer';
import type { Ctx2D } from '../../../src/renderer/overlay/cat/draw';

interface Stroke {
  style: string;
  width: number;
  dash: number[];
  segments: number[][];
}

function recordingCanvas() {
  const strokes: Stroke[] = [];
  let clears = 0;
  let path: number[][] = [];
  let dash: number[] = [];
  const state = { strokeStyle: '', lineWidth: 1, lineCap: 'butt' };
  let pending: number[] = [];
  const ctx = {
    ...state,
    setTransform: () => undefined,
    clearRect: () => {
      clears++;
    },
    beginPath: () => {
      path = [];
    },
    moveTo: (x: number, y: number) => {
      pending = [x, y];
    },
    lineTo: (x: number, y: number) => {
      path.push([...pending, x, y]);
    },
    setLineDash: (d: number[]) => {
      dash = [...d];
    },
    stroke() {
      strokes.push({ style: this.strokeStyle, width: this.lineWidth, dash: [...dash], segments: path });
    },
  };
  const canvas: LayerCanvas & { contexts: number } = {
    width: 300,
    height: 150,
    contexts: 0,
    getContext: () => {
      canvas.contexts++;
      return ctx as unknown as Ctx2D;
    },
  };
  return {
    canvas,
    strokes,
    get clears() {
      return clears;
    },
  };
}

const line = (role: SurfaceDebugLine['role'], x0: number, y0 = 100): SurfaceDebugLine => ({ kind: 'windowTop', role, x0, y0, x1: x0 + 50, y1: y0 });

describe('overlay surface layer', () => {
  let size = { width: 1536, height: 960 };
  let dpr = 1.25;
  const env = {
    dpr: () => dpr,
    size: () => size,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    size = { width: 1536, height: 960 };
    dpr = 1.25;
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new Error('the surface layer must not run an animation loop');
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('holds a 1x1 bitmap until there is something to draw', () => {
    const rec = recordingCanvas();
    const layer = new SurfaceLayer(rec.canvas, env);
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1, 1]);
    layer.show({ lines: [] });
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1, 1]);
    expect(rec.strokes).toEqual([]);
    expect(rec.canvas.contexts).toBe(0);
  });

  it('draws every role in its own colour, rejected dashed, back to front, at device resolution', () => {
    const rec = recordingCanvas();
    const layer = new SurfaceLayer(rec.canvas, env);
    layer.show({ lines: [line('target', 400), line('rejected', 10), line('valid', 100), line('reachable', 200), line('support', 300), line('rejected', 20)] });
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1920, 1200]);
    expect(rec.strokes.map((s) => s.style)).toEqual(ROLE_ORDER.map((r) => ROLE_STYLE[r].stroke));
    expect(rec.strokes[0]).toEqual({ style: ROLE_STYLE.rejected.stroke, width: ROLE_STYLE.rejected.width, dash: [6, 4], segments: [[10, 100, 60, 100], [20, 100, 70, 100]] });
    for (const s of rec.strokes.slice(1)) expect(s.dash).toEqual([]);
    expect(rec.strokes.at(-1)!.segments).toEqual([[400, 100, 450, 100]]);
    expect(layer.lineCount).toBe(6);
    // Distinct colours per role (grey, blue, green, orange, magenta).
    expect(new Set(ROLE_ORDER.map((r) => ROLE_STYLE[r].stroke)).size).toBe(ROLE_ORDER.length);
  });

  it('an empty frame clears the layer and releases the bitmap', () => {
    const rec = recordingCanvas();
    const layer = new SurfaceLayer(rec.canvas, env);
    layer.show({ lines: [line('valid', 100)] });
    layer.show({ lines: [] });
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1, 1]);
    expect(layer.lineCount).toBe(0);
  });

  it('clears itself when main stops sending, and each frame restarts that clock', () => {
    const rec = recordingCanvas();
    const layer = new SurfaceLayer(rec.canvas, env);
    layer.show({ lines: [line('valid', 100)] });
    vi.advanceTimersByTime(SURFACE_LINES_STALE_MS - 1);
    layer.show({ lines: [line('valid', 100)] });
    vi.advanceTimersByTime(SURFACE_LINES_STALE_MS - 1);
    expect(layer.lineCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(layer.lineCount).toBe(0);
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1, 1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redraws at the new size after a resize, and does nothing on resize while empty', () => {
    const rec = recordingCanvas();
    const layer = new SurfaceLayer(rec.canvas, env);
    layer.resize();
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1, 1]);
    layer.show({ lines: [line('support', 100)] });
    const drawn = rec.strokes.length;
    size = { width: 1280, height: 720 };
    dpr = 1.5;
    layer.resize();
    expect([rec.canvas.width, rec.canvas.height]).toEqual([1920, 1080]);
    expect(rec.strokes.length).toBe(drawn + 1);
    layer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
