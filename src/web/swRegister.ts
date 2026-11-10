// Registers the service worker (1.4.0) once the page has loaded. Whether to register at all is
// decided by hostMode.shouldRegisterServiceWorker (browser, secure origin, production build). A
// failure is a warning and never stops the cat: the page works without a worker, it just does not
// start offline. The sheet's offline line follows the worker's state (`onState`): getting ready,
// ready, a new version ready (it took over while the page ran; the page is never reloaded for it
// and it starts the next time GizeCat opens), or failed.
//
// Only GizeCat's own worker counts. On a shared origin (a github.io site, a nested copy) a worker
// with a broader scope can control this page too, and says nothing about GizeCat's offline copy;
// navigator.serviceWorker.ready is not used for the same reason (it can settle on that worker, and
// it settles only once).
//
// Structural types only (the container is navigator.serviceWorker), so it is unit-testable.

/**
 * - unavailable: no worker here (this browser, an insecure origin, a development build);
 * - preparing: the worker is installing, the offline copy is not complete yet;
 * - ready: GizeCat's worker has the full copy of the app and is active;
 * - update-ready: a newer version took over while the page ran;
 * - failed: the worker could not be installed, there is no offline copy.
 */
export type OfflineState = 'unavailable' | 'preparing' | 'ready' | 'update-ready' | 'failed';

export interface InstallingWorkerLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface ServiceWorkerLike {
  readonly scriptURL: string;
}

export interface ServiceWorkerContainerLike {
  /** The worker controlling this page, which may not be GizeCat's. */
  readonly controller: ServiceWorkerLike | null;
  register(url: string, options: { scope: string; updateViaCache: 'none' }): Promise<unknown>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface SwRegisterEnv {
  /** navigator.serviceWorker, undefined where unsupported. */
  container: ServiceWorkerContainerLike | undefined;
  /** This page's address (location.href): GizeCat's own worker is the sw.js next to it. */
  pageUrl: string;
  /** Runs `cb` after the window's load event (at once when it already fired). */
  whenLoaded: (cb: () => void) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  /** The offline state, once at the start and then at every change (never when unsupported: the page starts as 'unavailable'). */
  onState?: (state: OfflineState) => void;
}

export type SwRegisterResult = 'scheduled' | 'unsupported';

const SW_FILE = 'sw.js';

export function registerServiceWorker(env: SwRegisterEnv): SwRegisterResult {
  const c = env.container;
  if (!c || typeof c.register !== 'function') return 'unsupported';
  const ownScript = new URL(SW_FILE, env.pageUrl).href;
  const isOwn = (controller: ServiceWorkerLike | null): boolean => controller?.scriptURL === ownScript;
  // GizeCat's worker already controls this page: the app is already kept offline, and a later
  // controllerchange is a new version taking over. The first install (not ours yet) also changes
  // the controller; that is the copy becoming ready, not an update.
  let controlled = isOwn(c.controller);
  /** GizeCat's worker is active, so a full copy exists, whether or not it controls this page yet. */
  let hasCopy = controlled;
  let state: OfflineState = controlled ? 'ready' : 'preparing';
  const report = (): void => {
    try {
      env.onState?.(state);
    } catch {
      // The notice is optional.
    }
  };
  const set = (next: OfflineState): void => {
    // "A new version is ready" stays true until the page is left.
    if (state === 'update-ready' || state === next) return;
    state = next;
    report();
  };
  const copyIsReady = (): void => {
    hasCopy = true;
    set('ready');
  };
  report();
  try {
    c.addEventListener('controllerchange', () => {
      // Another worker taking the page says nothing about GizeCat's copy.
      if (!isOwn(c.controller)) return;
      if (controlled) {
        set('update-ready');
      } else {
        controlled = true;
        copyIsReady();
      }
    });
  } catch {
    // No update notice then.
  }
  const registrationFailed = (err: unknown): void => {
    env.warn('service worker registration failed: the app will not start offline', { error: err instanceof Error ? err.message : String(err) });
    // With an active worker of ours the app still starts offline, from its copy.
    if (!hasCopy) set('failed');
  };
  /**
   * What register() found. A worker already active means the copy exists. A first install resolves
   * with no active worker, so it is followed to its end: "activated" is the copy being ready, and
   * "redundant" with no earlier copy is a failure (e.g. a shell file could not be fetched).
   */
  const followRegistration = (registration: unknown): void => {
    const found = registration as { active?: unknown; installing?: InstallingWorkerLike | null } | null | undefined;
    if (found?.active) copyIsReady();
    const worker = found?.installing;
    if (!worker || typeof worker.addEventListener !== 'function') return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') copyIsReady();
      else if (worker.state === 'redundant' && !hasCopy) set('failed');
    });
  };
  env.whenLoaded(() => {
    try {
      void c.register(SW_FILE, { scope: './', updateViaCache: 'none' }).then(followRegistration, registrationFailed);
    } catch (err) {
      registrationFailed(err);
    }
  });
  return 'scheduled';
}
