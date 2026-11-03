// Client-side state for the settings window: holds the last view from main, sends
// one-leaf patches (debounced for sliders), reverts controls whose patch is
// rejected, and never overwrites a control the user is interacting with.
// v1.2: a change may carry more leaves in the same patch (a preset sets eight values at
// once; a governed slider sends activityPreset 'custom' with its value). Every leaf of a
// change counts as pending and in flight, so a broadcast never clobbers any of them.
import type { SettingsApi, SettingsViewState } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { FieldId, FieldKey, SectionKey } from './fields';
import { buildMultiPatch, fieldId, leafId, readField, valuesEqual, type Leaf } from './patch';
import { S } from './strings';

export type { Leaf } from './patch';

export interface Timers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** A control bound to one setting leaf. */
export interface FieldBinding {
  readonly field: FieldId;
  /** True while the user is dragging/editing; the store will not overwrite it. */
  isBusy(): boolean;
  sync(value: unknown): void;
  showError(message: string | null): void;
}

export interface SetOptions {
  /** Trailing debounce; 0 sends immediately. */
  debounceMs?: number;
  /** Binding that shows errors for this change. */
  origin?: FieldBinding;
  /**
   * More leaves sent in the same patch (v1.2: activityPreset 'custom' with a preset-governed
   * value). They ride along: a change whose own value equals the confirmed one is not sent.
   */
  with?: readonly Leaf[];
}

/** One change: the leaves the user set, plus the ones riding along. */
interface Change {
  primary: Leaf[];
  companions: Leaf[];
  origin: FieldBinding | undefined;
}

interface Pending extends Change {
  timer: number;
}

interface InFlight {
  count: number;
  latest: unknown;
}

export type ViewListener = (view: SettingsViewState) => void;

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return S.errors.unexpected;
}

const leavesOf = (c: Change): Leaf[] => [...c.primary, ...c.companions];

export class SettingsStore {
  private current: SettingsViewState;
  private readonly bindings = new Set<FieldBinding>();
  private readonly listeners = new Set<ViewListener>();
  /** Debounced changes, keyed by the field the user set. */
  private readonly pending = new Map<FieldId, Pending>();
  private readonly inflight = new Map<FieldId, InFlight>();
  private readonly sends = new Set<Promise<void>>();

  constructor(
    private readonly api: Pick<SettingsApi, 'update'>,
    initial: SettingsViewState,
    private readonly timers: Timers,
  ) {
    this.current = initial;
  }

  get view(): SettingsViewState {
    return this.current;
  }

  get settings(): Settings {
    return this.current.settings;
  }

  bind(binding: FieldBinding): () => void {
    this.bindings.add(binding);
    binding.sync(this.confirmedValue(binding.field));
    return () => this.bindings.delete(binding);
  }

  subscribe(listener: ViewListener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  /** Latest value the user asked for (pending or in flight), else the confirmed one. */
  intended<S extends SectionKey, K extends FieldKey<S>>(section: S, key: K): Settings[S][K] {
    const id = fieldId(section, key);
    const pending = this.pendingValue(id);
    if (pending.found) return pending.value as Settings[S][K];
    const flight = this.inflight.get(id);
    if (flight) return flight.latest as Settings[S][K];
    return readField(this.current.settings, section, key);
  }

  isSettling(field: FieldId): boolean {
    return this.pendingValue(field).found || this.inflight.has(field);
  }

  set<S extends SectionKey, K extends FieldKey<S>>(section: S, key: K, value: Settings[S][K], options: SetOptions = {}): void {
    const id = fieldId(section, key);
    const previous = this.pending.get(id);
    if (previous) {
      this.timers.clearTimeout(previous.timer);
      this.pending.delete(id);
    }
    options.origin?.showError(null);
    const change: Change = { primary: [{ section, key, value }], companions: [...(options.with ?? [])], origin: options.origin };
    const delay = options.debounceMs ?? 0;
    if (delay > 0) {
      const timer = this.timers.setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry || entry.timer !== timer) return;
        this.pending.delete(id);
        this.dispatch(entry);
      }, delay);
      this.pending.set(id, { ...change, timer });
    } else {
      this.dispatch(change);
    }
    this.notify();
  }

  /**
   * Sends several leaves as one patch, now (v1.2 presets). Debounced changes that touch any of
   * these fields are dropped first, so a slider move still waiting cannot land after them.
   */
  setMany(leaves: readonly Leaf[], options: Pick<SetOptions, 'origin'> = {}): void {
    if (leaves.length === 0) return;
    const ids = new Set(leaves.map(leafId));
    for (const [id, entry] of [...this.pending]) {
      if (!leavesOf(entry).some((l) => ids.has(leafId(l)))) continue;
      this.timers.clearTimeout(entry.timer);
      this.pending.delete(id);
    }
    options.origin?.showError(null);
    this.dispatch({ primary: [...leaves], companions: [], origin: options.origin });
    this.notify();
  }

  /** Sends every debounced change now. */
  async flush(): Promise<void> {
    for (const [id, entry] of [...this.pending]) {
      this.timers.clearTimeout(entry.timer);
      this.pending.delete(id);
      this.dispatch(entry);
    }
    await this.settled();
  }

  /** Resolves when no patch is in flight. */
  async settled(): Promise<void> {
    while (this.sends.size > 0) await Promise.all([...this.sends]);
  }

  /** A fresh view from main (broadcast or explicit reload). */
  receive(view: SettingsViewState): void {
    this.current = view;
    this.syncAll();
    this.notify();
  }

  /** Re-syncs one binding after its interaction ended (e.g. pointer released without a change). */
  release(binding: FieldBinding): void {
    if (!binding.isBusy() && !this.isSettling(binding.field)) binding.sync(this.confirmedValue(binding.field));
  }

  /** The newest pending value of `id` (as the field the user set, or riding along). */
  private pendingValue(id: FieldId): { found: boolean; value: unknown } {
    const own = this.pending.get(id);
    if (own) {
      const leaf = own.primary.find((l) => leafId(l) === id);
      if (leaf) return { found: true, value: leaf.value };
    }
    let out: { found: boolean; value: unknown } = { found: false, value: undefined };
    for (const entry of this.pending.values()) {
      for (const l of leavesOf(entry)) if (leafId(l) === id) out = { found: true, value: l.value };
    }
    return out;
  }

  private dispatch(change: Change): void {
    const unchanged = change.primary.every((l) => {
      const id = leafId(l);
      return !this.inflight.has(id) && valuesEqual(l.value, this.confirmedValue(id));
    });
    if (unchanged) {
      for (const l of change.primary) this.syncField(leafId(l));
      return;
    }
    const send = this.send(change);
    this.sends.add(send);
    void send.finally(() => this.sends.delete(send));
  }

  private async send(change: Change): Promise<void> {
    const leaves = leavesOf(change);
    for (const l of leaves) {
      const id = leafId(l);
      const flight = this.inflight.get(id) ?? { count: 0, latest: undefined };
      flight.count += 1;
      flight.latest = l.value;
      this.inflight.set(id, flight);
    }
    let error: string | null = null;
    try {
      const result = await this.api.update(buildMultiPatch(leaves));
      if (result.ok) this.current = { ...this.current, settings: result.settings };
      else error = result.error;
    } catch (e) {
      error = errorText(e);
    }
    for (const l of leaves) {
      const id = leafId(l);
      const flight = this.inflight.get(id);
      if (!flight) continue;
      flight.count -= 1;
      if (flight.count <= 0) this.inflight.delete(id);
    }
    if (error !== null) change.origin?.showError(S.errors.saveFailed(error));
    this.syncAll();
    this.notify();
  }

  private confirmedValue(id: FieldId): unknown {
    const dot = id.indexOf('.');
    const section = id.slice(0, dot) as SectionKey;
    const key = id.slice(dot + 1);
    return (this.current.settings[section] as Record<string, unknown>)[key];
  }

  private syncField(id: FieldId): void {
    for (const b of this.bindings) if (b.field === id && !b.isBusy()) b.sync(this.confirmedValue(id));
  }

  private syncAll(): void {
    for (const b of this.bindings) {
      if (b.isBusy() || this.isSettling(b.field)) continue;
      b.sync(this.confirmedValue(b.field));
    }
  }

  private notify(): void {
    for (const l of this.listeners) l(this.current);
  }
}
