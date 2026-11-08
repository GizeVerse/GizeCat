// Assembles the v1.1.1 SurfaceDiagnostics (src/shared/surfaceDiagnostics.ts) on demand for
// the Diagnostics page, the diagnostics export and the 'surfaces summary' log line. Every
// field is copied explicitly from the producers (provider, sim), clamped and capped, so
// nothing beyond the contract's counts, kinds, reasons and geometry (no titles, window or
// surface ids, process names) can ride along. Main parses the result once more with
// SurfaceDiagnosticsSchema before it crosses to a renderer. Electron-free and pure except
// for the cache and the log.
import { simWorld } from '../../core/display/simWorld';
import type { Rect } from '../../shared/geometry';
import type { SimOutput } from '../../shared/sim';
import {
  DECISION_TARGETS,
  emptySurfaceCounts,
  NAV_REJECT_REASONS,
  PROVIDER_SKIP_REASONS,
  SCREEN_EDGE_GUARD_STATES,
  TAB_STRIP_READER_KINDS,
  TARGET_AVAILABILITY,
  type DecisionDiagnostics,
  type NavDiagnostics,
  type ProviderDiagnostics,
  type SurfaceCounts,
  type SurfaceDiagnostics,
  type TargetAvailability,
} from '../../shared/surfaceDiagnostics';
import { MAX_CODE_LENGTH, MAX_DIAGNOSTIC_DISPLAYS, MAX_RECENT_ERRORS } from '../../shared/surfaceDiagnosticsSchema';
import { SCREEN_EDGE_KIND, SURFACE_KINDS, type SurfaceStatus } from '../../shared/surfaces';
import type { WorldGeometry } from '../../shared/world';
import type { Logger } from '../contracts';
import { surfaceVerdict, type SurfaceVerdictCode } from './surfaceVerdict';

/** A cached object is reused this long, so the 1 Hz page poll, the export and the log share one build. */
export const SURFACE_DIAGNOSTICS_CACHE_MS = 500;
/** The 'surfaces summary' log line is written on change, at most this often. */
export const SURFACE_SUMMARY_MIN_INTERVAL_MS = 60_000;

const COUNT_MAX = 1e9;
const TAB_STRIP_STATES: ReadonlySet<string> = new Set(['active', 'idle', 'off', 'unavailable']);
const SUPPORTS: ReadonlySet<string> = new Set(['floor', ...SURFACE_KINDS, SCREEN_EDGE_KIND, 'air', 'held', 'none']);
const TARGET_KINDS: ReadonlySet<string> = new Set(['floor', ...SURFACE_KINDS, SCREEN_EDGE_KIND]);
const AVAILABILITY: ReadonlySet<string> = new Set(TARGET_AVAILABILITY);

export interface SurfaceDiagnosticsInputs {
  /** Host clock (ms). */
  at: number;
  /** Main-process DPI awareness as logged at boot (dpiAwareness.ts). */
  dpiAwareness: string;
  /** The overlays' world (display.world); the floor comes from the sim's view of it (simWorld). */
  world: WorldGeometry;
  /** The cat's last sim output (anchor in px), null before the first tick. */
  output: Pick<SimOutput, 'x' | 'y' | 'displayId'> | null;
  observers: SurfaceStatus['windowSurfaces'];
  /** 1.4.0: no window tracking exists on this platform (the verdict says so instead of naming the taskbar). */
  floorOnly?: boolean;
  provider: () => ProviderDiagnostics;
  sim: () => { nav: NavDiagnostics; decision: DecisionDiagnostics };
}

export interface AssembledSurfaceDiagnostics {
  diagnostics: SurfaceDiagnostics;
  /** Machine-readable form of diagnostics.verdict (for the log). */
  code: SurfaceVerdictCode;
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const cnt = (v: unknown): number => Math.min(COUNT_MAX, Math.max(0, num(v)));
const text = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_CODE_LENGTH) : fallback);
const oneOf = <T extends string>(v: unknown, allowed: ReadonlySet<string>, fallback: T): T => (typeof v === 'string' && allowed.has(v) ? (v as T) : fallback);

const GUARD_STATES: ReadonlySet<string> = new Set(SCREEN_EDGE_GUARD_STATES);

function counts(c: Partial<SurfaceCounts> | null | undefined): SurfaceCounts {
  const out = emptySurfaceCounts();
  for (const k of SURFACE_KINDS) out[k] = cnt(c?.[k]);
  return out;
}

function reasons<R extends string>(rec: Partial<Record<R, number>> | null | undefined, keys: readonly R[]): Partial<Record<R, number>> {
  const out: Partial<Record<R, number>> = {};
  for (const k of keys) {
    const n = rec?.[k];
    if (n !== undefined) out[k] = cnt(n);
  }
  return out;
}

function rect(r: Rect): Rect {
  return { x: num(r.x), y: num(r.y), width: cnt(r.width), height: cnt(r.height) };
}

function pickProvider(p: ProviderDiagnostics): ProviderDiagnostics {
  const t = p.tabStrips;
  return {
    windowsConsidered: cnt(p.windowsConsidered),
    windowsWithSurfaces: cnt(p.windowsWithSurfaces),
    skipped: reasons(p.skipped, PROVIDER_SKIP_REASONS),
    listed: counts(p.listed),
    lastRefreshAt: num(p.lastRefreshAt),
    frontMaximized: p.frontMaximized === true,
    tabStrips: {
      state: oneOf(t?.state, TAB_STRIP_STATES, 'unavailable'),
      helperRunning: t?.helperRunning === true,
      interest: cnt(t?.interest),
      strips: cnt(t?.strips),
      reads: cnt(t?.reads),
      errors: cnt(t?.errors),
      lastReadAt: num(t?.lastReadAt),
      lastRejection: typeof t?.lastRejection === 'string' ? text(t.lastRejection, 'unknown') : null,
      ...(t?.byKind ? { byKind: reasons(t.byKind, TAB_STRIP_READER_KINDS) } : {}),
    },
    ...(p.screenEdges
      ? {
          screenEdges: {
            bands: cnt(p.screenEdges.bands),
            clearSpans: cnt(p.screenEdges.clearSpans),
            coveredSpans: cnt(p.screenEdges.coveredSpans),
            guard: oneOf(p.screenEdges.guard, GUARD_STATES, 'off'),
            failClosed: cnt(p.screenEdges.failClosed),
          },
        }
      : {}),
    recentErrors: (Array.isArray(p.recentErrors) ? p.recentErrors.slice(-MAX_RECENT_ERRORS) : []).map((e) => ({
      at: num(e?.at),
      source: text(e?.source, 'unknown'),
      kind: text(e?.kind, 'unknown'),
    })),
  };
}

function pickNav(n: NavDiagnostics): NavDiagnostics {
  return {
    received: counts(n.received),
    accepted: counts(n.accepted),
    rejected: reasons(n.rejected, NAV_REJECT_REASONS),
    reachable: counts(n.reachable),
    graph: { nodes: cnt(n.graph?.nodes), edges: cnt(n.graph?.edges), updates: cnt(n.graph?.updates), rebuilds: cnt(n.graph?.rebuilds) },
    climbs: {
      leaps: cnt(n.climbs?.leaps),
      mounts: cnt(n.climbs?.mounts),
      pulledUp: cnt(n.climbs?.pulledUp),
      reversed: cnt(n.climbs?.reversed),
      letGo: cnt(n.climbs?.letGo),
      topReResolved: cnt(n.climbs?.topReResolved),
    },
  };
}

function pickDecision(d: DecisionDiagnostics): DecisionDiagnostics {
  const targets = {} as Record<(typeof DECISION_TARGETS)[number], TargetAvailability>;
  for (const k of DECISION_TARGETS) targets[k] = oneOf<TargetAvailability>(d.targets?.[k], AVAILABILITY, 'noSurfaces');
  return {
    state: text(d.state, 'unknown'),
    support: oneOf<DecisionDiagnostics['support']>(d.support, SUPPORTS, 'none'),
    targetKind: typeof d.targetKind === 'string' && TARGET_KINDS.has(d.targetKind) ? d.targetKind : null,
    targets,
    exploreUrge: Math.min(1, Math.max(0, num(d.exploreUrge))),
    lastElevatedAt: num(d.lastElevatedAt),
    excursions: cnt(d.excursions),
  };
}

function emptyProvider(): ProviderDiagnostics {
  return {
    windowsConsidered: 0,
    windowsWithSurfaces: 0,
    skipped: {},
    listed: emptySurfaceCounts(),
    lastRefreshAt: 0,
    frontMaximized: false,
    tabStrips: { state: 'unavailable', helperRunning: false, interest: 0, strips: 0, reads: 0, errors: 0, lastReadAt: 0, lastRejection: null },
    recentErrors: [],
  };
}

function emptySim(): { nav: NavDiagnostics; decision: DecisionDiagnostics } {
  return {
    nav: {
      received: emptySurfaceCounts(),
      accepted: emptySurfaceCounts(),
      rejected: {},
      reachable: emptySurfaceCounts(),
      graph: { nodes: 0, edges: 0, updates: 0, rebuilds: 0 },
      climbs: { leaps: 0, mounts: 0, pulledUp: 0, reversed: 0, letGo: 0, topReResolved: 0 },
    },
    decision: {
      state: 'unknown',
      support: 'none',
      targetKind: null,
      targets: { perch: 'noSurfaces', climb: 'noSurfaces', tabStrip: 'noSurfaces' },
      exploreUrge: 0,
      lastElevatedAt: 0,
      excursions: 0,
    },
  };
}

function floorBelow(world: WorldGeometry, displayId: string | null): number | null {
  if (displayId === null) return null;
  const d = simWorld(world).displays.find((x) => x.id === displayId);
  return d ? d.workAreaPx.y + d.workAreaPx.height : null;
}

/** Builds one SurfaceDiagnostics. A failing producer yields empty counts and a recentErrors entry, never a throw. */
export function assembleSurfaceDiagnostics(i: SurfaceDiagnosticsInputs): AssembledSurfaceDiagnostics {
  const problems: ProviderDiagnostics['recentErrors'] = [];
  let provider: ProviderDiagnostics;
  try {
    provider = pickProvider(i.provider());
  } catch {
    provider = emptyProvider();
    problems.push({ at: num(i.at), source: 'diagnostics', kind: 'providerFailed' });
  }
  let sim: { nav: NavDiagnostics; decision: DecisionDiagnostics };
  try {
    const s = i.sim();
    sim = { nav: pickNav(s.nav), decision: pickDecision(s.decision) };
  } catch {
    sim = emptySim();
    problems.push({ at: num(i.at), source: 'diagnostics', kind: 'simFailed' });
  }
  if (problems.length > 0) provider.recentErrors = [...provider.recentErrors, ...problems].slice(-MAX_RECENT_ERRORS);
  const out = i.output;
  const displayId = out && typeof out.displayId === 'string' ? out.displayId.slice(0, MAX_CODE_LENGTH) : null;
  const observers = i.observers === 'tracked' ? 'tracked' : 'unavailable';
  const verdict = surfaceVerdict({ observers, floorOnly: i.floorOnly === true, provider, nav: sim.nav, decision: sim.decision });
  const diagnostics: SurfaceDiagnostics = {
    at: num(i.at),
    coordinates: {
      dpiAwareness: text(i.dpiAwareness, 'unknown'),
      displays: i.world.displays.slice(0, MAX_DIAGNOSTIC_DISPLAYS).map((d) => ({
        id: text(d.id, 'unknown'),
        primary: d.primary === true,
        scale: num(d.scaleFactor, 1) > 0 ? num(d.scaleFactor, 1) : 1,
        boundsPx: rect(d.boundsPx),
        workAreaPx: rect(d.workAreaPx),
        workAreaDip: rect(d.workAreaDip),
      })),
      cat: { displayId, xPx: num(out?.x), yPx: num(out?.y), floorYPx: floorBelow(i.world, displayId) },
    },
    provider,
    nav: sim.nav,
    decision: sim.decision,
    verdict: verdict.text,
  };
  return { diagnostics, code: verdict.code };
}

export interface SurfaceDiagnosticsSource {
  /** The cached object while younger than the cache period, else a fresh build. */
  get(): AssembledSurfaceDiagnostics;
}

export function createSurfaceDiagnosticsSource(opts: { clock: () => number; build: (at: number) => AssembledSurfaceDiagnostics; cacheMs?: number }): SurfaceDiagnosticsSource {
  const cacheMs = Math.max(SURFACE_DIAGNOSTICS_CACHE_MS, opts.cacheMs ?? SURFACE_DIAGNOSTICS_CACHE_MS);
  let cached: AssembledSurfaceDiagnostics | null = null;
  let builtAt = -Infinity;
  return {
    get() {
      const now = opts.clock();
      if (cached && now >= builtAt && now - builtAt < cacheMs) return cached;
      cached = opts.build(now);
      builtAt = now;
      return cached;
    },
  };
}

/**
 * What the 'surfaces summary' log line carries: counts by kind, flags, the verdict code, what
 * the cat stands on (a kind) and its trips up this session (a count), so a packaged build's
 * main.log shows that the cat went up. Nothing else.
 */
export interface SurfaceSummary {
  listed: SurfaceCounts;
  accepted: SurfaceCounts;
  reachable: SurfaceCounts;
  frontMaximized: boolean;
  tabStrips: ProviderDiagnostics['tabStrips']['state'];
  verdict: SurfaceVerdictCode;
  support: DecisionDiagnostics['support'];
  excursions: number;
}

export function surfaceSummary(a: AssembledSurfaceDiagnostics): SurfaceSummary {
  const d = a.diagnostics;
  return {
    listed: { ...d.provider.listed },
    accepted: { ...d.nav.accepted },
    reachable: { ...d.nav.reachable },
    frontMaximized: d.provider.frontMaximized,
    tabStrips: d.provider.tabStrips.state,
    verdict: a.code,
    support: d.decision.support,
    excursions: d.decision.excursions,
  };
}

export interface SurfaceSummaryLog {
  /** Logs `summary` when it differs from the last logged one and the interval has passed; true when it logged. */
  note(summary: SurfaceSummary, now: number): boolean;
}

export function createSurfaceSummaryLog(opts: { logger: Logger; minIntervalMs?: number }): SurfaceSummaryLog {
  const minIntervalMs = opts.minIntervalMs ?? SURFACE_SUMMARY_MIN_INTERVAL_MS;
  let lastKey: string | null = null;
  let lastAt = -Infinity;
  return {
    note(summary, now) {
      const key = JSON.stringify(summary);
      if (key === lastKey || now - lastAt < minIntervalMs) return false;
      lastKey = key;
      lastAt = now;
      opts.logger.info('surfaces summary', { ...summary });
      return true;
    },
  };
}
