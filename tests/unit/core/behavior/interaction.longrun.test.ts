// Interaction reliability over a long run (docs/gizeverse/13-interaction-reliability.md, synthesis §3.D):
// 24 simulated hours of the real sim with taps, double taps, strokes, drags, slow drags, throws, lost
// releases, mid-air catches and presses while held injected in every state the cat reaches (asleep,
// hunting, climbing a window side, on a window top, on a screen edge, held, in the air, on the floor),
// under lock/unlock, suspend/resume, hide/show, pause, fullscreen, a maximized window in front, window
// layout changes and dragging switched off and on.
//
// Invariants: every grab outside a designed guard state (hidden/fullscreen-hidden, dragging off) yields
// `held` on the same tick; every release yields one fall with the right cause (thrown/dropped); a lost
// release is dropped by the sim within DRAG_LOST_MS; presses while held or airborne are ignored; the
// counters and the profile match the oracle; the mode returns to normal after every lock/unlock and
// suspend/resume; the cat is never held without a hand, airborne for longer than a flight can last, or
// ignoring grabs for longer than the gap between two probes.
//
// SIMULATED: the real sim and Mover (createInstrumentedCatSim through the Harness) with an injected
// environment, injected clock and seeded randomness. The overlay, gesture recogniser and host are not
// in this loop (tests/unit/main/*longrun* cover them); nothing here is a claim about the real desktop.
import { describe, expect, it } from 'vitest';
import type { FallRecord } from '../../../../src/shared/behaviorProfile';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { Counters } from '../../../../src/shared/catState';
import type { Point, Rect } from '../../../../src/shared/geometry';
import type { Settings } from '../../../../src/shared/settings';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import type { ScreenEdgeBand, Surface } from '../../../../src/shared/surfaces';
import type { WindowInfo } from '../../../../src/shared/world';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import type { Random } from '../../../../src/core/behavior/random';
import { DRAG_LOST_MS, MAX_SIM_DT_MS } from '../../../../src/core/behavior/simCore';
import { ASLEEP_STATES, PHYSICAL_STATES } from '../../../../src/core/behavior/states';
import { MOVEMENT } from '../../../../src/core/movement';
import { Harness, settingsWith, SINGLE, surfacesFromWindows } from './fixtures';

const MIN = 60_000;
const HOUR = 60 * MIN;
const WALL = 1_800_000_000_000;
const BW = 84;
/** The sim's ordinary tick outside gestures: its longest step (the host sub-steps at the same 250 ms). */
const BASE_DT = MAX_SIM_DT_MS;
/** Ticks while a hand is on the cat: the 30 fps the sim asks for in physical states. */
const HAND_DT = 33;
/** Longest flight the mover allows (mover.ts MAX_FLIGHT_MS) plus the landing and a margin. */
const MAX_AIR_MS = 6000 + 1000;
/** A grab or a release injected with no hand: the sim's own lost-drag release, plus a tick. */
const HELD_WITHOUT_HAND_MS = DRAG_LOST_MS + 500;
/** No two grab attempts are further apart than this (so "never ignores grabs for longer" is measured, not vacuous). */
const PROBE_EVERY_MS = 5 * MIN;

/** Where the cat is when a press reaches it; 'hidden' is the designed guard state (hidden, or a fullscreen app in front). */
const SITUATIONS = ['floor', 'asleep', 'hunting', 'windowTop', 'climbing', 'screenEdge', 'held', 'airborne', 'hidden'] as const;
type Situation = (typeof SITUATIONS)[number];
const REACHABLE: readonly Situation[] = ['floor', 'asleep', 'hunting', 'windowTop', 'climbing', 'screenEdge', 'held', 'airborne'];
const BASE_SITUATIONS: readonly Situation[] = ['floor', 'asleep', 'hunting', 'windowTop', 'climbing', 'screenEdge'];
const GESTURES = ['tap', 'doubleTap', 'pet', 'drop', 'slowDrag', 'throw', 'lostRelease', 'catchMidAir', 'heldExtras'] as const;
type Gesture = (typeof GESTURES)[number];
type PointerKind = 'tap' | 'doubleTap' | 'pet' | 'dragStart' | 'dragEnd' | 'hoverStart';
type Mode = 'normal' | 'paused' | 'quiet' | 'locked' | 'away' | 'quit';
type Perturbation = 'lock' | 'suspend' | 'lockSuspend' | 'suspendSameTick' | 'hide' | 'pause' | 'fullscreen' | 'maximized' | 'layout' | 'dragOff' | 'display';
const PERTURBATIONS: readonly Perturbation[] = ['lock', 'suspend', 'lockSuspend', 'suspendSameTick', 'hide', 'pause', 'fullscreen', 'maximized', 'layout', 'dragOff', 'display'];

const CLEAR_BANDS: ScreenEdgeBand[] = [
  { displayId: '1', side: 'left', clearSpans: [{ y0: 0, y1: 1080 }] },
  { displayId: '1', side: 'right', clearSpans: [{ y0: 0, y1: 1080 }] },
];
const COVERED_BANDS: ScreenEdgeBand[] = [
  { displayId: '1', side: 'left', clearSpans: [] },
  { displayId: '1', side: 'right', clearSpans: [] },
];
/** Plain app windows, front first (none touches a screen edge, so the edge bands stay clear without a maximized one). */
const LAYOUTS: ReadonlyArray<Record<string, Rect>> = [
  { a: { x: 240, y: 430, width: 620, height: 520 }, b: { x: 1060, y: 300, width: 600, height: 560 } },
  { c: { x: 520, y: 260, width: 420, height: 300 }, a: { x: 120, y: 560, width: 700, height: 400 }, b: { x: 980, y: 200, width: 760, height: 700 } },
  { d: { x: 700, y: 380, width: 640, height: 560 } },
  {},
];
const MAXIMIZED: Rect = { x: -8, y: -8, width: 1936, height: 1056 };
const winInfo = (id: string, rect: Rect, maximized: boolean): WindowInfo => ({ id, rect, processName: 'app.exe', category: 'code', minimized: false, maximized, fullscreen: false, excluded: false });

interface PendingFall {
  cause: 'thrown' | 'dropped';
  /** falls.length when the release was delivered: the next record is this release's. */
  idx: number;
  at: number;
  deadline: number;
  why: string;
}

interface Cell {
  attempts: number;
  accepted: number;
  /** Refused by design: the cat hidden (or behind a fullscreen app), or the setting for this press off. */
  guarded: number;
}

interface DayReport {
  simHours: number;
  ticks: number;
  gestures: number;
  byGesture: Record<string, number>;
  /** Pointer events injected, by the cat's situation when the sim handled them and the event kind. */
  bySituation: Record<Situation, Partial<Record<PointerKind, Cell>>>;
  /** Gestures started, by situation and gesture. */
  gestureCoverage: Record<Situation, Partial<Record<Gesture, number>>>;
  byMode: Record<string, number>;
  perturbations: Record<string, number>;
  recoveries: number;
  falls: { thrown: number; dropped: number; recaught: number };
  grabsIgnoredByDesign: number;
  longestGrabAttemptGapMs: number;
  longestHeldWithoutHandMs: number;
  longestAirborneMs: number;
  counters: { expected: Partial<Record<keyof Counters, number>>; actual: Partial<Record<keyof Counters, number>>; pets: { min: number; max: number; actual: number } };
  profileFalls: { thrown: number; dropped: number };
  violations: string[];
}

function catWith(seed: number) {
  return newPersistedCat(mulberry32(seed), WALL - HOUR);
}

/**
 * One continuous simulated day. The cursor follows a play / work / away rhythm (hunts, a busy hand, an
 * empty desk where the cat sleeps), the local hour runs from 08:00 round the clock, perturbations come
 * every 6-25 sim-minutes, and gestures come every ~75 s on average, sooner while a situation still lacks
 * a gesture kind (so rare situations such as a screen-edge climb get every kind).
 */
function simulateDay(seed: number, hours: number): DayReport {
  const r: Random = mulberry32(seed);
  const rnd = (a: number, b: number): number => a + r() * (b - a);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const falls: FallRecord[] = [];
  const baseSettings: Settings = settingsWith({ behavior: { cursorPlay: 0.8, attentionSeeking: 0.6, disabledExtras: [] } });
  let settings: Settings = baseSettings;
  const h = new Harness({ seed: seed + 100, persisted: catWith(seed), settings, hooks: { onFall: (f) => falls.push(f) } });
  h.step([], 0);
  const start = h.now;
  const scale = SINGLE.displays[0]!.scaleFactor;
  const violations: string[] = [];
  const fail = (msg: string): void => {
    if (violations.length < 40) violations.push(`[seed ${seed} t=${((h.now - start) / MIN).toFixed(2)}min] ${msg}`);
  };

  // ---- environment ----------------------------------------------------------------
  const flags = { hidden: false, paused: false, locked: false, suspended: false, fullscreen: false, maximized: false, dragOff: false };
  let layout = 0;
  let surfaces: Surface[] = [];
  const applyDesk = (): void => {
    const wins: Record<string, Rect> = flags.maximized ? { max: MAXIMIZED, ...LAYOUTS[layout] } : { ...LAYOUTS[layout] };
    surfaces = surfacesFromWindows(wins, SINGLE, { walls: true, now: h.now, provider: true });
    h.env.surfaces = surfaces;
    h.env.edgeBands = flags.maximized ? COVERED_BANDS : CLEAR_BANDS;
    const front = Object.entries(wins)[0];
    h.env.foreground = front ? winInfo(front[0], front[1], front[0] === 'max') : null;
    h.env.hidden = flags.hidden;
    h.env.paused = flags.paused;
    h.env.fullscreenDisplayIds = flags.fullscreen ? ['1'] : [];
  };
  const expectedMode = (): Mode => {
    if (flags.hidden || flags.fullscreen) return 'away'; // fullscreenBehavior defaults to 'hide'
    if (flags.locked || flags.suspended) return 'locked';
    if (flags.paused) return 'paused';
    return 'normal';
  };
  const simMode = (): Mode => h.sim.debugInfo().mode as Mode;

  let phase: 'play' | 'work' | 'away' = 'play';
  let phaseUntil = 0;
  let workSpot: Point = { x: 960, y: 500 };
  let workSpotUntil = 0;
  let handOnCat = false; // a gesture controls the cursor
  const updateUser = (dt: number): void => {
    h.env.localHour = (8 + (h.now - start) / HOUR) % 24;
    if (handOnCat) return;
    if (h.now >= phaseUntil) {
      phase = pick(['play', 'work', 'work', 'away'] as const);
      phaseUntil = h.now + (phase === 'away' ? rnd(10, 45) : rnd(5, 25)) * MIN;
    }
    const o = h.last!;
    if (phase === 'play') {
      const side = o.x < 960 ? 1 : -1;
      h.env.cursor = { x: o.x + side * 2.5 * BW + 12 * Math.sin(h.now / 300), y: Math.min(o.y, h.floorY()) - 40, speed: 300 };
      h.env.userIdleMs = 0;
      h.env.typing = false;
    } else if (phase === 'work') {
      if (h.now >= workSpotUntil) {
        workSpot = { x: rnd(200, 1720), y: rnd(150, 900) };
        workSpotUntil = h.now + rnd(5, 40) * 1000;
      }
      h.env.cursor = { x: workSpot.x, y: workSpot.y, speed: h.now % 4000 < 1000 ? 500 : 0 };
      h.env.typing = h.now % 20_000 < 9000;
      h.env.userIdleMs = (h.env.userIdleMs ?? 0) > 4000 ? 0 : (h.env.userIdleMs ?? 0) + dt;
    } else {
      h.env.typing = false;
      h.env.cursor = { x: workSpot.x, y: workSpot.y, speed: 0 };
      h.env.userIdleMs = (h.env.userIdleMs ?? 0) + dt;
    }
    h.env.cursorOverCat = false;
    h.env.dragCursor = null;
    h.env.pointerButtonDown = false;
  };

  // ---- ticking and the global invariants ----------------------------------------
  let ticks = 0;
  let holding = false; // a hand holds the cat (the host would report dragCursor)
  let heldWithoutHandSince: number | null = null;
  let airborneSince: number | null = null;
  let longestHeldWithoutHandMs = 0;
  let longestAirborneMs = 0;
  const pending: PendingFall[] = [];
  const resolved = { thrown: 0, dropped: 0, recaught: 0 };

  const tick = (events: SimEvent[] = [], dt = BASE_DT): SimOutput => {
    updateUser(dt);
    const out = h.step(events, dt);
    ticks++;
    const s = h.sim.state;
    if ((s === 'held') !== (out.support.kind === 'held')) fail(`state ${s} disagrees with support ${out.support.kind}`);
    if (s === 'held' && !holding) {
      heldWithoutHandSince ??= h.now;
      const ms = h.now - heldWithoutHandSince;
      longestHeldWithoutHandMs = Math.max(longestHeldWithoutHandMs, ms);
      if (ms > HELD_WITHOUT_HAND_MS) {
        fail(`held without a hand for ${ms} ms`);
        heldWithoutHandSince = h.now;
      }
    } else heldWithoutHandSince = null;
    if (s === 'falling' || s === 'jumping') {
      airborneSince ??= h.now;
      const ms = h.now - airborneSince;
      longestAirborneMs = Math.max(longestAirborneMs, ms);
      if (ms > MAX_AIR_MS) {
        fail(`airborne (${s}) for ${ms} ms`);
        airborneSince = h.now;
      }
    } else airborneSince = null;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!;
      if (falls.length > p.idx) {
        const got = falls[p.idx]!.cause;
        if (got !== p.cause) fail(`${p.why}: fall cause ${got}, expected ${p.cause}`);
        else resolved[p.cause]++;
        pending.splice(i, 1);
      } else if (h.now > p.deadline) {
        fail(`${p.why}: no fall within ${p.deadline - p.at} ms (state ${s}, support ${out.support.kind})`);
        pending.splice(i, 1);
      }
    }
    return out;
  };

  // ---- the oracle ------------------------------------------------------------------
  const bySituation = Object.fromEntries(SITUATIONS.map((s) => [s, {}])) as Record<Situation, Partial<Record<PointerKind, Cell>>>;
  const gestureCoverage = Object.fromEntries(SITUATIONS.map((s) => [s, {}])) as Record<Situation, Partial<Record<Gesture, number>>>;
  const byMode: Record<string, number> = {};
  const expected: Partial<Record<keyof Counters, number>> = { clicks: 0, doubleClicks: 0, drags: 0, throws: 0 };
  const pets = { min: 0, max: 0 };
  let grabsIgnoredByDesign = 0;
  let lastGrabAttemptAt = start;
  let longestGrabAttemptGapMs = 0;

  const situation = (): Situation => {
    const s = h.sim.state;
    const sup = h.last!.support;
    if (s === 'away') return 'hidden';
    if (s === 'held') return 'held';
    if (s === 'falling' || s === 'jumping' || sup.kind === 'air') return 'airborne';
    if (sup.kind === 'surface' && sup.surfaceKind === 'screenEdge') return 'screenEdge';
    if (sup.kind === 'surface' && sup.orientation === 'wall') return 'climbing';
    if (sup.kind === 'surface' && (sup.surfaceKind === 'windowTop' || sup.surfaceKind === 'tabStrip')) return 'windowTop';
    if (ASLEEP_STATES.has(s)) return 'asleep';
    if (s === 'chasingCursor') return 'hunting';
    return 'floor';
  };
  const counters = (): Counters => h.sim.serialize().memory.counters;
  const catPoint = (): Point => ({ x: h.last!.x, y: h.last!.y - 30 });

  /** Delivers one pointer event on its own tick and checks the sim's answer against the oracle. */
  const inject = (kind: PointerKind, ev: SimEvent): { accepted: boolean; before: BehaviorState; sit: Situation } => {
    const before = h.sim.state;
    const sit = situation();
    const mode = simMode();
    const ignoredMode = mode === 'away' || mode === 'quit';
    const i = settings.interaction;
    let accepted: boolean;
    switch (kind) {
      case 'tap':
      case 'doubleTap':
        accepted = !ignoredMode && i.enabled && !PHYSICAL_STATES.has(before);
        break;
      case 'pet':
        accepted = !ignoredMode && i.enabled && i.petting && !PHYSICAL_STATES.has(before);
        break;
      case 'dragStart':
        accepted = !ignoredMode && i.enabled && i.dragging && before !== 'held';
        break;
      case 'dragEnd':
        accepted = !ignoredMode && before === 'held';
        break;
      case 'hoverStart':
        accepted = true;
        break;
    }
    if (kind === 'dragStart') {
      longestGrabAttemptGapMs = Math.max(longestGrabAttemptGapMs, h.now - lastGrabAttemptAt);
      lastGrabAttemptAt = h.now;
      if (!accepted && before !== 'held') grabsIgnoredByDesign++;
    }
    const cell = (bySituation[sit][kind] ??= { attempts: 0, accepted: 0, guarded: 0 });
    cell.attempts++;
    if (ignoredMode || !i.enabled || (kind === 'dragStart' && !i.dragging) || (kind === 'pet' && !i.petting)) cell.guarded++;
    byMode[mode] = (byMode[mode] ?? 0) + 1;
    tick([ev], HAND_DT);
    if (accepted) cell.accepted++;
    if (kind === 'dragStart') {
      if (accepted && h.sim.state !== 'held') fail(`grab ignored: ${sit}, state ${before}, mode ${mode} -> ${h.sim.state}`);
      if (!accepted && before !== 'held' && h.sim.state === 'held') fail(`grab taken in a guard state: mode ${mode}, dragging ${i.dragging}`);
      if (accepted) {
        expected.drags!++;
        // Caught again in mid-air: the earlier release's flight ends in the hand, not on the ground.
        for (let k = pending.length - 1; k >= 0; k--) {
          if (falls.length <= pending[k]!.idx) {
            pending.splice(k, 1);
            resolved.recaught++;
          }
        }
      }
    }
    if (kind === 'dragEnd' && accepted && h.sim.state === 'held') fail(`release ignored: still held (mode ${mode})`);
    if (kind === 'tap' && accepted) expected.clicks!++;
    if (kind === 'doubleTap' && accepted) expected.doubleClicks!++;
    return { accepted, before, sit };
  };

  // ---- gestures --------------------------------------------------------------------
  const clampPt = (p: Point): Point => ({ x: Math.min(1880, Math.max(40, p.x)), y: Math.min(1030, Math.max(40, p.y)) });
  let dragAt: Point = { x: 0, y: 0 };
  const grab = (): boolean => {
    dragAt = catPoint();
    handOnCat = true;
    h.env.userIdleMs = 0;
    h.env.cursor = { ...dragAt, speed: 0 };
    h.env.cursorOverCat = true;
    h.env.pointerButtonDown = true;
    h.env.dragCursor = dragAt;
    const { accepted } = inject('dragStart', { type: 'pointer.dragStart', at: dragAt });
    holding = accepted;
    if (!accepted) h.env.dragCursor = null;
    return accepted;
  };
  /** Moves the hand along `step` (px per tick) for `ms`, as the host reports the cursor while dragging. */
  const hold = (ms: number, step: Point): void => {
    const until = h.now + ms;
    while (h.now < until) {
      dragAt = clampPt({ x: dragAt.x + step.x, y: dragAt.y + step.y });
      h.env.dragCursor = holding ? dragAt : null;
      h.env.cursor = { ...dragAt, speed: (Math.hypot(step.x, step.y) * 1000) / HAND_DT };
      tick([], HAND_DT);
    }
  };
  const releaseCause = (v: Point): 'thrown' | 'dropped' => (settings.interaction.throwing && Math.hypot(v.x, v.y) > MOVEMENT.hardThrowDip * scale ? 'thrown' : 'dropped');
  const release = (v: Point, why: string): void => {
    h.env.dragCursor = null;
    h.env.pointerButtonDown = false;
    const idx = falls.length;
    const { accepted } = inject('dragEnd', { type: 'pointer.dragEnd', at: dragAt, velocity: v });
    holding = false;
    if (accepted) {
      const cause = releaseCause(v);
      if (cause === 'thrown') expected.throws!++;
      pending.push({ cause, idx, at: h.now, deadline: h.now + MAX_AIR_MS, why });
    }
  };
  const settle = (maxMs = MAX_AIR_MS + 500): void => {
    const until = h.now + maxMs;
    while (pending.length > 0 && h.now < until) tick([], HAND_DT);
  };
  const handOff = (): void => {
    handOnCat = false;
    h.env.cursorOverCat = false;
  };
  const slowVelocity = (): Point => {
    const a = rnd(0, 2 * Math.PI);
    const m = rnd(0, 500);
    return { x: Math.cos(a) * m, y: Math.sin(a) * m };
  };
  const throwVelocity = (): Point => ({ x: (r() < 0.5 ? -1 : 1) * rnd(1800, 3400), y: -rnd(200, 1500) });
  const toward = (): number => (dragAt.x < 960 ? 1 : -1);

  const runGesture = (g: Gesture): void => {
    const sit = situation();
    const mode = simMode();
    if (mode !== expectedMode()) fail(`mode ${mode} before ${g}, expected ${expectedMode()} (${JSON.stringify(flags)})`);
    gestureCoverage[sit][g] = (gestureCoverage[sit][g] ?? 0) + 1;
    const c0 = counters();
    const before = { ...expected };
    let strokes = 0;
    switch (g) {
      case 'tap':
      case 'doubleTap': {
        handOnCat = true;
        h.env.userIdleMs = 0;
        const at = catPoint();
        h.env.cursor = { ...at, speed: 0 };
        h.env.cursorOverCat = true;
        inject('hoverStart', { type: 'pointer.hoverStart', at });
        inject(g, g === 'tap' ? { type: 'pointer.tap', at } : { type: 'pointer.doubleTap', at });
        break;
      }
      case 'pet': {
        handOnCat = true;
        h.env.userIdleMs = 0;
        const n = Math.round(rnd(6, 24));
        for (let k = 0; k < n; k++) {
          const at = { x: catPoint().x + 20 * Math.sin(k), y: catPoint().y };
          h.env.cursor = { ...at, speed: 250 };
          h.env.cursorOverCat = true;
          if (inject('pet', { type: 'pointer.pet', at, strength: rnd(0.3, 1) }).accepted) strokes++;
          tick([], HAND_DT);
        }
        break;
      }
      case 'drop':
        if (grab()) {
          hold(rnd(120, 380), { x: rnd(-4, 4), y: -rnd(2, 10) });
          release(slowVelocity(), 'drop');
        }
        break;
      case 'slowDrag':
        // Longer than the overlay's old 400 ms lost-press window (H1): the sim must not care how long a hand holds.
        if (grab()) {
          hold(rnd(450, 3000), { x: toward() * rnd(0, 3), y: -rnd(0, 3) });
          release(slowVelocity(), 'slow drag');
        }
        break;
      case 'throw':
        if (grab()) {
          hold(rnd(100, 1200), { x: toward() * rnd(25, 60), y: -rnd(5, 25) });
          release(throwVelocity(), 'throw');
        }
        break;
      case 'lostRelease':
        // The host stops reporting the drag (the press ended without an up): the sim drops the cat by itself.
        if (grab()) {
          hold(rnd(200, 900), { x: rnd(-3, 3), y: -rnd(0, 6) });
          holding = false;
          h.env.dragCursor = null;
          h.env.pointerButtonDown = false;
          pending.push({ cause: 'dropped', idx: falls.length, at: h.now, deadline: h.now + DRAG_LOST_MS + MAX_AIR_MS, why: 'lost release' });
          settle(DRAG_LOST_MS + MAX_AIR_MS + 500);
          // The up that finally arrives finds no held cat: ignored, no second fall.
          inject('dragEnd', { type: 'pointer.dragEnd', at: dragAt, velocity: throwVelocity() });
        }
        break;
      case 'catchMidAir':
        if (grab()) {
          hold(rnd(250, 450), { x: 0, y: -rnd(25, 40) });
          release({ x: 0, y: 0 }, 'drop before a catch');
          for (let k = Math.round(rnd(1, 4)); k > 0; k--) tick([], HAND_DT);
          // A press on a falling cat is no click; a grab is a catch.
          inject('tap', { type: 'pointer.tap', at: catPoint() });
          if (grab()) {
            hold(rnd(100, 600), { x: toward() * rnd(0, 30), y: -rnd(0, 10) });
            release(r() < 0.5 ? throwVelocity() : slowVelocity(), 'release after a catch');
          }
        }
        break;
      case 'heldExtras':
        if (grab()) {
          hold(rnd(60, 200), { x: 0, y: -4 });
          // Presses while held change nothing: no click, no stroke, no second grab, still held.
          inject('tap', { type: 'pointer.tap', at: dragAt });
          inject('pet', { type: 'pointer.pet', at: dragAt, strength: 0.8 });
          inject('doubleTap', { type: 'pointer.doubleTap', at: dragAt });
          inject('dragStart', { type: 'pointer.dragStart', at: dragAt });
          inject('hoverStart', { type: 'pointer.hoverStart', at: dragAt });
          if (h.sim.state !== 'held') fail(`presses while held let go of the cat (${h.sim.state})`);
          hold(rnd(60, 400), { x: toward() * rnd(0, 40), y: -rnd(0, 10) });
          release(r() < 0.5 ? throwVelocity() : slowVelocity(), 'release after presses while held');
        }
        break;
    }
    settle();
    if (holding) fail(`gesture ${g} ended with the hand still on the cat`);
    holding = false;
    handOff();
    const c1 = counters();
    for (const k of ['clicks', 'doubleClicks', 'drags', 'throws'] as const) {
      const want = expected[k]! - before[k]!;
      const got = c1[k] - c0[k];
      if (got !== want) fail(`${g} in ${sit}: counter ${k} +${got}, expected +${want}`);
    }
    // One stroke gesture gives many pet events; the counter counts at most one per second, and the overstimulation
    // swat can swallow one stroke of a bout.
    const petGot = c1.pets - c0.pets;
    pets.max += strokes;
    if (strokes >= 2 && petGot < 1) fail(`pet in ${sit}: ${strokes} strokes taken, pets +0`);
    if (petGot > strokes) fail(`pet in ${sit}: pets +${petGot} from ${strokes} strokes`);
    if (strokes >= 2) pets.min += 1;
  };

  // ---- perturbations ---------------------------------------------------------------
  const perturbations: Record<string, number> = {};
  let recoveries = 0;
  let active: { kind: Perturbation; until: number; stage: number } | null = null;
  let nextPerturbationAt = start + rnd(4, 12) * MIN;
  const systemEvent = (type: 'system.lock' | 'system.unlock' | 'system.suspend' | 'system.resume'): void => {
    if (type === 'system.lock') flags.locked = true;
    if (type === 'system.unlock') flags.locked = false;
    if (type === 'system.suspend') flags.suspended = true;
    if (type === 'system.resume') flags.suspended = false;
    tick([{ type }]);
  };
  /** After a perturbation ends: the mode is the expected one at once, and a probe grab works. */
  const recovered = (what: string): void => {
    recoveries++;
    const want = expectedMode();
    tick();
    const got = simMode();
    if (got !== want) fail(`after ${what}: mode ${got}, expected ${want}`);
    if (want === 'normal' && h.sim.state === 'away') fail(`after ${what}: still away`);
    runGesture(pick(['drop', 'throw', 'slowDrag'] as const));
  };
  const startPerturbation = (): void => {
    const kind = pick(PERTURBATIONS);
    perturbations[kind] = (perturbations[kind] ?? 0) + 1;
    switch (kind) {
      case 'lock':
        systemEvent('system.lock');
        active = { kind, until: h.now + rnd(2, 40) * MIN, stage: 0 };
        break;
      case 'suspend':
        systemEvent('system.suspend');
        active = { kind, until: h.now + rnd(2, 10) * 1000, stage: 0 };
        break;
      case 'lockSuspend':
        systemEvent('system.lock');
        active = { kind, until: h.now + rnd(1, 5) * MIN, stage: 0 };
        break;
      case 'suspendSameTick':
        flags.suspended = false;
        tick([{ type: 'system.suspend' }, { type: 'system.resume' }]);
        recovered('suspend and resume in one tick');
        break;
      case 'hide':
        flags.hidden = true;
        applyDesk();
        tick();
        active = { kind, until: h.now + rnd(2, 20) * MIN, stage: 0 };
        break;
      case 'pause':
        flags.paused = true;
        applyDesk();
        tick();
        active = { kind, until: h.now + rnd(2, 20) * MIN, stage: 0 };
        break;
      case 'fullscreen':
        flags.fullscreen = true;
        applyDesk();
        tick();
        active = { kind, until: h.now + rnd(2, 15) * MIN, stage: 0 };
        break;
      case 'maximized':
        flags.maximized = !flags.maximized;
        applyDesk();
        tick();
        break;
      case 'layout':
        layout = (layout + 1 + Math.floor(r() * (LAYOUTS.length - 1))) % LAYOUTS.length;
        applyDesk();
        tick();
        break;
      case 'dragOff':
        settings = settingsWith({ behavior: { cursorPlay: 0.8, attentionSeeking: 0.6, disabledExtras: [] }, interaction: { dragging: false } });
        h.sim.updateSettings(settings);
        tick();
        active = { kind, until: h.now + rnd(2, 10) * MIN, stage: 0 };
        break;
      case 'display':
        h.setWorld(SINGLE);
        tick([{ type: 'display.changed' }]);
        break;
    }
  };
  const stepPerturbation = (): void => {
    const a = active;
    if (!a || h.now < a.until) return;
    switch (a.kind) {
      case 'lock':
        systemEvent('system.unlock');
        active = null;
        recovered('lock/unlock');
        return;
      case 'suspend':
        systemEvent('system.resume');
        active = null;
        recovered('suspend/resume');
        return;
      case 'lockSuspend':
        // Windows' order: lock, suspend, resume, then the user unlocks.
        if (a.stage === 0) {
          systemEvent('system.suspend');
          active = { ...a, stage: 1, until: h.now + rnd(2, 10) * 1000 };
        } else if (a.stage === 1) {
          systemEvent('system.resume');
          if (simMode() !== 'locked') fail(`resume before unlock: mode ${simMode()}, expected locked (only unlock ends a lock)`);
          active = { ...a, stage: 2, until: h.now + rnd(10, 90) * 1000 };
        } else {
          systemEvent('system.unlock');
          active = null;
          recovered('lock, suspend, resume, unlock');
        }
        return;
      case 'hide':
        flags.hidden = false;
        applyDesk();
        active = null;
        recovered('hide/show');
        return;
      case 'pause':
        flags.paused = false;
        applyDesk();
        active = null;
        recovered('pause/resume');
        return;
      case 'fullscreen':
        flags.fullscreen = false;
        applyDesk();
        active = null;
        recovered('fullscreen off');
        return;
      case 'dragOff':
        settings = baseSettings;
        h.sim.updateSettings(settings);
        active = null;
        recovered('dragging switched back on');
        return;
      default:
        active = null;
    }
  };

  // ---- the day -------------------------------------------------------------------------
  applyDesk();
  tick();
  const c00 = counters();
  const end = start + hours * HOUR;
  let lastGestureAt = start;
  let gestures = 0;
  const byGesture: Record<string, number> = {};
  const TARGET = 2;
  let lastHousekeeping = start;
  while (h.now < end) {
    if (h.now - lastHousekeeping > HOUR) {
      h.transitions.length = 0;
      h.delivered.length = 0;
      lastHousekeeping = h.now;
    }
    if (pending.length === 0) {
      stepPerturbation();
      if (!active && h.now >= nextPerturbationAt) {
        startPerturbation();
        nextPerturbationAt = h.now + rnd(6, 25) * MIN;
      }
    }
    const sinceGesture = h.now - lastGestureAt;
    let g: Gesture | null = null;
    if (sinceGesture >= 2000) {
      const sit = situation();
      const cov = gestureCoverage[sit];
      const missing = BASE_SITUATIONS.includes(sit) ? GESTURES.filter((x) => (cov[x] ?? 0) < TARGET) : [];
      if (missing.length > 0 && (sit !== 'floor' || r() < 0.02)) g = pick(missing);
      else if (h.now - lastGrabAttemptAt >= PROBE_EVERY_MS - 2000) g = pick(['drop', 'throw', 'slowDrag', 'catchMidAir'] as const);
      else if (r() < BASE_DT / 75_000) g = pick(GESTURES);
    }
    if (g) {
      runGesture(g);
      gestures++;
      byGesture[g] = (byGesture[g] ?? 0) + 1;
      lastGestureAt = h.now;
      continue;
    }
    tick();
  }
  settle();
  const c1 = counters();
  const actual: Partial<Record<keyof Counters, number>> = {};
  for (const k of ['clicks', 'doubleClicks', 'drags', 'throws'] as const) actual[k] = c1[k] - c00[k];
  const prof = h.sim.behaviorProfile().falls.byCause;
  return {
    simHours: (h.now - start) / HOUR,
    ticks,
    gestures,
    byGesture,
    bySituation,
    gestureCoverage,
    byMode,
    perturbations,
    recoveries,
    falls: resolved,
    grabsIgnoredByDesign,
    longestGrabAttemptGapMs,
    longestHeldWithoutHandMs,
    longestAirborneMs,
    counters: { expected, actual, pets: { min: pets.min, max: pets.max, actual: c1.pets - c00.pets } },
    profileFalls: { thrown: prof.thrown ?? 0, dropped: prof.dropped ?? 0 },
    violations,
  };
}

const SEED = Number(process.env.DESKTOP_CAT_LONGRUN_SEED ?? '1') || 1;

describe('interaction over 24 simulated hours (real sim, SIMULATED environment)', () => {
  it('every grab, release, tap and stroke lands in every reachable state, and nothing sticks', () => {
    const rep = simulateDay(SEED, 24);
    const summary = JSON.stringify({ ...rep, bySituation: undefined, gestureCoverage: undefined }, null, 0);
    // DESKTOP_CAT_LONGRUN_REPORT=1 prints the whole day report (with --silent=false), e.g. for another seed.
    if (process.env.DESKTOP_CAT_LONGRUN_REPORT === '1') console.log(JSON.stringify(rep, null, 1));
    expect(rep.violations, summary).toEqual([]);
    expect(rep.simHours).toBeGreaterThanOrEqual(24);

    // Coverage: grabs, releases and taps reached the cat in each situation (held and airborne through
    // presses while held and mid-air catches); every base situation got every gesture kind.
    for (const s of REACHABLE) {
      const cells = rep.bySituation[s];
      expect(cells.dragStart?.attempts ?? 0, `grabs in ${s}`).toBeGreaterThanOrEqual(3);
      expect(cells.tap?.attempts ?? 0, `taps in ${s}`).toBeGreaterThanOrEqual(1);
    }
    for (const s of BASE_SITUATIONS) {
      for (const g of GESTURES) expect(rep.gestureCoverage[s][g] ?? 0, `${g} started in ${s}`).toBeGreaterThanOrEqual(1);
    }
    expect(rep.bySituation.held.dragEnd?.accepted ?? 0, 'releases of a held cat').toBeGreaterThanOrEqual(100);
    // Designed: a press on a held or airborne cat is no click (the hand is busy or the cat is mid-flight).
    for (const s of ['held', 'airborne'] as const) {
      expect(rep.bySituation[s].tap?.accepted ?? 0, `taps taken while ${s}`).toBe(0);
      expect(rep.bySituation[s].pet?.accepted ?? 0, `strokes taken while ${s}`).toBe(0);
    }
    // A grab is taken in every situation but held, unless a guard refuses it by design (a grab of an airborne cat is a catch).
    for (const s of REACHABLE.filter((x) => x !== 'held')) {
      const c = rep.bySituation[s].dragStart!;
      expect(c.accepted, `grabs taken in ${s}`).toBe(c.attempts - c.guarded);
    }
    // Designed: a hidden cat (or one behind a fullscreen app) takes no press at all.
    expect(Object.values(rep.bySituation.hidden).reduce((a, c) => a + c.accepted, 0) - (rep.bySituation.hidden.hoverStart?.accepted ?? 0), 'presses taken while hidden').toBe(0);

    // Counters and the behaviour profile agree with the oracle.
    expect(rep.counters.actual).toEqual(rep.counters.expected);
    expect(rep.counters.pets.actual).toBeGreaterThanOrEqual(rep.counters.pets.min);
    expect(rep.counters.pets.actual).toBeLessThanOrEqual(rep.counters.pets.max);
    expect(rep.profileFalls).toEqual({ thrown: rep.falls.thrown, dropped: rep.falls.dropped });
    expect(rep.falls.thrown, 'throws landed').toBeGreaterThanOrEqual(50);
    expect(rep.falls.dropped, 'drops landed').toBeGreaterThanOrEqual(100);
    expect(rep.falls.recaught, 'mid-air catches').toBeGreaterThanOrEqual(10);

    // Lock/unlock, suspend/resume and the rest came and went, and the cat came back every time.
    for (const p of ['lock', 'suspend', 'lockSuspend', 'hide', 'pause', 'dragOff']) expect(rep.perturbations[p] ?? 0, `${p} episodes`).toBeGreaterThanOrEqual(2);
    expect(rep.recoveries).toBeGreaterThanOrEqual(20);
    expect(rep.byMode.locked ?? 0, 'presses while locked').toBeGreaterThan(0);
    expect(rep.byMode.away ?? 0, 'presses while hidden').toBeGreaterThan(0);

    // Bounded: grab attempts at most PROBE_EVERY_MS apart (plus one gesture), never held without a hand
    // past the sim's lost-drag release, never airborne past the longest flight.
    expect(rep.longestGrabAttemptGapMs).toBeLessThanOrEqual(PROBE_EVERY_MS + 30_000);
    expect(rep.longestHeldWithoutHandMs).toBeLessThanOrEqual(HELD_WITHOUT_HAND_MS);
    expect(rep.longestAirborneMs).toBeLessThanOrEqual(MAX_AIR_MS);
  }, 120_000);
});

describe('lock and suspend in every order (real sim)', () => {
  type Sys = 'lock' | 'unlock' | 'suspend' | 'resume';
  const ev = (k: Sys): SimEvent => ({ type: `system.${k}` });
  const grabAndDrop = (h: Harness, falls: FallRecord[]): void => {
    const o = h.last!;
    const at = { x: o.x, y: o.y - 30 };
    h.env.dragCursor = at;
    h.step([{ type: 'pointer.dragStart', at }], HAND_DT);
    expect(h.sim.state, 'grab').toBe('held');
    h.env.dragCursor = { x: at.x, y: at.y - 200 };
    h.run(300, HAND_DT);
    h.env.dragCursor = null;
    const idx = falls.length;
    h.step([{ type: 'pointer.dragEnd', at: { x: at.x, y: at.y - 200 }, velocity: { x: 0, y: 0 } }], HAND_DT);
    expect(h.sim.state).not.toBe('held');
    expect(h.runUntil(() => falls.length > idx, MAX_AIR_MS, HAND_DT), 'landed').toBe(true);
    expect(falls[idx]!.cause).toBe('dropped');
  };

  it.each<[string, Sys[][]]>([
    ['lock, unlock', [['lock'], ['unlock']]],
    ['suspend, resume', [['suspend'], ['resume']]],
    ['lock, suspend, resume, unlock', [['lock'], ['suspend'], ['resume'], ['unlock']]],
    ['suspend, lock, unlock, resume', [['suspend'], ['lock'], ['unlock'], ['resume']]],
    ['lock, suspend, unlock, resume', [['lock'], ['suspend'], ['unlock'], ['resume']]],
    ['lock and unlock in one tick', [['lock', 'unlock']]],
    ['suspend and resume in one tick', [['suspend', 'resume']]],
    ['unlock twice, resume without suspend', [['lock'], ['unlock'], ['unlock'], ['resume']]],
  ])('%s: back to normal, and the next grab and release work', (_name, batches) => {
    const falls: FallRecord[] = [];
    const h = new Harness({ seed: 7, persisted: catWith(7), hooks: { onFall: (f) => falls.push(f) } });
    h.env.cursor = { x: 400, y: 600, speed: 0 };
    h.run(30_000, HAND_DT);
    for (const b of batches) {
      h.step(b.map(ev), HAND_DT);
      h.run(20_000, BASE_DT);
    }
    h.run(10_000, HAND_DT);
    expect(h.sim.debugInfo().mode).toBe('normal');
    grabAndDrop(h, falls);
  });

  it('resume without unlock stays locked (designed: only unlock ends a lock); grabs still work while locked; unlock restores normal', () => {
    const falls: FallRecord[] = [];
    const h = new Harness({ seed: 8, persisted: catWith(8), hooks: { onFall: (f) => falls.push(f) } });
    h.env.cursor = { x: 400, y: 600, speed: 0 };
    h.run(30_000, HAND_DT);
    h.step([ev('lock')], HAND_DT);
    h.step([ev('suspend')], HAND_DT);
    h.run(5000, BASE_DT);
    h.step([ev('resume')], HAND_DT);
    h.run(60_000, BASE_DT);
    expect(h.sim.debugInfo().mode).toBe('locked');
    grabAndDrop(h, falls);
    h.step([ev('unlock')], HAND_DT);
    expect(h.sim.debugInfo().mode).toBe('normal');
    grabAndDrop(h, falls);
  });

  it('a lock while held drops the cat (cause dropped) and the late release is ignored', () => {
    const falls: FallRecord[] = [];
    const h = new Harness({ seed: 9, persisted: catWith(9), hooks: { onFall: (f) => falls.push(f) } });
    h.env.cursor = { x: 400, y: 600, speed: 0 };
    h.run(30_000, HAND_DT);
    const o = h.last!;
    const at = { x: o.x, y: o.y - 300 };
    h.env.dragCursor = { x: o.x, y: o.y - 30 };
    h.step([{ type: 'pointer.dragStart', at: { x: o.x, y: o.y - 30 } }], HAND_DT);
    h.env.dragCursor = at;
    h.run(400, HAND_DT);
    const idx = falls.length;
    const throws0 = h.sim.serialize().memory.counters.throws;
    h.step([ev('lock')], HAND_DT);
    expect(h.sim.state).not.toBe('held');
    h.env.dragCursor = null;
    expect(h.runUntil(() => falls.length > idx, MAX_AIR_MS, HAND_DT)).toBe(true);
    expect(falls[idx]!.cause).toBe('dropped');
    h.step([{ type: 'pointer.dragEnd', at, velocity: { x: 3000, y: -1000 } }], HAND_DT);
    h.run(MAX_AIR_MS, HAND_DT);
    expect(falls.length).toBe(idx + 1);
    expect(h.sim.serialize().memory.counters.throws).toBe(throws0);
    h.step([ev('unlock')], HAND_DT);
    h.run(5000, HAND_DT);
    expect(h.sim.debugInfo().mode).toBe('normal');
    grabAndDrop(h, falls);
  });
});
