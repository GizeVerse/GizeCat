// IPC contract between main and the two sandboxed renderers. Every payload that
// crosses into main is validated with these schemas; senders are also checked
// against the known webContents/origin in main.
import { z } from 'zod';
import type { BehaviorState, CatRenderState, HitRegion } from './cat';
import type { CatSummary } from './catState';
import type { PerceptionStatus, SceneReport, VisualEventKind, VisualFeatures } from './perception';
import type { SurfaceStatus } from './surfaces';
import type { PatchResult, Settings, SettingsPatch } from './settings';

/** Custom privileged scheme serving bundled renderer files (never file://). */
export const APP_SCHEME = 'desktop-cat';
export const OVERLAY_URL = `${APP_SCHEME}://app/renderer/overlay/index.html`;
export const SETTINGS_URL = `${APP_SCHEME}://app/renderer/settings/index.html`;

export const IPC = {
  // main -> overlay
  overlayRender: 'overlay:render',
  overlayConfig: 'overlay:config',
  // overlay -> main (send, fire-and-forget)
  overlayReady: 'overlay:ready',
  overlayPointer: 'overlay:pointer',
  overlayHitRegion: 'overlay:hit-region',
  overlayError: 'overlay:error',
  // settings <-> main (invoke)
  settingsGetState: 'settings:get-state',
  settingsUpdate: 'settings:update',
  settingsAction: 'settings:action',
  settingsSetApiKey: 'settings:set-api-key',
  settingsTestAi: 'settings:test-ai',
  settingsListModels: 'settings:list-models',
  settingsPreviewPerception: 'settings:preview-perception',
  // main -> settings
  settingsStateChanged: 'settings:state-changed',
} as const;

const finite = z.number().finite();

export const OverlayPointerEventSchema = z
  .object({
    kind: z.enum(['down', 'move', 'up', 'enter', 'leave', 'context', 'cancel']),
    x: finite.min(-100000).max(100000),
    y: finite.min(-100000).max(100000),
    button: z.number().int().min(-1).max(4),
    buttons: z.number().int().min(0).max(31),
    /** Renderer performance.now() timestamp. */
    t: finite.min(0),
  })
  .strict();
export type OverlayPointerEvent = z.infer<typeof OverlayPointerEventSchema>;

export const HitRegionSchema = z
  .object({
    rects: z
      .array(
        z
          .object({
            x: finite.min(-100000).max(100000),
            y: finite.min(-100000).max(100000),
            width: finite.min(0).max(5000),
            height: finite.min(0).max(5000),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export const OverlayErrorSchema = z.object({ message: z.string().max(500) }).strict();

/** Sent once per overlay window after load and on display changes. */
export interface OverlayConfig {
  displayId: string;
  scaleFactor: number;
  /** Draw hit regions and debug info. */
  debug: boolean;
}

export const SETTINGS_ACTIONS = [
  'pause',
  'resume',
  'hide',
  'show',
  'privacyPause',
  'privacyResume',
  'grantLocalStatsConsent',
  'grantAiConsent',
  'revokeConsent',
  'resetPersonality',
  'clearHistory',
  'exportDiagnostics',
  'openLogsFolder',
  'callCat',
  'completeFirstRun',
  'enableLaunchAtLogin',
  'disableLaunchAtLogin',
  'dismissLaunchNotice',
  'quit',
] as const;
export type SettingsAction = (typeof SETTINGS_ACTIONS)[number];
export const SettingsActionSchema = z.enum(SETTINGS_ACTIONS);

export const ApiKeyProviderSchema = z.enum(['anthropic', 'openai-compatible']);
export const SetApiKeySchema = z
  .object({
    provider: ApiKeyProviderSchema,
    /** null clears the stored key. */
    key: z.string().trim().min(8).max(400).nullable(),
  })
  .strict();

export const SettingsPatchSchema = z.record(z.string().max(32), z.record(z.string().max(64), z.unknown()));

/** Launch at Windows sign-in, as main sees it right now. */
export interface LoginItemStatus {
  /** Effective preference: 'unset' resolves to the product default (on). */
  enabled: boolean;
  preference: 'unset' | 'enabled' | 'disabled';
  disabledBy: 'user' | 'windows' | 'external' | null;
  /** Windows will start the app at sign-in (registry state read at last reconcile). */
  active: boolean;
  /** This build may write the registration (installed app); false for dev, test and unpacked builds. */
  writable: boolean;
  /** Short explanation when active differs from enabled (e.g. 'Disabled in Windows Startup apps'), or null. */
  reason: string | null;
  /** Show the one-time 'startup was turned on' notice. */
  showNotice: boolean;
}

export interface AppStatus {
  version: string;
  visible: boolean;
  paused: boolean;
  interactionsEnabled: boolean;
  catState: BehaviorState;
  displayCount: number;
  perception: PerceptionStatus;
  windowAwareness: 'event-hooks' | 'polling' | 'unavailable';
  /** v1.1 launch-at-sign-in state (main-owned). */
  loginItem: LoginItemStatus;
  /** v1.1 environment observers (taskbar, window surfaces, tab strips). */
  surfaces?: SurfaceStatus;
  shortcutRegistered: boolean;
  startedAt: number;
}

export interface ResourceSample {
  at: number;
  cpuPercent: number;
  workingSetMB: number;
}

export interface SettingsViewState {
  settings: Settings;
  status: AppStatus;
  cat: CatSummary;
  apiKeys: { anthropic: boolean; openaiCompatible: boolean };
  resources: ResourceSample[];
  versions: { app: string; electron: string; chrome: string; node: string; os: string };
  paths: { userData: string; logs: string };
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export interface AiTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  report?: SceneReport;
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  error?: string;
}

export interface PerceptionPreview {
  ok: boolean;
  /** Downscaled, masked frame exactly as analysed (data: URL, in-memory only). */
  imageDataUrl?: string;
  features?: VisualFeatures;
  events?: VisualEventKind[];
  blockedReason?: string;
}

/** API exposed to the overlay renderer as `window.desktopCat`. */
export interface OverlayApi {
  onRender(cb: (state: CatRenderState) => void): () => void;
  onConfig(cb: (config: OverlayConfig) => void): () => void;
  ready(): void;
  sendPointer(e: OverlayPointerEvent): void;
  sendHitRegion(region: HitRegion): void;
  reportError(message: string): void;
}

/** API exposed to the settings renderer as `window.desktopCatSettings`. */
export interface SettingsApi {
  getState(): Promise<SettingsViewState>;
  update(patch: SettingsPatch): Promise<PatchResult>;
  action(action: SettingsAction): Promise<ActionResult>;
  setApiKey(provider: 'anthropic' | 'openai-compatible', key: string | null): Promise<ActionResult>;
  testAi(): Promise<AiTestResult>;
  listModels(): Promise<ModelListResult>;
  previewPerception(): Promise<PerceptionPreview>;
  onStateChanged(cb: (state: SettingsViewState) => void): () => void;
}
