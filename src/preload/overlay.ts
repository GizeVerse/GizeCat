// Sandboxed preload for overlay windows: exposes exactly the OverlayApi as
// `window.desktopCat`. Only 'electron' is imported at runtime; the channel names are
// checked against the shared IPC table at compile time (import type keeps zod out of
// this bundle).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CatRenderState, HitRegion } from '../shared/cat';
import type { IPC, OverlayApi, OverlayConfig, OverlayPointerEvent } from '../shared/ipc';

type OverlayChannels = Pick<
  typeof IPC,
  'overlayRender' | 'overlayConfig' | 'overlayReady' | 'overlayPointer' | 'overlayHitRegion' | 'overlayError'
>;

const CH: OverlayChannels = {
  overlayRender: 'overlay:render',
  overlayConfig: 'overlay:config',
  overlayReady: 'overlay:ready',
  overlayPointer: 'overlay:pointer',
  overlayHitRegion: 'overlay:hit-region',
  overlayError: 'overlay:error',
};

const MAX_RECTS = 8;

function reportListenerError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  ipcRenderer.send(CH.overlayError, { message: `overlay listener failed: ${message}`.slice(0, 500) });
}

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  if (typeof cb !== 'function') return () => undefined;
  const handler = (_event: IpcRendererEvent, value: T): void => {
    try {
      cb(value);
    } catch (err) {
      reportListenerError(err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN);

const api: OverlayApi = {
  onRender: (cb: (state: CatRenderState) => void) => subscribe<CatRenderState>(CH.overlayRender, cb),
  onConfig: (cb: (config: OverlayConfig) => void) => subscribe<OverlayConfig>(CH.overlayConfig, cb),
  ready(): void {
    ipcRenderer.send(CH.overlayReady);
  },
  sendPointer(e: OverlayPointerEvent): void {
    // Copy only the contract fields; main validates them again.
    ipcRenderer.send(CH.overlayPointer, {
      kind: e.kind,
      x: num(e.x),
      y: num(e.y),
      button: num(e.button),
      buttons: num(e.buttons),
      t: num(e.t),
    });
  },
  sendHitRegion(region: HitRegion): void {
    const src = Array.isArray(region?.rects) ? region.rects.slice(0, MAX_RECTS) : [];
    ipcRenderer.send(CH.overlayHitRegion, {
      rects: src.map((r) => ({ x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) })),
    });
  },
  reportError(message: string): void {
    ipcRenderer.send(CH.overlayError, { message: String(message).slice(0, 500) });
  },
};

contextBridge.exposeInMainWorld('desktopCat', api);
