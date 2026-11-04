// End-to-end test surface, installed only when DESKTOP_CAT_TEST=1. Playwright
// reaches it through electronApp.evaluate(() => globalThis.__desktopCatTest...).
import type { BehaviorProfileSnapshot } from '../shared/behaviorProfile';
import type { Point } from '../shared/geometry';
import type { AppStatus } from '../shared/ipc';
import type { Settings, PatchResult } from '../shared/settings';
import type { SimEvent, SimOutput } from '../shared/sim';
import type { PerceptionStatus } from '../shared/perception';
import type { SurfaceDebugLine, SurfaceDiagnostics } from '../shared/surfaceDiagnostics';
import type { Surface, SurfaceStatus } from '../shared/surfaces';
import type { CatHostDebug } from './catHost';
import type { LogEntry } from './diagnostics/logger';
import type { AppAction } from './ipc/actions';
import type { OverlayInfo } from './overlay/overlayManager';
import { isTestMode } from './lifecycle/launchArgs';
import { parseInjectedSurfaces } from './surfaces/validate';

export const TEST_HOOK_GLOBAL = '__desktopCatTest';

export interface StartupReport {
  settingsLoad: string;
  catLoad: { recovered: boolean; source: string };
  userData: string;
  launchedAtLogin: boolean;
}

export interface TestHookContext {
  getSimOutput(): SimOutput | null;
  getOverlays(): OverlayInfo[];
  getStatus(): AppStatus;
  getSettings(): Settings;
  getPerceptionStatus(): PerceptionStatus | null;
  getHostDebug(): CatHostDebug;
  getStartup(): StartupReport;
  getLogProblems(): { warn: number; error: number };
  getRecentLogs(limit: number): LogEntry[];
  /** The diagnostics export payload, without the save dialog. */
  getDiagnosticsReport(): Record<string, unknown>;
  injectEvent(ev: SimEvent): void;
  /** env.surfaces of the last host tick (what the sim saw). */
  getSurfaces(): readonly Surface[];
  getSurfaceStatus(): SurfaceStatus;
  /**
   * Replaces every environment surface with `list` (SIMULATED geometry, validated), or
   * restores the real observers with null. Injected taskbar ledges raise taskbar.shown/hidden.
   */
  injectSurfaces(list: readonly Surface[] | null): void;
  /** v1.1.1: the Surfaces section's object, validated exactly as the settings window receives it. */
  getSurfaceDiagnostics(): SurfaceDiagnostics | null;
  /** v1.1.1: the sim's surface-outline segments (physical px), whether or not the outlines are shown. */
  getSurfaceDebugLines(): SurfaceDebugLine[];
  forceInteractive(value: boolean | null): void;
  // ---- v1.2 (ADR 0003 §15.4, review C2) ----
  /** The sim's session behaviour profile (counts, kinds, durations). */
  getBehaviorProfile(): BehaviorProfileSnapshot;
  /**
   * Feeds `p` (physical px) to the host as the cursor position, for the sim and for the overlay's
   * click-through decision, until null restores the real cursor. Never moves the real cursor.
   */
  injectCursor(p: Point | null): void;
  /**
   * Feeds `ms` to the sim as the user's idle time (GetLastInputInfo), until null restores the real
   * one. The longest idle sleep the settings allow is 120 minutes of real time, which time-scaled
   * E2E runs at an empty desk exceed: without this the cat only sleeps. Sends no OS input.
   */
  injectUserIdle(ms: number | null): void;
  /**
   * Lists only windows of these processes as surfaces (the E2E's own windows), or every window
   * again with null, so the user's windows never join a run.
   */
  restrictSurfacesToPids(pids: readonly number[] | null): void;
  setTimeScale(scale: number): void;
  runAction(action: AppAction): Promise<unknown>;
  patchSettings(patch: unknown): PatchResult;
  openSettings(): void;
  saveNow(): void;
  quit(): void;
}

export interface DesktopCatTestApi extends TestHookContext {
  readonly installedAt: number;
}

function isPointLike(v: unknown): v is Point {
  if (v === null || typeof v !== 'object') return false;
  const p = v as { x?: unknown; y?: unknown };
  return typeof p.x === 'number' && Number.isFinite(p.x) && Math.abs(p.x) < 1e6 && typeof p.y === 'number' && Number.isFinite(p.y) && Math.abs(p.y) < 1e6;
}

function isSimEventLike(v: unknown): v is SimEvent {
  return v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

export function installTestHooks(ctx: TestHookContext, env: Record<string, string | undefined> = process.env): boolean {
  if (!isTestMode(env)) return false;
  const api: DesktopCatTestApi = {
    ...ctx,
    injectEvent(ev) {
      if (!isSimEventLike(ev)) throw new Error('injectEvent: expected a SimEvent object');
      ctx.injectEvent(ev);
    },
    setTimeScale(scale) {
      if (typeof scale !== 'number' || !Number.isFinite(scale)) throw new Error('setTimeScale: expected a finite number');
      ctx.setTimeScale(scale);
    },
    forceInteractive(value) {
      if (value !== null && typeof value !== 'boolean') throw new Error('forceInteractive: expected boolean or null');
      ctx.forceInteractive(value);
    },
    injectSurfaces(list) {
      ctx.injectSurfaces(parseInjectedSurfaces(list));
    },
    injectCursor(p) {
      if (p !== null && !isPointLike(p)) throw new Error('injectCursor: expected {x, y} finite numbers or null');
      ctx.injectCursor(p === null ? null : { x: p.x, y: p.y });
    },
    injectUserIdle(ms) {
      if (ms !== null && (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)) throw new Error('injectUserIdle: expected a finite number >= 0, or null');
      ctx.injectUserIdle(ms);
    },
    restrictSurfacesToPids(pids) {
      const raw: unknown = pids;
      if (raw === null) {
        ctx.restrictSurfacesToPids(null);
        return;
      }
      if (!Array.isArray(raw) || raw.length > 64 || !raw.every((n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)) {
        throw new Error('restrictSurfacesToPids: expected up to 64 positive integer pids or null');
      }
      ctx.restrictSurfacesToPids((raw as number[]).slice());
    },
    installedAt: Date.now(),
  };
  Object.defineProperty(globalThis, TEST_HOOK_GLOBAL, { value: Object.freeze(api), configurable: false, enumerable: false, writable: false });
  return true;
}
