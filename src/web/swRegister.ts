// Registers the service worker (1.4.0) once the page has loaded. Whether to register at all is
// decided by hostMode.shouldRegisterServiceWorker (browser, secure origin, production build). A
// failure is a warning and never stops the cat: the page works without a worker, it just does not
// start offline. The sheet's offline line follows the worker's state (`onState`): getting ready,
// ready, a new version ready (it took over while the page ran; the page is never reloaded for it
// and it starts the next time GizeCat opens), or failed.
//
// Structural types only (the container is navigator.serviceWorker), so it is unit-testable.

/**
 * - unavailable: no worker here (this browser, an insecure origin, a development build);
 * - preparing: the worker is installing, the offline copy is not complete yet;
 * - ready: a worker with the full copy of the app is in charge;
 * - update-ready: a newer version took over while the page ran;
 * - failed: the worker could not be installed, there is no offline copy.
 */
export type OfflineState = 'unavailable' | 'preparing' | 'ready' | 'update-ready' | 'failed';

export interface InstallingWorkerLike {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}

export interface ServiceWorkerContainerLike {
  readonly controller: unknown;
  /** Resolves once a worker for this scope is active. */
  readonly ready?: Promise<unknown>;
  register(url: string, options: { scope: string; updateViaCache: 'none' }): Promise<unknown>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface SwRegisterEnv {
  /** navigator.serviceWorker, undefined where unsupported. */
  container: ServiceWorkerContainerLike | undefined;
  /** Runs `cb` after the window's load event (at once when it already fired). */
  whenLoaded: (cb: () => void) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  /** The offline state, once at the start and then at every change (never when unsupported: the page starts as 'unavailable'). */
  onState?: (state: OfflineState) => void;
}

export type SwRegisterResult = 'scheduled' | 'unsupported';

export function registerServiceWorker(env: SwRegisterEnv): SwRegisterResult {
  const c = env.container;
  if (!c || typeof c.register !== 'function') return 'unsupported';
  // A worker already controls this page: the app is already kept offline, and a later
  // controllerchange is a new version taking over. The first install (no controller yet) also
  // changes the controller; that is the copy becoming ready, not an update.
  let controlled = Boolean(c.controller);
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
  report();
  try {
    c.addEventListener('controllerchange', () => {
      if (controlled) {
        set('update-ready');
      } else {
        controlled = true;
        set('ready');
      }
    });
  } catch {
    // No update notice then.
  }
  const registrationFailed = (err: unknown): void => {
    env.warn('service worker registration failed: the app will not start offline', { error: err instanceof Error ? err.message : String(err) });
    // With a worker already in charge the app still starts offline, from its copy.
    if (!controlled) set('failed');
  };
  /** A first install that ends "redundant" failed (e.g. a shell file could not be fetched): there is no copy. */
  const watchInstall = (registration: unknown): void => {
    const worker = (registration as { installing?: InstallingWorkerLike | null } | null | undefined)?.installing;
    if (!worker || typeof worker.addEventListener !== 'function') return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'redundant' && !controlled) set('failed');
    });
  };
  env.whenLoaded(() => {
    try {
      void c.register('sw.js', { scope: './', updateViaCache: 'none' }).then(watchInstall, registrationFailed);
      void c.ready?.then(
        () => set('ready'),
        () => undefined,
      );
    } catch (err) {
      registrationFailed(err);
    }
  });
  return 'scheduled';
}
