// Registers the service worker (1.4.0) once the page has loaded. Whether to register at all is
// decided by hostMode.shouldRegisterServiceWorker (browser, secure origin, production build). A
// failure is a warning and never stops the cat: the page works without a worker, it just does not
// start offline. When a newer version takes over while the page runs, `onUpdateReady` tells the
// sheet ("a new version is ready the next time you open GizeCat"); the page is never reloaded for it.
//
// Structural types only (the container is navigator.serviceWorker), so it is unit-testable.

export interface ServiceWorkerContainerLike {
  readonly controller: unknown;
  register(url: string, options: { scope: string; updateViaCache: 'none' }): Promise<unknown>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface SwRegisterEnv {
  /** navigator.serviceWorker, undefined where unsupported. */
  container: ServiceWorkerContainerLike | undefined;
  /** Runs `cb` after the window's load event (at once when it already fired). */
  whenLoaded: (cb: () => void) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  onUpdateReady?: () => void;
}

export type SwRegisterResult = 'scheduled' | 'unsupported';

export function registerServiceWorker(env: SwRegisterEnv): SwRegisterResult {
  const c = env.container;
  if (!c || typeof c.register !== 'function') return 'unsupported';
  // A worker already controlled this page: a later controllerchange is a new version taking over.
  // The first install (no controller yet) also changes the controller; that is not an update.
  const hadController = Boolean(c.controller);
  let announced = false;
  try {
    c.addEventListener('controllerchange', () => {
      if (!hadController || announced) return;
      announced = true;
      try {
        env.onUpdateReady?.();
      } catch {
        // The notice is optional.
      }
    });
  } catch {
    // No update notice then.
  }
  env.whenLoaded(() => {
    try {
      c.register('sw.js', { scope: './', updateViaCache: 'none' }).catch((err: unknown) => {
        env.warn('service worker registration failed: the app will not start offline', { error: err instanceof Error ? err.message : String(err) });
      });
    } catch (err) {
      env.warn('service worker registration failed: the app will not start offline', { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return 'scheduled';
}
