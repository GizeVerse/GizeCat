// Service worker registration (src/web/swRegister.ts): after load, with the scope and update policy
// the design asks for; failures are warnings; the sheet's offline state follows the worker, and an
// update is announced only when a worker already controlled the page. MOCKED: the container is a fake.
import { describe, expect, it } from 'vitest';
import { registerServiceWorker, type InstallingWorkerLike, type OfflineState, type ServiceWorkerContainerLike } from '../../../src/web/swRegister';

function fakeContainer(controller: unknown, fail = false, registration: unknown = {}, ready?: Promise<unknown>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  let onChange: (() => void) | null = null;
  const c: ServiceWorkerContainerLike = {
    controller,
    ...(ready ? { ready } : {}),
    register(url, options) {
      calls.push({ url, options });
      return fail ? Promise.reject(new Error('blocked')) : Promise.resolve(registration);
    },
    addEventListener(_type, listener) {
      onChange = listener;
    },
  };
  return { c, calls, fire: () => onChange?.() };
}

/** Lets promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('service worker registration', () => {
  it('reports unsupported without a container and registers nothing', () => {
    expect(registerServiceWorker({ container: undefined, whenLoaded: (cb) => cb(), warn: () => undefined })).toBe('unsupported');
  });

  it("registers 'sw.js' after load with scope './' and updateViaCache 'none'", () => {
    const f = fakeContainer(null);
    // Typed through `as`, so the control flow does not narrow it to null (it is assigned in a callback).
    let loaded = null as (() => void) | null;
    expect(registerServiceWorker({ container: f.c, whenLoaded: (cb) => (loaded = cb), warn: () => undefined })).toBe('scheduled');
    expect(f.calls).toHaveLength(0);
    loaded!();
    expect(f.calls).toEqual([{ url: 'sw.js', options: { scope: './', updateViaCache: 'none' } }]);
  });

  it('logs a failed registration as a warning, never throws', async () => {
    const f = fakeContainer(null, true);
    const warnings: string[] = [];
    registerServiceWorker({ container: f.c, whenLoaded: (cb) => cb(), warn: (m) => warnings.push(m) });
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toHaveLength(1);
  });

  it('announces an update once, and only when a worker already controlled the page', () => {
    const states: OfflineState[] = [];
    const first = fakeContainer(null);
    registerServiceWorker({ container: first.c, whenLoaded: () => undefined, warn: () => undefined, onState: (s) => states.push(s) });
    first.fire();
    expect(states, 'the first install is the copy becoming ready, not an update').toEqual(['preparing', 'ready']);

    const later: OfflineState[] = [];
    const controlled = fakeContainer({});
    registerServiceWorker({ container: controlled.c, whenLoaded: () => undefined, warn: () => undefined, onState: (s) => later.push(s) });
    controlled.fire();
    controlled.fire();
    expect(later).toEqual(['ready', 'update-ready']);
  });

  it('a page that started without a worker announces a later update too', () => {
    const states: OfflineState[] = [];
    const f = fakeContainer(null);
    registerServiceWorker({ container: f.c, whenLoaded: () => undefined, warn: () => undefined, onState: (s) => states.push(s) });
    f.fire();
    f.fire();
    expect(states).toEqual(['preparing', 'ready', 'update-ready']);
  });

  it('is ready when the worker is active (navigator.serviceWorker.ready), without any controller change', async () => {
    const states: OfflineState[] = [];
    const f = fakeContainer(null, false, {}, Promise.resolve({}));
    registerServiceWorker({ container: f.c, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => states.push(s) });
    await settle();
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('keeps "a new version is ready" once it was reached, whatever follows', async () => {
    const states: OfflineState[] = [];
    let resolveReady: (v: unknown) => void = () => undefined;
    const ready = new Promise((r) => (resolveReady = r));
    const f = fakeContainer({}, false, {}, ready);
    registerServiceWorker({ container: f.c, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => states.push(s) });
    f.fire();
    resolveReady({});
    await settle();
    expect(states).toEqual(['ready', 'update-ready']);
  });

  it('reports a failed registration as failed only when nothing else keeps the app offline', async () => {
    const without: OfflineState[] = [];
    registerServiceWorker({ container: fakeContainer(null, true).c, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => without.push(s) });
    await settle();
    expect(without).toEqual(['preparing', 'failed']);

    const withWorker: OfflineState[] = [];
    registerServiceWorker({ container: fakeContainer({}, true).c, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => withWorker.push(s) });
    await settle();
    expect(withWorker, 'the older worker still serves the app').toEqual(['ready']);
  });

  it('reports a first install that ends redundant as failed', async () => {
    const states: OfflineState[] = [];
    let onStateChange: () => void = () => undefined;
    const installing: InstallingWorkerLike & { state: string } = {
      state: 'installing',
      addEventListener(_type, listener) {
        onStateChange = listener;
      },
    };
    const f = fakeContainer(null, false, { installing });
    registerServiceWorker({ container: f.c, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => states.push(s) });
    await settle();
    installing.state = 'installed';
    onStateChange();
    expect(states).toEqual(['preparing']);
    installing.state = 'redundant';
    onStateChange();
    expect(states).toEqual(['preparing', 'failed']);
  });

  it('never lets a state listener break registration', () => {
    const f = fakeContainer(null);
    expect(
      registerServiceWorker({
        container: f.c,
        whenLoaded: (cb) => cb(),
        warn: () => undefined,
        onState: () => {
          throw new Error('listener');
        },
      }),
    ).toBe('scheduled');
    expect(f.calls).toHaveLength(1);
  });
});
