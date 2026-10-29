// IPC entry points. Every message is checked against the sender's window (kind,
// main frame, our page URL), rate limited, and validated with the shared zod
// schemas before anything acts on it. Secrets never travel back to renderers.
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import type { HitRegion } from '../../shared/cat';
import {
  HitRegionSchema,
  IPC,
  OverlayErrorSchema,
  OverlayPointerEventSchema,
  SetApiKeySchema,
  SettingsActionSchema,
  SettingsPatchSchema,
  type ActionResult,
  type AiTestResult,
  type ModelListResult,
  type OverlayPointerEvent,
  type PerceptionPreview,
  type SettingsViewState,
} from '../../shared/ipc';
import { rejectConsentBypass, rejectMainOwnedPatch, type PatchResult } from '../../shared/settings';
import type { SurfaceDiagnostics } from '../../shared/surfaceDiagnostics';
import { parseSurfaceDiagnostics } from '../../shared/surfaceDiagnosticsSchema';
import type { Logger, PerceptionService } from '../contracts';
import { redactString } from '../diagnostics/redact';
import { verifyIpcSender, type WindowRegistry } from '../security';
import { ENCRYPTION_UNAVAILABLE_MESSAGE, type ManagedSecretStore } from '../store/secretStore';
import type { SettingsStore } from '../store/settingsStore';
import type { ActionRunner } from './actions';
import { createRateLimiter } from './rateLimit';
import { rejectMainOwnedFields } from './startupState';
import { toPerceptionPreview } from './viewState';

/** Shared overlay budget: pointer moves (the renderer caps them per time), hit regions, errors. */
export const OVERLAY_MESSAGES_PER_SECOND = 240;
/**
 * Separate budget for state-changing pointer events (press, release, cancel, context,
 * enter, leave), so a burst of moves can never cost a release; far above human rates.
 */
export const OVERLAY_POINTER_EVENTS_PER_SECOND = 120;
const DISCRETE_POINTER_KINDS: ReadonlySet<unknown> = new Set<OverlayPointerEvent['kind']>(['down', 'up', 'cancel', 'context', 'enter', 'leave']);
const SETTINGS_CALLS_PER_SECOND = 60;
const WARN_INTERVAL_MS = 5000;

/** True for a pointer message whose kind changes press/hover state (judged before validation). */
function isDiscretePointer(channel: string, payload: unknown): boolean {
  if (channel !== IPC.overlayPointer || typeof payload !== 'object' || payload === null) return false;
  return DISCRETE_POINTER_KINDS.has((payload as { kind?: unknown }).kind);
}

export interface OverlayIpcTarget {
  handleReady(webContentsId: number): void;
  handlePointer(webContentsId: number, ev: OverlayPointerEvent): void;
  handleHitRegion(webContentsId: number, region: HitRegion): void;
  handleRendererError(webContentsId: number, message: string): void;
}

export interface IpcDeps {
  ipcMain: Pick<IpcMain, 'on' | 'removeAllListeners' | 'handle' | 'removeHandler'>;
  registry: WindowRegistry;
  logger: Logger;
  overlays: OverlayIpcTarget;
  getViewState: () => SettingsViewState;
  settings: SettingsStore;
  actions: ActionRunner;
  secrets: ManagedSecretStore;
  perception: PerceptionService | null;
  /** Called after an API key was stored or removed. */
  onSecretsChanged: () => void;
  /** v1.1.1 surface diagnostics for the Diagnostics page (built and cached in main). */
  getSurfaceDiagnostics?: () => SurfaceDiagnostics;
  clock: () => number;
}

export interface IpcRegistration {
  dispose(): void;
}

const unavailable = 'Screen analysis is not available in this build.';
const surfacesUnavailable = 'Surface details are not available right now.';
const errorText = (err: unknown): string => redactString(err instanceof Error ? err.message : String(err)).slice(0, 300);

export function registerIpcHandlers(deps: IpcDeps): IpcRegistration {
  const log = deps.logger;
  const overlayLimiter = createRateLimiter(OVERLAY_MESSAGES_PER_SECOND, 1000);
  const pointerEventLimiter = createRateLimiter(OVERLAY_POINTER_EVENTS_PER_SECOND, 1000);
  const settingsLimiter = createRateLimiter(SETTINGS_CALLS_PER_SECOND, 1000);
  const lastWarn = new Map<string, number>();
  const suppressed = new Map<string, number>();
  const onChannels: string[] = [];
  const handleChannels: string[] = [];

  function warnThrottled(key: string, msg: string, data?: Record<string, unknown>): void {
    const now = deps.clock();
    const last = lastWarn.get(key) ?? -Infinity;
    if (now - last < WARN_INTERVAL_MS) {
      suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
      return;
    }
    lastWarn.set(key, now);
    const extra = suppressed.get(key) ?? 0;
    suppressed.delete(key);
    log.warn(msg, { ...data, ...(extra > 0 ? { suppressedSinceLast: extra } : {}) });
  }

  function onOverlay<T>(channel: string, schema: z.ZodType<T> | null, fn: (id: number, payload: T) => void): void {
    deps.ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
      if (!verifyIpcSender(event, deps.registry, 'overlay')) {
        warnThrottled(`sender:${channel}`, 'rejected overlay message from an untrusted sender', { channel });
        return;
      }
      const id = event.sender.id;
      const limiter = isDiscretePointer(channel, payload) ? pointerEventLimiter : overlayLimiter;
      if (!limiter.allow(id, deps.clock())) {
        warnThrottled(`rate:${id}`, 'overlay message rate limit exceeded; dropping', { channel });
        return;
      }
      let data: T;
      if (schema) {
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          warnThrottled(`invalid:${channel}`, 'rejected invalid overlay message', { channel, issues: parsed.error.issues.length });
          return;
        }
        data = parsed.data;
      } else {
        data = undefined as T;
      }
      try {
        fn(id, data);
      } catch (err) {
        log.error('overlay message handler failed', { channel, error: err });
      }
    });
    onChannels.push(channel);
  }

  function onSettings<R>(channel: string, fn: (payload: unknown) => R | Promise<R>): void {
    deps.ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!verifyIpcSender(event, deps.registry, 'settings')) {
        warnThrottled(`sender:${channel}`, 'rejected settings call from an untrusted sender', { channel });
        throw new Error('Forbidden');
      }
      if (!settingsLimiter.allow(event.sender.id, deps.clock())) {
        warnThrottled(`rate-settings:${channel}`, 'settings call rate limit exceeded', { channel });
        throw new Error('Too many requests');
      }
      return fn(payload);
    });
    handleChannels.push(channel);
  }

  // overlay -> main
  onOverlay(IPC.overlayReady, null, (id) => deps.overlays.handleReady(id));
  onOverlay(IPC.overlayPointer, OverlayPointerEventSchema, (id, ev) => deps.overlays.handlePointer(id, ev));
  onOverlay(IPC.overlayHitRegion, HitRegionSchema, (id, region) => deps.overlays.handleHitRegion(id, region));
  onOverlay(IPC.overlayError, OverlayErrorSchema, (id, e) => deps.overlays.handleRendererError(id, e.message));

  // settings <-> main
  onSettings(IPC.settingsGetState, (): SettingsViewState => deps.getViewState());

  onSettings(IPC.settingsUpdate, (payload): PatchResult => {
    const parsed = SettingsPatchSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'invalid patch' };
    const bypass = rejectConsentBypass(parsed.data);
    if (bypass !== null) {
      log.warn('rejected settings patch touching consent fields');
      return { ok: false, error: bypass };
    }
    const section = rejectMainOwnedPatch(parsed.data);
    if (section !== null) {
      log.warn('rejected settings patch touching a section main owns');
      return { ok: false, error: section };
    }
    const owned = rejectMainOwnedFields(parsed.data);
    if (owned !== null) {
      log.warn('rejected settings patch touching fields main maintains');
      return { ok: false, error: owned };
    }
    return deps.settings.patchUnknown(parsed.data);
  });

  onSettings(IPC.settingsAction, async (payload): Promise<ActionResult> => {
    const parsed = SettingsActionSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, message: 'Unknown action.' };
    return deps.actions.run(parsed.data);
  });

  onSettings(IPC.settingsSetApiKey, (payload): ActionResult => {
    const parsed = SetApiKeySchema.safeParse(payload);
    if (!parsed.success) return { ok: false, message: 'That does not look like a valid API key.' };
    const { provider, key } = parsed.data;
    if (key !== null && !deps.secrets.encryptionAvailable) return { ok: false, message: ENCRYPTION_UNAVAILABLE_MESSAGE };
    const ok = deps.secrets.set(provider, key);
    if (ok) {
      log.info(key === null ? 'API key removed' : 'API key stored (encrypted)', { provider });
      deps.onSecretsChanged();
      return { ok: true, message: key === null ? 'API key removed.' : 'API key saved (encrypted with Windows DPAPI).' };
    }
    return { ok: false, message: 'Could not save the API key; see the log for details.' };
  });

  onSettings(IPC.settingsTestAi, async (): Promise<AiTestResult> => {
    if (!deps.perception) return { ok: false, message: unavailable };
    try {
      const r = await deps.perception.testAi();
      return { ...r, message: redactString(r.message) };
    } catch (err) {
      log.warn('AI test failed', { error: err });
      return { ok: false, message: errorText(err) };
    }
  });

  onSettings(IPC.settingsListModels, async (): Promise<ModelListResult> => {
    if (!deps.perception) return { ok: false, models: [], error: unavailable };
    try {
      const r = await deps.perception.listModels();
      return { ok: r.ok, models: r.models.slice(0, 500), ...(r.error ? { error: redactString(r.error) } : {}) };
    } catch (err) {
      return { ok: false, models: [], error: errorText(err) };
    }
  });

  onSettings(IPC.settingsPreviewPerception, async (): Promise<PerceptionPreview> => {
    if (!deps.perception) return { ok: false, blockedReason: unavailable };
    try {
      return toPerceptionPreview(await deps.perception.preview());
    } catch (err) {
      return { ok: false, blockedReason: errorText(err) };
    }
  });

  // Parsed with the strict contract schema on the way out: only counts, kinds, reasons and
  // geometry reach the renderer, whatever a producer put in (no titles, ids or process names).
  onSettings(IPC.settingsGetSurfaceDiagnostics, (): SurfaceDiagnostics => {
    if (!deps.getSurfaceDiagnostics) throw new Error(surfacesUnavailable);
    let parsed: SurfaceDiagnostics | null;
    try {
      parsed = parseSurfaceDiagnostics(deps.getSurfaceDiagnostics());
    } catch (err) {
      warnThrottled('surfaces:failed', 'building surface diagnostics failed', { error: err });
      // Only the message reaches the renderer (Electron serialises invoke errors as text).
      throw new Error(surfacesUnavailable, { cause: err });
    }
    if (!parsed) {
      warnThrottled('surfaces:invalid', 'surface diagnostics failed validation; not sent');
      throw new Error(surfacesUnavailable);
    }
    return parsed;
  });

  return {
    dispose() {
      for (const ch of onChannels) deps.ipcMain.removeAllListeners(ch);
      for (const ch of handleChannels) deps.ipcMain.removeHandler(ch);
      onChannels.length = 0;
      handleChannels.length = 0;
    },
  };
}
