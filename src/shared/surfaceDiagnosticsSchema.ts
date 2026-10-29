// Runtime schemas for the v1.1.1 surface diagnostics (contract: ./surfaceDiagnostics.ts).
// Main parses every SurfaceDiagnostics with these before it reaches the settings window
// (strict objects: nothing beyond the contract's counts, kinds, reasons and geometry can
// leave main), and the overlay preload parses every outline frame before the renderer
// sees it. Built with zod/mini so the overlay preload bundle stays small (the full zod
// build would add ~440 KB to a 1 KB preload, zod/mini adds ~22 KB); the type checks at
// the bottom fail to compile if the schemas drift from the contract.
import * as z from 'zod/mini';
import { SCREEN_EDGE_KIND, SURFACE_KINDS } from './surfaces';
import {
  DEBUG_LINE_ROLES,
  MAX_DEBUG_LINES,
  NAV_REJECT_REASONS,
  PROVIDER_SKIP_REASONS,
  SCREEN_EDGE_GUARD_STATES,
  TAB_STRIP_READER_KINDS,
  TARGET_AVAILABILITY,
  type SurfaceDebugLine,
  type SurfaceDiagnostics,
} from './surfaceDiagnostics';

/** Displays listed in one diagnostics object (more than any real desk). */
export const MAX_DIAGNOSTIC_DISPLAYS = 16;
/** ProviderDiagnostics.recentErrors holds at most this many (contract). */
export const MAX_RECENT_ERRORS = 10;
/** Short machine-readable codes (state names, error kinds, rejection reasons). */
export const MAX_CODE_LENGTH = 64;
export const MAX_VERDICT_LENGTH = 400;

const COUNT_MAX = 1e9;
const COORD_LIMIT = 1e7;
/** Overlay-local DIP, the same bound as the overlay's other payloads (ipc.ts). */
const LOCAL_LIMIT = 100000;

const count = z.number().check(z.gte(0), z.lte(COUNT_MAX));
const time = z.number().check(z.gte(-COUNT_MAX * 1e3), z.lte(COUNT_MAX * 1e3));
const coord = z.number().check(z.gte(-COORD_LIMIT), z.lte(COORD_LIMIT));
const code = z.string().check(z.maxLength(MAX_CODE_LENGTH));

const counts = z.strictObject({ taskbar: count, windowTop: count, windowSide: count, tabStrip: count });
const rect = z.strictObject({ x: coord, y: coord, width: count, height: count });

const ProviderDiagnosticsSchema = z.strictObject({
  windowsConsidered: count,
  windowsWithSurfaces: count,
  skipped: z.partialRecord(z.enum(PROVIDER_SKIP_REASONS), count),
  listed: counts,
  lastRefreshAt: time,
  frontMaximized: z.boolean(),
  tabStrips: z.strictObject({
    state: z.enum(['active', 'idle', 'off', 'unavailable']),
    helperRunning: z.boolean(),
    interest: count,
    strips: count,
    reads: count,
    errors: count,
    lastReadAt: time,
    lastRejection: z.nullable(code),
    byKind: z.optional(z.partialRecord(z.enum(TAB_STRIP_READER_KINDS), count)),
  }),
  screenEdges: z.optional(
    z.strictObject({ bands: count, clearSpans: count, coveredSpans: count, guard: z.enum(SCREEN_EDGE_GUARD_STATES), failClosed: count }),
  ),
  recentErrors: z.array(z.strictObject({ at: time, source: code, kind: code })).check(z.maxLength(MAX_RECENT_ERRORS)),
});

const NavDiagnosticsSchema = z.strictObject({
  received: counts,
  accepted: counts,
  rejected: z.partialRecord(z.enum(NAV_REJECT_REASONS), count),
  reachable: counts,
  graph: z.strictObject({ nodes: count, edges: count, updates: count, rebuilds: count }),
  climbs: z.strictObject({ leaps: count, mounts: count, pulledUp: count, reversed: count, letGo: count, topReResolved: count }),
});

const availability = z.enum(TARGET_AVAILABILITY);

const DecisionDiagnosticsSchema = z.strictObject({
  state: code,
  support: z.enum(['floor', ...SURFACE_KINDS, SCREEN_EDGE_KIND, 'air', 'held', 'none']),
  targetKind: z.nullable(z.enum(['floor', ...SURFACE_KINDS, SCREEN_EDGE_KIND])),
  targets: z.strictObject({ perch: availability, climb: availability, tabStrip: availability }),
  exploreUrge: z.number().check(z.gte(0), z.lte(1)),
  lastElevatedAt: time,
  excursions: count,
});

export const SurfaceDiagnosticsSchema = z.strictObject({
  at: time,
  coordinates: z.strictObject({
    dpiAwareness: code,
    displays: z
      .array(
        z.strictObject({
          id: code,
          primary: z.boolean(),
          scale: z.number().check(z.gt(0), z.lte(16)),
          boundsPx: rect,
          workAreaPx: rect,
          workAreaDip: rect,
        }),
      )
      .check(z.maxLength(MAX_DIAGNOSTIC_DISPLAYS)),
    cat: z.strictObject({ displayId: z.nullable(code), xPx: coord, yPx: coord, floorYPx: z.nullable(coord) }),
  }),
  provider: ProviderDiagnosticsSchema,
  nav: NavDiagnosticsSchema,
  decision: DecisionDiagnosticsSchema,
  verdict: z.string().check(z.maxLength(MAX_VERDICT_LENGTH)),
});

const local = z.number().check(z.gte(-LOCAL_LIMIT), z.lte(LOCAL_LIMIT));

export const SurfaceDebugLineSchema = z.strictObject({
  kind: z.enum(['floor', ...SURFACE_KINDS]),
  role: z.enum(DEBUG_LINE_ROLES),
  x0: local,
  y0: local,
  x1: local,
  y1: local,
});

/** One frame of the on-desktop surface outlines for one overlay (overlay-local DIP); empty clears. */
export interface SurfaceLinesPayload {
  lines: SurfaceDebugLine[];
}

export const SurfaceLinesPayloadSchema = z.strictObject({
  lines: z.array(SurfaceDebugLineSchema).check(z.maxLength(MAX_DEBUG_LINES)),
});

/** The validated copy (unknown fields rejected), or null. */
export function parseSurfaceDiagnostics(value: unknown): SurfaceDiagnostics | null {
  const r = SurfaceDiagnosticsSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** The validated copy, or null. */
export function parseSurfaceLinesPayload(value: unknown): SurfaceLinesPayload | null {
  const r = SurfaceLinesPayloadSchema.safeParse(value);
  return r.success ? r.data : null;
}

// Compile-time drift checks: each schema's output and its contract type are mutually assignable.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const diagnosticsMatch: Same<z.infer<typeof SurfaceDiagnosticsSchema>, SurfaceDiagnostics> = true;
const linesMatch: Same<z.infer<typeof SurfaceLinesPayloadSchema>, SurfaceLinesPayload> = true;
export const SCHEMAS_MATCH_CONTRACT = diagnosticsMatch && linesMatch;
