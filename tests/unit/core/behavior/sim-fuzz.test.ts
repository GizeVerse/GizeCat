// Randomised long-run test: random events, random environment and topology changes,
// checking state-machine and output invariants on every tick.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import { ANIM_CLIPS, BEHAVIOR_STATES, EMOTES } from '../../../../src/shared/cat';
import { AI_REACTIONS, VISUAL_EVENT_KINDS } from '../../../../src/shared/perception';
import type { Rect } from '../../../../src/shared/geometry';
import { TOGGLEABLE_BEHAVIORS } from '../../../../src/shared/settings';
import type { SimEvent } from '../../../../src/shared/sim';
import type { Surface } from '../../../../src/shared/surfaces';
import type { WindowInfo, WorldGeometry } from '../../../../src/shared/world';
import { APP_CATEGORIES } from '../../../../src/shared/world';
import { canTransition, MAX_STATE_CHANGES_PER_WINDOW, mulberry32, STATE_CHANGE_WINDOW_MS, STATE_SPECS } from '../../../../src/core/behavior';
import { mayInterrupt, PHYSICAL_STATES } from '../../../../src/core/behavior/states';
import type { Random } from '../../../../src/core/behavior/random';
import { MOVEMENT } from '../../../../src/core/movement';
import { display, DUAL_FLAT, DUAL_MIXED, Harness, insideAnyWorkArea, settingsWith, SINGLE, stripId, surfacesFromWindows, tabStrip, taskbar, taskbarId, world } from './fixtures';

/** Two auto-hide displays (work area = whole screen) at mixed DPI: taskbars slide in above the floor. */
const AUTOHIDE_MIXED = world(display('1', 0, 0, 1920, 1200, { primary: true }), display('2', 1920, -200, 2560, 1440, { scale: 1.25 }));
const WORLDS: WorldGeometry[] = [DUAL_MIXED, SINGLE, DUAL_FLAT, AUTOHIDE_MIXED];
/** Longest a free fall may last before the mover forces a landing (MAX_FLIGHT_MS), plus a tick. */
const MAX_AIR_MS = 6000 + 500;
const STATE_SET: ReadonlySet<string> = new Set(BEHAVIOR_STATES);
const CLIP_SET: ReadonlySet<string> = new Set(ANIM_CLIPS);
const EMOTE_SET: ReadonlySet<string> = new Set(EMOTES);
const AIR_STATES: ReadonlySet<string> = new Set(['jumping', 'falling', 'held', 'landing']);

interface FuzzResult {
  ticks: number;
  simMs: number;
  states: Set<BehaviorState>;
  forbiddenSeen: Set<BehaviorState>;
  debug: Record<string, unknown>;
  /** Ticks spent on each kind of environment surface. */
  onSurface: Record<string, number>;
}

function fuzz(seed: number, ticks: number, opts: { disabledAll?: boolean } = {}): FuzzResult {
  const r: Random = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const settings = settingsWith({ behavior: { disabledBehaviors: opts.disabledAll ? [...TOGGLEABLE_BEHAVIORS] : [], cursorPlay: 0.9, attentionSeeking: 0.9, autonomy: 0.8 } });
  const h = new Harness({ seed: seed + 1000, world: DUAL_MIXED, settings });
  let worldIdx = 0;
  const windows: Record<string, Rect | null> = {};
  h.env.windows = windows;
  let held = false;
  let idleMs = 0;
  let prev = h.step();
  const states = new Set<BehaviorState>();
  const forbiddenSeen = new Set<BehaviorState>();
  const lastExit = new Map<BehaviorState, number>();
  const counted: number[] = [];
  let checked = 0;
  let lastPerception = -Infinity;
  let lastSave = -Infinity;

  const randPoint = () => {
    const w = WORLDS[worldIdx] as WorldGeometry;
    const d = pick(w.displays).workAreaPx;
    return { x: d.x + r() * d.width * 1.2 - d.width * 0.1, y: d.y + r() * d.height * 1.2 - d.height * 0.1 };
  };
  const randRect = (): Rect => {
    const p = randPoint();
    return { x: p.x, y: p.y, width: 150 + r() * 1200, height: 100 + r() * 800 };
  };
  const winInfo = (id: string): WindowInfo => ({
    id,
    rect: windows[id] ?? randRect(),
    processName: 'x.exe',
    category: pick(APP_CATEGORIES),
    minimized: r() < 0.05,
    maximized: r() < 0.05,
    fullscreen: false,
    excluded: r() < 0.1,
  });

  const randomEvent = (): SimEvent => {
    const at = r() < 0.02 ? { x: Number.NaN, y: 3 } : randPoint();
    const catAt = { x: prev.x + (r() - 0.5) * 40, y: prev.y - 30 };
    const ids = Object.keys(windows);
    const id = ids.length > 0 && r() < 0.8 ? pick(ids) : `w${Math.floor(r() * 9)}`;
    switch (Math.floor(r() * 30)) {
      case 0:
        return { type: 'pointer.tap', at: catAt };
      case 1:
        return { type: 'pointer.doubleTap', at: catAt };
      case 2:
        return { type: 'pointer.pet', at: catAt, strength: r() * 1.4 - 0.2 };
      case 3:
        held = true;
        return { type: 'pointer.dragStart', at: catAt };
      case 4:
        held = false;
        return { type: 'pointer.dragEnd', at, velocity: { x: (r() - 0.5) * 9000, y: (r() - 0.5) * 9000 } };
      case 5:
        return { type: 'pointer.hoverStart', at: catAt };
      case 6:
        return { type: 'window.shown', window: winInfo(id) };
      case 7:
        return { type: 'window.closed', id, rect: r() < 0.8 ? randRect() : null, category: pick(APP_CATEGORIES) };
      case 8:
        return { type: 'window.foreground', window: r() < 0.8 ? winInfo(id) : null, switchesPerMinute: r() * 20 };
      case 9:
        return { type: 'window.moveStart', id };
      case 10:
        return { type: 'window.moveEnd', id, rect: windows[id] ?? null };
      case 11:
        return { type: 'window.minimized', id };
      case 12:
        return { type: 'window.restored', window: winInfo(id) };
      case 13:
        return { type: 'activity.typingStart' };
      case 14:
        return { type: 'activity.typingEnd', durationMs: r() * 60_000 };
      case 15:
        return { type: 'activity.userIdle', idleMs };
      case 16:
        return { type: 'activity.userReturned', idleMs: r() * 3_600_000 };
      case 17:
        return { type: 'cursor.flick', speed: r() * 6000, at };
      case 18:
        return { type: 'system.lock' };
      case 19:
        return { type: 'system.unlock' };
      case 20:
        return {
          type: 'perception.visual',
          summary: {
            features: { brightness: r(), contrast: r(), colorfulness: r(), edgeDensity: r(), changeFraction: r(), changeBox: null, motion: r() },
            events: VISUAL_EVENT_KINDS.filter(() => r() < 0.3),
            regionPx: randRect(),
            changeCenterPx: r() < 0.7 ? randPoint() : null,
            at: h.now,
          },
        };
      case 21:
        return { type: 'perception.ai', report: { scene: 'other', energy: 'calm', interest: r(), reaction: pick(AI_REACTIONS), caption: '' }, regionPx: randRect() };
      case 22:
        return { type: 'command.callCat', at };
      case 23:
        return { type: 'command.sleep' };
      case 24:
        return { type: 'command.wake' };
      case 25:
        return { type: 'command.play' };
      case 26:
        return { type: 'system.suspend' };
      case 27:
        return { type: 'system.resume' };
      case 28:
        return { type: 'display.changed' };
      default:
        return { type: 'pointer.hoverEnd' };
    }
  };

  const forbidden: ReadonlySet<BehaviorState> = new Set(opts.disabledAll ? ['chasingCursor', 'seekingAttention', 'inspectingWindow', 'grooming'] : []);

  // ---- v1.1 surfaces: a provider emulation with sliding taskbars, tab strips on some windows,
  // a lagging list (surfaces missing while live) and vanished surfaces (getSurface null).
  const browsers = new Set(['w1', 'w3']);
  const taskbars = new Map<string, { progress: number; dir: -1 | 0 | 1; flapUntil: number }>();
  let listed: Surface[] = [];
  let live = new Map<string, Surface>();
  const missingSince = new Map<string, number>();
  let airSince: number | null = null;
  const onSurface: Record<string, number> = {};
  const surfaceEvents: SimEvent[] = [];
  const buildSurfaces = (): void => {
    const geometry = WORLDS[worldIdx] as WorldGeometry;
    const all: Surface[] = [];
    for (const s of surfacesFromWindows(windows, geometry, { walls: true, now: h.now })) {
      if (s.orientation === 'ledge' && browsers.has(s.ownerId)) {
        const span = s.x1 - s.x0;
        const strip = tabStrip(s.ownerId, s.y, s.x0 + span * 0.05, s.x1 - span * 0.15, r() < 0.8 ? { x0: s.x0 + span * 0.1, x1: s.x0 + span * 0.6 } : null, r() < 0.7 ? s.x0 + span * r() : null);
        all.push(strip);
      } else if (s.orientation === 'wall' && browsers.has(s.ownerId)) {
        all.push({ ...s, topLedgeId: stripId(s.ownerId) });
      } else {
        all.push(s);
      }
    }
    for (const d of geometry.displays) {
      const tb = taskbars.get(d.id) ?? { progress: 0, dir: 0, flapUntil: -Infinity };
      taskbars.set(d.id, tb);
      const wasListed = tb.progress >= 0.5;
      if (h.now < tb.flapUntil && r() < 0.3) tb.dir = tb.dir >= 0 ? -1 : 1;
      else if (tb.dir === 0 && r() < 0.004) tb.dir = tb.progress > 0.5 ? -1 : 1;
      tb.progress = Math.min(1, Math.max(0, tb.progress + tb.dir * (0.15 + r() * 0.5)));
      if (tb.progress === 0 || tb.progress === 1) tb.dir = 0;
      if (r() < 0.0005) tb.flapUntil = h.now + 10_000;
      const thick = 48 * d.scaleFactor;
      const bottom = d.boundsPx.y + d.boundsPx.height;
      const isListed = tb.progress >= 0.5;
      if (isListed) {
        const phase = tb.dir > 0 ? 'entering' : tb.dir < 0 ? 'leaving' : 'stable';
        all.push(taskbar(d.id, d, bottom - thick * tb.progress, { phase, vy: -tb.dir * 900 }));
      }
      if (isListed && !wasListed) surfaceEvents.push({ type: 'taskbar.shown', surfaceId: taskbarId(d.id), displayId: d.id, edge: 'bottom' });
      if (!isListed && wasListed) surfaceEvents.push({ type: 'taskbar.hidden', surfaceId: taskbarId(d.id), displayId: d.id, edge: 'bottom' });
    }
    live = new Map(all.map((s) => [s.id, s] as const));
    // Vanished: getSurface already says gone while the (lagging) list may still have it.
    if (r() < 0.01 && all.length > 0) live.delete(pick(all).id);
    // Lag: listed surfaces missing for a moment while still live.
    listed = r() < 0.03 ? all.filter(() => r() < 0.7) : all;
    h.env.surfaces = listed;
    const liveNow = live;
    h.env.getSurface = (id: string) => liveNow.get(id) ?? null;
  };

  for (let i = 0; i < ticks; i++) {
    // Environment drift.
    if (r() < 0.002) {
      worldIdx = Math.floor(r() * WORLDS.length);
      h.setWorld({ ...(WORLDS[worldIdx] as WorldGeometry), version: i + 2 });
    }
    if (r() < 0.01) {
      const id = `w${Math.floor(r() * 5)}`;
      windows[id] = r() < 0.3 ? null : randRect();
    }
    if (r() < 0.05) {
      for (const [k, v] of Object.entries(windows)) if (v && r() < 0.5) windows[k] = { ...v, x: v.x + (r() - 0.5) * 60, y: v.y + (r() - 0.5) * 40 };
    }
    const c = r() < 0.03 ? null : (h.env.cursor ?? { x: 500, y: 900, speed: 0 });
    h.env.cursor = c ? { x: c.x + (r() - 0.5) * 80, y: c.y + (r() - 0.5) * 60, speed: r() * 2500 } : null;
    if (h.env.cursor && !insideAnyWorkArea(WORLDS[worldIdx] as WorldGeometry, h.env.cursor.x, h.env.cursor.y, 200)) h.env.cursor = { ...randPoint(), speed: 0 };
    if (r() < 0.003) h.env.typing = !h.env.typing;
    if (r() < 0.0008) h.env.paused = !h.env.paused;
    if (r() < 0.0006) h.env.hidden = !h.env.hidden;
    if (r() < 0.0006) h.env.fullscreenDisplayIds = r() < 0.5 ? [] : [pick((WORLDS[worldIdx] as WorldGeometry).displays).id];
    if (r() < 0.001) h.env.localHour = r() * 24;
    idleMs = r() < 0.001 ? 0 : idleMs + 30;
    h.env.userIdleMs = r() < 0.0005 ? 20 * 60_000 : idleMs;
    h.env.dragCursor = held ? { x: prev.x + (r() - 0.5) * 300, y: prev.y + (r() - 0.5) * 300 } : null;
    if (h.env.dragCursor && r() < 0.02) h.env.dragCursor = null;
    h.env.foreground = r() < 0.001 ? null : (h.env.foreground ?? null);

    buildSurfaces();
    const events: SimEvent[] = surfaceEvents.splice(0);
    const n = r() < 0.15 ? 1 + Math.floor(r() * 3) : 0;
    for (let k = 0; k < n; k++) events.push(randomEvent());
    if (r() < 0.01) {
      const ids = [...live.keys()];
      const any = ids.length > 0 && r() < 0.7 ? pick(ids) : `tabStrip:w${Math.floor(r() * 9)}`;
      const kind = r();
      if (kind < 0.3) events.push({ type: 'taskbar.shown', surfaceId: any, displayId: r() < 0.5 ? '1' : null, edge: 'bottom' });
      else if (kind < 0.5) events.push({ type: 'taskbar.hidden', surfaceId: any, displayId: null, edge: 'bottom' });
      else events.push({ type: 'tabs.changed', surfaceId: any, ownerId: pick(['w1', 'w3', 'w0']), change: pick(['added', 'removed', 'selected', 'geometry'] as const), focusX: r() < 0.1 ? Number.NaN : randPoint().x });
    }
    const dt = r() < 0.9 ? 16 + Math.floor(r() * 120) : 250 + Math.floor(r() * 200);
    const before = h.transitions.length;
    const out = h.step(events, dt);

    // ---- invariants (plain checks: vitest's expect is too slow for 200k ticks) ----
    const fail = (what: string): never => {
      throw new Error(`${what} at tick ${i}: ${JSON.stringify({ out: { ...out, requests: undefined }, prev: { x: prev.x, y: prev.y, support: prev.support, state: prev.state }, dt, worldIdx, debug: h.sim.debugInfo() })}`);
    };
    const check = (cond: boolean, what: string): void => {
      if (!cond) fail(what);
    };
    states.add(out.state);
    if (forbidden.has(out.state)) forbiddenSeen.add(out.state);
    check(STATE_SET.has(out.state), 'unknown state');
    check(CLIP_SET.has(out.clip), 'unknown clip');
    check(out.emote === null || EMOTE_SET.has(out.emote), 'unknown emote');
    for (const v of [out.x, out.y, out.speed, out.vy, out.arousal, out.contentment, out.opacity, out.clipStartedAt, out.emoteStartedAt, out.nextTickMs, out.boundsPx.x, out.boundsPx.y, out.boundsPx.width, out.boundsPx.height]) {
      check(Number.isFinite(v), 'non-finite output');
    }
    check(!out.look || (Number.isFinite(out.look.x) && Number.isFinite(out.look.y)), 'non-finite look');
    check(insideAnyWorkArea(WORLDS[worldIdx] as WorldGeometry, out.x, out.y, 2.5), 'outside the world');
    check(out.opacity >= 0 && out.opacity <= 1, 'opacity range');
    check(out.arousal >= 0 && out.arousal <= 1 && out.contentment >= 0 && out.contentment <= 1, 'mood range');
    check(out.speed >= 0, 'negative speed');
    check(out.nextTickMs >= 33 && out.nextTickMs <= 500, 'nextTickMs range');
    check(out.clipStartedAt <= h.now, 'clip from the future');
    check(out.visible || out.opacity < 0.02, 'invisible but opaque');
    check(out.state !== 'held' || out.support.kind === 'held', 'held without held support');
    check(out.support.kind !== 'air' || AIR_STATES.has(out.state), 'airborne in a grounded state');
    // Riding surfaces moves with them (the fuzz moves windows in jumps), so only floors, air and walking are checked.
    if (!out.snap && prev.support.kind !== 'held' && out.support.kind !== 'held' && prev.support.kind !== 'surface' && out.support.kind !== 'surface') {
      check(Math.hypot(out.x - prev.x, out.y - prev.y) <= 4000 * (dt / 1000) + 8, 'teleport without snap');
    }
    // v1.1 surfaces.
    if (out.support.kind === 'surface') onSurface[out.support.surfaceKind] = (onSurface[out.support.surfaceKind] ?? 0) + 1;
    const onWall = out.support.kind === 'surface' && out.support.orientation === 'wall';
    check((out.clip === 'climb') === onWall, 'climb clip off a wall (or a wall without it)');
    if (out.support.kind === 'surface') {
      // Never attached to a surface the provider says is gone ...
      check(live.has(out.support.surfaceId), 'attached to a vanished surface');
      const sid = out.support.surfaceId;
      // ... nor to one missing from the list for longer than the (moving) grace.
      if (listed.some((s) => s.id === sid)) missingSince.delete(sid);
      else if (!missingSince.has(sid)) missingSince.set(sid, h.now);
      check(h.now - (missingSince.get(sid) ?? h.now) <= MOVEMENT.perchMovingGraceMs + 500, 'attached to an unlisted surface past the grace');
      check(!PHYSICAL_STATES.has(out.state) || out.state === 'landing' || out.state === 'jumping', 'physical state while attached');
    } else {
      missingSince.clear();
    }
    if (out.support.kind === 'air') {
      airSince ??= h.now;
      check(h.now - airSince <= MAX_AIR_MS, 'airborne for too long');
    } else {
      airSince = null;
    }
    for (const req of out.requests) {
      if (req.type === 'perception') {
        check(h.now - lastPerception >= 30_000, 'perception requested too often');
        lastPerception = h.now;
      } else if (req.type === 'save') {
        check(h.now - lastSave >= 60_000, 'save requested too often');
        lastSave = h.now;
      } else {
        fail('quitReady without a quit request');
      }
    }
    for (let k = before; k < h.transitions.length; k++) {
      const t = h.transitions[k] as (typeof h.transitions)[number];
      checked++;
      check(canTransition(t.from, t.to), `transition outside the table ${t.from}->${t.to}`);
      if (t.cause === 'autonomous') check(t.fromDone || t.dwellMs >= STATE_SPECS[t.from].dwellMs[0], `min dwell violated ${t.from}`);
      if (t.cause === 'stimulus') check(t.fromDone || mayInterrupt(t.from, t.to, t.dwellMs), `illegal interruption ${t.from}->${t.to}`);
      if ((t.cause === 'autonomous' || t.cause === 'stimulus') && lastExit.has(t.to)) {
        check(t.at - (lastExit.get(t.to) as number) >= STATE_SPECS[t.to].cooldownMs, `cooldown violated ${t.to}`);
      }
      if (!PHYSICAL_STATES.has(t.from) && t.from !== 'away') lastExit.set(t.from, t.at);
      if (t.counted) {
        counted.push(t.at);
        while (counted.length > 0 && (counted[0] as number) <= t.at - STATE_CHANGE_WINDOW_MS) counted.shift();
        check(counted.length <= MAX_STATE_CHANGES_PER_WINDOW, 'state thrash');
      }
    }
    prev = out;
  }

  // Quit still works after all that.
  h.env.paused = false;
  h.env.hidden = false;
  const q = h.step([{ type: 'lifecycle.quitRequested' }], 33);
  const t0 = h.now;
  let ready = q.requests.some((x) => x.type === 'quitReady');
  while (!ready && h.now - t0 < 1200) ready = h.step([], 33).requests.some((x) => x.type === 'quitReady');
  expect(ready).toBe(true);
  console.log(`fuzz seed=${seed}: ${ticks} ticks, ${Math.round(h.now / 60_000)} sim-min, ${checked} transitions, states=${states.size}, ticks on surfaces=${JSON.stringify(onSurface)}`);
  expect(checked).toBeGreaterThan(ticks / 200);
  return { ticks, simMs: h.now, states, forbiddenSeen, debug: h.sim.debugInfo(), onSurface };
}

describe('simulation fuzz', () => {
  it('200k random ticks keep every invariant', () => {
    const res = fuzz(1, 200_000);
    expect(res.debug.invalidSamples).toEqual([]);
    expect(res.debug.eventErrors).toBe(0);
    // The run is long and varied enough to visit almost every state.
    expect(res.states.size).toBeGreaterThanOrEqual(BEHAVIOR_STATES.length - 2);
    // The run really exercised taskbars, window tops and sides, and tab strips.
    for (const kind of ['taskbar', 'windowTop', 'windowSide', 'tabStrip']) expect(res.onSurface[kind] ?? 0, kind).toBeGreaterThan(0);
  }, 300_000);

  it('disabled behaviours never occur under random stimuli', () => {
    const res = fuzz(2, 60_000, { disabledAll: true });
    expect([...res.forbiddenSeen]).toEqual([]);
    expect(res.debug.invalidSamples).toEqual([]);
    // Everything switched off: no window tops, sides, taskbars or tab strips either.
    expect(res.onSurface).toEqual({});
  }, 300_000);
});
