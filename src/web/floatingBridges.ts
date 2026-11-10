// Page-side adapters for the two floating-cat bridges (floatingProtocol.ts). Each reads the global
// that androidx.webkit's addWebMessageListener put on `window` (only in the app's own origin; a
// browser tab has neither), and exposes it as plain typed functions. Nothing here throws: a missing
// bridge is null, a refused message is dropped.
import {
  CONTROL_BRIDGE_NAME,
  OVERLAY_BRIDGE_NAME,
  OVERLAY_SURFACE_QUERY,
  OVERLAY_SURFACE_VALUE,
  parseFloatingState,
  parseOverlayInbound,
  serializeControlOp,
  serializeOverlayOutbound,
  type ControlOp,
  type FloatingState,
  type OverlayInbound,
  type OverlayOutbound,
} from './floatingProtocol';
import type { OverlayPort } from './overlaySurface';

/** The shape addWebMessageListener installs: postMessage(string) and an onmessage property. */
interface NativePort {
  postMessage(message: string): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

function nativePort(win: object, name: string): NativePort | null {
  const candidate = (win as Record<string, unknown>)[name];
  if (typeof candidate !== 'object' || candidate === null) return null;
  const p = candidate as Partial<NativePort>;
  return typeof p.postMessage === 'function' ? (candidate as NativePort) : null;
}

/** True when this page was loaded as the floating cat's window (`?surface=overlay`). */
export function isOverlaySurface(search: string): boolean {
  try {
    return new URLSearchParams(search).get(OVERLAY_SURFACE_QUERY) === OVERLAY_SURFACE_VALUE;
  } catch {
    return false;
  }
}

/** The overlay window's bridge, or null when the page is not inside the floating window. */
export function connectOverlayBridge(win: object): OverlayPort | null {
  const port = nativePort(win, OVERLAY_BRIDGE_NAME);
  if (!port) return null;
  const listeners = new Set<(m: OverlayInbound) => void>();
  port.onmessage = (ev) => {
    const m = parseOverlayInbound(ev.data);
    if (!m) return;
    for (const cb of [...listeners]) {
      try {
        cb(m);
      } catch {
        // One listener's failure must not stop native's next message.
      }
    }
  };
  return {
    post(message: OverlayOutbound) {
      try {
        port.postMessage(serializeOverlayOutbound(message));
      } catch {
        // The window is going away.
      }
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/** The app screen's control bridge for the floating cat. */
export interface ControlPort {
  send(op: ControlOp): void;
  /** Called with every state native pushes (the answer to 'query', then each change); returns the unsubscribe. */
  onState(cb: (s: FloatingState) => void): () => void;
}

export function connectControlBridge(win: object): ControlPort | null {
  const port = nativePort(win, CONTROL_BRIDGE_NAME);
  if (!port) return null;
  const listeners = new Set<(s: FloatingState) => void>();
  port.onmessage = (ev) => {
    const s = parseFloatingState(ev.data);
    if (!s) return;
    for (const cb of [...listeners]) {
      try {
        cb(s);
      } catch {
        // Ignored, as above.
      }
    }
  };
  return {
    send(op) {
      try {
        port.postMessage(serializeControlOp(op));
      } catch {
        // Native is gone; the next page load tries again.
      }
    },
    onState(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
