// Shared helpers for the world-event engine tests: a stage and cat fixture, a tick input factory and a
// small driver that advances the engine's clocks. SIMULATED: nothing here touches a real display or
// the real clock. Written in the Living Companion sprint, NOT executed there.
import type { CompanionEventChoices } from '../../../../src/shared/companion';
import { mulberry32 } from '../../../../src/core/behavior';
import type { EventCatView, EventTemperament, EventTickInput, EventTickOutput, WorldEventEngine } from '../../../../src/core/events';

export const STAGE = { x: 0, y: 0, width: 1600, height: 700 } as const;
export const BODY_W = 84;
export const WALL0 = 1_800_000_000_000;

export const TEMPERAMENT: EventTemperament = {
  interest: 0.5,
  boldness: 0.5,
  persistence: 1,
  startle: 0.5,
  playfulness: 0.5,
  calm: 0.5,
  mischief: 0.5,
  alertness: 0.9,
  energy: 0.6,
};

export function catView(over: Partial<EventCatView> = {}): EventCatView {
  return {
    x: 800,
    y: STAGE.y + STAGE.height,
    facing: 1,
    bodyW: BODY_W,
    scale: 1,
    state: 'idle',
    asleep: false,
    busy: false,
    mood: 'happy',
    floorLeft: 800,
    floorRight: 800,
    ...over,
  };
}

export interface InputOptions {
  dt?: number;
  now?: number;
  wallNow?: number;
  localHour?: number;
  seed?: number;
  cat?: Partial<EventCatView>;
  temperament?: Partial<EventTemperament>;
  choices?: Partial<EventTickInput['choices']>;
  allowed?: boolean;
  userBusy?: boolean;
  stage?: EventTickInput['stage'];
  random?: () => number;
}

export const DEFAULT_CHOICES: CompanionEventChoices & { reducedMotion: boolean } = { enabled: true, rare: true, pace: 1, disabled: [], reducedMotion: false };

export function makeInput(o: InputOptions = {}): EventTickInput {
  return {
    now: o.now ?? 0,
    dt: o.dt ?? 50,
    wallNow: o.wallNow ?? WALL0,
    localHour: o.localHour ?? 14,
    random: o.random ?? mulberry32(o.seed ?? 1),
    stage: o.stage ?? { ...STAGE },
    cat: catView(o.cat),
    temperament: { ...TEMPERAMENT, ...o.temperament },
    choices: { ...DEFAULT_CHOICES, ...o.choices },
    allowed: o.allowed ?? true,
    userBusy: o.userBusy ?? false,
  };
}

/** Advances an engine with a shared sim clock, wall clock and one seeded random source. */
export class Driver {
  now = 0;
  wall = WALL0;
  readonly random: () => number;
  constructor(
    readonly engine: WorldEventEngine,
    seed: number,
    private readonly base: InputOptions = {},
  ) {
    this.random = mulberry32(seed);
  }

  input(over: InputOptions = {}): EventTickInput {
    const dt = over.dt ?? this.base.dt ?? 50;
    return makeInput({ ...this.base, ...over, dt, now: this.now + dt, wallNow: this.wall + dt, random: this.random });
  }

  step(over: InputOptions = {}): EventTickOutput {
    const inp = this.input(over);
    this.now = inp.now;
    this.wall = inp.wallNow;
    return this.engine.tick(inp);
  }

  /** Tick until `stop` says so (or maxTicks), returning every output. */
  run(maxTicks: number, over: InputOptions = {}, stop?: (o: EventTickOutput, i: number) => boolean): EventTickOutput[] {
    const outs: EventTickOutput[] = [];
    for (let i = 0; i < maxTicks; i++) {
      const o = this.step(over);
      outs.push(o);
      if (stop?.(o, i)) break;
    }
    return outs;
  }
}
