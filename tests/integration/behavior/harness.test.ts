// The behaviour-profile harness itself (ADR 0003 §14-§15, INT): SIMULATED. These tests pin what the
// harness does, never how the cat behaves, so they hold before and after the v1.2 behaviour work:
// it reads the sim through SimHooks and public methods only; its estimators are right; its layouts,
// taskbar, edge bands and the four v1.2 users do what §14 says they do; the band evaluation covers
// the cells it should.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cellChecks, evaluateBands, FULL_LIMITS } from '../../profile/bands';
import { cellKey, MATRICES, parseCellKey, runProfile, runRecovery, runThrowMonteCarlo, summarizeCell, type RunResult } from '../../profile/behaviorProfile';
import { VirtualClock } from '../../profile/clock';
import { BROWSER_FRAME, CHROME_ID, COVER_ID, Desktop, edgeBandsFor, edgeFootprintPx, FULL, SCREEN_H, SCREEN_W, TASKBAR_HIDE_DELAY_MS, TASKBAR_SLIDE_MS, TaskbarSim } from '../../profile/desktop';
import { concentration, HOUR, kaplanMeier, kmQuantile, MIN, minGap, seriesSummary, survivalAt, widenRate, widenShare } from '../../profile/metrics';
import { REAL_HANDLING, USER_MODELS } from '../../profile/user';
import { mulberry32 } from '../../../src/core/behavior';
import type { SimEnv } from '../../../src/shared/sim';
import { ROOT } from '../surfaces/pipeline';

describe('profile metrics', () => {
  it('Kaplan-Meier: textbook product-limit steps with right-censoring', () => {
    // Events at 6, 6, 6, 7, 10, 13, 16, 22, 23; censored at 6, 9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35 (Freireich 6-MP arm).
    const ev = [6, 6, 6, 7, 10, 13, 16, 22, 23].map((t) => ({ t, event: true }));
    const ce = [6, 9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35].map((t) => ({ t, event: false }));
    const km = kaplanMeier([...ce, ...ev]);
    expect(km.n).toBe(21);
    expect(km.events).toBe(9);
    expect(survivalAt(km, 6)).toBeCloseTo(0.857, 3);
    expect(survivalAt(km, 7)).toBeCloseTo(0.807, 3);
    expect(survivalAt(km, 10)).toBeCloseTo(0.753, 3);
    expect(survivalAt(km, 13)).toBeCloseTo(0.69, 3);
    expect(survivalAt(km, 16)).toBeCloseTo(0.627, 3);
    expect(survivalAt(km, 22)).toBeCloseTo(0.538, 3);
    expect(survivalAt(km, 23)).toBeCloseTo(0.448, 3);
    expect(survivalAt(km, 5)).toBe(1);
    expect(kmQuantile(km, 0.5)).toBe(23);
    expect(kmQuantile(km, 0.9)).toBeNull(); // S never reaches 0.1: too much censoring
    // Without censoring it is the empirical survival function.
    const plain = kaplanMeier([1, 2, 3, 4].map((t) => ({ t, event: true })));
    expect(survivalAt(plain, 2)).toBeCloseTo(0.5, 9);
    expect(kmQuantile(plain, 0.5)).toBe(2);
  });

  it('widening, gaps and concentration', () => {
    const w = widenRate(4, 15, 2);
    expect(w.lo).toBeLessThan(4);
    expect(w.hi).toBeGreaterThan(15);
    expect(widenRate(4, 15, 100).lo).toBeGreaterThan(w.lo);
    const s = widenShare(0.2, 0.35, 40);
    expect(s.lo).toBeLessThan(0.2);
    expect(s.hi).toBeGreaterThan(0.35);
    expect(minGap([300, 100, 220])).toBe(80);
    expect(minGap([1])).toBeNull();
    expect(concentration({ a: 3, b: 1, c: 0 })).toEqual({ total: 4, kinds: 2, maxShare: 0.75, maxKind: 'a' });
  });

  it('series summaries work for the longest scenario series (> 100k samples)', () => {
    const long = Array.from({ length: 300_000 }, (_, i) => (i % 2) * 0.75);
    expect(seriesSummary(long)).toEqual({ min: 0, mean: 0.375, max: 0.75, end: 0.75 });
    expect(seriesSummary([])).toEqual({ min: 0, mean: 0, max: 0, end: 0 });
  });
});

describe('the simulated desktop', () => {
  const fp = edgeFootprintPx(1);

  it('edge bands: clear edges, a maximized window covers both, a floating window cuts one side', () => {
    const clear = edgeBandsFor([], fp);
    expect(clear.map((b) => b.side)).toEqual(['left', 'right']);
    for (const b of clear) expect(b.clearSpans).toEqual([{ y0: 0, y1: SCREEN_H }]);
    for (const b of edgeBandsFor([FULL], fp)) expect(b.clearSpans).toEqual([]);
    const cut = edgeBandsFor([{ x: 10, y: 300, width: 800, height: 400 }], fp);
    expect(cut[0]!.clearSpans).toEqual([
      { y0: 0, y1: 300 },
      { y0: 700, y1: SCREEN_H },
    ]);
    expect(cut[1]!.clearSpans).toEqual([{ y0: 0, y1: SCREEN_H }]);
    // A window that ends just short of the footprint leaves the band clear.
    expect(edgeBandsFor([{ x: Math.ceil(fp) + 1, y: 0, width: 500, height: 500 }], fp)[0]!.clearSpans).toEqual([{ y0: 0, y1: SCREEN_H }]);
  });

  it('L4 offers no window at all; L4b starts maximized and stays so most of the time', () => {
    const clock = new VirtualClock();
    const l4 = new Desktop('L4', () => clock.now, mulberry32(1), null, fp);
    expect(Object.keys(l4.windows)).toEqual([]);
    expect(l4.listed).toEqual([]);
    expect(l4.foreground).toBeNull();
    const l4b = new Desktop('L4b', () => clock.now, mulberry32(2), null, fp);
    expect(l4b.maximizedFront).toBe(true);
    l4b.start(clock);
    for (let t = 0; t < 6 * HOUR; t += 1000) {
      clock.runUntil(t);
      l4b.update();
    }
    const share = l4b.log.maximizedFrontMs / (6 * HOUR);
    expect(share).toBeGreaterThan(0.7);
    expect(share).toBeLessThan(0.97);
    expect(l4b.log.swaps).toBeGreaterThanOrEqual(4);
  });

  it('L3c churns the strip window: covered (bare edges still served), maximized, minimized, restored', () => {
    const clock = new VirtualClock();
    const d = new Desktop('L3c', () => clock.now, mulberry32(3), null, fp);
    d.start(clock);
    const seen = new Set<string>();
    let coveredBare = 0;
    for (let t = 0; t < 2 * HOUR; t += 500) {
      clock.runUntil(t);
      d.update();
      for (const e of d.drainWindowEvents()) seen.add(e.type);
      if (d.windows[COVER_ID]) {
        // The strip's window is still there behind the cover: its own top is served on a live lookup.
        const id = `tabStrip:${CHROME_ID}`;
        if (!d.listed.some((s) => s.id === id) && d.getSurface(id)) coveredBare++;
      }
    }
    expect(d.log.covers).toBeGreaterThan(5);
    expect(d.log.maximizes).toBeGreaterThan(5);
    expect(d.log.minimizes).toBeGreaterThan(5);
    for (const t of ['window.shown', 'window.closed', 'window.minimized', 'window.restored', 'window.moveStart', 'window.moveEnd', 'window.foreground']) expect(seen).toContain(t);
    expect(coveredBare).toBeGreaterThan(0);
  });

  it('L1d drags the browser: moveStart/moveEnd pairs, moving surfaces mid-drag, always on screen', () => {
    const clock = new VirtualClock();
    const d = new Desktop('L1d', () => clock.now, mulberry32(4), null, fp);
    d.start(clock);
    let starts = 0;
    let ends = 0;
    let movingSeen = 0;
    for (let t = 0; t < HOUR; t += 100) {
      clock.runUntil(t);
      d.update();
      for (const e of d.drainWindowEvents()) {
        if (e.type === 'window.moveStart') starts++;
        if (e.type === 'window.moveEnd') ends++;
      }
      if (d.listed.some((s) => s.ownerId === CHROME_ID && s.vx !== 0)) movingSeen++;
      const f = d.browserFrame;
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x + f.width).toBeLessThanOrEqual(SCREEN_W);
    }
    expect(starts).toBeGreaterThan(40);
    expect(Math.abs(starts - ends)).toBeLessThanOrEqual(1);
    expect(movingSeen).toBeGreaterThan(0);
    expect(d.browserFrame).not.toEqual(BROWSER_FRAME);
  });

  it('the auto-hide taskbar slides in at the bottom edge and out after the cursor leaves', () => {
    const clock = new VirtualClock();
    let cursor = { x: 900, y: 600 };
    const tb = new TaskbarSim(() => clock.now, () => cursor);
    const step = (ms: number): void => {
      for (let i = 0; i < ms; i += 16) {
        clock.runUntil(clock.now + 16);
        tb.step();
      }
    };
    step(500);
    expect(tb.shown).toBe(false);
    cursor = { x: 900, y: SCREEN_H - 1 };
    step(TASKBAR_SLIDE_MS + 50);
    expect(tb.visibleRect()).toEqual({ x: 0, y: SCREEN_H - 60, width: SCREEN_W, height: 60 });
    cursor = { x: 900, y: SCREEN_H - 30 };
    step(2000);
    expect(tb.shown).toBe(true);
    cursor = { x: 900, y: 500 };
    step(TASKBAR_HIDE_DELAY_MS + TASKBAR_SLIDE_MS + 100);
    expect(tb.shown).toBe(false);
    expect(tb.reveals).toBe(1);
    const native = tb.native();
    const h = native.findWindow('Shell_TrayWnd');
    expect(h).not.toBeNull();
    expect(native.getWindowRect(h!)).toEqual({ left: 0, top: SCREEN_H - 2, right: SCREEN_W, bottom: SCREEN_H + 58 });
  });
});

describe('the harness reads the sim through hooks only', () => {
  it('no private sim field, wrapped method or internal module is touched', () => {
    const dir = path.join(ROOT, 'tests', 'profile');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // The v1.2-diagnosis harness read act/excursion/fallReason/cat/decisionTargets and wrapped decisionView/requestCandidate.
      expect(src, f).not.toMatch(/CatSimImpl|SimInternals|decisionView|requestCandidate|decisionTargets|\bfallReason\b/);
      // Only the behaviour package's public entry point.
      for (const m of src.matchAll(/from '(\.\.\/\.\.\/src\/core\/behavior[^']*)'/g)) expect(m[1], f).toBe('../../src/core/behavior');
    }
  });

  it('a run records every hook kind it receives and fills the v1.2 env fields from its own ground truth', () => {
    const envs: SimEnv[] = [];
    const r = runProfile({ profile: 'P2', layout: 'L1', user: 'U-mouse-work', seed: 11, hours: 0.5, onStep: (e) => void (envs.length < 200_000 && envs.push(e)) });
    expect(r.integrity.hostTickErrors).toBe(0);
    expect(r.integrity.eventErrors).toBe(0);
    expect(r.integrity.logErrors).toBe(0);
    expect(r.hooks.transition).toBeGreaterThan(10);
    expect(r.hooks.decision).toBeGreaterThan(10);
    expect(r.records.decisions.length).toBe(r.hooks.decision);
    expect(r.snapshot.decisions).toBe(r.hooks.decision);
    expect(envs.every((e) => typeof e.pointerButtonPresses === 'number' && typeof e.cursorIdleMs === 'number' && Array.isArray(e.edgeBands))).toBe(true);
    const presses = envs.map((e) => e.pointerButtonPresses ?? 0);
    for (let i = 1; i < presses.length; i++) expect(presses[i]!).toBeGreaterThanOrEqual(presses[i - 1]!);
    expect(presses[presses.length - 1]).toBe(r.userLog.presses);
    expect(envs.some((e) => e.pointerButtonDown)).toBe(true);
    expect(envs.some((e) => (e.cursorIdleMs ?? 0) > 1500)).toBe(true);
    const nb = runProfile({ profile: 'P2', layout: 'L4', user: 'U-active', variant: 'noEdgeBands', seed: 11, hours: 0.05, onStep: (e) => void envs.push(e) });
    expect(nb.integrity.hostTickErrors).toBe(0);
    expect(envs.slice(-50).every((e) => e.edgeBands === undefined)).toBe(true);
  });
});

describe('the v1.2 users (ADR 0003 §14)', () => {
  const runs = new Map<string, RunResult[]>();
  const of = (user: 'U-active' | 'U-typing' | 'U-play' | 'U-mouse-work'): ReturnType<typeof summarizeCell> => {
    let r = runs.get(user);
    if (!r) {
      // Without the run's one long absence, so most of the hour is present time.
      r = [1, 2].map((seed) => runProfile({ profile: 'P2', layout: 'L1', user, seed, hours: 1, usage: { longIdle: false } }));
      runs.set(user, r);
    }
    for (const x of r) expect(x.integrity.hostTickErrors + x.integrity.eventErrors + x.integrity.logErrors).toBe(0);
    return summarizeCell(r);
  };

  it('U-active moves the cursor, never types, and handles the cat at the REAL rate', () => {
    const c = of('U-active');
    expect(c.user.typingRawPctOfPresent).toBeLessThan(3);
    expect(c.user.modeSharePct.typing ?? 0).toBe(0);
    // Attempt rates per present hour (Poisson over ~2 h: within a factor of ~1.6).
    expect(c.user.petSessionsPerPresentHour).toBeGreaterThan(REAL_HANDLING.petsPerHour / 1.7);
    expect(c.user.petSessionsPerPresentHour).toBeLessThan(REAL_HANDLING.petsPerHour * 1.7);
    expect(c.user.dragsPerPresentHour + c.user.throwsPerPresentHour).toBeGreaterThan((REAL_HANDLING.dragsPerHour + REAL_HANDLING.throwsPerHour) / 1.6);
    expect(c.user.dragsPerPresentHour + c.user.throwsPerPresentHour).toBeLessThan((REAL_HANDLING.dragsPerHour + REAL_HANDLING.throwsPerHour) * 1.6);
  });

  it('U-typing types about 60 % of the present time', () => {
    const c = of('U-typing');
    expect(c.user.typingRawPctOfPresent).toBeGreaterThan(45);
    expect(c.user.typingRawPctOfPresent).toBeLessThan(85);
  });

  it('U-play keeps the cursor within 6 bw of the cat about 20 % of the present time, without clicks while playing', () => {
    const play = of('U-play');
    const active = of('U-active');
    expect(play.user.playPctOfPresent).toBeGreaterThan(10);
    expect(play.user.playPctOfPresent).toBeLessThan(32);
    expect(play.user.cursorNearInPlayPct).toBeGreaterThan(80);
    expect(play.user.cursorNearCatPctOfPresent).toBeGreaterThan(active.user.cursorNearCatPctOfPresent);
    expect(active.user.playPctOfPresent).toBe(0);
    // No clicks while playing.
    for (const r of runs.get('U-play') ?? []) {
      expect(r.userLog.pressesByMode.play ?? 0).toBe(0);
      expect(r.userLog.pressesByMode.mouse ?? 0).toBeGreaterThan(0);
    }
  });

  it('U-mouse-work presses every 2-10 s and reveals the taskbar every 1-3 min', () => {
    const c = of('U-mouse-work');
    const r = runs.get('U-mouse-work') ?? [];
    expect(c.user.pressesPerPresentHour).toBeGreaterThan(3600 / 10);
    expect(c.user.pressesPerPresentHour).toBeLessThan(3600 / 2 + 60);
    for (const x of r) {
      expect(x.userLog.pressGapsS.median).toBeGreaterThanOrEqual(2);
      expect(x.userLog.pressGapsS.median).toBeLessThanOrEqual(10);
    }
    expect(c.user.taskbarRevealsPerHour).toBeGreaterThan(15);
    expect(c.user.taskbarRevealsPerHour).toBeLessThan(60);
    // The REAL tracker followed the fake taskbar: it was on screen, and every reveal was seen.
    expect(c.user.taskbarShownPct).toBeGreaterThan(1);
    for (const x of r) expect(x.userLog.taskbarRevealsSeen).toBeGreaterThanOrEqual(Math.floor(x.userLog.taskbarReveals * 0.9));
  });

  it('the user models carry their stated parameters', () => {
    expect(USER_MODELS['U-typing'].modeShares?.typing).toBe(0.6);
    expect(USER_MODELS['U-play'].modeShares?.play).toBe(0.2);
    expect(USER_MODELS['U-mouse-work'].pressEveryMs).toEqual([2000, 10_000]);
    expect(USER_MODELS['U-mouse-work'].taskbarEveryMs).toEqual([MIN, 3 * MIN]);
    for (const u of ['U-active', 'U-typing', 'U-play', 'U-mouse-work'] as const) expect(USER_MODELS[u].throwsPerHour).toBe(REAL_HANDLING.throwsPerHour);
  });
});

describe('cells, scenarios and band evaluation', () => {
  it('cell keys round-trip and the bands matrix holds every cell §14 names', () => {
    for (const c of MATRICES.bands) expect(parseCellKey(cellKey(c))).toEqual(c.variant === 'default' ? { profile: c.profile, layout: c.layout, user: c.user } : c);
    const keys = new Set(MATRICES.bands.map(cellKey));
    for (const k of ['P1/L1/U-active', 'P2/L3/U-active', 'P1/L4b/U-active', 'P2/L1/U-play', 'P2/L1/U-mouse-work', 'P2/L1/U-typing', 'P2/L1/U-typing+typingReactionsOff', 'P2/L4/U-active', 'P2/L4/U-active+edgesOff', 'P2/L4/U-active+noEdgeBands', 'P2/L3c/U-active', 'P2/L1d/U-active', 'Calm/L1/U-active', 'Mischievous/L1/U-active']) expect(keys).toContain(k);
  });

  it('each kind of cell gets its bands', () => {
    const one = (key: string): string[] => {
      const spec = parseCellKey(key)!;
      const c = summarizeCell([runProfile({ ...spec, seed: 5, hours: 0.1 })]);
      return [...new Set(cellChecks(key, c, FULL_LIMITS).map((b) => b.id))].sort();
    };
    expect(one('P2/L1/U-active')).toEqual(expect.arrayContaining(['B1', 'B10', 'B14', 'B15', 'B2', 'B3', 'B4', 'B8b', 'B9', 'C-climbs', 'C-typing']));
    expect(one('P2/L3/U-active')).not.toContain('B2');
    expect(one('P2/L1/U-play')).toEqual(expect.arrayContaining(['B5', 'B9', 'B14']));
    expect(one('P2/L1/U-mouse-work')).toEqual(expect.arrayContaining(['B5b']));
    expect(one('P2/L1/U-typing+typingReactionsOff')).toEqual(expect.arrayContaining(['B6']));
    expect(one('P2/L4/U-active+edgesOff')).toEqual(expect.arrayContaining(['B11']));
    expect(one('P2/L3c/U-active')).toEqual(expect.arrayContaining(['B13']));
    const all = evaluateBands({});
    expect(all.find((b) => b.id === 'B12')?.status).toBe('n/a');
  });

  it('the B7 and B8 scenarios script hard throws at the stated spacing', () => {
    const mc = runThrowMonteCarlo('P2', 3, 5);
    const throws = mc.records.releases.filter((r) => r.kind === 'throw');
    expect(throws.length).toBeGreaterThanOrEqual(5);
    // U(1500, 5000) px/s at 125 %: every one above the 1100 DIP/s hard-throw speed.
    expect(throws.every((r) => r.speedDip >= 1200)).toBe(true);
    expect(throws.filter((r) => r.thrown).length).toBeGreaterThanOrEqual(5);
    expect(mc.userLog.petSessions + mc.userLog.drags).toBe(0);
    const tr = runRecovery('P2', 3, false);
    const burst = tr.run.records.releases.filter((r) => r.kind === 'throw');
    expect(burst).toHaveLength(5);
    expect(burst[0]!.at).toBeGreaterThanOrEqual(5 * MIN);
    expect(burst[4]!.at - burst[0]!.at).toBeLessThan(4 * MIN);
    expect(tr.samples[tr.samples.length - 1]!.t - tr.burstEndMs).toBeGreaterThanOrEqual(10 * MIN);
    expect(tr.run.userLog.petSessions).toBe(0);
    const petted = runRecovery('P2', 3, true);
    expect(petted.run.userLog.petSessions).toBeGreaterThan(0);
  });
});
