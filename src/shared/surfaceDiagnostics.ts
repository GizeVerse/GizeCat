// Surface-traversal diagnostics (v1.1.1): why the cat can or cannot get off the floor.
// Counts, kinds, reasons, timestamps and physical-px geometry only. Never window titles,
// tab names, process names or paths, page content or screenshots (docs/PRIVACY.md).
// Built on demand (Diagnostics page, diagnostics export), never logged continuously.

import type { Rect } from './geometry';
import type { SurfaceKind } from './surfaces';

/** Why the provider offered no surfaces for an app window (counted per window). */
export const PROVIDER_SKIP_REASONS = [
  'maximized',
  'minimized',
  'fullscreen',
  'coversWorkArea',
  /** Every edge is hidden behind windows above it. */
  'covered',
  /** Privacy exclusions (process rules, or title patterns while screen analysis is on). Counted only. */
  'excluded',
  'tooSmall',
  'offScreen',
  'disabled',
] as const;
export type ProviderSkipReason = (typeof PROVIDER_SKIP_REASONS)[number];

export type SurfaceCounts = Record<SurfaceKind, number>;

export interface ProviderDiagnostics {
  /** App windows the window tracker currently knows (after its shell/tool/own-process filters). */
  windowsConsidered: number;
  /** Windows that produced at least one surface. */
  windowsWithSurfaces: number;
  skipped: Partial<Record<ProviderSkipReason, number>>;
  /** Surfaces currently listed to the sim, by kind. */
  listed: SurfaceCounts;
  /** Host clock (ms) of the last completed window snapshot (0 = never). */
  lastRefreshAt: number;
  /** The topmost app window on the cat's display is maximized: it covers every window below it. */
  frontMaximized: boolean;
  tabStrips: {
    state: 'active' | 'idle' | 'off' | 'unavailable';
    helperRunning: boolean;
    /** Browser windows currently being measured. */
    interest: number;
    /** Tab strips currently known. */
    strips: number;
    reads: number;
    errors: number;
    /** Host clock (ms) of the last successful read (0 = never). */
    lastReadAt: number;
    /** Why the last measured browser produced no usable strip (e.g. 'maximized', 'noHeadroom', 'vertical', 'timeout'), or null. */
    lastRejection: string | null;
  };
  /** Most recent problems, newest last, at most 10. `kind` is a short machine-readable code. */
  recentErrors: Array<{ at: number; source: string; kind: string }>;
}

/** Why the movement engine did not accept a listed surface as walkable/climbable. */
export const NAV_REJECT_REASONS = [
  'invalid',
  'offDisplay',
  /** No room above the ledge for the cat's body (e.g. a top at the screen's top edge). */
  'noHeadroom',
  /** Too close above the floor to be worth standing on. */
  'nearFloor',
  'tooNarrow',
  /** Taskbars on the top/left/right edge are tracked but not ledges. */
  'unsupportedEdge',
  /** No on-screen room beside a side for the hanging cat. */
  'noRoomBeside',
  'tooShort',
  'disabled',
  'excluded',
  'capped',
] as const;
export type NavRejectReason = (typeof NAV_REJECT_REASONS)[number];

export interface NavDiagnostics {
  /** Surfaces the sim received on its last tick, by kind (after privacy filtering). */
  received: SurfaceCounts;
  /** Accepted by the world model as walkable ledges or climbable walls, by kind. */
  accepted: SurfaceCounts;
  rejected: Partial<Record<NavRejectReason, number>>;
  /** Accepted surfaces reachable from where the cat is now (any route: walk, jump, leap, climb), by kind. */
  reachable: SurfaceCounts;
  graph: { nodes: number; edges: number; updates: number; rebuilds: number };
  /** Session counters of climb outcomes. */
  climbs: {
    /** Jumped from a support and caught a window side above it. */
    leaps: number;
    /** Stepped onto a window side that reaches the support. */
    mounts: number;
    pulledUp: number;
    /** Turned back down because no top ledge was left to pull up onto. */
    reversed: number;
    letGo: number;
    /** The planned top changed under the climbing cat (e.g. a tab strip replaced the window top) and was re-resolved. */
    topReResolved: number;
  };
}

export const DECISION_TARGETS = ['perch', 'climb', 'tabStrip'] as const;
export type DecisionTarget = (typeof DECISION_TARGETS)[number];
export const TARGET_AVAILABILITY = ['available', 'disabled', 'cooldown', 'noSurfaces', 'unreachable', 'notGrounded', 'excluded'] as const;
export type TargetAvailability = (typeof TARGET_AVAILABILITY)[number];

export interface DecisionDiagnostics {
  /** Behaviour state name (e.g. 'walking', 'inspectingWindow'). */
  state: string;
  /** What the cat stands on or clings to right now. */
  support: 'floor' | SurfaceKind | 'air' | 'held' | 'none';
  /** Kind of surface the current activity is heading for, or null. */
  targetKind: 'floor' | SurfaceKind | null;
  /** Availability of each elevated destination type at the last decision. */
  targets: Record<DecisionTarget, TargetAvailability>;
  /** 0..1: grows while elevated surfaces are reachable but unvisited; raises the odds of an excursion. */
  exploreUrge: number;
  /** Sim clock (ms) of the last arrival on an elevated surface (0 = never this session). */
  lastElevatedAt: number;
  /** Arrivals on elevated surfaces this session. */
  excursions: number;
}

export interface DisplayCoordinates {
  id: string;
  primary: boolean;
  scale: number;
  boundsPx: Rect;
  workAreaPx: Rect;
  workAreaDip: Rect;
}

export interface SurfaceDiagnostics {
  /** Host clock (ms) when built. */
  at: number;
  coordinates: {
    /** Main-process DPI awareness as logged at boot (e.g. 'per-monitor-v2'). */
    dpiAwareness: string;
    displays: DisplayCoordinates[];
    /** The cat's anchor in physical px and the floor below it. */
    cat: { displayId: string | null; xPx: number; yPx: number; floorYPx: number | null };
  };
  provider: ProviderDiagnostics;
  nav: NavDiagnostics;
  decision: DecisionDiagnostics;
  /** One-line plain-English summary of the main reason the cat is (not) exploring. */
  verdict: string;
}

/** One segment of the optional on-desktop surface visualization (physical px). */
export const DEBUG_LINE_ROLES = ['rejected', 'valid', 'reachable', 'support', 'target'] as const;
export type DebugLineRole = (typeof DEBUG_LINE_ROLES)[number];
export interface SurfaceDebugLine {
  kind: 'floor' | SurfaceKind;
  role: DebugLineRole;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const MAX_DEBUG_LINES = 200;

export const emptySurfaceCounts = (): SurfaceCounts => ({ taskbar: 0, windowTop: 0, windowSide: 0, tabStrip: 0 });
