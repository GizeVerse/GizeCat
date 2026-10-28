// App-wide renderer hardening and IPC sender verification. Every renderer is ours,
// sandboxed, and may only ever show desktop-cat:// pages; IPC is accepted only from
// the main frame of a window main created, showing the expected page.
import type { App, IpcMainEvent, IpcMainInvokeEvent, Session, WebContents } from 'electron';
import type { Logger } from './contracts';
import { APP_SCHEME } from '../shared/ipc';

export type WindowKind = 'overlay' | 'settings';

const PAGE_PREFIX: Record<WindowKind, string> = {
  overlay: `${APP_SCHEME}://app/renderer/overlay/`,
  settings: `${APP_SCHEME}://app/renderer/settings/`,
};

export function isAppUrl(url: string): boolean {
  return url.startsWith(`${APP_SCHEME}://app/`);
}

export function urlMatchesKind(url: string, kind: WindowKind): boolean {
  return url.startsWith(PAGE_PREFIX[kind]);
}

/** webContents ids of windows main created, by kind. */
export interface WindowRegistry {
  register(contents: WebContents, kind: WindowKind): void;
  unregister(id: number): void;
  kindOf(id: number): WindowKind | null;
  ids(kind: WindowKind): number[];
}

export function createWindowRegistry(): WindowRegistry {
  const kinds = new Map<number, WindowKind>();
  return {
    register(contents, kind) {
      const id = contents.id;
      kinds.set(id, kind);
      contents.once('destroyed', () => kinds.delete(id));
    },
    unregister(id) {
      kinds.delete(id);
    },
    kindOf(id) {
      return kinds.get(id) ?? null;
    },
    ids(kind) {
      return [...kinds].filter(([, k]) => k === kind).map(([id]) => id);
    },
  };
}

interface SenderLike {
  sender: { id: number };
  senderFrame: { url: string; parent: unknown } | null;
}

/** Pure check, exported for tests. */
export function isTrustedSender(event: SenderLike, registry: Pick<WindowRegistry, 'kindOf'>, kind: WindowKind): boolean {
  let frame: SenderLike['senderFrame'];
  try {
    frame = event.senderFrame;
  } catch {
    return false;
  }
  if (!frame || frame.parent !== null) return false;
  if (!urlMatchesKind(frame.url, kind)) return false;
  return registry.kindOf(event.sender.id) === kind;
}

export function verifyIpcSender(event: IpcMainEvent | IpcMainInvokeEvent, registry: WindowRegistry, kind: WindowKind): boolean {
  return isTrustedSender(event, registry, kind);
}

const ALLOWED_RENDERER_SCHEMES = new Set([`${APP_SCHEME}:`, 'data:', 'blob:', 'devtools:']);

function schemeOf(url: string): string {
  const i = url.indexOf(':');
  return i > 0 ? url.slice(0, i + 1).toLowerCase() : '';
}

export function installSecurity(app: App, ses: Session, logger: Logger): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => {
      logger.warn('blocked window.open');
      return { action: 'deny' };
    });
    const guard = (e: { preventDefault(): void }, url: string, what: string): void => {
      if (isAppUrl(url)) return;
      e.preventDefault();
      logger.warn(`blocked ${what}`, { scheme: schemeOf(url) });
    };
    contents.on('will-navigate', (e, url) => guard(e, url, 'navigation'));
    contents.on('will-redirect', (e, url) => guard(e, url, 'redirect'));
    contents.on('will-frame-navigate', (e) => guard(e, e.url, 'frame navigation'));
    contents.on('will-attach-webview', (e) => {
      e.preventDefault();
      logger.warn('blocked webview');
    });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logger.debug('denied permission request', { permission });
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    logger.warn('denied display media request from a renderer');
    callback(null);
  });

  // No remote content in renderers. Main-process requests (no webContents) are
  // not affected; the perception service enforces its own endpoint policy.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (details.webContentsId === undefined || ALLOWED_RENDERER_SCHEMES.has(schemeOf(details.url))) {
      callback({});
      return;
    }
    logger.warn('blocked renderer request', { scheme: schemeOf(details.url) });
    callback({ cancel: true });
  });
}
