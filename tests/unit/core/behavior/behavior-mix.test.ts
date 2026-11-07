// "Alive but not hyperactive": over hours of a typical session the cat mostly rests,
// watches and grooms, with short bursts of activity and real variety.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { SimEvent } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { display, Harness, stripId, tabStrip, taskbar, taskbarId, world } from './fixtures';

const fg: WindowInfo = { id: 'w1', rect: { x: 300, y: 300, width: 900, height: 500 }, processName: 'code.exe', category: 'code', minimized: false, maximized: false, fullscreen: false, excluded: false };
const CALM: ReadonlySet<BehaviorState> = new Set(['resting', 'watchingUser', 'idle', 'grooming', 'sleeping', 'fallingAsleep', 'wakingUp', 'watchingCursor', 'curious', 'inspectingWindow', 'beingPetted']);
const ACTIVE: ReadonlySet<BehaviorState> = new Set(['running', 'playing', 'chasingCursor']);

describe('behaviour mix over a working session', () => {
  it('is mostly calm, with short bursts of activity, naps and variety', () => {
    const total = new Map<BehaviorState, number>();
    let transitions = 0;
    const hours = 2;
    const seeds = [1, 2, 3, 4, 5, 6];
    for (const seed of seeds) {
      const h = new Harness({ seed });
      h.env.foreground = fg;
      h.env.windows = { w1: fg.rect, w2: { x: 1300, y: 760, width: 500, height: 280 } };
      let cx = 900;
      h.run(hours * 3600_000, 100, (hh, i) => {
        // The user alternates between moving the mouse, typing and reading.
        const phase = Math.floor(i / 600) % 4;
        hh.env.typing = phase === 1;
        if (phase === 0) {
          cx = 900 + 600 * Math.sin(i / 25);
          hh.env.cursor = { x: cx, y: 700 + 300 * Math.cos(i / 31), speed: 500 };
        } else {
          hh.env.cursor = { x: cx, y: 500, speed: 0 };
        }
        const s = hh.last!.state;
        total.set(s, (total.get(s) ?? 0) + 100);
      });
      transitions += h.transitions.filter((t) => t.counted).length;
    }
    const sum = [...total.values()].reduce((a, b) => a + b, 0);
    const share = (pred: (s: BehaviorState) => boolean) => [...total.entries()].filter(([s]) => pred(s)).reduce((a, [, v]) => a + v, 0) / sum;
    expect(share((s) => CALM.has(s))).toBeGreaterThan(0.8);
    expect(share((s) => ACTIVE.has(s))).toBeGreaterThan(0.001);
    expect(share((s) => ACTIVE.has(s))).toBeLessThan(0.08);
    expect(share((s) => s === 'sleeping')).toBeGreaterThan(0.03);
    expect(share((s) => s === 'resting')).toBeLessThan(0.65);
    expect([...total.keys()].length).toBeGreaterThanOrEqual(10);
    const perHour = transitions / (hours * seeds.length);
    expect(perHour).toBeGreaterThan(40);
    expect(perHour).toBeLessThan(400);
    // Several 2 sim-hour runs: a hang guard that survives a loaded shared machine, not an assertion
    // (124 s and 60+ s against the default 60 s in two loaded verify runs on 2026-11-07).
  }, 180_000);
});

describe('behaviour mix with v1.1 surfaces (default settings)', () => {
  it('stays calm: modest time on surfaces and few surface reactions per hour', () => {
    // Auto-hide taskbar (work area = whole screen), a code editor in front, a browser with a tab
    // strip, and a tall window the cat could climb. The user reaches for the taskbar every few
    // minutes and now and then makes it flap; tabs change from time to time.
    const ah = display('1', 0, 0, 1920, 1200, { primary: true });
    const editor: WindowInfo = { ...fg, rect: { x: 300, y: 300, width: 900, height: 500 } };
    const hours = 2;
    const seeds = [1, 2, 3, 4];
    const tickMs = 100;
    const onKind = new Map<string, number>();
    let ticks = 0;
    let calm = 0;
    let onFloor = 0;
    let taskbarShows = 0;
    let taskbarReactions = 0;
    let tabReactions = 0;
    let climbs = 0;
    let jumps = 0;
    for (const seed of seeds) {
      const h = new Harness({ seed, world: world(ah) });
      h.env.foreground = editor;
      h.env.windows = { w1: editor.rect, tall: { x: 1350, y: 450, width: 450, height: 750 } };
      const strip = tabStrip('b', 820, 150, 1100, { x0: 250, x1: 900 }, 500);
      const tb = taskbar('tb', ah, 1152);
      let tbShown = false;
      let nextShowAt = 90_000 + seed * 10_000;
      let hideAt = -1;
      let flapUntil = -1;
      let wasWall = false;
      const fromTransitions = h.transitions.length;
      h.run(hours * 3600_000, tickMs, (hh, i) => {
        const now = hh.now;
        let want = tbShown;
        if (now < flapUntil) {
          // Flapping at ~2.5 Hz (the pointer hovering at the screen edge).
          want = Math.floor(now / 400) % 2 === 0;
        } else if (!tbShown && now >= nextShowAt) {
          want = true;
          hideAt = now + 6000;
          nextShowAt = now + 120_000 + ((seed * 7919 + i * 31) % 120_000);
          if (i % 5 === 0) flapUntil = now + 10_000;
        } else if (tbShown && now >= hideAt) {
          want = false;
        }
        const ev: SimEvent[] = [];
        if (want !== tbShown) {
          ev.push({ type: want ? 'taskbar.shown' : 'taskbar.hidden', surfaceId: taskbarId('tb'), displayId: '1', edge: 'bottom' });
          if (want) taskbarShows++;
          tbShown = want;
        }
        hh.env.extraSurfaces = tbShown ? [strip, tb] : [strip];
        if (i % 1500 === 700) ev.push({ type: 'tabs.changed', surfaceId: stripId('b'), ownerId: 'b', change: 'selected', focusX: 300 + (i % 5) * 120 });
        // The user alternates between typing and reading/moving the mouse.
        const phase = Math.floor(i / 600) % 4;
        hh.env.typing = phase === 1;
        hh.env.typingIntensity = phase === 1 ? 0.7 : 0.1;
        hh.env.cursor = phase === 0 ? { x: 900 + 500 * Math.sin(i / 25), y: 700, speed: 400 } : { x: 900, y: 500, speed: 0 };
        const o = hh.last!;
        ticks++;
        if (CALM.has(o.state)) calm++;
        if (o.support.kind === 'surface') onKind.set(o.support.surfaceKind, (onKind.get(o.support.surfaceKind) ?? 0) + 1);
        if (o.support.kind === 'floor') onFloor++;
        const isWall = o.support.kind === 'surface' && o.support.orientation === 'wall';
        if (isWall && !wasWall) climbs++;
        wasWall = isWall;
        return ev;
      });
      const all = h.transitions.slice(fromTransitions);
      jumps += all.filter((t) => t.to === 'jumping').length;
      // A reaction to a surface event happens on the tick the event is delivered.
      taskbarReactions += countStimulusAt(h, (ev) => ev.type === 'taskbar.shown' || ev.type === 'taskbar.hidden');
      tabReactions += countStimulusAt(h, (ev) => ev.type === 'tabs.changed');
    }
    const perHour = (n: number): number => n / (hours * seeds.length);
    const surfaceShare = [...onKind.values()].reduce((a, b) => a + b, 0) / ticks;
    const byKind = Object.fromEntries([...onKind.entries()].map(([k, v]) => [k, Math.round((1000 * v) / ticks) / 10]));
    console.log(
      `surface mix: on surfaces ${(100 * surfaceShare).toFixed(1)} % of the time ${JSON.stringify(byKind)} (%); per hour: ${perHour(taskbarShows).toFixed(1)} taskbar shows, ${perHour(taskbarReactions).toFixed(1)} taskbar reactions, ${perHour(tabReactions).toFixed(1)} tab reactions, ${perHour(climbs).toFixed(1)} climbs, ${perHour(jumps).toFixed(1)} jumps; calm ${(100 * calm / ticks).toFixed(1)} %`,
    );
    expect(calm / ticks).toBeGreaterThan(0.75);
    // ADR 0003 B2 x B3: long stays on window tops and strips are the point of v1.2 (the v1.1.1 ceiling was 45 %):
    // measured 36 % here (SIMULATED, 4 seeds x 2 sim-h). It goes up there, and it does not live up there.
    expect(surfaceShare).toBeGreaterThan(0.15);
    expect(surfaceShare).toBeLessThan(0.6);
    expect(onFloor / ticks).toBeGreaterThan(0.35);
    // Climbing happens, but only now and then (cooldown 1.5-4 min, low utility for a default cat).
    expect(climbs).toBeGreaterThan(0);
    expect(perHour(climbs)).toBeLessThanOrEqual(12);
    expect(perHour(taskbarReactions)).toBeLessThanOrEqual(perHour(taskbarShows) * 0.5);
    expect(perHour(tabReactions)).toBeLessThanOrEqual(10);
    expect(perHour(jumps)).toBeLessThan(120);
  }, 300_000);
});

/** Stimulus transitions on ticks at which an event matching `pred` was delivered (recorded by the harness hook). */
function countStimulusAt(h: Harness, pred: (ev: SimEvent) => boolean): number {
  const times = new Set(h.delivered.filter((d) => d.events.some(pred)).map((d) => d.at));
  return h.transitions.filter((t) => t.cause === 'stimulus' && times.has(t.at)).length;
}