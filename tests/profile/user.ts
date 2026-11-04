// The synthetic user of the behaviour profile (ADR 0003 §14 users), seeded, on the virtual clock.
// It moves the cursor, types (last-input time without cursor motion), presses buttons, reveals
// the auto-hide taskbar, pets, drags and throws the cat, and selects tabs. It reports what the
// OS would (cursor position, last-input time, button state, press count) and logs what it did,
// so bands can be checked against the harness's own ground truth (presses, typing, lingering).
//
// U-legacy is the v1.2-diagnosis model unchanged (same draws in the same order: a run with it
// reproduces the baseline trajectories). The four v1.2 users (U-active, U-typing, U-play,
// U-mouse-work) handle the cat at the REAL rate (diagnosis §1.5: 46 pets, 19 drags incl. throws,
// 8.3 hard throws per awake hour).
import type { Point } from '../../src/shared/geometry';
import type { SimEvent, SimOutput } from '../../src/shared/sim';
import { BODY_H_PX, BODY_PX, WORLD } from '../integration/surfaces/pipeline';
import type { VirtualClock } from './clock';
import { FULL, SCREEN_H, SCREEN_W, type Desktop } from './desktop';
import { HOUR, MIN } from './metrics';

const BL = BODY_PX;
const BH = BODY_H_PX;

export type Mode = 'mouse' | 'typing' | 'pause' | 'idle' | 'longIdle' | 'hand' | 'play';
export type ShareMode = 'mouse' | 'typing' | 'pause' | 'idle' | 'play';

/** The usage model (seeded). */
export interface UsageModel {
  /** Petting sessions, drags (gentle carry and release) and throws per hour of presence. */
  petsPerHour: number;
  dragsPerHour: number;
  throwsPerHour: number;
  /** Share of throws released above the app's hard-throw speed (the rest are brisk but below it). */
  hardThrowShare: number;
  /** Share of drags that put the cat onto the front window's top / tab strip. */
  placeOnTopShare: number;
  /** Share of mouse moves that end near the cat (on its level), and anywhere on screen (else inside the front window). */
  nearCatMoveShare: number;
  anywhereMoveShare: number;
  /** Tab selections per hour while the browser is in front and the user uses the mouse. */
  tabSwitchesPerHour: number;
  /** One idle stretch longer than the sleep threshold per run. */
  longIdle: boolean;
  // ---- v1.2 users (absent: the v1.2-diagnosis behaviour) ----
  /**
   * Target shares of the hands-free present time per mode (idle counts as away). The next mode is
   * drawn with probability share / mean duration, so the long-run shares match. Absent: the
   * diagnosis' fixed transition table.
   */
  modeShares?: Partial<Record<ShareMode, number>>;
  /** Share of mouse moves that end with a click (diagnosis: 0.5). */
  clickShare?: number;
  /** A button press every U(lo, hi) ms while in mouse mode (U-mouse-work), independent of moves. */
  pressEveryMs?: readonly [number, number] | null;
  /** A taskbar reveal at the bottom edge every U(lo, hi) ms while in mouse mode (U-mouse-work). */
  taskbarEveryMs?: readonly [number, number] | null;
  /** Releases are hard throws at U(1500, 5000) DIP/s only (B7, B8 scenarios). */
  hardThrowsOnly?: boolean;
  /** Scripted handling (sim ms from the start), on top of the rates: B8's throw burst. */
  script?: ReadonlyArray<{ at: number; kind: 'pet' | 'drag' | 'throw' }>;
  /** The simulated machine has the user's auto-hide bottom taskbar (tracked by the REAL tracker). */
  taskbar?: boolean;
}

/** The v1.2 diagnosis' user (harness v1): kept bit-for-bit so its runs reproduce the baseline. */
export const LEGACY_USAGE: UsageModel = {
  petsPerHour: 10,
  dragsPerHour: 4,
  throwsPerHour: 3,
  hardThrowShare: 0.7,
  placeOnTopShare: 0.2,
  nearCatMoveShare: 0.08,
  anywhereMoveShare: 0.12,
  tabSwitchesPerHour: 15,
  longIdle: true,
};

/**
 * The REAL handling rate (diagnosis §1.5) as attempt rates per hour of presence: the legacy model's
 * 10 / 4 / 3 gave 47-62 pets, 6.6-7.7 drags and 1.7-2.6 counted throws per awake hour, so these
 * land near the user's 46 / 19.4 / 8.25 (the harness test checks the attempt rates, the profile
 * reports the sim's counters next to the REAL ones).
 */
export const REAL_HANDLING: Pick<UsageModel, 'petsPerHour' | 'dragsPerHour' | 'throwsPerHour' | 'hardThrowShare'> = {
  petsPerHour: 8.5,
  dragsPerHour: 8.5,
  throwsPerHour: 10,
  hardThrowShare: 0.7,
};
/** The REAL throw spacing (8.3 hard throws per awake hour), for B7. */
export const REAL_THROW_SPACING_MS = HOUR / 8.3;

export type UserModelId = 'U-legacy' | 'U-active' | 'U-typing' | 'U-play' | 'U-mouse-work' | 'U-hands-off';
export const USER_MODEL_IDS: readonly UserModelId[] = ['U-legacy', 'U-active', 'U-typing', 'U-play', 'U-mouse-work', 'U-hands-off'];

const V12_BASE: UsageModel = { ...LEGACY_USAGE, ...REAL_HANDLING, taskbar: true, clickShare: 0.5 };

export const USER_MODELS: Readonly<Record<UserModelId, UsageModel>> = {
  'U-legacy': LEGACY_USAGE,
  /** Moving the cursor, not typing, handling at the REAL rate. */
  'U-active': { ...V12_BASE, modeShares: { mouse: 0.6, pause: 0.28, idle: 0.12 } },
  /** Typing 60 % of the present time (run with reactToTyping on and off). */
  'U-typing': { ...V12_BASE, modeShares: { typing: 0.6, mouse: 0.27, pause: 0.08, idle: 0.05 } },
  /** The cursor lingers within 6 bw of the cat, erratic, no clicks, 20 % of the present time. */
  'U-play': { ...V12_BASE, modeShares: { play: 0.2, mouse: 0.5, pause: 0.22, idle: 0.08 } },
  /** A button press every 2-10 s, the cursor commuting, taskbar reveals at the bottom every 1-3 min. */
  'U-mouse-work': { ...V12_BASE, modeShares: { mouse: 0.88, pause: 0.08, idle: 0.04 }, clickShare: 0, pressEveryMs: [2000, 10_000], taskbarEveryMs: [MIN, 3 * MIN], nearCatMoveShare: 0.04, anywhereMoveShare: 0.2 },
  /** Like U-active, breaks included, but never touches the cat: nothing but a greeting ever relieves its social need (B3b). */
  'U-hands-off': { ...V12_BASE, petsPerHour: 0, dragsPerHour: 0, throwsPerHour: 0, modeShares: { mouse: 0.6, pause: 0.28, idle: 0.12 } },
};

export const USER_MODEL_DESCRIPTIONS: Readonly<Record<UserModelId, string>> = {
  'U-legacy': 'the v1.2 diagnosis user (10 pets, 4 drags, 3 throws per hour; mouse/typing/pause/idle machine)',
  'U-active': 'cursor moving 60 %, pauses 28 %, short idles 12 %, never typing; REAL handling rate',
  'U-typing': 'typing 60 % of the present time, mouse 27 %, pauses 8 %; REAL handling rate',
  'U-play': 'cursor lingering within 6 bw of the cat, erratic, no clicks, 20 % of the present time; REAL handling rate',
  'U-mouse-work': 'mouse work: a press every 2-10 s, the cursor commuting, taskbar reveals every 1-3 min; REAL handling rate',
  'U-hands-off': 'cursor moving 60 %, pauses 28 %, breaks 12 %, never typing; never pets, drags or throws the cat',
};

interface CursorPath {
  from: number;
  to: number;
  at: (t: number) => Point;
}

export interface Release {
  at: number;
  kind: 'drag' | 'throw';
  speedDip: number;
  /** Counted as a hard throw by the sim (filled in by the recorder). */
  thrown: boolean | null;
}

export interface Press {
  at: number;
  x: number;
  y: number;
}

export interface UserLog {
  modeMs: Record<Mode, number>;
  petSessions: number;
  petEvents: number;
  drags: number;
  throws: number;
  placedOnTop: number;
  shortIdles: number;
  longIdles: number;
  deferred: number;
  moves: number;
  nearCatMoves: number;
  taskbarReveals: number;
  /** Button presses by the mode the user was in (drags count as 'hand'). */
  pressesByMode: Partial<Record<Mode, number>>;
  /** How often each mode was entered. */
  modeEntries: Partial<Record<Mode, number>>;
  releases: Release[];
  presses: Press[];
}

const smooth = (k: number): number => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * k * (10 + k * (6 * k - 15)));
const clampScreen = (p: Point): Point => ({ x: Math.min(SCREEN_W - 1, Math.max(0, p.x)), y: Math.min(SCREEN_H - 1, Math.max(0, p.y)) });

export class User {
  mode: Mode = 'mouse';
  dragging = false;
  private gen = 0;
  private path: CursorPath | null = null;
  private rest: Point = { x: 1100, y: 520 };
  private lastInput = 0;
  private lastMoveAt = 0;
  private leftUntil = -1;
  private modeSince = 0;
  private longIdleDone = false;
  private keys = 0;
  private taskbarDueAt = Infinity;
  private modeEndsAt = 0;
  readonly log: UserLog = {
    modeMs: { mouse: 0, typing: 0, pause: 0, idle: 0, longIdle: 0, hand: 0, play: 0 },
    petSessions: 0,
    petEvents: 0,
    drags: 0,
    throws: 0,
    placedOnTop: 0,
    shortIdles: 0,
    longIdles: 0,
    deferred: 0,
    moves: 0,
    nearCatMoves: 0,
    taskbarReveals: 0,
    pressesByMode: {},
    modeEntries: {},
    releases: [],
    presses: [],
  };

  constructor(
    private readonly rng: () => number,
    private readonly clock: VirtualClock,
    private readonly desk: Desktop,
    private readonly usage: UsageModel,
    private readonly sleepThresholdMs: number,
    private readonly runMs: number,
    private readonly cat: () => SimOutput | null,
    private readonly enqueue: (ev: SimEvent) => void,
    private readonly onRelease: (r: Release) => void,
  ) {}

  start(): void {
    this.startMode('mouse');
    this.schedule('pet', this.usage.petsPerHour);
    this.schedule('drag', this.usage.dragsPerHour);
    this.schedule('throw', this.usage.throwsPerHour);
    this.scheduleTabs();
    if (this.usage.longIdle) this.clock.setTimeout(() => this.beginLongIdle(), this.range(0.35, 0.6) * this.runMs);
    const tb = this.usage.taskbarEveryMs;
    if (tb) this.taskbarDueAt = this.range(tb[0], tb[1]);
    for (const s of this.usage.script ?? []) this.clock.setTimeout(() => this.attempt(s.kind, 0), Math.max(0, s.at));
  }

  finish(): void {
    this.log.modeMs[this.mode] += this.clock.now - this.modeSince;
    this.modeSince = this.clock.now;
  }

  // ---- what the OS reports

  cursorAt(t: number): Point {
    const p = this.path;
    if (p && t <= p.to) return clampScreen(p.at(Math.max(p.from, t)));
    return this.rest;
  }
  idleMs(t: number): number {
    const p = this.path;
    if (p && t >= p.from && t <= p.to) return 0;
    return Math.max(0, t - this.lastInput);
  }
  /** ms since the cursor last moved (SimEnv.cursorIdleMs). */
  cursorIdleMs(t: number): number {
    const p = this.path;
    if (p && t >= p.from && t <= p.to) return 0;
    return Math.max(0, t - this.lastMoveAt);
  }
  leftDown(t: number): boolean {
    return this.dragging || t <= this.leftUntil;
  }
  /** Button presses (down edges) so far (SimEnv.pointerButtonPresses). */
  get pressCount(): number {
    return this.log.presses.length;
  }
  get present(): boolean {
    return this.mode !== 'idle' && this.mode !== 'longIdle';
  }

  // ---- helpers

  private range(a: number, b: number): number {
    return a + (b - a) * this.rng();
  }
  private now(): number {
    return this.clock.now;
  }
  private after(ms: number, g: number, fn: () => void): void {
    this.clock.setTimeout(() => {
      if (g === this.gen) fn();
    }, ms);
  }
  private catPoint(): Point | null {
    const o = this.cat();
    if (!o || !o.visible) return null;
    return { x: o.x, y: o.y - 0.5 * BH };
  }
  private press(): void {
    const t = this.now();
    this.lastInput = t;
    this.leftUntil = t + 90;
    const c = this.cursorAt(t);
    this.log.presses.push({ at: t, x: c.x, y: c.y });
    this.log.pressesByMode[this.mode] = (this.log.pressesByMode[this.mode] ?? 0) + 1;
  }
  /** Ends the current path where it is now (the hand stops there). */
  private settle(): void {
    const t = this.now();
    const p = this.path;
    if (p) {
      this.rest = clampScreen(p.at(Math.min(Math.max(p.from, t), p.to)));
      if (t >= p.from) {
        this.lastInput = Math.min(t, p.to);
        this.lastMoveAt = Math.min(t, p.to);
      }
    }
    this.path = null;
  }
  private setPath(ms: number, at: (t: number) => Point): void {
    this.settle();
    const from = this.now();
    const to = from + Math.max(1, ms);
    const path: CursorPath = { from, to, at };
    this.path = path;
    this.clock.setTimeout(() => {
      if (this.path === path) this.settle();
    }, to - from);
  }
  private moveTo(target: Point | (() => Point | null), ms: number): void {
    const start = this.cursorAt(this.now());
    const t0 = this.now();
    let last = typeof target === 'function' ? (target() ?? start) : target;
    this.setPath(ms, (t) => {
      if (typeof target === 'function') last = target() ?? last;
      const k = smooth((t - t0) / ms);
      return { x: start.x + (last.x - start.x) * k, y: start.y + (last.y - start.y) * k };
    });
  }

  // ---- the mode machine

  private modeRange(m: Mode): readonly [number, number] {
    const thr = this.sleepThresholdMs;
    switch (m) {
      case 'mouse':
        return [20_000, 150_000];
      case 'typing':
        return [60_000, 360_000];
      case 'pause':
        return [5_000, 60_000];
      case 'play':
        return [20_000, 90_000];
      default:
        return [Math.min(45_000, 0.3 * thr), Math.min(0.5 * thr, 6 * MIN)];
    }
  }

  private startMode(m: Mode, ms?: number): void {
    const t = this.now();
    this.log.modeMs[this.mode] += t - this.modeSince;
    this.modeSince = t;
    const g = ++this.gen;
    this.mode = m;
    this.log.modeEntries[m] = (this.log.modeEntries[m] ?? 0) + 1;
    if (m === 'hand') return;
    const [lo, hi] = this.modeRange(m);
    const dur = ms ?? this.range(lo, hi);
    this.modeEndsAt = t + dur;
    if (m === 'idle') this.log.shortIdles++;
    if (m === 'mouse') this.mouseStep(g);
    if (m === 'typing') this.typeStep(g);
    if (m === 'play') this.playStep(g);
    if (m === 'mouse' && this.usage.pressEveryMs) this.pressStep(g);
    this.after(dur, g, () => this.nextMode());
  }

  private nextMode(): void {
    const shares = this.usage.modeShares;
    if (shares) {
      // A renewal process: pick a mode with probability share / mean duration.
      const modes = (Object.keys(shares) as ShareMode[]).filter((k) => (shares[k] ?? 0) > 0);
      const w = modes.map((k) => {
        const [lo, hi] = this.modeRange(k);
        return (shares[k] ?? 0) / Math.max(1, (lo + hi) / 2);
      });
      const total = w.reduce((a, b) => a + b, 0);
      let r = this.rng() * total;
      for (let i = 0; i < modes.length; i++) {
        r -= w[i]!;
        if (r <= 0 || i === modes.length - 1) {
          this.startMode(modes[i]!);
          return;
        }
      }
      this.startMode('mouse');
      return;
    }
    const r = this.rng();
    switch (this.mode) {
      case 'mouse':
        this.startMode(r < 0.45 ? 'typing' : r < 0.78 ? 'pause' : r < 0.85 ? 'idle' : 'mouse');
        return;
      case 'typing':
        this.startMode(r < 0.6 ? 'mouse' : r < 0.9 ? 'pause' : 'idle');
        return;
      case 'pause':
        this.startMode(r < 0.55 ? 'mouse' : 'typing');
        return;
      default:
        this.startMode('mouse');
    }
  }

  private beginLongIdle(): void {
    if (this.longIdleDone) return;
    if (this.mode === 'hand') {
      this.clock.setTimeout(() => this.beginLongIdle(), 10_000);
      return;
    }
    this.longIdleDone = true;
    this.log.longIdles++;
    this.settle();
    this.startMode('longIdle', this.sleepThresholdMs + this.range(5 * MIN, 15 * MIN));
  }

  private mouseStep(g: number): void {
    if (this.usage.taskbarEveryMs && this.now() >= this.taskbarDueAt) {
      this.revealTaskbar(g);
      return;
    }
    const r = this.rng();
    let target: Point;
    const cat = this.cat();
    if (r < this.usage.nearCatMoveShare && cat?.visible) {
      const side = this.rng() < 0.5 ? -1 : 1;
      target = clampScreen({ x: cat.x + side * this.range(1, 5) * BL, y: cat.y - this.range(0.3, 3) * BH });
      this.log.nearCatMoves++;
    } else if (r < this.usage.nearCatMoveShare + this.usage.anywhereMoveShare) {
      target = { x: this.range(10, SCREEN_W - 10), y: this.range(10, SCREEN_H - 10) };
    } else {
      const w = this.desk.foreground?.rect ?? FULL;
      target = clampScreen({ x: this.range(w.x + 20, w.x + w.width - 20), y: this.range(w.y + 40, w.y + w.height - 20) });
    }
    this.log.moves++;
    const from = this.cursorAt(this.now());
    const d = Math.hypot(target.x - from.x, target.y - from.y);
    const ms = Math.min(1800, Math.max(120, 100 + (d / this.range(700, 3200)) * 1000));
    this.moveTo(target, ms);
    this.after(ms, g, () => {
      // A click where the move ends (the diagnosis model: half of them; the same draw either way).
      if (this.rng() < (this.usage.clickShare ?? 0.5)) this.press();
      this.after(this.range(150, 2500), g, () => this.mouseStep(g));
    });
  }

  /** U-mouse-work: the cursor goes down to the bottom edge, the taskbar slides in, an icon gets a click, back up. */
  private revealTaskbar(g: number): void {
    const tb = this.usage.taskbarEveryMs;
    if (tb) this.taskbarDueAt = this.now() + this.range(tb[0], tb[1]);
    this.log.taskbarReveals++;
    const x = this.range(200, SCREEN_W - 200);
    const down = this.range(300, 700);
    this.moveTo({ x, y: SCREEN_H - 1 }, down);
    this.after(down + this.range(250, 500), g, () => {
      const over = this.range(400, 900);
      this.moveTo({ x: x + this.range(-300, 300), y: SCREEN_H - this.range(15, 45) }, over);
      this.after(over + this.range(800, 2500), g, () => {
        if (this.rng() < 0.6) this.press();
        this.after(this.range(150, 600), g, () => this.mouseStep(g));
      });
    });
  }

  private pressStep(g: number): void {
    const iv = this.usage.pressEveryMs;
    if (!iv) return;
    this.after(this.range(iv[0], iv[1]), g, () => {
      if (!this.dragging) this.press();
      this.pressStep(g);
    });
  }

  /** U-play: the cursor lingers within 6 bw of the cat on its level, erratic (quick turns, stops), no clicks. */
  private playStep(g: number): void {
    const o = this.cat();
    if (!o || !o.visible) {
      this.after(500, g, () => this.playStep(g));
      return;
    }
    if (this.rng() < 0.18) {
      // A still cursor (the crouch case): the hand rests a moment.
      this.settle();
      this.after(this.range(300, 1800), g, () => this.playStep(g));
      return;
    }
    const side = this.rng() < 0.5 ? -1 : 1;
    const target = clampScreen({ x: o.x + side * this.range(0.5, 6) * BL, y: o.y - this.range(0.2, 2.2) * BH });
    const ms = this.range(150, 900);
    this.moveTo(target, ms);
    this.after(ms, g, () => this.playStep(g));
  }

  private typeStep(g: number): void {
    this.lastInput = this.now();
    this.keys++;
    let gap = this.range(90, 260);
    if (this.keys % 6 === 0) gap += this.range(200, 700);
    if (this.rng() < 0.012) gap += this.range(2000, 9000);
    this.after(gap, g, () => this.typeStep(g));
  }

  private scheduleTabs(): void {
    const rate = this.usage.tabSwitchesPerHour / HOUR;
    if (!(rate > 0)) return;
    this.clock.setTimeout(
      () => {
        if (this.mode === 'mouse' && this.desk.browserFront) {
          const others = [0, 1, 2].filter((i) => i !== this.desk.tab);
          this.desk.selectTab(others[Math.floor(this.rng() * others.length)] ?? 0);
        }
        this.scheduleTabs();
      },
      -Math.log(1 - this.rng()) / rate,
    );
  }

  // ---- the hand on the cat

  private schedule(kind: 'pet' | 'drag' | 'throw', perHour: number): void {
    const rate = perHour / HOUR;
    if (!(rate > 0)) return;
    this.clock.setTimeout(() => this.attempt(kind, perHour), -Math.log(1 - this.rng()) / rate);
  }

  private interactable(o: SimOutput | null, pet: boolean): boolean {
    if (!o || !o.visible) return false;
    if (['held', 'jumping', 'falling', 'landing', 'away'].includes(o.state)) return false;
    if (o.support.kind === 'air' || o.support.kind === 'held') return false;
    if (pet && o.support.kind === 'surface' && o.support.surfaceKind === 'windowSide') return false;
    return true;
  }

  /** One handling attempt; perHour 0 = scripted (not rescheduled). */
  private attempt(kind: 'pet' | 'drag' | 'throw', perHour: number): void {
    if (!this.present || this.mode === 'hand' || !this.interactable(this.cat(), kind === 'pet')) {
      // Away or busy: the same intention a little later (presence-time rate).
      this.log.deferred++;
      this.clock.setTimeout(() => this.attempt(kind, perHour), this.range(5_000, 30_000));
      return;
    }
    const resume = this.resumeAfterHand();
    this.startMode('hand');
    const g = this.gen;
    const approach = this.range(400, 900);
    this.moveTo(() => this.catPoint(), approach);
    this.after(approach, g, () => {
      const p = this.catPoint();
      if (!p || !this.interactable(this.cat(), kind === 'pet')) {
        this.after(500, g, () => this.startMode(resume.mode, resume.ms));
        if (perHour > 0) this.schedule(kind, perHour);
        else this.clock.setTimeout(() => this.attempt(kind, 0), this.range(5_000, 30_000));
        return;
      }
      this.enqueue({ type: 'pointer.hoverStart', at: this.cursorAt(this.now()) });
      if (kind === 'pet') this.pet(g, resume);
      else this.drag(g, kind, resume);
      if (perHour > 0) this.schedule(kind, perHour);
    });
  }

  /**
   * Where the hand goes back to: the diagnosis model always starts a fresh mouse mode; the v1.2
   * users resume the interrupted mode for its remaining time (a fresh full-length mode would bias
   * the mode shares toward the long modes that handling interrupts most).
   */
  private resumeAfterHand(): { mode: Mode; ms: number | undefined } {
    if (!this.usage.modeShares) return { mode: 'mouse', ms: undefined };
    const m = this.mode;
    if (m === 'hand' || m === 'idle' || m === 'longIdle') return { mode: 'mouse', ms: undefined };
    return { mode: m, ms: Math.max(5000, this.modeEndsAt - this.now()) };
  }

  private pet(g: number, resume: { mode: Mode; ms: number | undefined }): void {
    this.log.petSessions++;
    const dur = this.range(3000, 10_000);
    const period = this.range(600, 900);
    const amp = this.range(25, 45);
    const t0 = this.now();
    this.setPath(dur, (t) => {
      const c = this.catPoint() ?? this.rest;
      return { x: c.x + amp * Math.sin((2 * Math.PI * (t - t0)) / period), y: c.y };
    });
    const stroke = (): void => {
      if (this.now() - t0 >= dur) {
        this.enqueue({ type: 'pointer.hoverEnd' });
        const w = this.desk.foreground?.rect ?? FULL;
        this.moveTo(clampScreen({ x: this.range(w.x + 20, w.x + w.width - 20), y: this.range(w.y + 40, w.y + w.height - 20) }), 500);
        this.after(500, g, () => this.startMode(resume.mode, resume.ms));
        return;
      }
      if (this.isOverCat(this.cursorAt(this.now()))) {
        this.enqueue({ type: 'pointer.pet', at: this.cursorAt(this.now()), strength: this.range(0.55, 0.9) });
        this.log.petEvents++;
      }
      this.after(period / 2, g, stroke);
    };
    this.after(period / 4, g, stroke);
  }

  private drag(g: number, kind: 'drag' | 'throw', resume: { mode: Mode; ms: number | undefined }): void {
    const start = this.cursorAt(this.now());
    this.enqueue({ type: 'pointer.dragStart', at: start });
    this.dragging = true;
    // The grab is a button press (down edge) too.
    this.log.presses.push({ at: this.now(), x: start.x, y: start.y });
    this.log.pressesByMode.hand = (this.log.pressesByMode.hand ?? 0) + 1;
    let dest: Point = { x: this.range(200, SCREEN_W - 200), y: this.range(250, 1000) };
    const ledge = kind === 'drag' && this.rng() < this.usage.placeOnTopShare ? this.desk.ledgeToPlaceOn() : null;
    if (ledge) {
      dest = { x: this.range(ledge.x0, ledge.x1), y: ledge.y - this.range(40, 110) };
      this.log.placedOnTop++;
    }
    if (kind === 'drag') this.log.drags++;
    else this.log.throws++;
    const carry = this.range(700, 2000);
    this.moveTo(dest, carry);
    this.after(carry, g, () => {
      let velocity: Point;
      let flingMs = 0;
      if (kind === 'throw') {
        const hard = this.usage.hardThrowsOnly ? true : this.rng() < this.usage.hardThrowShare;
        const speed = hard ? this.range(1500, 5000) : this.range(700, 1350);
        const ang = (this.range(-60, 25) * Math.PI) / 180;
        const dir = this.rng() < 0.5 ? -1 : 1;
        velocity = { x: dir * speed * Math.cos(ang), y: speed * Math.sin(ang) };
        flingMs = 110;
        const from = this.cursorAt(this.now());
        const f0 = this.now();
        this.setPath(flingMs, (t) => ({ x: from.x + (velocity.x * (t - f0)) / 1000, y: from.y + (velocity.y * (t - f0)) / 1000 }));
      } else {
        const speed = this.range(0, 250);
        const ang = this.range(0, 2 * Math.PI);
        velocity = { x: speed * Math.cos(ang), y: speed * Math.sin(ang) };
      }
      this.after(flingMs, g, () => {
        const at = this.cursorAt(this.now());
        this.settle();
        this.enqueue({ type: 'pointer.dragEnd', at, velocity });
        this.dragging = false;
        this.enqueue({ type: 'pointer.hoverEnd' });
        const r: Release = { at: this.now(), kind, speedDip: Math.hypot(velocity.x, velocity.y) / WORLD.displays[0]!.scaleFactor, thrown: null };
        this.log.releases.push(r);
        this.onRelease(r);
        this.after(this.range(300, 1500), g, () => this.startMode(resume.mode, resume.ms));
      });
    });
  }

  isOverCat(c: Point | null): boolean {
    const o = this.cat();
    if (!c || !o || !o.visible) return false;
    const b = o.boundsPx;
    return c.x >= b.x - 4 && c.x <= b.x + b.width + 4 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4;
  }
}
