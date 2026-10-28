import type { SettingsApi } from '../../shared/ipc';
import type { PageId } from './catalog';
import type { SettingsStore, Timers } from './store';

/** Everything a page needs; created once by app.ts. */
export interface PageContext {
  readonly api: SettingsApi;
  readonly store: SettingsStore;
  readonly timers: Timers;
  now(): number;
  navigate(page: PageId): void;
  /** Re-reads the full view from main (after actions whose effects main may not broadcast). */
  refresh(): Promise<void>;
}

export interface PageView {
  id: PageId;
  title: string;
  element: HTMLElement;
  /** Called every time the page becomes visible. */
  onShow?(): void;
}
