// Preload for the settings window (sandboxed, contextIsolation). Exposes exactly
// one object, window.desktopCatSettings, implementing SettingsApi; every call is a
// fixed IPC channel and main validates every payload.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ActionResult,
  AiTestResult,
  IPC,
  ModelListResult,
  PerceptionPreview,
  SettingsAction,
  SettingsApi,
  SettingsViewState,
} from '../shared/ipc';
import type { BehaviorProfileSnapshot } from '../shared/behaviorProfile';
import type { PatchResult, SettingsPatch } from '../shared/settings';
import type { SurfaceDiagnostics } from '../shared/surfaceDiagnostics';

type SettingsChannel =
  | 'settingsGetState'
  | 'settingsUpdate'
  | 'settingsAction'
  | 'settingsSetApiKey'
  | 'settingsTestAi'
  | 'settingsListModels'
  | 'settingsPreviewPerception'
  | 'settingsGetSurfaceDiagnostics'
  | 'settingsGetBehaviorProfile'
  | 'settingsStateChanged';

// Importing IPC at runtime would bundle zod (≈440 KB) into the preload, because
// src/shared/ipc.ts builds its schemas at module load. The `satisfies` clause makes
// any drift from the shared channel names a compile error instead.
const CH = {
  settingsGetState: 'settings:get-state',
  settingsUpdate: 'settings:update',
  settingsAction: 'settings:action',
  settingsSetApiKey: 'settings:set-api-key',
  settingsTestAi: 'settings:test-ai',
  settingsListModels: 'settings:list-models',
  settingsPreviewPerception: 'settings:preview-perception',
  settingsGetSurfaceDiagnostics: 'settings:get-surface-diagnostics',
  settingsGetBehaviorProfile: 'settings:get-behavior-profile',
  settingsStateChanged: 'settings:state-changed',
} as const satisfies Pick<typeof IPC, SettingsChannel>;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: SettingsApi = {
  getState: () => invoke<SettingsViewState>(CH.settingsGetState),
  update: (patch: SettingsPatch) => invoke<PatchResult>(CH.settingsUpdate, patch),
  action: (action: SettingsAction) => invoke<ActionResult>(CH.settingsAction, action),
  setApiKey: (provider: 'anthropic' | 'openai-compatible', key: string | null) => invoke<ActionResult>(CH.settingsSetApiKey, { provider, key }),
  testAi: () => invoke<AiTestResult>(CH.settingsTestAi),
  listModels: () => invoke<ModelListResult>(CH.settingsListModels),
  previewPerception: () => invoke<PerceptionPreview>(CH.settingsPreviewPerception),
  getSurfaceDiagnostics: () => invoke<SurfaceDiagnostics>(CH.settingsGetSurfaceDiagnostics),
  getBehaviorProfile: () => invoke<BehaviorProfileSnapshot>(CH.settingsGetBehaviorProfile),
  onStateChanged(cb: (state: SettingsViewState) => void): () => void {
    if (typeof cb !== 'function') throw new TypeError('onStateChanged expects a function');
    const listener = (_event: IpcRendererEvent, state: SettingsViewState): void => cb(state);
    ipcRenderer.on(CH.settingsStateChanged, listener);
    return () => {
      ipcRenderer.removeListener(CH.settingsStateChanged, listener);
    };
  },
};

contextBridge.exposeInMainWorld('desktopCatSettings', api);
