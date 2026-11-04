// v1.2 short-form band cells (ADR 0003 §14) for the behaviour package's unit tests: the real Sim
// and Mover through the Harness on the user's screen with provider-shaped surfaces, a seeded
// synthetic user (its own generator, so the sim's stream is untouched), and the SimHooks records.
// SIMULATED: synthetic input, OS mocked. The full matrix is INT's (tests/profile, tests/integration).
import type { BehaviorProfileSnapshot, DecisionRecord, ExcursionRecord, FallRecord, HuntRecord, ReactionRecord } from '../../../../src/shared/behaviorProfile';
import type { Drives, Stats, Traits } from '../../../../src/shared/catState';
import type { Settings } from '../../../../src/shared/settings';
import type { SimEvent } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import { Harness } from './fixtures';
import { TYPICAL_FRAME, TYPICAL_STRIP, USER_SCREEN, USER_TRAITS } from './liveness';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
const WALL = 1_800_000_000_000;

/** REAL handling rate of the user's 1.1.1 cat (diagnosis §1): pets, drags and throws per awake hour. */
export const REAL_RATE = { petsPerHour: 46, dragsPerHour: 19, throwsPerHour: 8.3 };

export type Layout = 'L1' | 'L2';
export type User = 'active' | 'typing' | 'play' | 'mouseWork';

export interface CellOptions {
  seed: number;
  hours: number;
  layout?: Layout;
  user?: User;
  /** Handling at the REAL rate (pets, drags, throws). */
  handling?: boolean;
  settings?: Settings;
  /** P1: the user's cat; P2 (default): a fresh cat with default settings. */
  profile?: 'P1' | 'P2';
  traits?: Partial<Traits>;
  stats?: Partial<Stats>;
  /** The drives at the start (a social need that has already saturated, say). */
  drives?: Partial<Drives>;
  /** Host tick, ms (default 50). */
  dt?: number;
}

export interface CellResult {
  profile: BehaviorProfileSnapshot;
  decisions: DecisionRecord[];
  hunts: HuntRecord[];
  reactions: ReactionRecord[];
  excursions: ExcursionRecord[];
  falls: FallRecord[];
  /** Sim times at which raw typing ended (the 3 s hold follows each). */
  typingEnds: number[];
  /** Sim intervals [start, end) with raw typing on. */
  typing: Array<[number, number]>;
  /** Mouse-button press times. */
  presses: number[];
  harness: Harness;
  simMs: number;
}

const BROWSER: WindowInfo = { id: 'b', rect: TYPICAL_FRAME, processName: 'msedge.exe', category: 'browser', minimized: false, maximized: false, fullscreen: false, excluded: false };
const EDITOR: WindowInfo = { id: 'e', rect: TYPICAL_FRAME, processName: 'code.exe', category: 'code', minimized: false, maximized: false, fullscreen: false, excluded: false };

/** Runs one cell; `each` may watch every tick. */
export function runCell(o: CellOptions, each?: (h: Harness) => void): CellResult {
  const decisions: DecisionRecord[] = [];
  const hunts: HuntRecord[] = [];
  const reactions: ReactionRecord[] = [];
  const excursions: ExcursionRecord[] = [];
  const falls: FallRecord[] = [];
  const cat = newPersistedCat(mulberry32(o.seed), WALL - HOUR);
  if (o.profile === 'P1') Object.assign(cat.traits, USER_TRAITS);
  Object.assign(cat.traits, o.traits ?? {});
  Object.assign(cat.stats, o.stats ?? {});
  Object.assign(cat.drives, o.drives ?? {});
  const h = new Harness({
    seed: o.seed,
    world: USER_SCREEN,
    persisted: cat,
    ...(o.settings ? { settings: o.settings } : {}),
    wall: WALL,
    hooks: { onDecision: (r) => decisions.push(r), onHunt: (r) => hunts.push(r), onReaction: (r) => reactions.push(r), onExcursion: (r) => excursions.push(r), onFall: (r) => falls.push(r) },
  });
  const layout = o.layout ?? 'L1';
  const fg = layout === 'L1' ? BROWSER : EDITOR;
  h.env.windows = { [fg.id]: TYPICAL_FRAME };
  if (layout === 'L1') h.env.tabStrips = { b: TYPICAL_STRIP };
  h.env.foreground = fg;
  const user = o.user ?? 'active';
  const ur = mulberry32(o.seed * 7919 + 17);
  const between = (a: number, b: number): number => a + (b - a) * ur();
  const expo = (ratePerHour: number): number => (-Math.log(Math.max(1e-9, ur())) * HOUR) / Math.max(1e-9, ratePerHour);
  const dt = o.dt ?? 50;
  const bw = 84 * 1.25;
  const W = 1920;
  const floorY = h.floorY();
  // Cursor state.
  let cx = 900;
  let cy = 600;
  let tx = cx;
  let ty = cy;
  let speed = 0;
  let pauseUntil = 0;
  // Typing.
  let typingOn = false;
  let typingSwitchAt = 0;
  const typing: Array<[number, number]> = [];
  const typingEnds: number[] = [];
  let typingStart = 0;
  // Play episodes (U-play) and presses (U-mouse-work).
  let playUntil = -1;
  let nextPlayAt = between(10_000, 60_000);
  let presses = 0;
  const pressTimes: number[] = [];
  let nextPressAt = between(2000, 10_000);
  let nextRevealAt = between(60_000, 180_000);
  // Handling.
  let nextPetAt = o.handling ? expo(8) : Infinity;
  let petUntil = -1;
  let nextDragAt = o.handling ? expo(REAL_RATE.dragsPerHour) : Infinity;
  let drag: { until: number; throwIt: boolean; vx: number } | null = null;
  const start = h.now;
  const end = h.now + o.hours * HOUR;
  h.run(5000, dt);
  while (h.now < end) {
    const t = h.now - start;
    const ev: SimEvent[] = [];
    const last = h.last!;
    // ---- typing (U-typing: ~60 % of the time in blocks) ----
    if (user === 'typing' && t >= typingSwitchAt) {
      typingOn = !typingOn;
      typingSwitchAt = t + (typingOn ? between(45_000, 180_000) : between(20_000, 90_000));
      if (typingOn) {
        typingStart = h.now;
        ev.push({ type: 'activity.typingStart' });
      } else {
        typing.push([typingStart, h.now]);
        typingEnds.push(h.now);
        ev.push({ type: 'activity.typingEnd', durationMs: h.now - typingStart });
      }
    }
    h.env.typing = typingOn;
    h.env.typingIntensity = typingOn ? 0.8 : 0.05;
    // ---- the cursor ----
    const playing = user === 'play' && h.now < playUntil;
    if (user === 'play' && h.now >= nextPlayAt && !playing) {
      playUntil = h.now + between(20_000, 60_000);
      nextPlayAt = playUntil + between(60_000, 200_000);
    }
    if (typingOn) {
      speed = 0;
    } else if (playing) {
      // Lingering within 6 bw of the cat, erratic.
      if (Math.hypot(tx - cx, ty - cy) < 10 || ur() < 0.02) {
        tx = last.x + between(-5, 5) * bw;
        ty = floorY - between(0.1, 1.5) * 80;
      }
      speed = between(300, 900);
    } else if (h.now >= pauseUntil && Math.hypot(tx - cx, ty - cy) < 10) {
      pauseUntil = h.now + between(500, 5000);
      const nearCat = ur() < 0.25;
      tx = nearCat ? last.x + between(-4, 4) * bw : between(50, W - 50);
      ty = nearCat ? floorY - between(0, 2) * 80 : between(80, 1150);
      speed = between(300, 900);
    }
    if (h.now >= pauseUntil && speed > 0) {
      const d = Math.hypot(tx - cx, ty - cy);
      const stepPx = (speed * dt) / 1000;
      if (d <= stepPx) {
        cx = tx;
        cy = ty;
      } else {
        cx += ((tx - cx) / d) * stepPx;
        cy += ((ty - cy) / d) * stepPx;
      }
    }
    const moving = h.now >= pauseUntil && speed > 0 && !typingOn;
    // ---- U-mouse-work: presses every 2-10 s, taskbar reveals every 1-3 min ----
    if (user === 'mouseWork') {
      if (h.now >= nextPressAt) {
        presses++;
        pressTimes.push(h.now);
        nextPressAt = h.now + between(2000, 10_000);
      }
      if (h.now >= nextRevealAt) {
        cy = 1199;
        nextRevealAt = h.now + between(60_000, 180_000);
      }
      h.env.pointerButtonPresses = presses;
    }
    // ---- handling ----
    if (h.now >= nextPetAt && !drag) {
      petUntil = h.now + between(4000, 8000);
      nextPetAt = h.now + expo(8);
    }
    if (h.now < petUntil && !drag) {
      cx = last.x;
      cy = last.y - 30;
      // Gentle stroking: two strokes a second.
      if (Math.floor(h.now / 500) !== Math.floor((h.now - dt) / 500)) ev.push({ type: 'pointer.pet', at: { x: last.x, y: last.y - 30 }, strength: 0.8 });
      h.env.cursorOverCat = true;
    } else h.env.cursorOverCat = false;
    if (!drag && h.now >= nextDragAt && h.now >= petUntil && last.support.kind !== 'air' && last.support.kind !== 'held') {
      const throwIt = ur() < REAL_RATE.throwsPerHour / REAL_RATE.dragsPerHour;
      drag = { until: h.now + between(800, 2000), throwIt, vx: (ur() < 0.5 ? -1 : 1) * between(1500, 3200) };
      nextDragAt = h.now + expo(REAL_RATE.dragsPerHour);
      ev.push({ type: 'pointer.dragStart', at: { x: last.x, y: last.y - 30 } });
      h.env.dragCursor = { x: last.x, y: last.y - 200 };
    } else if (drag) {
      if (h.now >= drag.until) {
        ev.push({ type: 'pointer.dragEnd', at: h.env.dragCursor ?? { x: cx, y: cy }, velocity: drag.throwIt ? { x: drag.vx, y: -800 } : { x: 0, y: 0 } });
        h.env.dragCursor = null;
        drag = null;
      } else if (h.env.dragCursor) {
        h.env.dragCursor = { x: Math.min(W - 60, Math.max(60, h.env.dragCursor.x + (drag.vx > 0 ? 1 : -1) * 2)), y: Math.max(250, h.env.dragCursor.y - 1) };
      }
    }
    h.env.cursor = drag ? (h.env.dragCursor ? { ...h.env.dragCursor, speed: 300 } : null) : { x: cx, y: cy, speed: moving ? speed : 0 };
    h.env.userIdleMs = (h.now % 5000) + 0;
    h.step(ev, dt);
    each?.(h);
  }
  if (typingOn) typing.push([typingStart, h.now]);
  return { profile: h.sim.behaviorProfile(), decisions, hunts, reactions, excursions, falls, typingEnds, typing, presses: pressTimes, harness: h, simMs: h.now - start };
}

/** Active share of awake time and asleep share of present time from a profile. */
export function shares(p: BehaviorProfileSnapshot): { active: number; asleep: number } {
  const t = p.timeMs;
  const present = t.asleep + t.calm + t.active + t.interaction + t.reaction + t.physical;
  return { active: p.activeShare, asleep: present > 0 ? t.asleep / present : 0 };
}
