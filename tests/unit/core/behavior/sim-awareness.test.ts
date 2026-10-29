// Awareness from the product brief: screen statistics (video-like, new element, busy/quiet),
// the user's perception interval, switches that turn reactions fully off, private windows
// and windowed video or games.
import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import type { VisualEventKind, VisualSummary } from '../../../../src/shared/perception';
import type { SimEvent, SimOutput } from '../../../../src/shared/sim';
import type { WindowInfo } from '../../../../src/shared/world';
import { PERCEPTION_FLOOR_MS } from '../../../../src/core/behavior/sim';
import { decisionView, Harness, onWindowSurface, scoreOf, settingsWith, WAKE_MS } from './fixtures';

const MIN = 60_000;
const ACTIVE: ReadonlySet<BehaviorState> = new Set(['running', 'playing', 'chasingCursor']);
const catPoint = (o: SimOutput | null) => ({ x: o?.x ?? 0, y: (o?.y ?? 0) - 30 });

function windowInfo(id: string, rect: WindowInfo['rect'], o: Partial<WindowInfo> = {}): WindowInfo {
  return { id, rect, processName: 'app.exe', category: 'browser', minimized: false, maximized: false, fullscreen: false, excluded: false, ...o };
}

function visual(events: VisualEventKind[], at: number, changeCenterPx: { x: number; y: number } | null = { x: 700, y: 600 }): SimEvent {
  const summary: VisualSummary = {
    features: { brightness: 0.5, contrast: 0.5, colorfulness: 0.6, edgeDensity: 0.1, changeFraction: 0.1, changeBox: null, motion: 0.4 },
    events,
    regionPx: { x: 400, y: 400, width: 600, height: 400 },
    changeCenterPx,
    at,
  };
  return { type: 'perception.visual', summary };
}

function activeShare(h: Harness, ms: number, dt: number, each?: (h: Harness, i: number) => readonly SimEvent[] | void): number {
  let active = 0;
  let total = 0;
  h.run(ms, dt, (hh, i) => {
    total += dt;
    if (ACTIVE.has(hh.last!.state)) active += dt;
    return each?.(hh, i);
  });
  return active / total;
}

describe('F7: reactions to screen statistics', () => {
  it('video-like content makes the cat sit and watch it, and keeps it calmer', () => {
    let watched = 0;
    let withVideo = 0;
    let without = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const v = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
      v.run(WAKE_MS);
      withVideo += activeShare(v, 60 * MIN, 100, (hh, i) => {
        const o = hh.last!;
        if (o.state === 'watchingUser' && o.look && Math.hypot(o.look.x - 700, o.look.y - 600) < 1) watched++;
        return i % 200 === 0 ? [visual(['videoLike', 'motion'], hh.now)] : [];
      });
      const n = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
      n.run(WAKE_MS);
      without += activeShare(n, 60 * MIN, 100);
    }
    expect(watched).toBeGreaterThan(0);
    expect(withVideo).toBeLessThan(without * 0.75);
  });

  it('a new element makes a curious cat look or go over, at most once per 45 s', () => {
    let curious = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
      h.run(WAKE_MS);
      const t0 = h.transitions.length;
      let looked = false;
      h.run(3 * MIN, 100, (hh, i) => {
        const o = hh.last!;
        if (o.state === 'curious' && o.look && Math.hypot(o.look.x - 700, o.look.y - 600) < 1) looked = true;
        return i % 20 === 0 ? [visual(['newElement'], hh.now)] : [];
      });
      const starts = h.transitions.slice(t0).filter((t) => t.to === 'curious' && t.cause === 'stimulus').map((t) => t.at);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(45_000 - 200);
      expect(starts.length).toBeLessThanOrEqual(4);
      if (starts.length > 0) {
        curious++;
        expect(looked).toBe(true);
      }
    }
    expect(curious).toBeGreaterThan(1);
  });

  it('a noticed new element it does not go to gets a head tilt', () => {
    let tilts = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { activitySensitivity: 0.05 } }) });
      h.run(WAKE_MS);
      h.runUntil((o) => o.state === 'idle', 5 * MIN);
      const o = h.step([visual(['newElement'], h.now)]);
      if (o.reaction?.kind === 'headTilt' && o.reaction.at === h.now) tilts++;
    }
    expect(tilts).toBeGreaterThan(3);
  });

  it('tracks the look of the screen from local statistics and AI scenes, and forgets it after a few minutes', () => {
    const h = new Harness({ seed: 9 });
    h.run(WAKE_MS);
    expect(h.sim.debugInfo().screen).toBeNull();
    h.step([visual(['busy'], h.now)]);
    expect(h.sim.debugInfo().screen).toBe('busy');
    h.step([visual(['quiet', 'still'], h.now)]);
    expect(h.sim.debugInfo().screen).toBe('quiet');
    h.step([visual(['videoLike', 'busy', 'motion'], h.now)]);
    expect(h.sim.debugInfo().screen).toBe('video');
    h.step([visual(['dark'], h.now)]);
    expect(h.sim.debugInfo().screen).toBeNull();
    h.step([{ type: 'perception.ai', report: { scene: 'game', energy: 'intense', interest: 0.1, reaction: 'ignore', caption: '' }, regionPx: { x: 0, y: 0, width: 800, height: 600 } }]);
    expect(h.sim.debugInfo().screen).toBe('video');
    h.run(3 * MIN + 1000, 200);
    expect(h.sim.debugInfo().screen).toBeNull();
  });

  it('a busy screen lowers activity a little, video-like content (or a windowed video app) a lot; a quiet one favours rest', () => {
    const base = decisionView();
    const busy = decisionView({ screen: 'busy' });
    const video = decisionView({ screen: 'video' });
    const media = decisionView({ mediaForeground: true });
    const quiet = decisionView({ screen: 'quiet' });
    for (const [state, variant] of [['playing', 'pawAt'], ['chasingCursor', null], ['walking', 'wander']] as const) {
      const b = scoreOf(base, state, variant);
      expect(b).toBeGreaterThan(0);
      expect(scoreOf(busy, state, variant)).toBeCloseTo(b * 0.8, 6);
      expect(scoreOf(video, state, variant)).toBeCloseTo(b * 0.4, 6);
      expect(scoreOf(media, state, variant)).toBeCloseTo(b * 0.4, 6);
    }
    expect(scoreOf(video, 'watchingUser')).toBeGreaterThan(scoreOf(base, 'watchingUser'));
    expect(scoreOf(quiet, 'resting')).toBeGreaterThan(scoreOf(base, 'resting'));
  });
});

describe('F8: the perception interval setting applies', () => {
  function gaps(minIntervalSec: number): number[] {
    const h = new Harness({ seed: 61, settings: settingsWith({ perception: { minIntervalSec } }) });
    h.env.foreground = windowInfo('f', { x: 300, y: 100, width: 1200, height: 800 });
    h.env.typing = true;
    const at: number[] = [];
    h.run(20 * MIN, 100, (hh) => {
      for (const r of hh.last!.requests) if (r.type === 'perception') at.push(hh.now);
    });
    return at.slice(1).map((t, i) => t - at[i]!);
  }

  it('asks for an analysis no more often than settings.perception.minIntervalSec', () => {
    const fast = gaps(5);
    expect(fast.length).toBeGreaterThan(20);
    for (const g of fast) expect(g).toBeGreaterThanOrEqual(5000);
    // Faster than the old fixed 30 s floor.
    expect(fast.some((g) => g < 30_000)).toBe(true);
    const slow = gaps(120);
    expect(slow.length).toBeGreaterThan(0);
    for (const g of slow) expect(g).toBeGreaterThanOrEqual(120_000);
  });

  it('keeps a hard floor of 5 s whatever the setting holds', () => {
    for (const g of gaps(1)) expect(g).toBeGreaterThanOrEqual(PERCEPTION_FLOOR_MS);
  });
});

describe('F9: switches turn their reactions fully off', () => {
  it('"React to typing" off: typing changes nothing in the scores', () => {
    const behavior = { ...decisionView().behavior, reactToTyping: false };
    const quiet = scoreOf(decisionView({ behavior, typing: false }), 'playing') + scoreOf(decisionView({ behavior, typing: false }), 'chasingCursor');
    const typing = scoreOf(decisionView({ behavior, typing: true }), 'playing') + scoreOf(decisionView({ behavior, typing: true }), 'chasingCursor');
    expect(typing).toBeCloseTo(quiet, 9);
    expect(scoreOf(decisionView({ behavior, typing: true }), 'watchingUser')).toBeCloseTo(scoreOf(decisionView({ behavior, typing: false }), 'watchingUser'), 9);
  });

  it('"React to typing" off: the cat still plays with the pointer while you type', () => {
    let chased = false;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1, reactToTyping: false } }) });
      h.env.typing = true;
      h.env.typingIntensity = 0.9;
      h.run(WAKE_MS);
      const x0 = h.last!.x;
      h.run(30_000, 33, (hh, i) => {
        if (hh.last!.state === 'chasingCursor') chased = true;
        hh.env.cursor = { x: x0 + 300 * Math.sin(i / 10), y: 1000, speed: 1200 };
        return i % 60 === 0 ? [{ type: 'cursor.flick', speed: 3000, at: { x: x0 + 200, y: 1000 } }] : [];
      });
    }
    expect(chased).toBe(true);
  });

  it('"React to windows" off: fast app switching does not make it stop and watch', () => {
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { reactToWindows: false } }) });
      const fg = windowInfo('f', { x: 500, y: 200, width: 800, height: 600 });
      h.env.foreground = fg;
      h.run(WAKE_MS);
      h.run(10 * MIN, 100, (_hh, i) => (i % 30 === 0 ? [{ type: 'window.foreground', window: fg, switchesPerMinute: 14 }] : []));
      expect(h.transitions.some((t) => t.to === 'watchingUser' && t.cause === 'stimulus')).toBe(false);
      expect(h.sim.debugInfo().mode).toBe('normal');
    }
  });

  it('"Pointer play" at 0 %: never chases on its own', () => {
    const behavior = { ...decisionView().behavior, cursorPlay: 0 };
    expect(scoreOf(decisionView({ behavior }), 'chasingCursor')).toBe(0);
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 0, autonomy: 1 } }) });
      h.run(30 * MIN, 100, (hh, i) => {
        hh.env.cursor = { x: 900 + 500 * Math.sin(i / 20), y: 1000, speed: 1500 };
      });
      expect(h.transitions.some((t) => t.to === 'chasingCursor')).toBe(false);
    }
  });

  it('"Attention seeking" at 0 %: no greeting when the user comes back', () => {
    const greets = (attentionSeeking: number): number => {
      let n = 0;
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const h = new Harness({ seed, settings: settingsWith({ behavior: { attentionSeeking } }) });
        h.env.cursor = { x: 1500, y: 900, speed: 0 };
        h.run(WAKE_MS);
        h.runUntil((o) => o.state === 'idle', 5 * MIN);
        h.step([{ type: 'activity.userReturned', idleMs: 10 * MIN }]);
        h.run(3000);
        if (h.transitions.some((t) => t.to === 'seekingAttention')) n++;
      }
      return n;
    };
    expect(greets(0.35)).toBeGreaterThan(0);
    expect(greets(0)).toBe(0);
  });
});

describe('F13: private windows', () => {
  const rect = { x: 600, y: 820, width: 800, height: 220 };

  function perches(excluded: boolean): number {
    let n = 0;
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
      h.env.windows = { w: rect };
      h.step([{ type: 'window.shown', window: windowInfo('w', rect, { excluded }) }]);
      let on = false;
      h.run(60 * MIN, 100, (hh) => {
        if (onWindowSurface(hh.last!.support)) on = true;
      });
      if (on) n++;
    }
    return n;
  }

  it('the cat never climbs onto a window the host marks private', () => {
    expect(perches(false)).toBeGreaterThanOrEqual(2);
    expect(perches(true)).toBe(0);
  });

  it('a window that becomes private stops being a perch; one cleared again is usable', () => {
    const h = new Harness({ seed: 2, settings: settingsWith({ behavior: { autonomy: 1 } }) });
    h.env.windows = { w: rect };
    h.env.foreground = windowInfo('w', rect, { excluded: true });
    h.keepOutputs = true;
    h.run(30 * MIN, 100);
    expect(h.outputs.some((o) => onWindowSurface(o.support))).toBe(false);
    h.env.foreground = windowInfo('w', rect, { excluded: false });
    h.run(60 * MIN, 100);
    expect(h.outputs.some((o) => onWindowSurface(o.support))).toBe(true);
  });

  it('moving or closing a private window gets at most a glance: no following, inspecting or investigating', () => {
    const run = (excluded: boolean): BehaviorState[] => {
      const seen: BehaviorState[] = [];
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const h = new Harness({ seed, settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
        h.run(WAKE_MS);
        const x = h.last!.x;
        const r = { x: Math.max(0, x - 400), y: 500, width: 800, height: 500 };
        h.env.windows = { m: r };
        h.run(20 * MIN, 100, (_hh, i) => {
          const k = i % 300;
          if (k === 0) return [{ type: 'window.moveStart', id: 'm', excluded }];
          if (k === 20) return [{ type: 'window.moveEnd', id: 'm', rect: r, excluded }];
          if (k === 150) return [{ type: 'window.closed', id: `c${i}`, rect: r, category: 'browser', excluded }];
          return [];
        });
        for (const t of h.transitions) if (t.cause === 'stimulus') seen.push(t.to);
      }
      return seen;
    };
    const open = run(false);
    expect(open.some((s) => s === 'walking' || s === 'inspectingWindow' || s === 'curious')).toBe(true);
    const priv = run(true);
    expect(priv).not.toContain('walking');
    expect(priv).not.toContain('inspectingWindow');
    expect(priv).not.toContain('curious');
  });

  it('a private window that appears is not inspected or stared at', () => {
    for (const seed of [1, 2, 3, 4]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { activitySensitivity: 1 } }) });
      h.run(WAKE_MS);
      const r = { x: Math.max(0, h.last!.x - 300), y: 600, width: 700, height: 440 };
      h.env.windows = { p: r };
      h.run(10 * MIN, 100, (_hh, i) => (i % 400 === 0 ? [{ type: 'window.shown', window: windowInfo(`p${i}`, r, { excluded: true }) }] : []));
      expect(h.transitions.some((t) => t.cause === 'stimulus' && (t.to === 'inspectingWindow' || t.to === 'curious'))).toBe(false);
    }
  });
});

describe('F15: windowed video, games and media keep the cat quiet', () => {
  it('a video, game or media app in front lowers activity compared with a code editor', () => {
    const share = (category: WindowInfo['category']): number => {
      let total = 0;
      for (const seed of [1, 2, 3, 4]) {
        const h = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1 } }) });
        h.env.foreground = windowInfo('f', { x: 300, y: 200, width: 1200, height: 700 }, { category });
        total += activeShare(h, 90 * MIN, 100, (hh, i) => {
          hh.env.cursor = { x: 900 + 500 * Math.sin(i / 25), y: 900, speed: 500 };
        });
      }
      return total;
    };
    const code = share('code');
    expect(code).toBeGreaterThan(0);
    for (const c of ['video', 'game', 'media'] as const) expect(share(c)).toBeLessThan(code * 0.7);
  });

  it('the decision view knows the foreground category', () => {
    const h = new Harness({ seed: 3 });
    h.env.foreground = windowInfo('f', { x: 300, y: 200, width: 1200, height: 700 }, { category: 'video' });
    h.run(WAKE_MS);
    // Petting and tapping still work as usual while a video plays.
    h.step([{ type: 'pointer.tap', at: catPoint(h.last) }]);
    expect(h.last!.reaction?.kind).toBe('earFlick');
  });
});
