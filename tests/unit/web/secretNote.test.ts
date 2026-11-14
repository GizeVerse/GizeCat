// The note under the name field, on a tiny fake DOM (the web tests run in node). Throwaway strings only.
// MOCKED: fake elements and a fake secret source.
import { describe, expect, it } from 'vitest';
import type { EggState } from '../../../src/shared/secretEgg';
import type { WebSecretName } from '../../../src/web/secretName';
import { attachSecretNote } from '../../../src/web/secretNote';

const rnd = (): string => 'q' + Math.random().toString(16).slice(2, 10);

class FakeEl {
  textContent = '';
  className = '';
  attrs: Record<string, string> = {};
  parentNode: FakeEl | null = null;
  nextSibling: FakeEl | null = null;
  children: FakeEl[] = [];
  value = '';
  handlers = new Map<string, Array<(e: unknown) => void>>();
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  insertBefore(node: FakeEl, ref: FakeEl | null): void {
    const i = ref ? this.children.indexOf(ref) : this.children.length;
    this.children.splice(i, 0, node);
    node.parentNode = this;
  }
  remove(): void {
    const p = this.parentNode;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(t: string, fn: (e: unknown) => void): void {
    this.handlers.set(t, [...(this.handlers.get(t) ?? []), fn]);
  }
  removeEventListener(t: string, fn: (e: unknown) => void): void {
    this.handlers.set(t, (this.handlers.get(t) ?? []).filter((f) => f !== fn));
  }
  fire(t: string, e: unknown = {}): void {
    for (const fn of this.handlers.get(t) ?? []) fn(e);
  }
}

function fakeSecret(available = true) {
  let st: EggState = { active: false };
  const subs = new Set<(s: EggState) => void>();
  const names: string[] = [];
  const typed: string[] = [];
  const holds: Array<(c: string) => boolean> = [];
  const secret: WebSecretName = {
    available,
    setName: (n: string) => void names.push(n),
    setTyped: (n: string) => void typed.push(n),
    holdNote: (h) => {
      holds.push(h);
      return () => void holds.splice(holds.indexOf(h), 1);
    },
    onAccessoryChange: () => () => undefined,
    state: () => st,
    accessory: () => (st.active ? 'heartPendant' : undefined),
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    dispose: () => undefined,
  };
  return {
    secret,
    names,
    typed,
    holds,
    set(next: EggState) {
      st = next;
      for (const cb of subs) cb(next);
    },
  };
}

function setup(available = true) {
  const parent = new FakeEl();
  const input = new FakeEl();
  parent.insertBefore(input, null);
  const f = fakeSecret(available);
  const doc = { createElement: () => new FakeEl() as unknown as HTMLElement };
  const detach = attachSecretNote(input as unknown as HTMLInputElement, f.secret, doc);
  return { parent, input, f, detach };
}

describe('attachSecretNote', () => {
  it('adds nothing without a payload or a source', () => {
    const { parent, input } = setup(false);
    expect(parent.children).toEqual([input]);
    expect(() => attachSecretNote(input as unknown as HTMLInputElement, undefined)).not.toThrow();
  });

  it('shows the message directly under the input and removes it at once', () => {
    const { parent, input, f } = setup();
    const message = rnd();
    f.set({ active: true, message });
    expect(parent.children[0]).toBe(input);
    const note = parent.children[1]!;
    expect(note.textContent).toBe(message);
    expect(note.attrs['aria-live']).toBe('polite');
    f.set({ active: false });
    expect(parent.children).toEqual([input]);
  });

  it('feeds typed values as typed and committed values as committed, but not half-composed text', () => {
    const { input, f } = setup();
    const a = rnd();
    input.value = a;
    input.fire('input', { isComposing: true });
    expect(f.typed).toEqual([]);
    input.fire('input', { isComposing: false });
    input.fire('compositionend');
    expect(f.typed).toEqual([a, a]);
    input.fire('change');
    expect(f.names).toEqual([a]);
  });

  it('registers a hold that is false when the field is not focused, and releases it on detach', () => {
    const { input, f, detach } = setup();
    expect(f.holds).toHaveLength(1);
    expect(f.holds[0]!(rnd())).toBe(false);
    void input;
    detach();
    expect(f.holds).toHaveLength(0);
  });

  it('detach removes the note and the listeners', () => {
    const { parent, input, f, detach } = setup();
    f.set({ active: true, message: rnd() });
    detach();
    expect(parent.children).toEqual([input]);
    input.value = rnd();
    input.fire('input', {});
    expect(f.typed).toEqual([]);
  });
});
