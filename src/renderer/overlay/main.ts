// Overlay renderer entry point (bundled to out/renderer/overlay/main.js).
import type { OverlayApi } from '../../shared/ipc';
import { OverlayRuntime } from './runtime';
import { SurfaceLayer } from './surfaceLayer';

declare global {
  interface Window {
    desktopCat?: OverlayApi;
  }
}

function boot(): void {
  const api = window.desktopCat;
  if (!api) {
    console.error('overlay: preload API missing');
    return;
  }
  const canvas = document.getElementById('cat');
  if (!(canvas instanceof HTMLCanvasElement)) {
    api.reportError('overlay: #cat canvas missing');
    return;
  }
  let runtime: OverlayRuntime;
  try {
    runtime = new OverlayRuntime(canvas, api);
  } catch (err) {
    api.reportError(`overlay: init failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  window.addEventListener('error', (ev) => runtime.reportError(`overlay error: ${ev.message}`));
  window.addEventListener('unhandledrejection', (ev) => {
    const r: unknown = ev.reason;
    runtime.reportError(`overlay rejection: ${r instanceof Error ? r.message : String(r)}`);
  });
  window.addEventListener('beforeunload', () => runtime.dispose());
  startSurfaceLayer(api, runtime);
  runtime.start();
}

/** v1.1.1 surface outlines: their own canvas under the cat, drawn only when main sends a frame. */
function startSurfaceLayer(api: OverlayApi, runtime: OverlayRuntime): void {
  const canvas = document.getElementById('surfaces');
  if (!(canvas instanceof HTMLCanvasElement)) return;
  try {
    const layer = new SurfaceLayer(canvas, {
      dpr: () => window.devicePixelRatio,
      size: () => ({ width: window.innerWidth, height: window.innerHeight }),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
    });
    const off = api.onSurfaceLines((p) => layer.show(p));
    const onResize = (): void => layer.resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('beforeunload', () => {
      off();
      window.removeEventListener('resize', onResize);
      layer.dispose();
    });
  } catch (err) {
    runtime.reportError(`overlay: surface layer failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

boot();
