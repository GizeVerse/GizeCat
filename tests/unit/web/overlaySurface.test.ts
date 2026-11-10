// The floating cat's page side: the display service, the window rectangle and the surface that turns
// native messages into the cat's input and the cat's position into a window position
// (src/web/overlayDisplay.ts, src/web/overlaySurface.ts). Written for 1.4.1 and NOT RUN
// by the agent that wrote it (owner rule: no tests).
import { describe, expect, it, vi } from 'vitest';
import type { OverlayInbound, OverlayOutbound, ScreenMetrics } from '../../../src/web/floatingProtocol';
import { createOverlayDisplayService, screenDisplay } from '../../../src/web/overlayDisplay';
import { createOverlaySurface, windowRectFor, windowSizeDip, type OverlayPort, type OverlayTargets } from '../../../src/web/overlaySurface';
import type { SimOutput } from '../../../src/shared/sim';

const METRICS: ScreenMetrics = { width: 1280, height: 800, density: 2, insets: { top: 24, right: 0, bottom: 48, left: 0 } };

describe('overlay display', () => {
  it('the work area is the screen inside the bars, in dp', () => {
    const d = screenDisplay(METRICS);
    expect(d.boundsPx).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(d.workAreaPx).toEqual({ x: 0, y: 24, width: 1280, height: 728 });
    expect(d.scaleFactor).toBe(1);
  });

  it('local DIP is the world minus the window origin, and back', () => {
    const svc = createOverlayDisplayService(METRICS);
    svc.setOrigin({ x: 100, y: 50 });
    expect(svc.toLocalDip('x', { x: 130, y: 90 })).toEqual({ x: 30, y: 40 });
    expect(svc.fromLocalDip('x', { x: 30, y: 40 })).toEqual({ x: 130, y: 90 });
    svc.setOrigin({ x: Number.NaN, y: 0 });
    expect(svc.origin).toEqual({ x: 100, y: 50 });
  });

  it('reports a changed screen once and a repeat not at all', () => {
    const svc = createOverlayDisplayService(METRICS);
    const seen: number[] = [];
    svc.onChange((w) => seen.push(w.version));
    expect(svc.update(METRICS)).toBe(false);
    expect(svc.update({ ...METRICS, width: 800, height: 1280 })).toBe(true);
    expect(svc.update({ ...METRICS, width: 800, height: 1280 })).toBe(false);
    expect(seen).toEqual([2]);
    expect(svc.world.displays[0]?.boundsPx.width).toBe(800);
  });
});

describe('window rectangle', () => {
  const appearance = { size: 1, emotes: false };

  it('is the footprint plus the renderer margins, snapped to device pixels', () => {
    const size = windowSizeDip(appearance);
    expect(size.width).toBe(84 + 2 * 44);
    const rect = windowRectFor({ x: 300.3, y: 500.2, width: 84, height: 64 }, appearance, 2.625);
    expect(rect.width * 2.625).toBeCloseTo(Math.round(rect.width * 2.625), 6);
    expect(rect.x * 2.625).toBeCloseTo(Math.round(rect.x * 2.625), 6);
    expect(rect.y * 2.625).toBeCloseTo(Math.round(rect.y * 2.625), 6);
    expect(rect.width).toBeGreaterThanOrEqual(size.width);
    expect(rect.x).toBeCloseTo(300.3 - 44, 0);
  });

  it('is larger with emotes on, and scales with the cat', () => {
    expect(windowSizeDip({ size: 1, emotes: true }).height).toBeGreaterThan(windowSizeDip({ size: 1, emotes: false }).height);
    expect(windowSizeDip({ size: 2, emotes: false }).width).toBe(2 * windowSizeDip({ size: 1, emotes: false }).width);
  });

  it('survives a nonsense density', () => {
    const r = windowRectFor({ x: 10, y: 10, width: 84, height: 64 }, appearance, Number.NaN);
    expect(Number.isFinite(r.x) && Number.isFinite(r.width)).toBe(true);
  });
});

function harness(touchable: () => boolean = () => true) {
  const posted: OverlayOutbound[] = [];
  let handler: ((m: OverlayInbound) => void) | null = null;
  const port: OverlayPort = {
    post: (m) => posted.push(m),
    onMessage: (cb) => {
      handler = cb;
      return () => {
        handler = null;
      };
    },
  };
  const router = { handle: vi.fn(), cancel: vi.fn() };
  const targets: OverlayTargets = {
    setPaused: vi.fn(),
    setHidden: vi.fn(),
    onSystem: vi.fn(),
    saveNow: vi.fn(() => true),
    reloadSettings: vi.fn(),
    router,
    getAppearance: () => ({ size: 1, emotes: false }),
  };
  const surface = createOverlaySurface(METRICS, port, () => ({ size: 1, emotes: false }), touchable);
  const disconnect = surface.connect(targets);
  const send = (m: OverlayInbound): void => handler?.(m);
  return { posted, router, targets, surface, send, disconnect };
}

const OUT = { boundsPx: { x: 400, y: 600, width: 84, height: 64 }, x: 442, y: 664 } as unknown as SimOutput;

describe('overlay surface', () => {
  it('says hello when connected', () => {
    const h = harness();
    expect(h.posted[0]).toEqual({ t: 'hello', v: 1 });
  });

  it('turns the cat into a window position, once per change, and sets the local origin', () => {
    const h = harness();
    h.surface.onPresence(OUT);
    const win = h.posted.find((m) => m.t === 'win');
    expect(win).toMatchObject({ t: 'win', vis: true });
    expect(h.surface.display.origin.x).toBeCloseTo(400 - 44, 0);
    const count = h.posted.length;
    h.surface.onPresence(OUT);
    expect(h.posted.length).toBe(count);
    h.surface.onPresence(null);
    expect(h.posted.at(-1)).toMatchObject({ t: 'win', vis: false });
  });

  it('tells native when the cat takes no touches, also after a command that does not move the cat', () => {
    let touchable = true;
    const h = harness(() => touchable);
    h.surface.onPresence(OUT);
    expect(h.posted.at(-1)).toMatchObject({ t: 'win', vis: true, touch: true });
    touchable = false;
    h.send({ t: 'cmd', c: 'pause' });
    expect(h.posted.at(-1)).toMatchObject({ t: 'win', vis: true, touch: false });
    const count = h.posted.length;
    h.send({ t: 'cmd', c: 'reloadSettings' });
    expect(h.posted.length).toBe(count);
    touchable = true;
    h.send({ t: 'cmd', c: 'resume' });
    expect(h.posted.at(-1)).toMatchObject({ touch: true });
  });

  it('turns native touches into touch pointer events at the raw position', () => {
    const h = harness();
    h.send({ t: 'ptr', k: 'down', id: 3, x: 500, y: 640 });
    h.send({ t: 'ptr', k: 'move', id: 3, x: 520, y: 650 });
    h.send({ t: 'ptr', k: 'up', id: 3, x: 520, y: 650 });
    h.send({ t: 'ptr', k: 'cancel', id: 4, x: 1, y: 2 });
    const calls = h.router.handle.mock.calls.map((c) => c[0] as { type: string; pointerType: string; pointerId: number; clientX: number; clientY: number });
    expect(calls.map((e) => e.type)).toEqual(['pointerdown', 'pointermove', 'pointerup', 'pointercancel']);
    expect(calls.every((e) => e.pointerType === 'touch')).toBe(true);
    expect(calls[0]).toMatchObject({ pointerId: 3, clientX: 500, clientY: 640 });
  });

  it('runs commands, saves with an answer, and follows new screen metrics', () => {
    const h = harness();
    h.send({ t: 'cmd', c: 'pause' });
    expect(h.router.cancel).toHaveBeenCalled();
    expect(h.targets.setPaused).toHaveBeenCalledWith(true);
    h.send({ t: 'cmd', c: 'resume' });
    expect(h.targets.setPaused).toHaveBeenLastCalledWith(false);
    h.send({ t: 'cmd', c: 'hide' });
    expect(h.targets.setHidden).toHaveBeenCalledWith(true);
    h.send({ t: 'cmd', c: 'suspend' });
    expect(h.targets.onSystem).toHaveBeenCalledWith('suspend');
    h.send({ t: 'cmd', c: 'wake' });
    expect(h.targets.onSystem).toHaveBeenLastCalledWith('resume');
    h.send({ t: 'cmd', c: 'reloadSettings' });
    expect(h.targets.reloadSettings).toHaveBeenCalled();
    h.send({ t: 'cmd', c: 'save' });
    expect(h.posted.at(-1)).toEqual({ t: 'saved', ok: true });
    h.send({ t: 'metrics', metrics: { ...METRICS, width: 800, height: 1280 } });
    expect(h.surface.display.world.displays[0]?.boundsPx.width).toBe(800);
  });

  it('answers a failed save with ok false, and a throwing save too', () => {
    const h = harness();
    vi.mocked(h.targets.saveNow).mockReturnValueOnce(false);
    h.send({ t: 'cmd', c: 'save' });
    expect(h.posted.at(-1)).toEqual({ t: 'saved', ok: false });
    vi.mocked(h.targets.saveNow).mockImplementationOnce(() => {
      throw new Error('storage');
    });
    h.send({ t: 'cmd', c: 'save' });
    expect(h.posted.at(-1)).toEqual({ t: 'saved', ok: false });
  });

  it('ends the cat\'s press when it disconnects', () => {
    const h = harness();
    h.disconnect();
    expect(h.router.cancel).toHaveBeenCalled();
  });
});
