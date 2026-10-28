// Client-side state for the settings window: holds the last view from main, sends
// one-leaf patches (debounced for sliders), reverts controls whose patch is
// rejected, and never overwrites a control the user is interacting with.
import type { SettingsApi, SettingsViewState } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import type { FieldId, FieldKey, SectionKey } from './fields';
import { buildPatch, fieldId, readField, valuesEqual } from './patch';
import { S } from './strings';

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
}

interface Pending {
  section: SectionKey;
  key: string;
  value: unknown;
  timer: number;
  origin: FieldBinding | undefined;
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

export class SettingsStore {
  private current: SettingsViewState;
  private readonly bindings = new Set<FieldBinding>();
  private readonly listeners = new Set<ViewListener>();
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
    const pending = this.pending.get(id);
    if (pending) return pending.value as Settings[S][K];
    const flight = this.inflight.get(id);
    if (flight) return flight.latest as Settings[S][K];
    return readField(this.current.settings, section, key);
  }

  isSettling(field: FieldId): boolean {
    return this.pending.has(field) || this.inflight.has(field);
  }

  set<S extends SectionKey, K extends FieldKey<S>>(section: S, key: K, value: Settings[S][K], options: SetOptions = {}): void {
    const id = fieldId(section, key);
    const previous = this.pending.get(id);
    if (previous) {
      this.timers.clearTimeout(previous.timer);
      this.pending.delete(id);
    }
    options.origin?.showError(null);
    const delay = options.debounceMs ?? 0;
    if (delay > 0) {
      const timer = this.timers.setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry || entry.timer !== timer) return;
        this.pending.delete(id);
        this.dispatch(id, section, key, entry.value, entry.origin);
      }, delay);
      this.pending.set(id, { section, key, value, timer, origin: options.origin });
    } else {
      this.dispatch(id, section, key, value, options.origin);
    }
    this.notify();
  }

  /** Sends every debounced change now. */
  async flush(): Promise<void> {
    for (const [id, entry] of [...this.pending]) {
      this.timers.clearTimeout(entry.timer);
      this.pending.delete(id);
      this.dispatch(id, entry.section, entry.key, entry.value, entry.origin);
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

  private dispatch(id: FieldId, section: SectionKey, key: string, value: unknown, origin: FieldBinding | undefined): void {
    if (!this.inflight.has(id) && valuesEqual(value, this.confirmedValue(id))) {
      this.syncField(id);
      return;
    }
    const send = this.send(id, section, key, value, origin);
    this.sends.add(send);
    void send.finally(() => this.sends.delete(send));
  }

  private async send(id: FieldId, section: SectionKey, key: string, value: unknown, origin: FieldBinding | undefined): Promise<void> {
    const flight = this.inflight.get(id) ?? { count: 0, latest: undefined };
    flight.count += 1;
    flight.latest = value;
    this.inflight.set(id, flight);
    let error: string | null = null;
    try {
      const patch = buildPatch(section, key as never, value as never);
      const result = await this.api.update(patch);
      if (result.ok) this.current = { ...this.current, settings: result.settings };
      else error = result.error;
    } catch (e) {
      error = errorText(e);
    }
    flight.count -= 1;
    if (flight.count === 0) this.inflight.delete(id);
    if (error !== null) origin?.showError(S.errors.saveFailed(error));
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
