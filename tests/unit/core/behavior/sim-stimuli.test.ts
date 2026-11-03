import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { AiReaction } from '../../../../src/shared/perception';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { callCat, display, DUAL_MIXED, Harness, onWindowSurface, onWindowTop, settingsWith, WAKE_MS, world } from './fixtures';

const MIN = 60_000;
const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });

function windowInfo(id: string, rect: WindowInfo['rect'], category: WindowInfo['category'] = 'browser'): WindowInfo {
  return { id, rect, processName: 'app.exe', category, minimized: false, maximized: false, fullscreen: false, excluded: false };
}

function collect(h: Harness, ms: number, each?: (h: Harness, i: number) => readonly SimEvent[] | void, dt = 33): BehaviorState[] {
  const out: BehaviorState[] = [];
  h.run(ms, dt, (hh, i) => {
    out.push(hh.last!.state);
    return each?.(hh, i);
  });
  out.push(h.last!.state);
  return out;
}

describe('window stimuli', () => {
  it('a new, large, nearby window makes a curious cat inspect it and perch on top', () => {
    let perched = false;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
      h.run(WAKE_MS);
      const rect = { x: Math.max(0, h.last!.x - 300), y: 760, width: 700, height: 280 };
      h.env.windows = { n: rect };
      const states = collect(h, 30_000, (_hh, i) => (i === 0 ? [{ type: 'window.shown', window: windowInfo('n', rect) }] : []));
      if (states.includes('inspectingWindow')) perched ||= states.includes('jumping') && onWindowSurface(h.last!.support);
    }
    expect(perched).toBe(true);
  });

  it('habituates: a stream of window events produces glances, not constant movement', () => {
    const h = new Harness({ seed: 9, settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
    h.run(2000);
    let reactions = 0;
    let prev: BehaviorState = h.last!.state;
    collect(h, 10 * MIN, (hh, i) => {
      const s = hh.last!.state;
      if (s !== prev && (s === 'curious' || s === 'inspectingWindow')) reactions++;
      prev = s;
      return i % 30 === 0 ? [{ type: 'window.shown', window: windowInfo(`w${i}`, { x: 200, y: 300, width: 1200, height: 700 }) }] : [];
    });
    // ~600 events in 10 minutes; reactions stay rare.
    expect(reactions).toBeLessThan(25);
  });

  it('rapid foreground switching makes a wandering cat stop and observe', () => {
    const h = new Harness({ seed: 10 });
    h.run(2000);
    callCat(h, { x: 100, y: 1000 });
    h.run(300);
    expect(['running', 'walking']).toContain(h.last!.state);
    h.env.foreground = windowInfo('f', { x: 500, y: 200, width: 800, height: 600 });
    const states = collect(h, 2000, (_hh, i) => (i % 3 === 0 ? [{ type: 'window.foreground', window: windowInfo('f', { x: 500, y: 200, width: 800, height: 600 }), switchesPerMinute: 14 }] : []));
    // Commands win over observation; an autonomous walk does not.
    expect(states).not.toContain('watchingUser');
    const g = new Harness({ seed: 10 });
    g.env.foreground = windowInfo('f', { x: 500, y: 200, width: 800, height: 600 });
    g.run(1000);
    const st = collect(g, 10 * MIN, (_hh, i) => (i % 60 === 0 ? [{ type: 'window.foreground', window: windowInfo('f', { x: 500, y: 200, width: 800, height: 600 }), switchesPerMinute: 14 }] : []), 100);
    const share = st.filter((s) => s === 'watchingUser').length / st.length;
    const moving = st.filter((s) => s === 'walking' || s === 'running' || s === 'playing' || s === 'chasingCursor').length / st.length;
    expect(share).toBeGreaterThan(0.2);
    expect(moving).toBeLessThan(0.05);
  });

  // ADR 0003 §3: a vanished support is a calm controlled bail-out in v1.2, no fall and no start.
  it('bails out calmly when the window it sits on is closed', () => {
    const h = new Harness({ seed: 11 });
    h.run(2000);
    const rect = { x: Math.max(0, h.last!.x - 300), y: 800, width: 600, height: 240 };
    h.env.windows = { p: rect };
    callCat(h, { x: rect.x + 300, y: 700 });
    expect(h.runUntil((o) => onWindowTop(o.support) && o.state === 'idle', 30_000)).toBe(true);
    h.env.windows = {};
    const states = collect(h, 4000);
    expect(states.some((s) => s === 'jumping' || s === 'falling')).toBe(true);
    expect(states).toContain('landing');
    expect(states).not.toContain('startled');
    expect(h.last!.support.kind).toBe('floor');
  });
});

describe('cursor and pointer', () => {
  it('a fast cursor flick near the floor can start a brief chase that ends by itself', () => {
    let chased = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1 } }) });
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      // ADR 0003 §4.2: a hunt runs up to 3 stalk-to-bat cycles of 1.5 x chaseDurationSec, so it ends within 45 s.
      const states = collect(h, 45_000, (hh, i) => {
        hh.env.cursor = { x: x0 + 300 * Math.sin(i / 10), y: 1000, speed: 1200 };
        return i % 60 === 0 ? [{ type: 'cursor.flick', speed: 3000, at: { x: x0 + 200, y: 1000 } }] : [];
      });
      if (states.includes('chasingCursor')) {
        chased = true;
        const lastChase = states.lastIndexOf('chasingCursor');
        expect(lastChase).toBeLessThan(states.length - 1);
      }
    }
    expect(chased).toBe(true);
  });

  it('does not chase a cursor far above it (watches instead)', () => {
    const h = new Harness({ seed: 3, settings: settingsWith({ behavior: { cursorPlay: 1 } }) });
    h.run(3000);
    const states = collect(h, 20_000, (hh, i) => {
      hh.env.cursor = { x: 900 + 200 * Math.sin(i / 10), y: 200, speed: 1500 };
      return i % 30 === 0 ? [{ type: 'cursor.flick', speed: 4000, at: { x: 900, y: 200 } }] : [];
    });
    expect(states).not.toContain('chasingCursor');
  });

  it('double tap: playful hop (jump) or a happy emote', () => {
    let hopped = 0;
    let emoted = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed });
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      let happy = false;
      const states = collect(h, 2500, (hh, i) => {
        if (hh.last!.emote === 'sparkle' || hh.last!.emote === 'note') happy = true;
        return i === 0 ? [{ type: 'pointer.doubleTap', at: catPoint(hh.last) }] : [];
      });
      if (states.includes('jumping')) {
        hopped++;
        expect(states).toContain('landing');
        expect(Math.abs(h.last!.x - x0)).toBeLessThan(84);
      } else if (happy || h.last!.emote === 'sparkle' || h.last!.emote === 'note') emoted++;
    }
    expect(hopped).toBeGreaterThan(0);
    expect(hopped + emoted).toBeGreaterThan(4);
  });

  it('respects interaction settings', () => {
    const h = new Harness({ seed: 4, settings: settingsWith({ interaction: { petting: false, dragging: false } }) });
    h.run(2000);
    const states = collect(h, 5000, (hh, i) => (i % 5 === 0 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }, { type: 'pointer.dragStart', at: catPoint(hh.last) }] : []));
    expect(states).not.toContain('beingPetted');
    expect(states).not.toContain('held');
    const off = new Harness({ seed: 4, settings: settingsWith({ interaction: { enabled: false } }) });
    off.run(2000);
    const st = collect(off, 5000, (hh, i) => (i % 5 === 0 ? [{ type: 'pointer.tap', at: catPoint(hh.last) }, { type: 'pointer.doubleTap', at: catPoint(hh.last) }] : []));
    expect(st).not.toContain('annoyed');
    expect(off.sim.serialize().memory.counters.clicks).toBe(0);
  });

  it('a drag that loses its cursor drops the cat instead of holding it forever', () => {
    const h = new Harness({ seed: 5 });
    h.run(2000);
    h.step([{ type: 'pointer.dragStart', at: catPoint(h.last) }]);
    expect(h.last!.state).toBe('held');
    h.env.dragCursor = null;
    expect(h.runUntil((o) => o.state === 'falling' || o.state === 'landing', 3000)).toBe(true);
  });
});

describe('learned preferences', () => {
  it('tracks petting sessions per active hour', () => {
    const h = new Harness({ seed: 12 });
    h.run(1000);
    // One 3-second petting session (many pet events) every 10 minutes for 3 hours: ~6 sessions/hour.
    h.run(3 * 60 * MIN, 250, (hh, i) => {
      const inSession = i % 2400 < 12;
      return inSession ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 0.7 }] : [];
    });
    const rate = h.sim.serialize().memory.preferences.petRatePerHour;
    expect(rate).toBeGreaterThan(3);
    expect(rate).toBeLessThan(8);
  });
});

describe('attention seeking', () => {
  function seekRun(answer: boolean): { sought: boolean; delta: number } {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { attentionSeeking: 1 } }) });
      h.env.cursor = { x: 1500, y: 900, speed: 0 };
      const before = h.sim.serialize().memory.preferences.attentionAcceptance;
      let sought = false;
      let seekTicks = 0;
      h.run(60 * MIN, 100, (hh) => {
        if (hh.last!.state !== 'seekingAttention') {
          seekTicks = 0;
          return [];
        }
        sought = true;
        // Answer every request about a second after it starts.
        return answer && ++seekTicks === 10 ? [{ type: 'pointer.pet', at: catPoint(hh.last), strength: 1 }] : [];
      });
      if (!sought) continue;
      const p = h.sim.serialize();
      expect(p.memory.counters.attentionRequests).toBeGreaterThan(0);
      if (answer) expect(p.memory.counters.attentionAnswered).toBeGreaterThan(0);
      return { sought, delta: p.memory.preferences.attentionAcceptance - before };
    }
    return { sought: false, delta: 0 };
  }

  it('after a long quiet period an affectionate cat asks for attention and learns from the answer', () => {
    const yes = seekRun(true);
    expect(yes.sought).toBe(true);
    expect(yes.delta).toBeGreaterThan(0);
    const no = seekRun(false);
    expect(no.sought).toBe(true);
    expect(no.delta).toBeLessThan(0);
  });

  it('asks rarely: bounded by its long cooldown', () => {
    const h = new Harness({ seed: 2, settings: settingsWith({ behavior: { attentionSeeking: 1 } }) });
    let entries = 0;
    let prev: BehaviorState = 'idle';
    h.run(3 * 60 * MIN, 200, (hh) => {
      const s = hh.last!.state;
      if (s === 'seekingAttention' && prev !== 'seekingAttention') entries++;
      prev = s;
    });
    expect(entries).toBeLessThanOrEqual(3 * 6);
  });
});

describe('perception', () => {
  const region = { x: 300, y: 300, width: 600, height: 400 };
  const ai = (reaction: AiReaction, interest = 0.9): SimEvent => ({ type: 'perception.ai', report: { scene: 'video', energy: 'moderate', interest, reaction, caption: 'x' }, regionPx: region });

  it('maps allow-listed AI reactions to behaviours', () => {
    const expectState = (reaction: AiReaction, ok: (s: BehaviorState[]) => boolean) => {
      const h = new Harness({ seed: 6 });
      h.run(WAKE_MS);
      // From an idle cat (a walk or rest it just started may not be cut short).
      h.runUntil((o) => o.state === 'idle', 5 * MIN);
      const states = collect(h, 1500, (_hh, i) => (i === 0 ? [ai(reaction)] : []));
      expect(ok(states)).toBe(true);
    };
    expectState('watch', (s) => s.includes('watchingUser'));
    expectState('approach', (s) => s.includes('curious'));
    expectState('play', (s) => s.includes('playing'));
    expectState('startle', (s) => s.includes('startled'));
    expectState('groom', (s) => s.includes('grooming'));
    expectState('sit_nearby', (s) => s.includes('curious'));
    expectState('ignore', (s) => !s.includes('curious') && !s.includes('playing') && !s.includes('startled'));
  });

  it('ignores low-interest and unknown reactions and rate-limits AI reactions', () => {
    const h = new Harness({ seed: 6 });
    h.run(3000);
    const before = h.transitions.length;
    collect(h, 2000, (_hh, i) => (i === 0 ? [ai('play', 0.1), { ...ai('play'), report: { ...(ai('play') as { report: object }).report, reaction: 'open_browser' } } as unknown as SimEvent] : []));
    expect(h.transitions.slice(before).some((t) => t.to === 'playing')).toBe(false);
    const g = new Harness({ seed: 6 });
    g.run(3000);
    const states = collect(g, 5000, (_hh, i) => (i % 10 === 0 ? [i === 0 ? ai('watch') : ai('startle')] : []));
    expect(states).not.toContain('startled');
  });

  it('a dark screen makes the cat sleepier', () => {
    const naps = (dark: boolean): number => {
      let total = 0;
      for (const seed of [1, 2, 3, 4]) {
        const h = new Harness({ seed });
        let slept = 0;
        h.run(90 * MIN, 250, (hh, i) => {
          if (hh.last!.state === 'sleeping') slept += 250;
          return dark && i % 400 === 0 ? [{ type: 'perception.visual', summary: { features: { brightness: 0.05, contrast: 0.1, colorfulness: 0, edgeDensity: 0, changeFraction: 0, changeBox: null, motion: 0 }, events: ['dark', 'still'], regionPx: region, changeCenterPx: null, at: hh.now } }] : [];
        });
        total += slept;
      }
      return total;
    };
    expect(naps(true)).toBeGreaterThan(naps(false));
  });
});

describe('multi-monitor in the simulation', () => {
  it('survives removal of the display it is on (snap onto a valid floor)', () => {
    const h = new Harness({ seed: 7, world: DUAL_MIXED });
    h.step();
    callCat(h, { x: -1500, y: 1200 });
    expect(h.runUntil((o) => o.displayId === '2' && o.state === 'idle', 60_000)).toBe(true);
    h.setWorld(world(display('1', 0, 0, 1920, 1080, { primary: true, taskbar: 40 })));
    const o = h.step();
    expect(o.snap).toBe(true);
    expect(o.displayId).toBe('1');
    // The new display's floor as the app's sim sees it (work-area bottom less the floor inset).
    expect(o.y).toBe(h.floorY('1'));
    expect(o.x).toBeGreaterThanOrEqual(42);
    h.run(5000);
    expect(h.last!.displayId).toBe('1');
  });

  it('reports the display containing the cat for negative coordinates and mixed DPI', () => {
    const h = new Harness({ seed: 8, world: DUAL_MIXED });
    h.step();
    callCat(h, { x: -2000, y: 1250 });
    h.runUntil((o) => o.state === 'idle' && o.displayId === '2', 60_000);
    expect(h.last!.x).toBeLessThan(0);
    expect(h.last!.y).toBe(h.floorY('2'));
    expect(h.last!.boundsPx.width).toBeCloseTo(84 * 1.5, 6);
    expect(h.last!.support).toEqual({ kind: 'floor', displayId: '2' });
  });
});
