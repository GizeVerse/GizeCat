// End-to-end test surface, installed only when DESKTOP_CAT_TEST=1. Playwright
// reaches it through electronApp.evaluate(() => globalThis.__desktopCatTest...).
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BehaviorProfileSnapshot } from '../shared/behaviorProfile';
import type { Point } from '../shared/geometry';
import type { AppStatus } from '../shared/ipc';
import type { Settings, PatchResult } from '../shared/settings';
import type { SimEvent, SimOutput } from '../shared/sim';
import type { PerceptionStatus } from '../shared/perception';
import type { SurfaceDebugLine, SurfaceDiagnostics } from '../shared/surfaceDiagnostics';
import type { Surface, SurfaceStatus } from '../shared/surfaces';
import type { CatHostDebug, ClickGuardStats } from './catHost';
import type { LogEntry } from './diagnostics/logger';
import type { AppAction } from './ipc/actions';
import type { OverlayInfo, OverlayInteractionStats, OverlayManager } from './overlay/overlayManager';
import { isTestMode } from './lifecycle/launchArgs';
import { parseInjectedSurfaces } from './surfaces/validate';

export const TEST_HOOK_GLOBAL = '__desktopCatTest';

/** The four powerMonitor signals app.ts handles ('lock-screen', 'unlock-screen', 'suspend', 'resume'). */
export const SYSTEM_EVENT_KINDS = ['lock', 'unlock', 'suspend', 'resume'] as const;
export type SystemEventKind = (typeof SYSTEM_EVENT_KINDS)[number];

/**
 * Interaction counters for the soak (docs/gizeverse/13-interaction-reliability.md): the overlay
 * manager's press path and the host's click guard and lock/suspend bookkeeping, since start.
 */
export interface InteractionStatsReport {
  /** null while app.ts does not pass `interactionOverlays` (the field is optional, see TestHookContext). */
  overlay: OverlayInteractionStats | null;
  /** A press or drag is in progress in main right now (null: not wired). */
  pressed: boolean | null;
  dragging: boolean | null;
  /** Some overlay takes the mouse right now (null: not wired). */
  interactive: boolean | null;
  clickGuard: ClickGuardStats;
  lifecycle: CatHostDebug['lifecycle'];
}

/** Main-process event-loop delay (perf_hooks.monitorEventLoopDelay, 10 ms resolution) since the last reset. */
export interface EventLoopDelayReport {
  count: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

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
  // ---- interaction reliability (docs/gizeverse/13-interaction-reliability.md) ----
  /**
   * Runs the app's own powerMonitor handler for `kind` (app.ts onLock / onUnlock / onSuspend /
   * onResume, the same closures powerMonitor calls), so a test exercises exactly what the OS signal
   * would. Sends nothing to the OS. Optional until app.ts passes it; the hook then throws.
   */
  systemEvent?: (kind: SystemEventKind) => void;
  /** The overlay manager's press-path state and counters. Optional until app.ts passes it. */
  interactionOverlays?: Pick<OverlayManager, 'interactionStats' | 'pressed' | 'dragging' | 'interactive'>;
}

export interface DesktopCatTestApi extends Omit<TestHookContext, 'systemEvent' | 'interactionOverlays'> {
  readonly installedAt: number;
  /** See TestHookContext.systemEvent; throws when app.ts does not wire it. */
  systemEvent(kind: SystemEventKind): void;
  /** Overlay press-path counters plus the host's click-guard and lifecycle counters. */
  interactionStats(): InteractionStatsReport;
  /** Main event-loop delay since the previous call with `reset` (the histogram starts on the first call). */
  eventLoopDelay(reset?: boolean): EventLoopDelayReport;
}

function isPointLike(v: unknown): v is Point {
  if (v === null || typeof v !== 'object') return false;
  const p = v as { x?: unknown; y?: unknown };
  return typeof p.x === 'number' && Number.isFinite(p.x) && Math.abs(p.x) < 1e6 && typeof p.y === 'number' && Number.isFinite(p.y) && Math.abs(p.y) < 1e6;
}

function isSimEventLike(v: unknown): v is SimEvent {
  return v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string';
}

function isSystemEventKind(v: unknown): v is SystemEventKind {
  return typeof v === 'string' && (SYSTEM_EVENT_KINDS as readonly string[]).includes(v);
}

const NS_PER_MS = 1e6;

export function installTestHooks(ctx: TestHookContext, env: Record<string, string | undefined> = process.env): boolean {
  if (!isTestMode(env)) return false;
  // Never exposed as such: only the calls below reach them (the overlay manager is not handed out).
  const { systemEvent, interactionOverlays, ...base } = ctx;
  let loopDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  const api: DesktopCatTestApi = {
    ...base,
    systemEvent(kind) {
      if (!isSystemEventKind(kind)) throw new Error(`systemEvent: expected one of ${SYSTEM_EVENT_KINDS.join(', ')}`);
      if (!systemEvent) throw new Error('systemEvent: app.ts does not pass the powerMonitor handlers (TestHookContext.systemEvent)');
      systemEvent(kind);
    },
    interactionStats() {
      const host = ctx.getHostDebug();
      const o = interactionOverlays ?? null;
      return {
        overlay: o ? o.interactionStats() : null,
        pressed: o ? o.pressed : null,
        dragging: o ? o.dragging : null,
        interactive: o ? o.interactive : null,
        clickGuard: host.clickGuardStats,
        lifecycle: host.lifecycle,
      };
    },
    eventLoopDelay(reset) {
      if (!loopDelay) {
        loopDelay = monitorEventLoopDelay({ resolution: 10 });
        loopDelay.enable();
      }
      const h = loopDelay;
      const ms = (ns: number): number => (Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0);
      const out: EventLoopDelayReport = { count: h.count, minMs: h.count > 0 ? ms(h.min) : 0, meanMs: h.count > 0 ? ms(h.mean) : 0, p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) };
      if (reset === true) h.reset();
      return out;
    },
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
