// Liveness scenarios (v1.1.1): the user's real profile and screen, driven through the real Sim
// and Mover with provider-shaped surfaces, ticking at the rate the sim asks for (as the host
// does). Only kinds, counts and timings are collected.
import type { PersistedCat, Stats, Traits } from '../../../../src/shared/catState';
import type { Rect } from '../../../../src/shared/geometry';
import type { Settings } from '../../../../src/shared/settings';
import type { SimOutput } from '../../../../src/shared/sim';
import type { Surface } from '../../../../src/shared/surfaces';
import type { WindowInfo } from '../../../../src/shared/world';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { display, Harness, providerSurfacesFromWindows, world, type StripSpec } from './fixtures';

export const MIN = 60_000;
const WALL = 1_800_000_000_000;

/** The user's machine: one 1920x1200 display at 125 %, auto-hide taskbar (work area = the whole screen). */
export const USER_SCREEN = world(display('1', 0, 0, 1920, 1200, { primary: true, scale: 1.25 }));

/** The user's cat (cat-state.json, docs/research/v1.1.1-floor-only-diagnosis.md). */
export const USER_TRAITS: Traits = { curiosity: 0.65, playfulness: 0.38, affection: 0.44, confidence: 0.51, energyLevel: 0.54, laziness: 0.33, startleSensitivity: 0.5 };
export const USER_STATS: Partial<Stats> = { energy: 0.74, boredom: 0.02, bond: 0.28, annoyance: 0, fear: 0 };

/** A typical floating window in front (DWM frame [300,120]-[1300,960]): sides end 245 px above the floor, top ~1075 px up. */
export const TYPICAL_FRAME: Rect = { x: 300, y: 120, width: 1000, height: 840 };

/** The browser's tab strip on that frame, as the helper measures it: left controls and window buttons excluded. */
export const TYPICAL_STRIP: StripSpec = { x0: 400, x1: 1110, rest: { x0: 420, x1: 1000 }, focusX: 640 };

export function userCat(seed: number, traits: Partial<Traits> = {}, stats: Partial<Stats> = {}): PersistedCat {
  const cat = newPersistedCat(mulberry32(seed), WALL - 3600_000);
  Object.assign(cat.traits, USER_TRAITS, traits);
  Object.assign(cat.stats, USER_STATS, stats);
  return cat;
}

export interface Scenario {
  seed: number;
  settings?: Settings;
  traits?: Partial<Traits>;
  stats?: Partial<Stats>;
  /** App windows front first (default: the typical frame). */
  windows?: Record<string, Rect>;
  /** Tab strips measured on some of them. */
  tabStrips?: Record<string, StripSpec>;
  category?: WindowInfo['category'];
  /** Typing like a busy user: typing flag and intensity (default: none). */
  typing?: { typing: boolean; intensity: number };
}

export interface Excursion {
  /** Sim time of the arrival on the elevated surface, ms since the run started. */
  at: number;
  kind: 'windowTop' | 'tabStrip';
  /** How long it stayed on elevated surfaces (tops, strips, sides) before it was down again, ms. */
  stayMs: number;
  /** Furthest it walked along the surface it arrived on, from where it arrived, in body lengths. */
  walkedBl: number;
  /** The activity (state/variant) that took it up, and how long before the arrival it started, ms. */
  via: string;
  approachMs: number;
}

export interface LivenessResult {
  excursions: Excursion[];
  /** ms from the start to the first arrival (null: never). */
  firstAt: number | null;
  /** Highest exploration urge seen. */
  maxUrge: number;
  /** Ticks with the clip 'climb', or a window side as support. */
  wallTicks: number;
  /** Ticks on any surface other than a taskbar (tops, strips, sides). */
  upTicks: number;
  ticks: number;
  simMs: number;
  /** Diagnostics counter at the end (arrivals). */
  diagExcursions: number;
  surfaceShare: number;
  /** ms spent up (tops, strips, sides) by state. */
  upByState: Record<string, number>;
}

const ELEVATED = new Set(['windowTop', 'tabStrip', 'windowSide']);

/**
 * Runs one scenario for `ms` of sim time. The user is active (input a few seconds ago, never
 * long enough for the cat to fall asleep from idleness), never pets or drags it.
 */
export function runLiveness(sc: Scenario, ms: number): LivenessResult {
  const h = new Harness({ seed: sc.seed, world: USER_SCREEN, persisted: userCat(sc.seed, sc.traits, sc.stats), ...(sc.settings ? { settings: sc.settings } : {}) });
  const windows = sc.windows ?? { w: TYPICAL_FRAME };
  const surfaces: Surface[] = providerSurfacesFromWindows(windows, USER_SCREEN, { walls: true, now: 0, tabStrips: sc.tabStrips });
  const byId = new Map(surfaces.map((s) => [s.id, s] as const));
  h.env.surfaces = surfaces;
  h.env.getSurface = (id) => byId.get(id) ?? null;
  const front = Object.entries(windows)[0];
  if (front) {
    h.env.foreground = { id: front[0], rect: front[1], processName: 'app.exe', category: sc.category ?? 'code', minimized: false, maximized: false, fullscreen: false, excluded: false };
  }
  if (sc.typing) {
    h.env.typing = sc.typing.typing;
    h.env.typingIntensity = sc.typing.intensity;
  }
  const t0 = h.now;
  const excursions: Excursion[] = [];
  let cur: (Excursion & { surfaceId: string; x0: number }) | null = null;
  let via = '';
  let viaSince = 0;
  let maxUrge = 0;
  let wallTicks = 0;
  let ticks = 0;
  let upTicksMs = 0;
  let upTicks = 0;
  const upByState: Record<string, number> = {};
  let out: SimOutput = h.step([], 33);
  const bl = 84 * 1.25;
  while (h.now - t0 < ms) {
    // Input every few seconds: idle time never builds up to the idle-sleep threshold.
    h.env.userIdleMs = (h.now - t0) % 7000;
    const dt = Math.min(200, Math.max(16, out.nextTickMs));
    out = h.step([], dt);
    ticks++;
    const sup = out.support;
    const kind = sup.kind === 'surface' ? sup.surfaceKind : null;
    if (kind === 'windowSide' || out.clip === 'climb') wallTicks++;
    if (!['jumping', 'falling', 'landing', 'held'].includes(out.state)) {
      const next = `${out.state}/${String(h.sim.debugInfo().variant)}`;
      if (next !== via) viaSince = h.now - t0;
      via = next;
    }
    if (kind !== null && ELEVATED.has(kind)) {
      upTicks++;
      upTicksMs += dt;
      upByState[out.state] = (upByState[out.state] ?? 0) + dt;
    }
    if (cur) {
      if (kind === null || !ELEVATED.has(kind)) {
        if (sup.kind !== 'air') {
          cur.stayMs = h.now - t0 - cur.at;
          excursions.push({ at: cur.at, kind: cur.kind, stayMs: cur.stayMs, walkedBl: cur.walkedBl, via: cur.via, approachMs: cur.approachMs });
          cur = null;
        }
      } else if (sup.kind === 'surface' && sup.surfaceId === cur.surfaceId) {
        cur.walkedBl = Math.max(cur.walkedBl, Math.abs(out.x - cur.x0) / bl);
      }
    } else if (sup.kind === 'surface' && (sup.surfaceKind === 'windowTop' || sup.surfaceKind === 'tabStrip')) {
      cur = { at: h.now - t0, kind: sup.surfaceKind, stayMs: 0, walkedBl: 0, surfaceId: sup.surfaceId, x0: out.x, via, approachMs: h.now - t0 - viaSince };
    }
    if (ticks % 25 === 0) maxUrge = Math.max(maxUrge, h.sim.surfaceDiagnostics().decision.exploreUrge);
  }
  if (cur) excursions.push({ at: cur.at, kind: cur.kind, stayMs: h.now - t0 - cur.at, walkedBl: cur.walkedBl, via: cur.via, approachMs: cur.approachMs });
  const diag = h.sim.surfaceDiagnostics().decision;
  maxUrge = Math.max(maxUrge, diag.exploreUrge);
  return { excursions, firstAt: excursions[0]?.at ?? null, maxUrge, wallTicks, upTicks, ticks, simMs: h.now - t0, diagExcursions: diag.excursions, surfaceShare: upTicksMs / (h.now - t0), upByState };
}
