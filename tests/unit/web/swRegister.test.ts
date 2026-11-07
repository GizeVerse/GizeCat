// Service worker registration (src/web/swRegister.ts): after load, with the scope and update policy
// the design asks for; failures are warnings; an update is announced only when a worker already
// controlled the page. MOCKED: the container is a fake.
import { describe, expect, it } from 'vitest';
import { registerServiceWorker, type ServiceWorkerContainerLike } from '../../../src/web/swRegister';

function fakeContainer(controller: unknown, fail = false) {
  const calls: Array<{ url: string; options: unknown }> = [];
  let onChange: (() => void) | null = null;
  const c: ServiceWorkerContainerLike = {
    controller,
    register(url, options) {
      calls.push({ url, options });
      return fail ? Promise.reject(new Error('blocked')) : Promise.resolve({});
    },
    addEventListener(_type, listener) {
      onChange = listener;
    },
  };
  return { c, calls, fire: () => onChange?.() };
}

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
    const first = fakeContainer(null);
    let n = 0;
    registerServiceWorker({ container: first.c, whenLoaded: () => undefined, warn: () => undefined, onUpdateReady: () => n++ });
    first.fire();
    expect(n, 'first install is not an update').toBe(0);
    const later = fakeContainer({});
    registerServiceWorker({ container: later.c, whenLoaded: () => undefined, warn: () => undefined, onUpdateReady: () => n++ });
    later.fire();
    later.fire();
    expect(n).toBe(1);
  });
});
