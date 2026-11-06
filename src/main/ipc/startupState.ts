// The state the cat starts in (general.startupState) and the last visible, hidden or
// paused state, which main keeps in general.rememberedState for "As I left it".
// Electron-free.
import type { Logger } from '../contracts';
import type { Settings } from '../../shared/settings';
import type { SettingsStore } from '../store/settingsStore';

export type CatViewState = Settings['general']['rememberedState'];

export interface CatViewFlags {
  readonly hidden: boolean;
  readonly paused: boolean;
}

export interface CatViewTarget extends CatViewFlags {
  setHidden(hidden: boolean): void;
  setPaused(paused: boolean): void;
}

/** Hidden wins over paused: a cat the user put away must not come back on screen. */
export function viewStateOf(cat: CatViewFlags): CatViewState {
  if (cat.hidden) return 'hidden';
  return cat.paused ? 'paused' : 'visible';
}

export interface StartupPlan {
  view: CatViewState;
  /** The Welcome page opens on a first run, but not when Windows starts the app at sign-in. */
  openWelcome: boolean;
}

/** A launch at sign-in starts in the same state as any other launch. */
export function startupPlan(general: Pick<Settings['general'], 'startupState' | 'rememberedState' | 'firstRunCompleted'>, flags: { launchedAtLogin: boolean }): StartupPlan {
  return {
    view: general.startupState === 'remember' ? general.rememberedState : general.startupState,
    openWelcome: !general.firstRunCompleted && !flags.launchedAtLogin,
  };
}

export function applyViewState(cat: CatViewTarget, view: CatViewState): void {
  cat.setHidden(view === 'hidden');
  cat.setPaused(view === 'paused');
}

export interface ViewStateMemory {
  /** Called on every status change; writes only when hidden/paused/visible changed. */
  update(cat: CatViewFlags): void;
}

/**
 * Keeps general.rememberedState in step with the cat. The value goes through the
 * settings store (debounced save, flushed on quit and session end), never through the
 * renderer patch path, which may not write it (see rejectMainOwnedFields).
 */
export function createViewStateMemory(deps: { settings: Pick<SettingsStore, 'get' | 'patch'>; logger: Logger }): ViewStateMemory {
  return {
    update(cat) {
      const view = viewStateOf(cat);
      if (deps.settings.get().general.rememberedState === view) return;
      const r = deps.settings.patch({ general: { rememberedState: view } });
      if (!r.ok) deps.logger.warn('could not remember the cat state', { error: r.error });
    },
  };
}

/** Settings only main writes. Returns an error message, or null if the patch may be applied. */
export function rejectMainOwnedFields(patch: unknown): string | null {
  if (patch === null || typeof patch !== 'object') return null;
  const general = (patch as Record<string, unknown>)['general'];
  if (general !== null && typeof general === 'object' && 'rememberedState' in general) return 'general.rememberedState is kept by the app itself';
  return null;
}
