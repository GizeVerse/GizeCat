// Service worker registration (src/web/swRegister.ts): after load, with the scope and update policy
// the design asks for; failures are warnings; the sheet's offline state follows GizeCat's own
// worker, never another worker with a broader scope on the same origin; an update is announced only
// when GizeCat's worker already controlled the page. MOCKED: the container is a fake.
import { describe, expect, it } from 'vitest';
import {
  registerServiceWorker,
  type InstallingWorkerLike,
  type OfflineState,
  type ServiceWorkerContainerLike,
  type ServiceWorkerLike,
  type SwRegisterEnv,
} from '../../../src/web/swRegister';

const PAGE = 'https://example.test/gizecat/index.html?source=pwa';
const OWN: ServiceWorkerLike = { scriptURL: 'https://example.test/gizecat/sw.js' };
/** A root-scoped worker of another site on the origin. */
const OUTER: ServiceWorkerLike = { scriptURL: 'https://example.test/sw.js' };

function fakeContainer(controller: ServiceWorkerLike | null, fail = false, registration: unknown = {}) {
  const calls: Array<{ url: string; options: unknown }> = [];
  let current = controller;
  let onChange: (() => void) | null = null;
  const c: ServiceWorkerContainerLike = {
    get controller() {
      return current;
    },
    register(url, options) {
      calls.push({ url, options });
      return fail ? Promise.reject(new Error('blocked')) : Promise.resolve(registration);
    },
    addEventListener(_type, listener) {
      onChange = listener;
    },
  };
  /** The controller becomes `next` and controllerchange fires. */
  const fire = (next: ServiceWorkerLike | null): void => {
    current = next;
    onChange?.();
  };
  return { c, calls, fire };
}

function installingWorker() {
  let onStateChange: () => void = () => undefined;
  const worker: InstallingWorkerLike & { state: string } = {
    state: 'installing',
    addEventListener(_type, listener) {
      onStateChange = listener;
    },
  };
  return {
    worker,
    /** The worker moves to `state` and statechange fires. */
    to(state: string): void {
      worker.state = state;
      onStateChange();
    },
  };
}

/** Runs registration on a fake (load has fired unless the caller says otherwise) and returns the states it reports. */
function run(container: ServiceWorkerContainerLike, over: Partial<SwRegisterEnv> = {}): OfflineState[] {
  const states: OfflineState[] = [];
  registerServiceWorker({ container, pageUrl: PAGE, whenLoaded: (cb) => cb(), warn: () => undefined, onState: (s) => states.push(s), ...over });
  return states;
}

const notLoaded = { whenLoaded: () => undefined };

/** Lets promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('service worker registration', () => {
  it('reports unsupported without a container and registers nothing', () => {
    expect(registerServiceWorker({ container: undefined, pageUrl: PAGE, whenLoaded: (cb) => cb(), warn: () => undefined })).toBe('unsupported');
  });

  it("registers 'sw.js' after load with scope './' and updateViaCache 'none'", () => {
    const f = fakeContainer(null);
    // Typed through `as`, so the control flow does not narrow it to null (it is assigned in a callback).
    let loaded = null as (() => void) | null;
    expect(registerServiceWorker({ container: f.c, pageUrl: PAGE, whenLoaded: (cb) => (loaded = cb), warn: () => undefined })).toBe('scheduled');
    expect(f.calls).toHaveLength(0);
    loaded!();
    expect(f.calls).toEqual([{ url: 'sw.js', options: { scope: './', updateViaCache: 'none' } }]);
  });

  it('logs a failed registration as a warning, never throws', async () => {
    const f = fakeContainer(null, true);
    const warnings: string[] = [];
    registerServiceWorker({ container: f.c, pageUrl: PAGE, whenLoaded: (cb) => cb(), warn: (m) => warnings.push(m) });
    await settle();
    expect(warnings).toHaveLength(1);
  });

  it("announces an update once, and only when GizeCat's worker already controlled the page", () => {
    const first = fakeContainer(null);
    const states = run(first.c, notLoaded);
    first.fire(OWN);
    expect(states, 'the first install is the copy becoming ready, not an update').toEqual(['preparing', 'ready']);

    const controlled = fakeContainer(OWN);
    const later = run(controlled.c, notLoaded);
    controlled.fire(OWN);
    controlled.fire(OWN);
    expect(later).toEqual(['ready', 'update-ready']);
  });

  it('a page that started without a worker announces a later update too', () => {
    const f = fakeContainer(null);
    const states = run(f.c, notLoaded);
    f.fire(OWN);
    f.fire(OWN);
    expect(states).toEqual(['preparing', 'ready', 'update-ready']);
  });

  it('is ready when register() finds an active worker, without any controller change', async () => {
    const states = run(fakeContainer(null, false, { active: {} }).c);
    await settle();
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('is ready when a first install reaches activated, not before', async () => {
    const w = installingWorker();
    const states = run(fakeContainer(null, false, { installing: w.worker, active: null }).c);
    await settle();
    w.to('installed');
    w.to('activating');
    expect(states).toEqual(['preparing']);
    w.to('activated');
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('keeps "a new version is ready" once it was reached, whatever follows', async () => {
    const w = installingWorker();
    const f = fakeContainer(OWN, false, { installing: w.worker, active: {} });
    const states = run(f.c);
    await settle();
    f.fire(OWN);
    w.to('activated');
    expect(states).toEqual(['ready', 'update-ready']);
  });

  it('reports a failed registration as failed only when nothing else keeps the app offline', async () => {
    const without = run(fakeContainer(null, true).c);
    await settle();
    expect(without).toEqual(['preparing', 'failed']);

    const withWorker = run(fakeContainer(OWN, true).c);
    await settle();
    expect(withWorker, 'the older worker still serves the app').toEqual(['ready']);
  });

  it('reports a first install that ends redundant as failed', async () => {
    const w = installingWorker();
    const states = run(fakeContainer(null, false, { installing: w.worker }).c);
    await settle();
    w.to('installed');
    expect(states).toEqual(['preparing']);
    w.to('redundant');
    expect(states).toEqual(['preparing', 'failed']);
  });

  it('does not report a failed update as failed while an active worker keeps the copy, even on an uncontrolled page', async () => {
    const w = installingWorker();
    const states = run(fakeContainer(null, false, { installing: w.worker, active: {} }).c);
    await settle();
    w.to('redundant');
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('never lets a state listener break registration', () => {
    const f = fakeContainer(null);
    expect(
      registerServiceWorker({
        container: f.c,
        pageUrl: PAGE,
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

describe('a worker with a broader scope on the same origin', () => {
  it('is not taken for an offline copy: the first visit is still getting ready', () => {
    expect(run(fakeContainer(OUTER).c, notLoaded)).toEqual(['preparing']);
  });

  it("does not make GizeCat's first install look like an update", () => {
    const f = fakeContainer(OUTER);
    const states = run(f.c, notLoaded);
    f.fire(OWN);
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('is ignored when it is the one taking the page', () => {
    const f = fakeContainer(null);
    const states = run(f.c, notLoaded);
    f.fire(OUTER);
    expect(states).toEqual(['preparing']);
    f.fire(OWN);
    f.fire(OUTER);
    expect(states).toEqual(['preparing', 'ready']);
  });

  it('does not hide a failed install or a failed registration', async () => {
    const w = installingWorker();
    const install = run(fakeContainer(OUTER, false, { installing: w.worker }).c);
    await settle();
    w.to('redundant');
    expect(install).toEqual(['preparing', 'failed']);

    const registration = run(fakeContainer(OUTER, true).c);
    await settle();
    expect(registration).toEqual(['preparing', 'failed']);
  });

  it('tells a nested copy from the outer copy by the sw.js next to the page', () => {
    const nested = 'https://example.test/gizecat/next/';
    expect(run(fakeContainer(OWN).c, { ...notLoaded, pageUrl: nested }), 'the outer copy is not the nested one').toEqual(['preparing']);
    expect(run(fakeContainer({ scriptURL: `${nested}sw.js` }).c, { ...notLoaded, pageUrl: nested })).toEqual(['ready']);
  });
});
