// The world-event engine: schedules an event every 5-30 minutes (while the cat is free to enjoy it),
// runs it (props from mechanics.ts, an invitation for the cat from the catalogue's beats) and winds it
// down gracefully when anything gets in the way. Pure and deterministic: the clock, the wall clock and
// every random draw arrive through EventTickInput (and createWorldEventEngine's own random for the
// creation / restore / idle-interrupt draws), so a seed replays exactly. It never touches the cat: it
// only DESCRIBES what the cat is invited to do; the sim stays the source of truth for the body.
import type { AnyEventId, EventHistoryEntry, JournalEntry, OutcomeId, RenderProp, WorldEventSnapshot } from '../../shared/companion';
import { ALL_EVENT_IDS, EVENT_HISTORY_MAX, MAX_PROPS, isRareEvent } from '../../shared/companion';
import { CAT_BASE_WIDTH_DIP } from '../../shared/cat';
import type { Point } from '../../shared/geometry';
import { safeRandom } from '../behavior/random';
import { EVENT_CATALOG, isJournalWorthy, type Beat, type EventDef, type OutcomeDef, type TempKey } from './catalog';
import { MECHANICS, RUN_ID_SPAN, createRun, type Ctx, type Frame, type Run } from './mechanics';
import { MAX_COUNTDOWN_STEP_MS, canOffer, chooseEvent, clampPace, drawGraceMs, drawRawDelayMs, effectiveDelayMs } from './schedule';
import type {
  CreateEventEngineOptions,
  EventEngineMemory,
  EventIntent,
  EventTemperament,
  EventTickInput,
  EventTickOutput,
  InterruptReason,
  WorldEventEngine,
} from './types';

/** A single event step never integrates more than this much real time (a long frame cannot teleport props). */
const MAX_EVENT_STEP_MS = 1000;
/** Graceful wind-down (props fade out in place, or run off) and the quick fade of a user or drag interrupt. */
const WIND_MS: Record<EventDef['interrupt'], number> = { fade: 1500, flee: 1500, pop: 600, dissolve: 1200 };
const QUICK_MS = 250;
/** Reduced motion plays the event clock at half speed and shortens the event. */
const REDUCED_SPEED = 0.5;
const REDUCED_LENGTH = 0.35;
/** A run that has not finished this long (clock ms) after its engaged window is wound down regardless. */
const SAFETY_MS = 20_000;
const MIN_MAIN_MS = 2500;
const MAX_OUTCOME_LEN = 32;

const finite = (v: number, d: number): number => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---- sanitising what comes in -----------------------------------------------------------------

function cleanTemperament(t: EventTemperament): EventTemperament {
  const unit = (v: number): number => clamp(finite(v, 0.5), 0, 1);
  return {
    interest: unit(t.interest),
    boldness: unit(t.boldness),
    persistence: clamp(finite(t.persistence, 1), 0.5, 1.6),
    startle: unit(t.startle),
    playfulness: unit(t.playfulness),
    calm: unit(t.calm),
    mischief: unit(t.mischief),
    alertness: unit(t.alertness),
    energy: unit(t.energy),
  };
}

function makeCtx(input: EventTickInput, random: () => number): Ctx {
  const st = input.stage;
  const x = finite(st.x, 0);
  const y = finite(st.y, 0);
  const width = Math.max(0, finite(st.width, 0));
  const height = Math.max(0, finite(st.height, 0));
  const unit = input.cat.bodyW > 0 && Number.isFinite(input.cat.bodyW) ? input.cat.bodyW : CAT_BASE_WIDTH_DIP;
  const floorY = y + height;
  const cat = {
    ...input.cat,
    x: clamp(finite(input.cat.x, x + width / 2), x, x + width),
    y: finite(input.cat.y, floorY),
    bodyW: unit,
    scale: finite(input.cat.scale, 1),
  };
  return {
    stage: { x, y, width, height },
    left: x,
    right: x + width,
    floorY,
    ceilY: Math.max(y, floorY - 5 * unit),
    unit,
    cat,
    reduced: input.choices.reducedMotion,
    random,
  };
}

export function sanitizeHistory(history: readonly EventHistoryEntry[] | undefined): EventHistoryEntry[] {
  const out: EventHistoryEntry[] = [];
  for (const h of history ?? []) {
    if (!h || !(ALL_EVENT_IDS as readonly string[]).includes(h.id) || !Number.isFinite(h.at) || typeof h.outcome !== 'string') continue;
    out.push({ id: h.id, at: h.at, outcome: h.outcome.slice(0, MAX_OUTCOME_LEN) });
  }
  return out.slice(-EVENT_HISTORY_MAX);
}

// ---- outcome, pacing, notice -------------------------------------------------------------------

function axis(t: EventTemperament, key: TempKey): number {
  if (key === 'persistence') return clamp((t.persistence - 1.05) / 0.55, -1, 1);
  return clamp((t[key] - 0.5) * 2, -1, 1);
}

/** Outcome probabilities: each base weight tilted by how far the cat's traits lean the way the outcome's bias asks. */
export function outcomeWeights(def: EventDef, t: EventTemperament): readonly { id: OutcomeId; weight: number }[] {
  return def.outcomes.map((o) => {
    let f = 1;
    if (o.bias) for (const k of Object.keys(o.bias) as TempKey[]) f += (o.bias[k] ?? 0) * axis(t, k);
    return { id: o.id, weight: Math.max(0, o.weight * clamp(f, 0.1, 4)) };
  });
}

function chooseOutcome(def: EventDef, t: EventTemperament, random: () => number): OutcomeDef {
  const weights = outcomeWeights(def, t);
  let total = 0;
  for (const w of weights) total += w.weight;
  let x = random() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i]?.weight ?? 0;
    if (x < 0) return def.outcomes[i] ?? def.outcomes[0]!;
  }
  return def.outcomes[def.outcomes.length - 1] ?? def.outcomes[0]!;
}

/** How long the event runs, as a multiplier: persistent, calm and keen cats stay with it longer. */
function pacingFactor(def: EventDef, t: EventTemperament): number {
  if (def.pacing.length === 0) return 1;
  let sum = 0;
  for (const k of def.pacing) {
    if (k === 'persistence') sum += Math.pow(clamp(t.persistence, 0.55, 1.6), 0.8);
    else if (k === 'calm') sum += 0.9 + 0.2 * t.calm;
    else sum += 0.8 + 0.4 * t.interest;
  }
  return sum / def.pacing.length;
}

/** When (event clock ms) the cat notices: alertness and interest, whether it is facing the thing, how far away it is. */
function noticeDelay(def: EventDef, t: EventTemperament, catX: number, facing: 1 | -1, unit: number, focus: Point | null, random: () => number): number {
  const base = def.noticeMs[0] + (def.noticeMs[1] - def.noticeMs[0]) * random();
  let f = 2.2 - 1.4 * (0.6 * t.alertness + 0.4 * t.interest);
  if (t.alertness < 0.25) f *= 1.8;
  if (focus) {
    const dx = focus.x - catX;
    f *= (dx >= 0 ? 1 : -1) === facing ? 0.7 : 1.4;
    f *= 1 + Math.min(1.5, Math.abs(dx) / (8 * unit));
  }
  return base * f;
}

// ---- beats -> intent ----------------------------------------------------------------------------

function defaultTarget(kind: Beat['kind']): 'prop' | 'ground' | 'none' {
  switch (kind) {
    case 'watch':
    case 'brace':
      return 'prop';
    case 'approach':
    case 'sneak':
    case 'chase':
    case 'flee':
    case 'play':
    case 'inspect':
    case 'hop':
    case 'settle':
      return 'ground';
    default:
      return 'none';
  }
}

function adjustPace(beat: Beat, t: EventTemperament): EventIntent['pace'] {
  if (beat.pace === 'run' && (t.energy < 0.35 || t.calm > 0.8)) return 'walk';
  return beat.pace;
}

/** The fraction of the engaged window at `age`: 1 once the props are leaving, and 0.5 pinned to the key moment when there is one. */
function windowU(age: number, noticeAt: number, mainMs: number, keyAt: number | null): number {
  if (age >= mainMs) return 1;
  const start = noticeAt;
  const end = Math.max(mainMs, start + 1);
  if (keyAt !== null && keyAt > start + 1 && keyAt < end - 1) {
    return age < keyAt ? (0.5 * (age - start)) / (keyAt - start) : 0.5 + (0.5 * (age - keyAt)) / (end - keyAt);
  }
  return clamp((age - start) / (end - start), 0, 1);
}

function beatIndex(beats: readonly Beat[], u: number): number {
  let idx = 0;
  for (let i = 0; i < beats.length; i++) if ((beats[i]?.from ?? 0) <= u + 1e-9) idx = i;
  return idx;
}

// ---- the active run ------------------------------------------------------------------------------

interface Active {
  run: Run;
  snapshot: WorldEventSnapshot;
  noticeAt: number;
  noticed: boolean;
  phase: 'live' | 'winding';
  windAge: number;
  windMs: number;
  /** The event was cut short (wound down while its props were still on screen). */
  cut: boolean;
  doneAt: number | null;
  lastBeat: number;
  stopReq: 'quick' | 'wind' | null;
}

export function createWorldEventEngine(opts: CreateEventEngineOptions): WorldEventEngine {
  const idleRandom = safeRandom(opts.random);
  let history: EventHistoryEntry[] = sanitizeHistory(opts.memory?.history);
  let active: Active | null = null;
  let nextId = 1;
  // The countdown: `rawDelay` is the draw at pace 1 (the pace in force counts when it is checked), or a fixed grace.
  let rawDelay = drawRawDelayMs(idleRandom);
  let fixedDelay = false;
  let waited = 0;
  let frozen = false;
  let lastPace = 1;

  const threshold = (): number => (fixedDelay ? rawDelay : effectiveDelayMs(rawDelay, lastPace));

  function redraw(random: () => number): void {
    rawDelay = drawRawDelayMs(random);
    fixedDelay = false;
    waited = 0;
  }

  function defer(random: () => number): void {
    rawDelay = drawGraceMs(random);
    fixedDelay = true;
    waited = 0;
  }

  // ---- starting ----

  function startRun(def: EventDef, input: EventTickInput, random: () => number): void {
    const t = cleanTemperament(input.temperament);
    const ctx = makeCtx(input, random);
    const reduced = input.choices.reducedMotion;
    const outcome = chooseOutcome(def, t, random);
    const drawn = (def.durationS[0] + (def.durationS[1] - def.durationS[0]) * random()) * 1000;
    const mainMs = Math.max(MIN_MAIN_MS, drawn * pacingFactor(def, t) * (reduced ? REDUCED_LENGTH : 1));
    const run = createRun(def, outcome, nextId, mainMs, ctx.cat.x);
    nextId = (nextId + RUN_ID_SPAN) % 1_000_000_000 || 1;
    const mech = MECHANICS[def.mechanic];
    mech.init(run, ctx);
    run.mainMs = Math.max(MIN_MAIN_MS, run.mainMs);
    const frame0 = mech.update(run, ctx, 0);
    run.lastFocus = frame0.focus;
    let noticeAt = noticeDelay(def, t, ctx.cat.x, ctx.cat.facing, ctx.unit, frame0.focus, random);
    if (def.canMiss) {
      if (noticeAt > 0.8 * run.mainMs) noticeAt = Infinity;
    } else {
      noticeAt = Math.min(noticeAt, 0.25 * run.mainMs, 2500);
    }
    if (run.keyAt !== null) {
      // The key moment must lie inside the engaged window for the stretch to make sense.
      const lo = (Number.isFinite(noticeAt) ? noticeAt : 0) + 300;
      const hi = run.mainMs - 300;
      run.keyAt = lo < hi ? clamp(run.keyAt, lo, hi) : null;
    }
    active = {
      run,
      snapshot: { id: def.id, rare: isRareEvent(def.id), startedAt: input.now },
      noticeAt,
      noticed: false,
      phase: 'live',
      windAge: 0,
      windMs: 0,
      cut: false,
      doneAt: null,
      lastBeat: -1,
      stopReq: null,
    };
  }

  function offerContext(input: EventTickInput, ignoreHours: boolean) {
    return {
      stage: input.stage,
      bodyW: input.cat.bodyW,
      localHour: input.localHour,
      reducedMotion: input.choices.reducedMotion,
      rare: input.choices.rare,
      disabled: input.choices.disabled,
      ignoreHours,
    };
  }

  function dueCheck(input: EventTickInput, random: () => number): void {
    if (input.cat.busy) return; // stays due until the cat is free
    const id = chooseEvent(random, offerContext(input, false), history, input.wallNow);
    const def = id ? EVENT_CATALOG[id] : undefined;
    if (!def) {
      redraw(random); // nothing fits right now (small stage, switched off): try again later
      return;
    }
    if (def.needsAwake && input.cat.asleep) {
      defer(random);
      return;
    }
    startRun(def, input, random);
  }

  // ---- finishing ----

  function finish(a: Active, input: EventTickInput, random: () => number): EventTickOutput {
    const def = a.run.def;
    const outcome: OutcomeId = a.cut ? 'cut' : def.canMiss && !a.noticed ? 'unnoticed' : a.run.outcome.id;
    const entry: EventHistoryEntry = { id: def.id, at: input.wallNow, outcome };
    history = [...history, entry].slice(-EVENT_HISTORY_MAX);
    const journal: JournalEntry | null = isJournalWorthy(def, outcome) ? { id: def.id, at: input.wallNow, outcome } : null;
    active = null;
    redraw(random);
    return { props: [], intent: null, active: null, finished: { history: entry, journal } };
  }

  function beginWind(a: Active, quick: boolean): void {
    if (a.phase === 'live') {
      a.phase = 'winding';
      a.windAge = 0;
      a.windMs = quick ? QUICK_MS : WIND_MS[a.run.def.interrupt];
      // Props that can run off do; the rest fade in place. Never frozen in mid-air.
      if (a.run.def.interrupt === 'flee' && !quick) a.run.scared = true;
      // Whatever is still on screen was cut short; an event whose props already left finished for real.
      a.cut = a.doneAt === null;
    } else if (quick) {
      a.windMs = Math.min(a.windMs, a.windAge + QUICK_MS);
    }
  }

  // ---- one tick of a running event ----

  function stepActive(a: Active, input: EventTickInput, random: () => number): EventTickOutput {
    const ctx = makeCtx(input, random);
    const run = a.run;
    const def = run.def;
    const dt = clamp(finite(input.dt, 0), 0, MAX_EVENT_STEP_MS);
    const speed = ctx.reduced ? REDUCED_SPEED : 1;
    const clockDt = dt * speed;

    if (a.stopReq) beginWind(a, a.stopReq === 'quick');
    a.stopReq = null;
    if (a.phase === 'live') {
      if (!input.allowed || !input.choices.enabled) beginWind(a, false);
      else if (run.age > run.mainMs + SAFETY_MS) beginWind(a, false);
    }

    run.age += clockDt;
    run.followDx += (ctx.cat.x - run.cat0x - run.followDx) * Math.min(1, dt * 0.0012);
    const frame: Frame = MECHANICS[def.mechanic].update(run, ctx, clockDt);
    if (frame.focus) run.lastFocus = frame.focus;
    if (frame.done && a.doneAt === null) a.doneAt = run.age;

    if (a.phase === 'winding') {
      a.windAge += dt;
      if (a.windAge >= a.windMs || frame.done) return finish(a, input, random);
    } else if (a.doneAt !== null) {
      // The aftermath beat plays on for a moment after the last prop is gone (the clock is in event time).
      if (run.age - a.doneAt >= def.recoverMs * speed) return finish(a, input, random);
    }

    if (!a.noticed && run.age >= a.noticeAt) a.noticed = true;
    const fade = a.phase === 'winding' ? Math.max(0, 1 - a.windAge / Math.max(1, a.windMs)) : 1;
    const props = finalizeProps(frame.props, ctx, fade);
    const intent = a.phase === 'live' && a.noticed ? buildIntent(a, input, ctx, frame) : null;
    return { props, intent, active: a.snapshot, finished: null };
  }

  function buildIntent(a: Active, input: EventTickInput, ctx: Ctx, frame: Frame): EventIntent | null {
    const run = a.run;
    const def = run.def;
    const beats = run.outcome.beats;
    if (beats.length === 0) return null;
    const t = cleanTemperament(input.temperament);
    const u = windowU(run.age, a.noticeAt, run.mainMs, run.keyAt);
    const idx = beatIndex(beats, u);
    const beat = beats[idx];
    if (!beat) return null;
    const first = idx !== a.lastBeat;
    a.lastBeat = idx;
    const focus = frame.focus ?? run.lastFocus;
    const mode = beat.target ?? defaultTarget(beat.kind);
    const intent: EventIntent = { kind: beat.kind, urgency: clamp(beat.urgency ?? 0.15, 0, 1) };
    if (focus && mode !== 'none') intent.target = mode === 'ground' ? { x: focus.x, y: ctx.floorY } : { x: focus.x, y: focus.y };
    if (beat.standoff !== undefined) {
      let standoff = beat.standoff * ctx.unit * (1.3 - 0.6 * t.boldness);
      if (beat.kind === 'approach' || beat.kind === 'sneak' || beat.kind === 'chase') standoff = Math.max(standoff, def.minStandoffBody * ctx.unit);
      intent.standoffPx = standoff;
    }
    const pace = adjustPace(beat, t);
    if (pace) intent.pace = pace;
    if (beat.clip) intent.clip = beat.clip;
    // One-shots (a sound, an emote) go out once, on the tick a beat begins.
    if (first && beat.emote) intent.emote = beat.emote;
    if (first && beat.sound) intent.sound = beat.sound;
    const mood = beat.mood ?? def.mood;
    intent.mood = { mood: mood.mood, strength: mood.strength };
    return intent;
  }

  // ---- the public tick ----

  function tick(input: EventTickInput): EventTickOutput {
    const random = safeRandom(input.random);
    lastPace = clampPace(input.choices.pace);
    if (active) {
      frozen = false;
      return stepActive(active, input, random);
    }
    frozen = !(input.allowed && !input.userBusy && input.choices.enabled);
    if (!frozen) {
      waited += clamp(finite(input.dt, 0), 0, MAX_COUNTDOWN_STEP_MS);
      if (waited >= threshold()) dueCheck(input, random);
    }
    // The first tick of a new event already shows it (props at t = 0 fade in from nothing).
    if (active) return stepActive(active, { ...input, dt: 0 }, random);
    return { props: [], intent: null, active: null, finished: null };
  }

  function trigger(id: AnyEventId, input: EventTickInput): boolean {
    const def = EVENT_CATALOG[id];
    if (!def || active || !input.allowed || !input.choices.enabled) return false;
    if (!canOffer(def, offerContext(input, true))) return false;
    startRun(def, input, safeRandom(input.random));
    return true;
  }

  function interrupt(reason: InterruptReason): void {
    const reset = reason === 'suspend' || reason === 'lock' || reason === 'display';
    if (!active) {
      if (reset) redraw(idleRandom);
      return;
    }
    const quick = reason === 'user' || reason === 'drag' || reset;
    if (quick) active.stopReq = 'quick';
    else if (active.stopReq !== 'quick') active.stopReq = 'wind';
  }

  return {
    tick,
    interrupt,
    get active(): boolean {
      return active !== null;
    },
    msUntilNext(): number | null {
      if (active || frozen) return null;
      return Math.max(0, threshold() - waited);
    },
    restore(memory: EventEngineMemory): void {
      history = sanitizeHistory(memory.history);
      active = null;
      redraw(idleRandom);
    },
    snapshot(): EventEngineMemory {
      return { history: history.map((h) => ({ ...h })) };
    },
    trigger,
    debugInfo(): Record<string, unknown> {
      return {
        active: active ? { id: active.snapshot.id, outcome: active.run.outcome.id, age: Math.round(active.run.age), mainMs: Math.round(active.run.mainMs), noticeAt: active.noticeAt, phase: active.phase } : null,
        waitedMs: Math.round(waited),
        thresholdMs: Math.round(threshold()),
        fixedDelay,
        frozen,
        history: history.length,
      };
    },
  };
}

/** Clamp every prop into the stage, apply the wind-down fade, and keep at most MAX_PROPS. */
function finalizeProps(props: readonly RenderProp[], ctx: Ctx, fade: number): RenderProp[] {
  const out: RenderProp[] = [];
  for (const p of props) {
    if (out.length >= MAX_PROPS) break;
    const alpha = clamp(p.alpha * fade, 0, 1);
    if (alpha <= 0.004) continue;
    const half = Math.min(p.size / 2, (ctx.right - ctx.left) / 2);
    out.push({
      ...p,
      alpha,
      x: clamp(finite(p.x, ctx.cat.x), ctx.left + half, ctx.right - half),
      y: clamp(finite(p.y, ctx.floorY), ctx.stage.y, ctx.floorY),
    });
  }
  return out;
}
