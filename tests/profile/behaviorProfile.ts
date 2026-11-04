// Behaviour-profile harness, version 2 (ADR 0003 §14-§15): measures the cat from hook records only.
//
// SIMULATED through REAL code, on one virtual clock (tests/profile/clock.ts), on the reporting
// user's screen (one 1920x1200 display at 125 %, auto-hide bottom taskbar, work area = screen):
//   - the real cat simulation (src/core/behavior Sim + Mover), seeded, created with
//     createInstrumentedCatSim and observed ONLY through SimHooks, each sub-step's SimEnv and
//     SimOutput and the public CatSim methods (tests/profile/recorder.ts): no private sim field;
//   - the real host loop (src/main/catHost.ts createCatHost) at its own tick cadence and catch-up;
//   - the real activity monitor (src/main/win32/activityMonitor.ts) fed a synthetic input stream,
//     so typing, typing intensity, cursor speed, flicks and idle come from the app's code;
//   - the real taskbar tracker over a fake auto-hide taskbar that slides like the user's
//     (tests/profile/desktop.ts), for the v1.2 users;
//   - provider-shaped surfaces from the app's own geometry code and the REAL Edge 156 strip probe.
// MOCKED: the OS side (window tracker, display service, overlays/hit-testing, cat store, surface
// provider) as small stubs; the v1.2 SimEnv fields pointerButtonDown, pointerButtonPresses,
// cursorIdleMs and edgeBands come from the harness's own ground truth (the synthetic user and the
// simulated desktop), not from catHost, until INT-b points the stubs at PRV's sources in wave 3.
// Not simulated: perception events, other monitors, browser tab add/close (only selection).
// Only kinds, counts, timings and geometry are recorded; no window title exists anywhere here.
import { createInstrumentedCatSim, mulberry32, newPersistedCat, type SimHooks } from '../../src/core/behavior';
import { simWorld } from '../../src/core/display/simWorld';
import { createCatHost, type HostOverlays, type HostSurfaceProvider } from '../../src/main/catHost';
import type { DisplayService, Logger, Win32Api, WindowTracker } from '../../src/main/contracts';
import { createActivityMonitor } from '../../src/main/win32/activityMonitor';
import { createTaskbarTracker } from '../../src/main/win32/taskbar';
import type { BehaviorProfileSnapshot, ExcursionRecord } from '../../src/shared/behaviorProfile';
import { PHYSICS_ERROR_CAUSES } from '../../src/shared/behaviorProfile';
import type { PersistedCat, Stats } from '../../src/shared/catState';
import { defaultSettings, type Settings } from '../../src/shared/settings';
import { PRESET_VALUES } from '../../src/shared/settingsPresets';
import type { CatSim, SimEnv, SimOutput } from '../../src/shared/sim';
import { BODY_PX, WORLD } from '../integration/surfaces/pipeline';
import { USER_TRAITS } from '../unit/core/behavior/liveness';
import { VirtualClock } from './clock';
import { Desktop, edgeFootprintPx, LAYOUT_DESCRIPTIONS, LAYOUT_IDS, SCREEN_H, SCREEN_W, TaskbarSim, type LayoutId } from './desktop';
import { concentration, dist, HOUR, kaplanMeier, kmQuantile, MIN, minGap, perHour, quantileOf, ratio, round3, seriesSummary, share, survivalAt, type Dist } from './metrics';
import { inc, PRESS_GAP_MS, Recorder, type Counter, type RunRecords } from './recorder';
import { REAL_THROW_SPACING_MS, User, USER_MODEL_DESCRIPTIONS, USER_MODEL_IDS, USER_MODELS, type UsageModel, type UserLog, type UserModelId } from './user';

export { HOUR, MIN } from './metrics';
export { LAYOUT_IDS, type LayoutId } from './desktop';
export { USER_MODEL_IDS, USER_MODELS, type UserModelId } from './user';

export const HARNESS_VERSION = 2;

// ------------------------------------------------------------------ profiles and variants

/** P1: the user's settings and cat. P2: defaults. Calm / Mischievous: the presets on defaults (informational). */
export type ProfileId = 'P1' | 'P2' | 'Calm' | 'Mischievous';
export const PROFILE_IDS: readonly ProfileId[] = ['P1', 'P2', 'Calm', 'Mischievous'];

/**
 * Setting and host variants of a cell: reactToTyping off (B6), the screenEdges opt-out (B11 "off"),
 * and no env.edgeBands at all (B11 "no bands": a host without the click guard).
 */
export type VariantId = 'default' | 'typingReactionsOff' | 'edgesOff' | 'noEdgeBands';
export const VARIANT_IDS: readonly VariantId[] = ['default', 'typingReactionsOff', 'edgesOff', 'noEdgeBands'];

/** The reporting user's cat now (installed 1.1.1, cat-state.json read 2026-10-29; traits as in liveness.ts). */
export const USER_STATS_NOW: Stats = { energy: 0.95, boredom: 0.013, bond: 0.6, annoyance: 0, fear: 0 };

/**
 * REAL evidence from the user's installed 1.1.1 (counters after 189 awake minutes), per awake hour.
 * pets counts seconds of stroking (the sim bumps it at most once per second), drags include throws,
 * throws are the hard ones only (the sim counts no others).
 */
export const USER_EVIDENCE_PER_AWAKE_HOUR = {
  awakeMin: 189,
  pets: (145 / 189) * 60,
  drags: (61 / 189) * 60,
  throws: (26 / 189) * 60,
  chasesStarted: (1 / 189) * 60,
  chasesEngaged: 0,
  windowsInspected: (2 / 189) * 60,
  naps: (12 / 189) * 60,
};

export function profileSettings(p: ProfileId, variant: VariantId = 'default'): Settings {
  const s = defaultSettings();
  if (p === 'P1') {
    Object.assign(s.behavior, { autonomy: 0.8, cursorPlay: 0.7, attentionSeeking: 0.5, activitySensitivity: 0.95, sleepAfterIdleMinutes: 30, chaseDurationSec: 5, movementSpeed: 1, disabledBehaviors: [] });
    // Mirrors the user's consented local statistics; no perception events are simulated.
    s.perception.visualMode = 'local-stats';
    s.perception.consentAt = '2026-10-29T15:31:00.000Z';
  } else if (p === 'Calm' || p === 'Mischievous') {
    const v = PRESET_VALUES[p === 'Calm' ? 'calm' : 'mischievous'];
    Object.assign(s.behavior, v.behavior, { activityPreset: p === 'Calm' ? 'calm' : 'mischievous' });
    Object.assign(s.interaction, v.interaction);
  }
  if (variant === 'typingReactionsOff') s.behavior.reactToTyping = false;
  if (variant === 'edgesOff') s.behavior.disabledExtras = [...s.behavior.disabledExtras, 'screenEdges'];
  return s;
}

/** P1: the user's traits and current stats. Others: a fresh cat (traits drawn from the seed, default stats). */
export function profileCat(p: ProfileId, seed: number, wall0: number, stats?: Partial<Stats>): PersistedCat {
  const cat = newPersistedCat(mulberry32(1000 + seed), wall0 - HOUR);
  if (p === 'P1') {
    Object.assign(cat.traits, USER_TRAITS);
    Object.assign(cat.stats, USER_STATS_NOW);
  }
  if (stats) Object.assign(cat.stats, stats);
  cat.lastPosition = null;
  return cat;
}

// ------------------------------------------------------------------ one run

export interface ProfileScenario {
  profile: ProfileId;
  layout: LayoutId;
  user: UserModelId;
  variant?: VariantId;
  seed: number;
  hours: number;
  /** Local hour the run starts at (the user's evidence session started 18:31). */
  startHour?: number;
  /** Overrides on the user model (scenarios: scripted throws, other rates). */
  usage?: Partial<UsageModel>;
  /** Overrides on the cat's stats at the start (B8: bond 0.3). */
  stats?: Partial<Stats>;
  /** Stop early (checked every sim minute), e.g. after 100 reactions. */
  stopWhen?: (rec: Recorder) => boolean;
  /** Keep the per-record lists in the result (default true; the report drops them unless asked). */
  keepRecords?: boolean;
  /** Called every sim second with the sim (B8 reads the drives over time). */
  onSecond?: (t: number, sim: CatSim) => void;
  /** Called after every sim sub-step with what the sim saw and did (harness tests). */
  onStep?: (env: SimEnv, out: SimOutput) => void;
}

export interface RunResult {
  profile: ProfileId;
  layout: LayoutId;
  user: UserModelId;
  variant: VariantId;
  seed: number;
  simMs: number;
  /** Awake = calm + active + interaction + reaction + physical (the snapshot's classes). */
  awakeMs: number;
  presentMs: number;
  traits: Record<string, number>;
  /** The sim's own session profile at the end (CatSim.behaviorProfile(), without recentStays). */
  snapshot: Omit<BehaviorProfileSnapshot, 'recentStays'>;
  time: {
    state: Counter;
    clip: Counter;
    support: Counter;
    classByState: Counter;
    movingMs: number;
    floorXDeciles: number[];
    floorEdgeMs: number;
    floorMs: number;
    front: Counter;
    frontElevated: Counter;
    asleepPresentMs: number;
    cursorWatchMs: number;
    cursorNearMs: number;
    playMs: number;
    playNearMs: number;
  };
  transitions: Counter;
  transitionCauses: Counter;
  napsWhilePresent: number;
  legacy: { chaseStarts: number; pounces: number; watchStarts: number };
  records: RunRecords;
  stats: Record<string, { min: number; mean: number; max: number; end: number }>;
  counters: Record<string, number>;
  nav: { climbs: Record<string, number> };
  userLog: Omit<UserLog, 'releases' | 'presses'> & { presses: number; pressGapsS: Dist; taskbarShownMs: number; taskbarRevealsSeen: number };
  desktop: Desktop['log'];
  hooks: Counter;
  integrity: { hostTicks: number; hostTickErrors: number; droppedEvents: number; invalidRequests: number; eventErrors: number; logErrors: number; wallMs: number };
}

const noop = (): void => undefined;

export function runProfile(sc: ProfileScenario): RunResult {
  const wallStart = Date.now();
  const variant = sc.variant ?? 'default';
  const usage: UsageModel = { ...USER_MODELS[sc.user], ...(sc.usage ?? {}) };
  const runMs = sc.hours * HOUR;
  const startHour = sc.startHour ?? 18.5;
  const wall0 = new Date(2026, 9, 29, Math.floor(startHour), Math.round((startHour % 1) * 60), 0).getTime();
  const clock = new VirtualClock();
  const settings = profileSettings(sc.profile, variant);
  const persisted = profileCat(sc.profile, sc.seed, wall0, sc.stats);
  let user: User | null = null;
  const cursorAt = (t: number) => user?.cursorAt(t) ?? { x: 1100, y: 520 };
  const taskbar = usage.taskbar ? new TaskbarSim(() => clock.now, cursorAt) : null;
  const desk = new Desktop(sc.layout, () => clock.now, mulberry32(0xd35c + sc.seed * 104_729), taskbar, edgeFootprintPx(settings.appearance.size));
  let logErrors = 0;
  const logger: Logger = {
    error: () => void logErrors++,
    warn: () => void logErrors++,
    info: noop,
    debug: noop,
    child: () => logger,
  };

  let recorder: Recorder | null = null;
  // The recorder needs the sim (public methods) and the sim needs the hooks: forward until it exists.
  let hooks: SimHooks = {};
  const sim = createInstrumentedCatSim(
    { persisted, settings, world: simWorld(WORLD), now: 0, random: mulberry32(sc.seed), wallClock: () => wall0 + clock.now },
    {
      onTransition: (r) => hooks.onTransition?.(r),
      onDecision: (r) => hooks.onDecision?.(r),
      onExcursion: (r) => hooks.onExcursion?.(r),
      onFall: (r) => hooks.onFall?.(r),
      onReaction: (r) => hooks.onReaction?.(r),
      onHunt: (r) => hooks.onHunt?.(r),
      onSlip: (r) => hooks.onSlip?.(r),
      onEdgeVisit: (r) => hooks.onEdgeVisit?.(r),
    },
  );
  const publicSim: CatSim = sim;

  let lastOut: SimOutput | null = null;
  let nextSecond = 0;
  const v12Env = (env: SimEnv): SimEnv => {
    const u = user;
    if (!u) return env;
    const t = env.now;
    const e: SimEnv = { ...env, pointerButtonDown: u.leftDown(t), pointerButtonPresses: u.pressCount, cursorIdleMs: u.cursorIdleMs(t) };
    if (variant === 'noEdgeBands') delete e.edgeBands;
    else e.edgeBands = desk.edgeBands();
    return e;
  };
  const hostSim: CatSim = {
    tick(env0, events) {
      const env = v12Env(env0);
      recorder?.beforeStep(env);
      const out = publicSim.tick(env, events);
      lastOut = out;
      recorder?.afterStep(env, events, out);
      sc.onStep?.(env, out);
      if (env.now >= nextSecond) {
        nextSecond = env.now + 1000;
        sc.onSecond?.(env.now, publicSim);
      }
      return out;
    },
    updateSettings: (s) => publicSim.updateSettings(s),
    setWorld: (w) => publicSim.setWorld(w),
    serialize: () => publicSim.serialize(),
    resetPersonality: () => publicSim.resetPersonality(),
    clearHistory: () => publicSim.clearHistory(),
    get state() {
      return publicSim.state;
    },
    debugInfo: () => publicSim.debugInfo(),
    surfaceDiagnostics: () => publicSim.surfaceDiagnostics(),
    surfaceDebugLines: () => publicSim.surfaceDebugLines(),
    behaviorProfile: () => publicSim.behaviorProfile(),
  };

  const u = new User(
    mulberry32(0x5eed + sc.seed * 7919),
    clock,
    desk,
    usage,
    settings.behavior.sleepAfterIdleMinutes * MIN,
    runMs,
    () => lastOut,
    (ev) => host.enqueue(ev),
    (r) => recorder?.onRelease(r),
  );
  user = u;
  const rec = new Recorder(publicSim, u, desk);
  recorder = rec;
  hooks = rec.hooks();
  const traits = { ...persisted.traits } as Record<string, number>;
  const counters0 = rec.counters();
  const climbs0 = { ...publicSim.surfaceDiagnostics().nav.climbs } as Record<string, number>;

  const win32 = {
    available: true,
    getCursorPos: () => u.cursorAt(clock.now),
    getIdleMs: () => u.idleMs(clock.now),
    isLeftButtonDown: () => u.leftDown(clock.now),
  } as unknown as Win32Api;
  const tracker = {
    mode: 'event-hooks',
    start: noop,
    stop: noop,
    drainEvents: () => desk.drainWindowEvents(),
    getForeground: () => desk.foreground,
    getPlatforms: () => [],
    getWindowRect: () => null,
    getFullscreenDisplayIds: () => [],
    isExcludedAt: () => false,
    isForegroundExcluded: () => false,
    getExcludedRects: () => [],
    setExclusions: noop,
  } as unknown as WindowTracker;
  const display: DisplayService = {
    world: WORLD,
    onChange: () => noop,
    toLocalDip: (_id, p) => ({ x: p.x / 1.25, y: p.y / 1.25 }),
    fromLocalDip: (_id, p) => ({ x: p.x * 1.25, y: p.y * 1.25 }),
    displayAt: (p) => (p.x >= 0 && p.x < SCREEN_W && p.y >= 0 && p.y < SCREEN_H ? '1' : null),
    refresh: () => false,
    dispose: noop,
  };
  const overlays: HostOverlays = {
    render: noop,
    updateInteractivity: noop,
    isCursorOverCat: (c) => u.isOverCat(c),
    get dragging() {
      return u.dragging;
    },
    pressed: false,
    interactive: false,
  };
  const taskbars = taskbar ? createTaskbarTracker(logger, { now: () => clock.now, native: taskbar.native(), world: WORLD }) : null;
  const provider = {
    getSurfaces: () => {
      desk.update();
      return taskbars && settings.behavior.disabledBehaviors.includes('taskbarPlay') === false ? [...taskbars.surfaces(), ...desk.listed] : desk.listed;
    },
    getSurface: (id: string) => {
      if (taskbars && id.startsWith('taskbar:')) return taskbars.surfaces().find((s) => s.id === id) ?? null;
      return desk.getSurface(id);
    },
    drainEvents: () => [...(taskbars ? taskbars.drainEvents() : []), ...desk.drainSurfaceEvents()],
  } as unknown as HostSurfaceProvider;
  const activity = createActivityMonitor(win32, logger, { now: () => clock.now });
  const host = createCatHost({
    sim: hostSim,
    win32,
    tracker,
    activity,
    perception: null,
    display,
    overlays,
    catStore: { markDirty: noop, save: () => Promise.resolve(true) },
    logger,
    getSettings: () => settings,
    cursorFallback: () => null,
    clock: () => clock.now,
    wallClock: () => new Date(wall0 + clock.now),
    timers: { setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h) },
    timeScale: 1,
    surfaces: provider,
    taskbars,
  });

  // Start order of src/main/app.ts.
  activity.start();
  taskbars?.start();
  host.updateSettings(settings);
  host.start();
  u.start();
  desk.start(clock);
  if (sc.stopWhen) {
    for (let t = MIN; t < runMs; t += MIN) {
      clock.runUntil(t);
      if (sc.stopWhen(rec)) break;
    }
    if (!sc.stopWhen(rec)) clock.runUntil(runMs);
  } else clock.runUntil(runMs);
  host.stop();
  taskbars?.stop();
  u.finish();
  rec.finish(rec.simMs);

  const counters1 = rec.counters();
  const counters: Record<string, number> = {};
  for (const [k, v] of Object.entries(counters1)) counters[k] = v - (counters0[k] ?? 0);
  const climbs1 = publicSim.surfaceDiagnostics().nav.climbs as Record<string, number>;
  const climbs: Record<string, number> = {};
  for (const [k, v] of Object.entries(climbs1)) climbs[k] = v - (climbs0[k] ?? 0);
  const stats: RunResult['stats'] = {};
  for (const [k, s] of Object.entries(rec.series)) stats[k] = seriesSummary(s);
  const { recentStays: _recent, ...snapshot } = publicSim.behaviorProfile();
  const t = snapshot.timeMs;
  const awakeMs = t.calm + t.active + t.interaction + t.reaction + t.physical;
  const dbg = publicSim.debugInfo();
  const hostDbg = host.debug();
  const { releases: _r, presses, ...userLog } = u.log;
  const gaps: number[] = [];
  for (let i = 1; i < presses.length; i++) gaps.push((presses[i]!.at - presses[i - 1]!.at) / 1000);
  const records = rec.records;
  return {
    profile: sc.profile,
    layout: sc.layout,
    user: sc.user,
    variant,
    seed: sc.seed,
    simMs: Math.round(rec.simMs),
    awakeMs: Math.round(awakeMs),
    presentMs: Math.round(rec.presentMs),
    traits,
    snapshot,
    time: {
      state: roundAll(rec.stateMs),
      clip: roundAll(rec.clipMs),
      support: roundAll(rec.supportMs),
      classByState: roundAll(rec.classByStateMs),
      movingMs: Math.round(rec.movingMs),
      floorXDeciles: rec.floorX.map(Math.round),
      floorEdgeMs: Math.round(rec.edgeMs),
      floorMs: Math.round(rec.floorMs),
      front: roundAll(rec.frontMs),
      frontElevated: roundAll(rec.frontElevatedMs),
      asleepPresentMs: Math.round(rec.asleepPresentMs),
      cursorWatchMs: Math.round(rec.cursorWatchMs),
      cursorNearMs: Math.round(rec.cursorNearMs),
      playMs: Math.round(rec.playMs),
      playNearMs: Math.round(rec.playNearMs),
    },
    transitions: rec.transitions,
    transitionCauses: rec.transitionCauses,
    napsWhilePresent: rec.napsWhilePresent,
    legacy: { chaseStarts: rec.chaseStarts, pounces: rec.legacyPounces, watchStarts: rec.watchStarts },
    records: sc.keepRecords === false ? emptyRecords() : records,
    stats,
    counters,
    nav: { climbs },
    userLog: { ...userLog, presses: presses.length, pressGapsS: dist(gaps), taskbarShownMs: Math.round(taskbar?.shownMs ?? 0), taskbarRevealsSeen: taskbar?.reveals ?? 0 },
    desktop: { ...desk.log },
    hooks: { ...rec.hookCalls },
    integrity: {
      hostTicks: hostDbg.ticks,
      hostTickErrors: hostDbg.tickErrors,
      droppedEvents: hostDbg.droppedEvents,
      invalidRequests: Number(dbg.invalidRequests ?? 0),
      eventErrors: Number(dbg.eventErrors ?? 0),
      logErrors,
      wallMs: Date.now() - wallStart,
    },
  };
}

export const emptyRecords = (): RunRecords => ({ decisions: [], stays: [], falls: [], reactions: [], hunts: [], slips: [], edgeVisits: [], strikes: [], releases: [], typing: [], pressTimes: [] });

function roundAll(c: Counter): Counter {
  const o: Counter = {};
  for (const [k, v] of Object.entries(c)) o[k] = Math.round(v);
  return o;
}

// ------------------------------------------------------------------ cells

export interface CellSpec {
  profile: ProfileId;
  layout: LayoutId;
  user: UserModelId;
  variant?: VariantId;
}

export const cellKey = (c: CellSpec): string => `${c.profile}/${c.layout}/${c.user}${c.variant && c.variant !== 'default' ? `+${c.variant}` : ''}`;

export function parseCellKey(key: string): CellSpec | null {
  const m = /^([^/]+)\/([^/]+)\/([^+]+)(?:\+(.+))?$/.exec(key);
  if (!m) return null;
  const [, profile, layout, user, variant] = m;
  if (!PROFILE_IDS.includes(profile as ProfileId) || !LAYOUT_IDS.includes(layout as LayoutId) || !USER_MODEL_IDS.includes(user as UserModelId)) return null;
  if (variant !== undefined && !VARIANT_IDS.includes(variant as VariantId)) return null;
  return { profile: profile as ProfileId, layout: layout as LayoutId, user: user as UserModelId, ...(variant ? { variant: variant as VariantId } : {}) };
}

const cross = (profiles: readonly ProfileId[], layouts: readonly LayoutId[], users: readonly UserModelId[], variants: readonly VariantId[] = ['default']): CellSpec[] =>
  profiles.flatMap((profile) => layouts.flatMap((layout) => users.flatMap((user) => variants.map((variant) => ({ profile, layout, user, variant })))));

/**
 * Named matrices. `bands`: every cell a §14 band is asserted on (plus the presets, informational).
 * `diagnosis`: the v1.2 diagnosis' cells (P1, P2 x L1-L3 with its user), for continuity.
 * `short`: the verify-fast subset (L1/P2/U-active).
 */
export const MATRICES: Readonly<Record<'bands' | 'diagnosis' | 'short', readonly CellSpec[]>> = {
  bands: [
    ...cross(['P1', 'P2'], ['L1', 'L2', 'L3', 'L4b', 'L5'], ['U-active']),
    ...cross(['P1', 'P2'], ['L1'], ['U-play', 'U-mouse-work']),
    ...cross(['P1', 'P2'], ['L1', 'L2'], ['U-hands-off']),
    ...cross(['P1', 'P2'], ['L1'], ['U-typing'], ['default', 'typingReactionsOff']),
    ...cross(['P1', 'P2'], ['L4'], ['U-active']),
    ...cross(['P2'], ['L4'], ['U-active'], ['edgesOff', 'noEdgeBands']),
    ...cross(['P2'], ['L3c', 'L1d'], ['U-active']),
    ...cross(['Calm', 'Mischievous'], ['L1'], ['U-active']),
  ],
  diagnosis: cross(['P1', 'P2'], ['L1', 'L2', 'L3'], ['U-legacy']),
  short: cross(['P2'], ['L1'], ['U-active']),
};
export type MatrixId = keyof typeof MATRICES;

// ------------------------------------------------------------------ the cell summary

/** Stays that ended by the cat's own leave intent are the events; every imposed end and the run's end censor (B3). */
export const isOwnLeave = (s: { endReason: ExcursionRecord['endReason']; open: boolean }): boolean => !s.open && s.endReason === 'leave';

const sumBy = <T>(xs: readonly T[], f: (x: T) => number): number => xs.reduce((a, x) => a + f(x), 0);

/** Pooled numbers for one cell over its seeds: what the bands assert and the report prints. */
export function summarizeCell(runs: readonly RunResult[]) {
  const simMs = sumBy(runs, (r) => r.simMs);
  const awakeMs = sumBy(runs, (r) => r.awakeMs);
  const presentMs = sumBy(runs, (r) => r.presentMs);
  const sum = (f: (r: RunResult) => Counter): Counter => {
    const c: Counter = {};
    for (const r of runs) for (const [k, v] of Object.entries(f(r))) inc(c, k, v);
    return c;
  };
  const pctOf = (c: Counter, total: number): Counter => {
    const o: Counter = {};
    for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) o[k] = share(v, total);
    return o;
  };
  const cls = sum((r) => r.snapshot.timeMs);
  const state = sum((r) => r.time.state);
  const support = sum((r) => r.time.support);
  const clip = sum((r) => r.time.clip);
  const front = sum((r) => r.time.front);
  const frontElevated = sum((r) => r.time.frontElevated);
  const moving = sumBy(runs, (r) => r.time.movingMs);
  const recs = <K extends keyof RunRecords>(k: K): Array<RunRecords[K][number]> => runs.flatMap((r) => r.records[k] as Array<RunRecords[K][number]>);

  // Stays (B2-B4, B13).
  const stays = recs('stays');
  const own = stays.filter((s) => s.arrivedBy !== 'carried');
  const km = kaplanMeier(own.map((s) => ({ t: s.dwellMs / 1000, event: isOwnLeave(s) })));
  const ended = own.filter((s) => !s.open).map((s) => s.dwellMs / 1000).sort((a, b) => a - b);
  const planned = own.filter((s) => s.plannedMs > 0).map((s) => s.plannedMs / 1000).sort((a, b) => a - b);
  const byEnd: Counter = {};
  const byLeave: Counter = {};
  const byRoute: Counter = {};
  for (const s of stays) {
    inc(byEnd, s.open ? 'open' : (s.endReason ?? 'null'));
    if (isOwnLeave(s) && s.leaveKind) inc(byLeave, s.leaveKind);
    inc(byRoute, s.arrivedBy);
  }
  const imposedLoss = stays.filter((s) => !s.open && (s.endReason === 'covered' || s.endReason === 'gone'));
  const leave = concentration(byLeave);
  const climbs = sum((r) => r.nav.climbs);
  const edgeVisits = recs('edgeVisits');
  const windowClimbs = Math.max(0, (climbs.leaps ?? 0) + (climbs.mounts ?? 0) - edgeVisits.length);

  // Hunts and strikes (B5, B5b, B5c, B6).
  const hunts = recs('hunts');
  const pounceTimesByRun = runs.map((r) => r.records.hunts.flatMap((h) => h.pounceTimes ?? []));
  const pressesByRun = runs.map((r) => r.records.pressTimes);
  const gaps = pounceTimesByRun.map((ts) => minGap(ts)).filter((g): g is number => g !== null);
  let pouncesNearPress = 0;
  pounceTimesByRun.forEach((ts, i) => {
    const ps = pressesByRun[i] ?? [];
    for (const t of ts) if (ps.some((p) => p <= t && t - p <= PRESS_GAP_MS)) pouncesNearPress++;
  });
  const strikes = recs('strikes');
  const pounceStrikes = strikes.filter((s) => s.clip === 'pounce');
  const clearances = hunts.map((h) => h.minClearanceDip).filter((x): x is number => typeof x === 'number');
  const typingAt = (runIdx: number, t: number): boolean => {
    const iv = runs[runIdx]!.records.typing;
    return iv.some(([a, b]) => t >= a && t <= b + 3000);
  };
  let huntsStartedTyping = 0;
  let pouncesTyping = 0;
  runs.forEach((r, i) => {
    for (const h of r.records.hunts) {
      if (typeof h.startedAt === 'number' && typingAt(i, h.startedAt)) huntsStartedTyping++;
      for (const t of h.pounceTimes ?? []) if (typingAt(i, t)) pouncesTyping++;
    }
  });
  const strikesTypingNearCursor = strikes.filter((s) => s.typingNear && s.cursorDxBw !== null && Math.abs(s.cursorDxBw) <= 3).length;
  const decisions = recs('decisions');
  const playNearCursorTyping = decisions.filter((d) => d.typingNear && (d.state === 'playing' || d.state === 'chasingCursor') && d.cursorDistBw !== null && d.cursorDistBw <= 3).length;
  const huntOutcomes: Counter = {};
  const huntGates: Counter = {};
  for (const h of hunts) {
    inc(huntOutcomes, h.outcome);
    if (h.gate) inc(huntGates, h.gate);
  }

  // Reactions (B7).
  const reactions = recs('reactions');
  const reactionKinds: Counter = {};
  for (const r of reactions) inc(reactionKinds, r.kind);
  const rc = concentration(reactionKinds);
  const releases = recs('releases');
  const hardReleases = releases.filter((r) => r.kind === 'throw' && r.thrown);
  const firstAfterHard: Counter = {};
  for (const r of hardReleases) inc(firstAfterHard, r.first);

  // Falls (B9, B13), slips (B10), edges (B11), moods (B8b), sleep (B15), watchdog (B14).
  const falls = recs('falls');
  const fallCauses: Counter = {};
  const fallImpacts: Counter = {};
  for (const f of falls) {
    inc(fallCauses, f.cause);
    inc(fallImpacts, f.impact);
  }
  const slips = recs('slips');
  const slipKinds: Counter = {};
  for (const s of slips) inc(slipKinds, s.kind);
  const edgeSides: Counter = {};
  const edgeLeave: Counter = {};
  for (const e of edgeVisits) {
    inc(edgeSides, e.side);
    inc(edgeLeave, e.leave);
  }
  const mood = sum((r) => r.snapshot.moodMs);
  const decisionCauses: Counter = {};
  const decisionClasses: Counter = {};
  const picks: Counter = {};
  const episodes: Counter = {};
  for (const d of decisions) {
    inc(decisionCauses, d.cause);
    inc(decisionClasses, d.activityClass);
    inc(picks, `${d.state}:${d.variant ?? '-'}`);
    inc(episodes, d.episode);
  }
  const tripDecisions = decisions.filter((d) => d.variant === 'explore' || d.variant === 'climb' || d.variant === 'tabStrip' || d.variant === 'hop' || d.variant === 'screenEdge').length;

  const statsTable: Record<string, { min: number; mean: number; max: number }> = {};
  for (const k of [...new Set(runs.flatMap((r) => Object.keys(r.stats)))]) {
    const ss = runs.map((r) => r.stats[k]).filter((s): s is NonNullable<typeof s> => !!s);
    statsTable[k] = { min: round3(Math.min(...ss.map((s) => s.min))), mean: round3(sumBy(ss, (s) => s.mean) / Math.max(1, ss.length)), max: round3(Math.max(...ss.map((s) => s.max))) };
  }
  const counters = sum((r) => r.counters);
  const countersPerAwakeHour: Counter = {};
  for (const [k, v] of Object.entries(counters)) countersPerAwakeHour[k] = perHour(v, awakeMs);
  const floorMs = sumBy(runs, (r) => r.time.floorMs);
  const typingMs = sumBy(runs, (r) => sumBy(r.records.typing, ([a, b]) => b - a));
  const kmS = (q: number): number | null => {
    const v = kmQuantile(km, q);
    return v === null ? null : Math.round(v * 10) / 10;
  };
  const q = (arr: number[], p: number): number | null => {
    const v = quantileOf(arr, p);
    return v === null ? null : Math.round(v * 10) / 10;
  };
  const hours = simMs / HOUR;
  return {
    runs: runs.length,
    seeds: runs.map((r) => r.seed),
    simHours: Math.round(hours * 100) / 100,
    awakeHours: Math.round((awakeMs / HOUR) * 100) / 100,
    presentHours: Math.round((presentMs / HOUR) * 100) / 100,
    /** B1: the snapshot's variant-aware active share of awake time (activityClassOf). */
    activeShare: ratio(cls.active ?? 0, awakeMs),
    activeShareBySeed: Object.fromEntries(runs.map((r) => [String(r.seed), r.snapshot.activeShare])),
    /** The same from the output state alone (ACTIVITY_CLASS, no variants): the v1.1.1 measure. */
    activeShareByState: ratio(sumBy(runs, (r) => r.time.classByState.active ?? 0), simMs - sumBy(runs, (r) => (r.time.classByState.asleep ?? 0) + (r.time.classByState.away ?? 0))),
    timeSharePct: {
      classOfAwake: pctOf(Object.fromEntries(Object.entries(cls).filter(([k]) => k !== 'asleep' && k !== 'away')), awakeMs),
      classOfSim: pctOf(cls, simMs),
      moving: share(moving, simMs),
      elevated: share((support.windowTop ?? 0) + (support.tabStrip ?? 0) + (support.windowSide ?? 0) + (support.screenEdge ?? 0), simMs),
      support: pctOf(support, simMs),
      state: pctOf(state, simMs),
      clip: pctOf(clip, simMs),
      front: pctOf(front, simMs),
      elevatedWhileWindowFront: share(frontElevated.windowFront ?? 0, front.windowFront ?? 0),
      elevatedWhileMaximizedFront: share(frontElevated.maximizedFront ?? 0, front.maximizedFront ?? 0),
    },
    decisions: {
      total: decisions.length,
      perAwakeMin: Math.round((decisions.length / Math.max(1, awakeMs / MIN)) * 100) / 100,
      byCause: decisionCauses,
      byClassPct: pctOf(decisionClasses, decisions.length),
      byEpisode: episodes,
      topPicksPct: Object.fromEntries(Object.entries(pctOf(picks, decisions.length)).slice(0, 20)),
      tripDecisionsPerHour: perHour(tripDecisions, simMs),
    },
    stays: {
      arrivals: stays.length,
      ownArrivals: own.length,
      /** B2: own arrivals (not carried up by the user) per sim hour. */
      ownArrivalsPerHour: perHour(own.length, simMs),
      byRoute,
      /** B2: wall mounts and leaps onto window sides per hour (screen-edge climbs excluded). */
      windowClimbsPerHour: perHour(windowClimbs, simMs),
      tripSuccessPct: share(own.length, tripDecisions),
      /** B3: Kaplan-Meier over own arrivals, own leaves = events, imposed ends and the run end censored (seconds). */
      km: { n: km.n, events: km.events, p10: kmS(0.1), median: kmS(0.5), p90: kmS(0.9), pOver5min: round3(survivalAt(km, 300)), pOver15min: round3(survivalAt(km, 900)) },
      /** The experienced (uncensored) dwell of every finished own stay. */
      experiencedMedianS: q(ended, 0.5),
      dwellS: dist(ended),
      /** B3: the stay intents drawn on arrival (seconds). */
      planned: { n: planned.length, p10: q(planned, 0.1), median: q(planned, 0.5), p90: q(planned, 0.9), over5minShare: ratio(planned.filter((x) => x > 300).length, planned.length) },
      byEnd,
      byLeave,
      /** B4: own departures by leave kind. */
      leave: { departures: leave.total, kinds: leave.kinds, maxShare: round3(leave.maxShare), maxKind: leave.maxKind },
      /** B13: covered / gone ends and how many of them had a controlled bail-out. */
      imposedLoss: { n: imposedLoss.length, withBailOut: imposedLoss.filter((s) => !!s.bailOut).length, covered: imposedLoss.filter((s) => s.endReason === 'covered').length },
      resumed: stays.filter((s) => s.resumed).length,
    },
    hunts: {
      count: hunts.length,
      perHour: perHour(hunts.length, simMs),
      pounces: sumBy(hunts, (h) => h.pounces),
      pouncesPerHour: perHour(sumBy(hunts, (h) => h.pounces), simMs),
      /** B5: the smallest gap between two pounces of one run (s); null with fewer than two. */
      minPounceGapS: gaps.length ? Math.round(Math.min(...gaps) / 100) / 10 : null,
      /** B5c: the smallest recorded hit-region clearance of any pounce or strike (DIP). */
      minClearanceDip: clearances.length ? Math.round(Math.min(...clearances) * 10) / 10 : null,
      clearanceBelow8: clearances.filter((c) => c < 8).length,
      /** B5b: pounces within 2 s after a press; pounce landings within 1 bw of a recent press point. */
      pouncesNearPress,
      pounceLandingsNearPressPoint: pounceStrikes.filter((s) => s.pressNearBw !== null && s.pressNearBw <= 1).length,
      /** B6: hunts and pounces started while typing (raw signal) or within 3 s after. */
      startedWhileTyping: huntsStartedTyping,
      pouncesWhileTyping: pouncesTyping,
      byOutcome: huntOutcomes,
      byGate: huntGates,
      /** v1.1.1 measures from transitions (comparable with the diagnosis baseline). */
      legacy: {
        chaseStartsPerHour: perHour(sumBy(runs, (r) => r.legacy.chaseStarts), simMs),
        pouncesPerHour: perHour(sumBy(runs, (r) => r.legacy.pounces), simMs),
        watchStartsPerHour: perHour(sumBy(runs, (r) => r.legacy.watchStarts), simMs),
      },
    },
    strikes: {
      byClip: Object.fromEntries([...new Set(strikes.map((s) => s.clip))].map((c) => [c, strikes.filter((s) => s.clip === c).length])),
      /** B6: strike clips (pounce, swat, pawAt) started while typing or < 3 s after, cursor within 3 bw. */
      whileTypingNearCursor: strikesTypingNearCursor,
      /** B6: play or chase decisions while typing or < 3 s after, cursor within 3 bw. */
      playNearCursorWhileTyping: playNearCursorTyping,
    },
    reactions: {
      n: reactions.length,
      byKind: reactionKinds,
      kinds: rc.kinds,
      maxShare: round3(rc.maxShare),
      maxKind: rc.maxKind,
      hideShare: ratio(reactionKinds.hide ?? 0, reactions.length),
      cappedShare: ratio(reactions.filter((r) => r.capped).length, reactions.length),
      byTrigger: Object.fromEntries(['throw', 'roughDrag'].map((k) => [k, reactions.filter((r) => (r.trigger ?? 'throw') === k).length])),
      /** v1.1.1 measure: what the cat did first after a counted hard throw (transitions). */
      legacyHard: { n: hardReleases.length, hidPct: share(hardReleases.filter((r) => r.hid).length, hardReleases.length), first: firstAfterHard, recoveryS: dist(hardReleases.filter((r) => r.recoveryMs !== null).map((r) => (r.recoveryMs as number) / 1000)) },
    },
    falls: {
      count: falls.length,
      perHour: perHour(falls.length, simMs),
      byCause: fallCauses,
      byImpact: fallImpacts,
      /** B9: falls whose cause is a physics error ('covered' without a bail-out, 'physics'). */
      physicsErrors: falls.filter((f) => PHYSICS_ERROR_CAUSES.has(f.cause)).length,
      legacyToFallingPerHour: perHour(sumBy(runs, (r) => Object.entries(r.transitions).filter(([k]) => k.endsWith('>falling')).reduce((a, [, v]) => a + v, 0)), simMs),
    },
    slips: { count: slips.length, perAwakeHour: perHour(slips.length, awakeMs), byKind: slipKinds },
    edges: {
      visits: edgeVisits.length,
      visitsPerHour: perHour(edgeVisits.length, simMs),
      peeks: edgeVisits.filter((e) => e.covered).length,
      peeksPerHour: perHour(edgeVisits.filter((e) => e.covered).length, simMs),
      bySide: edgeSides,
      topReached: edgeVisits.filter((e) => e.topReached).length,
      leave: edgeLeave,
      holdS: dist(edgeVisits.map((e) => e.holdMs / 1000)),
    },
    /** B8b: shares of awake time with wariness > 0.3, irritability > 0.5, fear > 0.3 (the snapshot's moodMs). */
    moods: { waryShare: ratio(mood.wary ?? 0, awakeMs), irritableShare: ratio(mood.irritable ?? 0, awakeMs), fearfulShare: ratio(mood.fearful ?? 0, awakeMs) },
    /** B15: asleep share of the user's present time; naps entered while the user was present, per present hour. */
    sleep: {
      asleepShareOfPresent: ratio(sumBy(runs, (r) => r.time.asleepPresentMs), presentMs),
      napsPerPresentHour: perHour(sumBy(runs, (r) => r.napsWhilePresent), presentMs),
      sleepsPerAwakeHour: perHour(sumBy(runs, (r) => r.snapshot.sleeps), awakeMs),
      asleepShareOfSim: ratio(cls.asleep ?? 0, simMs),
    },
    /** B14: progress-monitor resets (snapshot) and watchdog decisions. */
    stuckResets: sumBy(runs, (r) => r.snapshot.stuckResets),
    watchdogDecisions: decisionCauses.watchdog ?? 0,
    stats: statsTable,
    countersPerAwakeHour,
    floor: { xDecilesPct: Array.from({ length: 10 }, (_, i) => share(sumBy(runs, (r) => r.time.floorXDeciles[i] ?? 0), floorMs)), nearScreenEdgePct: share(sumBy(runs, (r) => r.time.floorEdgeMs), floorMs) },
    user: {
      petSessionsPerPresentHour: perHour(sumBy(runs, (r) => r.userLog.petSessions), presentMs),
      dragsPerPresentHour: perHour(sumBy(runs, (r) => r.userLog.drags), presentMs),
      throwsPerPresentHour: perHour(sumBy(runs, (r) => r.userLog.throws), presentMs),
      pressesPerPresentHour: perHour(sumBy(runs, (r) => r.userLog.presses), presentMs),
      taskbarRevealsPerHour: perHour(sumBy(runs, (r) => r.userLog.taskbarReveals), simMs),
      taskbarShownPct: share(sumBy(runs, (r) => r.userLog.taskbarShownMs), simMs),
      typingRawPctOfPresent: share(typingMs, presentMs),
      cursorNearCatPctOfPresent: share(sumBy(runs, (r) => r.time.cursorNearMs), presentMs),
      cursorInWatchBandPctOfPresent: share(sumBy(runs, (r) => r.time.cursorWatchMs), presentMs),
      /** U-play: the play mode's share of the present time, and how much of it the cursor was within 6 bw of the cat. */
      playPctOfPresent: share(sumBy(runs, (r) => r.time.playMs), presentMs),
      cursorNearInPlayPct: share(sumBy(runs, (r) => r.time.playNearMs), sumBy(runs, (r) => r.time.playMs)),
      modeSharePct: pctOf(sum((r) => r.userLog.modeMs), simMs),
      presentPct: share(presentMs, simMs),
    },
    desktop: {
      maximizedFrontPct: share(sumBy(runs, (r) => r.desktop.maximizedFrontMs), simMs),
      noWindowPct: share(sumBy(runs, (r) => r.desktop.noWindowMs), simMs),
      tabSwitchesPerHour: perHour(sumBy(runs, (r) => r.desktop.tabSwitches), simMs),
      churnPerHour: perHour(sumBy(runs, (r) => r.desktop.covers + r.desktop.maximizes + r.desktop.minimizes), simMs),
      windowDragsPerHour: perHour(sumBy(runs, (r) => r.desktop.drags), simMs),
      swaps: sumBy(runs, (r) => r.desktop.swaps),
    },
    nav: climbs,
    hooks: sum((r) => r.hooks),
    integrity: {
      hostTickErrors: sumBy(runs, (r) => r.integrity.hostTickErrors),
      invalidRequests: sumBy(runs, (r) => r.integrity.invalidRequests),
      eventErrors: sumBy(runs, (r) => r.integrity.eventErrors),
      logErrors: sumBy(runs, (r) => r.integrity.logErrors),
      wallSec: Math.round(sumBy(runs, (r) => r.integrity.wallMs) / 1000),
    },
  };
}
export type CellSummary = ReturnType<typeof summarizeCell>;

// ------------------------------------------------------------------ scenarios (B7, B8)

/**
 * B7: hard throws at the REAL spacing (8.3 per awake hour) onto a cat whose user otherwise rests
 * the hand, until `throws` reactions are recorded. Returns the run (records.reactions).
 */
export function runThrowMonteCarlo(profile: ProfileId, seed: number, throws = 100, layout: LayoutId = 'L1'): RunResult {
  const hours = Math.ceil(((throws * REAL_THROW_SPACING_MS) / HOUR) * 1.6);
  return runProfile({
    profile,
    layout,
    user: 'U-active',
    seed,
    hours,
    usage: { petsPerHour: 0, dragsPerHour: 0, throwsPerHour: HOUR / REAL_THROW_SPACING_MS, hardThrowsOnly: true, longIdle: false, modeShares: { pause: 1 } },
    // A sim without reaction records (v1.1.1) stops after 1.5x the throws instead of running the whole budget.
    stopWhen: (rec) => rec.records.reactions.length >= throws || rec.records.releases.filter((r) => r.kind === 'throw').length >= throws * 1.5,
  });
}

/** B8's drive trajectory: wariness, irritability (drives) and fear (stats) every sim second. */
export interface RecoveryTrace {
  burstEndMs: number;
  pre: { irritability: number };
  samples: Array<{ t: number; fear: number; irritability: number; wariness: number }>;
  run: RunResult;
}

/** The REAL petting rate as a session spacing (8.5 sessions per present hour, diagnosis §1.5). */
export const REAL_PET_SPACING_MS = HOUR / USER_MODELS['U-active'].petsPerHour;

/**
 * B8: 5 hard throws about 20 s apart after 5 min (bond 0.3), then 15 min without handling, or with
 * petting at the REAL rate (`petting`: a session 60 s after the burst, then every
 * REAL_PET_SPACING_MS). The trace starts at the last throw.
 */
export function runRecovery(profile: ProfileId, seed: number, petting: boolean): RecoveryTrace {
  const t0 = 5 * MIN;
  const script: Array<{ at: number; kind: 'pet' | 'throw' }> = Array.from({ length: 5 }, (_, i) => ({ at: t0 + i * 20_000, kind: 'throw' as const }));
  if (petting) for (let at = t0 + 80_000 + MIN; at < t0 + 100_000 + 15 * MIN; at += REAL_PET_SPACING_MS) script.push({ at, kind: 'pet' });
  const samples: RecoveryTrace['samples'] = [];
  let pre = { irritability: 0 };
  const run = runProfile({
    profile,
    layout: 'L1',
    user: 'U-active',
    seed,
    hours: (t0 + 100_000 + 15 * MIN) / HOUR,
    stats: { bond: 0.3 },
    usage: { petsPerHour: 0, dragsPerHour: 0, throwsPerHour: 0, hardThrowsOnly: true, longIdle: false, modeShares: { pause: 1 }, script },
    onSecond: (t, sim) => {
      const c = sim.serialize();
      if (t < t0) pre = { irritability: c.drives.irritability };
      samples.push({ t, fear: c.stats.fear, irritability: c.drives.irritability, wariness: c.drives.wariness });
    },
  });
  const lastThrow = Math.max(...run.records.releases.filter((r) => r.kind === 'throw').map((r) => r.at), t0);
  return { burstEndMs: lastThrow, pre, samples: samples.filter((s) => s.t >= lastThrow), run };
}

// ------------------------------------------------------------------ many runs, aggregated

export interface ProfileConfig {
  label: string;
  hours: number;
  seeds: number[];
  cells: CellSpec[];
  startHour?: number;
  /** Keep every run's record lists in the JSON (large). */
  records?: boolean;
}

/**
 * From the environment (scripts/behavior-profile.mjs sets these): DESKTOP_CAT_PROFILE_MATRIX
 * (bands | diagnosis | short; default bands), or an explicit cross product of _PROFILES, _LAYOUTS,
 * _USERS, _VARIANTS; _CELLS (comma-separated cell keys) wins over both. _HOURS (3), _SEEDS (8 or
 * a list), _LABEL, _START_HOUR, _RECORDS=1.
 */
export function configFromEnv(env: Record<string, string | undefined>): ProfileConfig {
  const list = <T extends string>(v: string | undefined, all: readonly T[]): T[] | null => (v ? (v.split(',').map((s) => s.trim()).filter((s) => (all as readonly string[]).includes(s)) as T[]) : null);
  const seedsRaw = env.DESKTOP_CAT_PROFILE_SEEDS ?? '8';
  const seeds = seedsRaw.includes(',') ? seedsRaw.split(',').map(Number).filter(Number.isFinite) : Array.from({ length: Math.max(1, Number(seedsRaw) || 8) }, (_, i) => i + 1);
  let cells: CellSpec[];
  const explicit = env.DESKTOP_CAT_PROFILE_CELLS ? env.DESKTOP_CAT_PROFILE_CELLS.split(',').map((k) => parseCellKey(k.trim())).filter((c): c is CellSpec => c !== null) : null;
  const profiles = list(env.DESKTOP_CAT_PROFILE_PROFILES, PROFILE_IDS);
  const layouts = list(env.DESKTOP_CAT_PROFILE_LAYOUTS, LAYOUT_IDS);
  const users = list(env.DESKTOP_CAT_PROFILE_USERS, USER_MODEL_IDS);
  const variants = list(env.DESKTOP_CAT_PROFILE_VARIANTS, VARIANT_IDS);
  if (explicit && explicit.length) cells = explicit;
  else if (profiles || layouts || users || variants) cells = cross(profiles ?? ['P1', 'P2'], layouts ?? ['L1', 'L2', 'L3'], users ?? ['U-active'], variants ?? ['default']);
  else {
    const m = (env.DESKTOP_CAT_PROFILE_MATRIX ?? 'bands') as MatrixId;
    cells = [...(MATRICES[m] ?? MATRICES.bands)];
  }
  return {
    label: (env.DESKTOP_CAT_PROFILE_LABEL ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_'),
    hours: Math.max(0.05, Number(env.DESKTOP_CAT_PROFILE_HOURS ?? '3') || 3),
    seeds,
    cells,
    ...(env.DESKTOP_CAT_PROFILE_START_HOUR ? { startHour: Number(env.DESKTOP_CAT_PROFILE_START_HOUR) } : {}),
    ...(env.DESKTOP_CAT_PROFILE_RECORDS === '1' ? { records: true } : {}),
  };
}

/** A run without its record lists (what the report keeps per run by default). */
export type SlimRun = Omit<RunResult, 'records'> & { records?: RunRecords };

export interface ProfileReport {
  meta: {
    harnessVersion: number;
    label: string;
    createdAt: string;
    config: ProfileConfig;
    usage: Record<string, UsageModel>;
    users: Record<string, string>;
    screen: string;
    layouts: Record<string, string>;
    userEvidencePerAwakeHour: typeof USER_EVIDENCE_PER_AWAKE_HOUR;
    labels: string;
  };
  cells: Record<string, CellSummary>;
  runs: SlimRun[];
  /** Filled by the band evaluation (tests/profile/bands.ts). */
  bands?: unknown;
}

export interface CellCheckpoint {
  harnessVersion: number;
  key: string;
  hours: number;
  seeds: number[];
  summary: CellSummary;
  runs: SlimRun[];
}

/** Runs every cell (or loads its checkpoint), pooling the seeds per cell. */
export function runProfiles(
  cfg: ProfileConfig,
  log: (msg: string) => void = noop,
  checkpoints?: { load(key: string): CellCheckpoint | null; save(cp: CellCheckpoint): void },
): ProfileReport {
  const cells: Record<string, CellSummary> = {};
  const all: SlimRun[] = [];
  for (const spec of cfg.cells) {
    const key = cellKey(spec);
    const cp = checkpoints?.load(key);
    if (cp && cp.harnessVersion === HARNESS_VERSION && cp.hours === cfg.hours && cp.seeds.join(',') === cfg.seeds.join(',')) {
      cells[key] = cp.summary;
      all.push(...cp.runs);
      log(`profile ${key}: checkpoint reused (${cp.runs.length} runs)`);
      continue;
    }
    const runs: RunResult[] = [];
    for (const seed of cfg.seeds) {
      const r = runProfile({ ...spec, seed, hours: cfg.hours, ...(cfg.startHour !== undefined ? { startHour: cfg.startHour } : {}) });
      runs.push(r);
      log(`profile ${key} seed ${seed}: ${(r.simMs / HOUR).toFixed(2)} sim-h in ${(r.integrity.wallMs / 1000).toFixed(1)} s; ${r.records.decisions.length} decisions, ${r.records.stays.filter((s) => s.arrivedBy !== 'carried').length} own arrivals, ${r.records.hunts.length} hunts, ${r.legacy.chaseStarts} chases`);
    }
    const summary = summarizeCell(runs);
    cells[key] = summary;
    const slim: SlimRun[] = runs.map((r) => {
      const { records, ...rest } = r;
      return cfg.records ? { ...rest, records } : rest;
    });
    all.push(...slim);
    checkpoints?.save({ harnessVersion: HARNESS_VERSION, key, hours: cfg.hours, seeds: cfg.seeds, summary, runs: slim });
  }
  const users = [...new Set(cfg.cells.map((c) => c.user))];
  return {
    meta: {
      harnessVersion: HARNESS_VERSION,
      label: cfg.label,
      createdAt: new Date().toISOString(),
      config: cfg,
      usage: Object.fromEntries(users.map((u) => [u, USER_MODELS[u]])),
      users: Object.fromEntries(users.map((u) => [u, USER_MODEL_DESCRIPTIONS[u]])),
      screen: '1920x1200 px @125 % (1536x960 DIP), auto-hide bottom taskbar (work area = screen), app floor inset',
      layouts: Object.fromEntries([...new Set(cfg.cells.map((c) => c.layout))].map((l) => [l, LAYOUT_DESCRIPTIONS[l]])),
      userEvidencePerAwakeHour: USER_EVIDENCE_PER_AWAKE_HOUR,
      labels:
        'SIMULATED: real Sim/Mover/host loop/activity monitor/taskbar tracker with synthetic input and provider-shaped surfaces, measured from SimHooks records; MOCKED OS stubs and the v1.2 env fields (buttons, presses, cursor idle, edge bands) from the harness; not the real desktop',
    },
    cells,
    runs: all,
  };
}

/** Body width in px (the bands are stated in body widths). */
export const BW_PX = BODY_PX;
