import { describe, expect, it } from 'vitest';
import type { SettingsViewState } from '../../../../src/shared/ipc';
import { applySettingsPatch, type PatchResult, type SettingsPatch } from '../../../../src/shared/settings';
import { SLIDER_DEBOUNCE_MS } from '../../../../src/renderer/settings/controls';
import type { FieldId } from '../../../../src/renderer/settings/fields';
import { SettingsStore, type FieldBinding, type Timers } from '../../../../src/renderer/settings/store';
import { S } from '../../../../src/renderer/settings/strings';
import { previewView } from './preview/fixture';

/** Manual clock: timers only fire when advance() is called. */
function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...queue].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          queue.delete(id);
          t.fn();
        }
      }
    },
    pending: () => queue.size,
  };
}

interface Deferred {
  patch: SettingsPatch;
  resolve(r: PatchResult): void;
  reject(e: unknown): void;
}

/** Fake main: records patches; each call resolves only when the test says so. */
function fakeApi() {
  const calls: Deferred[] = [];
  return {
    calls,
    update(patch: SettingsPatch): Promise<PatchResult> {
      return new Promise<PatchResult>((resolve, reject) => calls.push({ patch, resolve, reject }));
    },
  };
}

function fakeBinding(field: FieldId) {
  const b = {
    field,
    busy: false,
    synced: [] as unknown[],
    errors: [] as Array<string | null>,
    isBusy: () => b.busy,
    sync: (v: unknown) => void b.synced.push(v),
    showError: (m: string | null) => void b.errors.push(m),
  };
  return b satisfies FieldBinding & { busy: boolean };
}

const view = (): SettingsViewState => previewView(0, { electron: 'e', chrome: 'c', node: 'n' });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SettingsStore', () => {
  it('syncs a binding with the confirmed value on bind', () => {
    const store = new SettingsStore(fakeApi(), view(), fakeTimers());
    const b = fakeBinding('appearance.size');
    store.bind(b);
    expect(b.synced).toEqual([1]);
  });

  it('coalesces debounced slider changes into one patch with the last value', () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    store.set('appearance', 'size', 1.1, { debounceMs: SLIDER_DEBOUNCE_MS });
    timers.advance(100);
    store.set('appearance', 'size', 1.2, { debounceMs: SLIDER_DEBOUNCE_MS });
    timers.advance(100);
    store.set('appearance', 'size', 1.3, { debounceMs: SLIDER_DEBOUNCE_MS });
    expect(api.calls).toHaveLength(0);
    expect(store.intended('appearance', 'size')).toBe(1.3);
    timers.advance(SLIDER_DEBOUNCE_MS);
    expect(api.calls.map((c) => c.patch)).toEqual([{ appearance: { size: 1.3 } }]);
    expect(timers.pending()).toBe(0);
  });

  it('sends immediate changes at once and applies the returned settings', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const b = fakeBinding('appearance.shadow');
    store.bind(b);
    store.set('appearance', 'shadow', false, { origin: b });
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0]!;
    call.resolve(applySettingsPatch(store.settings, call.patch));
    await store.settled();
    expect(store.settings.appearance.shadow).toBe(false);
    expect(b.synced.at(-1)).toBe(false);
    expect(b.errors.at(-1)).toBeNull();
  });

  it('does not send a change that equals the confirmed value', () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    store.set('appearance', 'size', 1);
    expect(api.calls).toHaveLength(0);
  });

  it('reverts the control and reports the error when main rejects a patch', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const b = fakeBinding('general.catName');
    store.bind(b);
    store.set('general', 'catName', 'Bad', { origin: b });
    api.calls[0]!.resolve({ ok: false, error: 'invalid value for general.catName' });
    await store.settled();
    expect(store.settings.general.catName).toBe('Miso');
    expect(b.synced.at(-1)).toBe('Miso');
    expect(b.errors.at(-1)).toBe(S.errors.saveFailed('invalid value for general.catName'));
  });

  it('reverts and reports when the IPC call itself fails', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const b = fakeBinding('appearance.opacity');
    store.bind(b);
    store.set('appearance', 'opacity', 0.5, { origin: b });
    api.calls[0]!.reject(new Error('channel closed'));
    await store.settled();
    expect(b.synced.at(-1)).toBe(1);
    expect(b.errors.at(-1)).toBe(S.errors.saveFailed('channel closed'));
  });

  it('never overwrites a control the user is dragging, and resyncs on release', () => {
    const store = new SettingsStore(fakeApi(), view(), fakeTimers());
    const b = fakeBinding('appearance.size');
    store.bind(b);
    b.busy = true;
    const next = view();
    next.settings.appearance.size = 2;
    store.receive(next);
    expect(b.synced).toEqual([1]);
    b.busy = false;
    store.release(b);
    expect(b.synced).toEqual([1, 2]);
  });

  it('does not clobber a field with a pending or in-flight change on broadcasts', async () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    const b = fakeBinding('behavior.autonomy');
    store.bind(b);
    store.set('behavior', 'autonomy', 0.9, { debounceMs: 150, origin: b });
    store.receive(view());
    expect(b.synced).toEqual([0.6]);
    timers.advance(150);
    store.receive(view());
    expect(b.synced).toEqual([0.6]);
    const call = api.calls[0]!;
    call.resolve(applySettingsPatch(store.settings, call.patch));
    await store.settled();
    expect(b.synced.at(-1)).toBe(0.9);
  });

  it('syncs only after the last of several in-flight patches resolves', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    const b = fakeBinding('appearance.size');
    store.bind(b);
    store.set('appearance', 'size', 1.5, { origin: b });
    store.set('appearance', 'size', 2, { origin: b });
    expect(store.intended('appearance', 'size')).toBe(2);
    const [first, second] = api.calls;
    first!.resolve(applySettingsPatch(store.settings, first!.patch));
    await tick();
    expect(b.synced).toEqual([1]);
    second!.resolve(applySettingsPatch(store.settings, second!.patch));
    await store.settled();
    expect(b.synced).toEqual([1, 2]);
    expect(store.settings.appearance.size).toBe(2);
  });

  it('flush sends debounced changes immediately and waits for them', async () => {
    const api = fakeApi();
    const timers = fakeTimers();
    const store = new SettingsStore(api, view(), timers);
    store.set('ai', 'maxPerHour', 30, { debounceMs: 150 });
    const flushed = store.flush();
    expect(api.calls.map((c) => c.patch)).toEqual([{ ai: { maxPerHour: 30 } }]);
    api.calls[0]!.resolve(applySettingsPatch(store.settings, api.calls[0]!.patch));
    await flushed;
    expect(store.settings.ai.maxPerHour).toBe(30);
    timers.advance(1000);
    expect(api.calls).toHaveLength(1);
  });

  it('notifies subscribers on set, results and broadcasts', async () => {
    const api = fakeApi();
    const store = new SettingsStore(api, view(), fakeTimers());
    let count = 0;
    store.subscribe(() => count++);
    expect(count).toBe(1);
    store.set('interaction', 'dragging', false);
    expect(count).toBe(2);
    expect(store.intended('interaction', 'dragging')).toBe(false);
    api.calls[0]!.resolve(applySettingsPatch(store.settings, api.calls[0]!.patch));
    await store.settled();
    expect(count).toBe(3);
    store.receive(view());
    expect(count).toBe(4);
  });
});
