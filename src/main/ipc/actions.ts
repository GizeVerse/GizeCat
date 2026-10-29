// One dispatcher for user actions from the settings window, the tray and the
// cat's context menu, so every entry point behaves identically. Electron-free.
import type { Logger } from '../contracts';
import type { ActionResult, SettingsAction } from '../../shared/ipc';
import type { Point } from '../../shared/geometry';
import type { SettingsPatch } from '../../shared/settings';
import type { SimEvent } from '../../shared/sim';
import type { MenuAction } from '../lifecycle/menuModel';
import type { SettingsStore } from '../store/settingsStore';

export type AppAction = SettingsAction | MenuAction;

export interface ActionTargets {
  setPaused(paused: boolean): void;
  setHidden(hidden: boolean): void;
  /** Calls the cat to the current cursor position. */
  callCat(): void;
  enqueue(ev: SimEvent): void;
  catAnchor(): Point | null;
  resetPersonality(): void;
  clearHistory(): void;
  exportDiagnostics(): Promise<ActionResult>;
  openLogsFolder(): Promise<ActionResult>;
  openSettings(): void;
  /** v1.1: the only path that changes the launch-at-sign-in preference (main-owned). */
  setLaunchAtLogin(on: boolean): ActionResult;
  dismissLaunchNotice(): ActionResult;
  /** v1.1.1 on-desktop surface outlines (session-only, never persisted). */
  setSurfaceOutlines?(on: boolean): void;
  quit(): void;
}

export interface ActionRunner {
  run(action: AppAction): Promise<ActionResult>;
}

/** Settings change implied by a consent action (consent timestamps are recorded here, in main). */
export function consentPatch(action: 'grantLocalStatsConsent' | 'grantAiConsent' | 'revokeConsent', now: Date): SettingsPatch {
  switch (action) {
    case 'grantLocalStatsConsent':
      return { perception: { visualMode: 'local-stats', consentAt: now.toISOString() } };
    case 'grantAiConsent':
      return { perception: { visualMode: 'ai', consentAt: now.toISOString() } };
    case 'revokeConsent':
      return { perception: { visualMode: 'off', consentAt: null } };
  }
}

export function createActionRunner(deps: {
  targets: ActionTargets;
  settings: SettingsStore;
  logger: Logger;
  now?: () => Date;
  defer?: (fn: () => void) => void;
}): ActionRunner {
  const { targets, settings, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const defer = deps.defer ?? ((fn: () => void) => setTimeout(fn, 50));

  function applyPatch(patch: SettingsPatch): ActionResult {
    const r = settings.patch(patch);
    return r.ok ? { ok: true } : { ok: false, message: r.error };
  }

  function run(action: AppAction): ActionResult | Promise<ActionResult> {
    logger.info('action', { action });
    switch (action) {
      case 'pause':
      case 'resume':
        targets.setPaused(action === 'pause');
        return { ok: true };
      case 'hide':
      case 'show':
        targets.setHidden(action === 'hide');
        return { ok: true };
      case 'privacyPause':
      case 'privacyResume':
        // Persisted privacy pause; the perception service stops capturing as soon as it sees the setting.
        return applyPatch({ perception: { paused: action === 'privacyPause' } });
      case 'grantLocalStatsConsent':
      case 'grantAiConsent':
      case 'revokeConsent':
        return applyPatch(consentPatch(action, now()));
      case 'resetPersonality':
        targets.resetPersonality();
        return { ok: true, message: 'Personality reset.' };
      case 'clearHistory':
        targets.clearHistory();
        return { ok: true, message: 'Interaction history cleared.' };
      case 'exportDiagnostics':
        return targets.exportDiagnostics();
      case 'openLogsFolder':
        return targets.openLogsFolder();
      case 'callCat':
        targets.callCat();
        return { ok: true };
      case 'completeFirstRun':
        return applyPatch({ general: { firstRunCompleted: true } });
      case 'enableLaunchAtLogin':
        return targets.setLaunchAtLogin(true);
      case 'disableLaunchAtLogin':
        return targets.setLaunchAtLogin(false);
      case 'dismissLaunchNotice':
        return targets.dismissLaunchNotice();
      case 'showSurfaceOutlines':
      case 'hideSurfaceOutlines':
        // Session state in main only: never a settings patch, so a restart always starts with it off.
        if (!targets.setSurfaceOutlines) return { ok: false, message: 'Surface outlines are not available.' };
        targets.setSurfaceOutlines(action === 'showSurfaceOutlines');
        return { ok: true };
      case 'quit':
        // Let the IPC reply reach the renderer before windows start closing.
        defer(() => targets.quit());
        return { ok: true };
      case 'pet': {
        const at = targets.catAnchor();
        if (!at) return { ok: false, message: 'The cat is not on screen.' };
        targets.enqueue({ type: 'pointer.pet', at, strength: 1 });
        return { ok: true };
      }
      case 'play':
        targets.enqueue({ type: 'command.play' });
        return { ok: true };
      case 'sleep':
        targets.enqueue({ type: 'command.sleep' });
        return { ok: true };
      case 'wake':
        targets.enqueue({ type: 'command.wake' });
        return { ok: true };
      case 'toggleInteractions':
        return applyPatch({ interaction: { enabled: !settings.get().interaction.enabled } });
      case 'settings':
        targets.openSettings();
        return { ok: true };
    }
  }

  return {
    async run(action) {
      try {
        return await run(action);
      } catch (err) {
        logger.error('action failed', { action, error: err });
        return { ok: false, message: 'Something went wrong; details are in the log.' };
      }
    },
  };
}
