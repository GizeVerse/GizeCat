// Overlay renderer entry point (bundled to out/renderer/overlay/main.js).
import type { OverlayApi } from '../../shared/ipc';
import { OverlayRuntime } from './runtime';

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
  runtime.start();
}

boot();
