// IPC contract between main and the two sandboxed renderers. Every payload that
// crosses into main is validated with these schemas; senders are also checked
// against the known webContents/origin in main.
import { z } from 'zod';
import type { BehaviorProfileSnapshot } from './behaviorProfile';
import type { PlatformReport } from './platform';
import type { BehaviorState, CatRenderState, HitRegion } from './cat';
import type { CatSummary } from './catState';
import type { AnyEventId, JournalEntry, Mood, PersonalityId } from './companion';
import { IDENTITY } from './identity';
import type { PerceptionStatus, SceneReport, VisualEventKind, VisualFeatures } from './perception';
import type { ProfilePart, ProfileParts, ProfilePreview, ProfileRejectReason } from './profileTransfer';
import type { SurfaceDiagnostics } from './surfaceDiagnostics';
import type { SurfaceLinesPayload } from './surfaceDiagnosticsSchema';
import type { SurfaceStatus } from './surfaces';
import type { BehaviorId, PatchResult, Settings, SettingsPatch } from './settings';

/** Custom privileged scheme serving bundled renderer files (never file://). Frozen (identity.ts). */
export const APP_SCHEME = IDENTITY.scheme;
export const OVERLAY_URL = `${APP_SCHEME}://app/renderer/overlay/index.html`;
export const SETTINGS_URL = `${APP_SCHEME}://app/renderer/settings/index.html`;

export const IPC = {
  // main -> overlay
  overlayRender: 'overlay:render',
  overlayConfig: 'overlay:config',
  /** v1.1.1 surface outlines (debug aid; only while the session toggle is on). */
  overlaySurfaceLines: 'overlay:surface-lines',
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
  settingsGetSurfaceDiagnostics: 'settings:get-surface-diagnostics',
  /** v1.2 behaviour profile for Diagnostics -> Behaviour (validated in main; kinds, counts and durations only). */
  settingsGetBehaviorProfile: 'settings:get-behavior-profile',
  /**
   * 1.4.0 profile transfer ("Take your cat to another device"). Main builds, parses, previews and
   * applies the profile; files come only from main's own save/open dialogs, and the renderer never
   * sends file content or a path (only the export option, a token and the chosen parts).
   */
  settingsExportProfile: 'settings:export-profile',
  settingsOpenProfile: 'settings:open-profile',
  settingsApplyProfile: 'settings:apply-profile',
  /** Living Companion: the cat journal for the Journal page (validated in main; event ids, outcome tokens and dates only). */
  settingsGetJournal: 'settings:get-journal',
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
  /** v1.1.1 on-desktop surface outlines: session-only, never persisted (off after a restart). */
  'showSurfaceOutlines',
  'hideSurfaceOutlines',
  /** 1.4.0, macOS only: main opens System Settings › General › Login Items (a constant URL); elsewhere it fails. */
  'openLoginItemsSettings',
  /**
   * Living Companion. Laser Mode is session-only (off after every start, never persisted): the red
   * dot follows the real pointer and the cat chases it without ever catching it. Event pause is also
   * session-only: it holds the world-event schedule until resumed or restarted.
   */
  'startLaserMode',
  'stopLaserMode',
  'pauseEvents',
  'resumeEvents',
  /** Clears the cat journal (and the event history it was written from); nothing else. */
  'clearJournal',
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

// ---- 1.4.0 profile transfer (src/shared/profileTransfer.ts holds the file format)

/** A pending import's token: 128 random bits in hex, issued by main for a file picked in its own dialog. */
export const PROFILE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export const ExportProfileRequestSchema = z.object({ includeMemory: z.boolean() }).strict();

export const ProfilePartsSchema = z
  .object({ cat: z.boolean(), appearance: z.boolean(), preferences: z.boolean(), memory: z.boolean() })
  .strict();
// Compile-time pin: the schema's keys are exactly the profile parts.
const _profilePartsSchemaMatches: [keyof z.infer<typeof ProfilePartsSchema>] extends [ProfilePart]
  ? [ProfilePart] extends [keyof z.infer<typeof ProfilePartsSchema>]
    ? true
    : false
  : false = true;

export const ApplyProfileRequestSchema = z.object({ token: z.string().regex(PROFILE_TOKEN_PATTERN), parts: ProfilePartsSchema }).strict();

/** Export outcome. Reason codes only; the renderer words them (strings.ts S.profile). */
export type ProfileExportResponse =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'failed' }
  | { status: 'unavailable' };

/** Open outcome: a preview (plain data) and the token that applies it, or why not. */
export type ProfileOpenResponse =
  | { status: 'ready'; token: string; preview: ProfilePreview }
  | { status: 'rejected'; reason: ProfileRejectReason | 'unreadable'; formatMajor?: number }
  | { status: 'cancelled' }
  | { status: 'busy' }
  | { status: 'unavailable' };

export type ProfileApplyFailureReason = 'expired' | 'nothing-selected' | 'invalid-request' | 'unavailable' | 'failed';
export type ProfileApplyResponse =
  | { ok: true; name: string; catReplaced: boolean; keptOff: BehaviorId[] }
  | { ok: false; reason: ProfileApplyFailureReason };

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
  /** v1.1.1 surface outlines are drawn on the desktop (session-only debug aid). */
  surfaceOutlines?: boolean;
  shortcutRegistered: boolean;
  startedAt: number;
  /** GizeVerse (ADR 0004 §2.2): this platform and what it can do here. */
  platform?: PlatformReport;
}

export interface ResourceSample {
  at: number;
  cpuPercent: number;
  workingSetMB: number;
}

/**
 * What the Companion page shows live (Living Companion). Derived by main from the sim each time the view
 * state is built; never persisted and content-free (ids and numbers only).
 */
export interface CompanionStatus {
  /** The cat's temporary mood. */
  mood: Mood;
  /** What the cat is doing (its behaviour state). */
  activity: BehaviorState;
  /** The chosen personality, or the nearest profile of a cat that keeps its born traits ('auto'). */
  personality: PersonalityId;
  /** True when `personality` is the nearest profile of an 'auto' cat rather than the user's choice. */
  personalityIsAuto: boolean;
  /** The world event that is running, or null. */
  event: AnyEventId | null;
  /** ms until the next world event, or null when one is running, events are off or the schedule is frozen. */
  nextEventInMs: number | null;
  /** The user paused events for this session. */
  eventsPaused: boolean;
  /** Laser Mode is on. */
  laserActive: boolean;
}

export interface SettingsViewState {
  settings: Settings;
  status: AppStatus;
  cat: CatSummary;
  /** Living Companion live status; absent from older builds' snapshots. */
  companion?: CompanionStatus;
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
  /** v1.1.1 surface outline frames (validated in the preload; overlay-local DIP). */
  onSurfaceLines(cb: (payload: SurfaceLinesPayload) => void): () => void;
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
  /** v1.1.1: why the cat can or cannot get off the floor (validated in main; no titles or ids). */
  getSurfaceDiagnostics(): Promise<SurfaceDiagnostics>;
  /** v1.2: what the cat did this session (validated in main against BehaviorProfileSchema; no ids, titles or positions). */
  getBehaviorProfile(): Promise<BehaviorProfileSnapshot>;
  /** 1.4.0: saves this cat to a file the user picks in main's save dialog. */
  exportProfile(opts: { includeMemory: boolean }): Promise<ProfileExportResponse>;
  /** 1.4.0: main's open dialog; returns a preview and a token, never the file's content or path. */
  openProfile(): Promise<ProfileOpenResponse>;
  /** 1.4.0: applies the chosen parts of the file behind `token` (after the user confirmed the preview). */
  applyProfile(token: string, parts: ProfileParts): Promise<ProfileApplyResponse>;
  /** Living Companion: the journal, newest last (bounded, content-free tokens; sentences are built in the UI from src/shared/worldText.ts). */
  getJournal(): Promise<JournalEntry[]>;
  onStateChanged(cb: (state: SettingsViewState) => void): () => void;
}
