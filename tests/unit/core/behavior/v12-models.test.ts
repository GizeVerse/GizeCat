// ADR 0003 §15.1: the pure v1.2 models, without the sim: jump-down limits, the stay intent and the
// leave decision, the scorer, the sub-act gate property (§9.4), the rhythm with nothing to climb,
// startle sensitivity, rough memory.
import { describe, expect, it } from 'vitest';
import type { BehaviorId } from '../../../../src/shared/settings';
import { SUB_BEHAVIOR_GATES, SUB_BEHAVIORS, subBehaviorAllowed } from '../../../../src/shared/behaviorGates';
import { mulberry32, newPersistedCat } from '../../../../src/core/behavior';
import type { LeaveOption } from '../../../../src/core/movement';
import type { Candidate, DecisionView } from '../../../../src/core/behavior/decide';
import { startleSensitivityFor } from '../../../../src/core/behavior/personality';
import { RoughMemory } from '../../../../src/core/behavior/reactions';
import { activeEpisodeProbability, RHYTHM_NOTHING_TO_CLIMB_DAMP, rhythmDrive, type RhythmContext } from '../../../../src/core/behavior/rhythm';
import { chooseLeave, drawStayIntent, jumpDownLimitsFor, leaveAllowed, leaveBackoffMs, scoreLeaveOptions } from '../../../../src/core/behavior/stay';
import { pickProbabilities, scoreAll, subActsOf } from '../../../../src/core/behavior/utility';
import { decisionView, Harness, WAKE_MS } from './fixtures';

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.floor(q * (sorted.length - 1))] as number;
const DAY = 24 * 3600_000;

describe('jump-down limits (ADR 0003 §6.3)', () => {
  it('match the worked defaults and stay ordered for every cat', () => {
    const def = jumpDownLimitsFor(0.55, 0.5, 0.9);
    expect(def.safeDip).toBeGreaterThan(460);
    expect(def.safeDip).toBeLessThan(490);
    expect(def.maxDip).toBeCloseTo(1.35 * def.safeDip, 6);
    const r = mulberry32(5);
    for (let i = 0; i < 1000; i++) {
      const l = jumpDownLimitsFor(r(), r(), r());
      expect(l.safeDip).toBeGreaterThan(0);
      expect(l.maxDip).toBeGreaterThanOrEqual(l.safeDip);
      expect(l.maxDip).toBeLessThanOrEqual(900);
    }
    // A tired, timid cat of low heights keeps far lower than a daring one.
    expect(jumpDownLimitsFor(0, 0.2, 0.2).maxDip).toBeLessThan(jumpDownLimitsFor(1, 0.8, 1).maxDip * 0.5);
  });
});

describe('stay intent (ADR 0003 §2.1)', () => {
  it('10^4 draws at the defaults: median, tails and the hard cap of the band', () => {
    const r = mulberry32(11);
    const ctx = { stayLength: 0.5, laziness: 0.45, curiosity: 0.6, zEff: 0.2, strip: false, typing: false };
    const ms = Array.from({ length: 10_000 }, () => drawStayIntent(r, ctx).plannedMs).sort((a, b) => a - b);
    expect(quantile(ms, 0.5) / 1000).toBeGreaterThanOrEqual(120);
    expect(quantile(ms, 0.5) / 1000).toBeLessThanOrEqual(200);
    expect(quantile(ms, 0.1) / 1000).toBeGreaterThanOrEqual(30);
    expect(ms.filter((m) => m > 300_000).length / ms.length).toBeGreaterThanOrEqual(0.12);
    expect(quantile(ms, 0.9) / 1000).toBeLessThanOrEqual(12 * 60);
    expect(ms.at(-1)).toBeLessThanOrEqual(30 * 60_000);
  });

  it('Activity is not in it; a longer stay setting and typing lengthen it', () => {
    const median = (c: Partial<Parameters<typeof drawStayIntent>[1]>): number => {
      const r = mulberry32(3);
      const ms = Array.from({ length: 3000 }, () => drawStayIntent(r, { stayLength: 0.5, laziness: 0.45, curiosity: 0.6, zEff: 0.2, strip: false, typing: false, ...c }).plannedMs).sort((a, b) => a - b);
      return quantile(ms, 0.5);
    };
    expect(median({ stayLength: 1 })).toBeGreaterThan(median({ stayLength: 0 }) * 1.5);
    expect(median({ typing: true })).toBeGreaterThan(median({}) * 1.15);
  });
});

describe('leave intent (ADR 0003 §2.3)', () => {
  const option = (kind: LeaveOption['kind'], o: Partial<LeaveOption> = {}): LeaveOption => ({ kind, target: { x: 0, y: 0 }, toKind: 'floor', toSurfaceId: null, dropDip: 100, impact: 'soft', effort: 5, risk: 0, startX: 0, emergency: false, ...o });
  const ctx = { heights: 0.55, confidence: 0.5, laziness: 0.45, exploreNeed: 0.4, typing: false, disabled: new Set<BehaviorId>() };

  it('varies: the last kinds are discounted and no kind takes over', () => {
    const opts = [option('jumpDown'), option('climbDown'), option('climbLeap'), option('hop', { toKind: 'windowTop', toSurfaceId: 't' })];
    const r = mulberry32(2);
    const recent: LeaveOption['kind'][] = [];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const c = chooseLeave(r, opts, ctx, recent);
      expect(c).not.toBeNull();
      counts[c!.kind] = (counts[c!.kind] ?? 0) + 1;
      recent.push(c!.kind);
      if (recent.length > 8) recent.shift();
    }
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(4);
    for (const n of Object.values(counts)) expect(n / 2000).toBeLessThan(0.7);
    const same = scoreLeaveOptions([option('climbDown')], ctx, ['climbDown', 'climbDown'])[0]!.score;
    expect(same).toBeCloseTo(scoreLeaveOptions([option('climbDown')], ctx, [])[0]!.score * 0.55 * 0.55, 9);
  });

  it('never takes the emergency option while another allowed one exists; backs off 2 -> 4 -> 8 s', () => {
    const e = option('jumpDown', { emergency: true, risk: 1 });
    const c = option('climbDown');
    const r = mulberry32(4);
    // The Mover lists an emergency option only alone; Mover.emergencyLeaveOption() is the rescue next to a list.
    for (let i = 0; i < 200; i++) expect(chooseLeave(r, [c], ctx, [], e)).toBe(c);
    expect(chooseLeave(r, [e], ctx, [])).toBe(e);
    expect(chooseLeave(r, [], ctx, [])).toBeNull();
    // Everything listed switched off: the rescue, not a retry for ever (review BEH-2).
    const hop = option('hop', { toKind: 'windowTop', toSurfaceId: 't' });
    const noHops = { ...ctx, disabled: new Set<BehaviorId>(['surfaceHops']) };
    expect(chooseLeave(r, [hop], noHops, [])).toBeNull();
    expect(chooseLeave(r, [hop], noHops, [], e)).toBe(e);
    expect([1, 2, 3, 9].map(leaveBackoffMs)).toEqual([2000, 4000, 8000, 8000]);
  });

  it('respects the sub-act gates (hops, wall jumps, a landing on a taskbar); the emergency option is always allowed', () => {
    const off = (...ids: BehaviorId[]): ReadonlySet<BehaviorId> => new Set(ids);
    expect(leaveAllowed(option('hop'), off('surfaceHops'))).toBe(false);
    // Review BEH-3: a jump down onto another window's top or strip is a hop as well.
    expect(leaveAllowed(option('jumpDown', { toKind: 'windowTop', toSurfaceId: 't' }), off('surfaceHops'))).toBe(false);
    expect(leaveAllowed(option('jumpDown', { toKind: 'tabStrip', toSurfaceId: 't' }), off('surfaceHops'))).toBe(false);
    expect(leaveAllowed(option('jumpDown', { toKind: 'windowTop', toSurfaceId: 't', emergency: true }), off('surfaceHops'))).toBe(true);
    expect(leaveAllowed(option('climbLeap'), off('climbWindows'))).toBe(false);
    expect(leaveAllowed(option('jumpDown', { toKind: 'taskbar' }), off('taskbarPlay'))).toBe(false);
    expect(leaveAllowed(option('jumpDown', { toKind: 'taskbar', emergency: true }), off('taskbarPlay'))).toBe(true);
    expect(leaveAllowed(option('jumpDown'), off('surfaceHops', 'taskbarPlay'))).toBe(true);
  });
});

describe('scorer (ADR 0003 §1.3-§1.5)', () => {
  const full = (o: Partial<DecisionView> = {}): DecisionView =>
    decisionView({
      episode: 'none',
      cursor: { point: { x: 500, y: 900 }, speedDip: 400, distBodyLengths: 3, reachable: true },
      foreground: { center: { x: 900, y: 500 }, distBodyLengths: 4 },
      cornerTarget: { x: 60, y: 1040 },
      wanderTarget: { x: 700, y: 1040 },
      perchTarget: { windowId: 'w', point: { x: 800, y: 400 } },
      climbTarget: { point: { x: 800, y: 400 }, dir: 'up', ownerId: 'w' },
      tabStripTarget: { x: 800, y: 300 },
      edgeTarget: { wallId: 'screenEdge:1:right', side: 'right', point: { x: 1880, y: 1040 }, gripY: 200, peek: false, covered: false },
      cursorBand: 'watch',
      huntReady: true,
      ambushSpot: { x: 500, y: 1040 },
      surpriseReady: true,
      recentStimulus: true,
      recentRough: 3,
      restedMs: 90_000,
      drives: { socialNeed: 0.8, playNeed: 0.8, exploreNeed: 0.8, sleepiness: 0.7, mischief: 0.6, huntDrive: 0.8, irritability: 0, frustration: 0, wariness: 0.4 },
      ...o,
    });

  it('has no top-k cut: every feasible candidate above the floor keeps a chance', () => {
    const p = pickProbabilities(scoreAll(full()));
    expect(p.length).toBeGreaterThan(8);
    for (const { p: x } of p) expect(x).toBeGreaterThan(0);
  });

  it('drive-gated candidates have no baseline: a satisfied drive never starts them', () => {
    const none = { socialNeed: 0, playNeed: 0.5, exploreNeed: 0.5, sleepiness: 0, mischief: 0, huntDrive: 0, irritability: 0, frustration: 0, wariness: 0 };
    const states = scoreAll(full({ drives: none, recentRough: 0, recentStimulus: false, surpriseReady: false, ambushSpot: null })).map((c) => `${c.item.state}:${c.item.variant ?? ''}`);
    for (const k of ['seekingAttention:', 'chasingCursor:hunt', 'hiding:', 'startled:surprise', 'resting:ambush', 'fallingAsleep:']) expect(states).not.toContain(k);
  });

  it('on a stay only the on-surface plan is offered: leaving is not a candidate', () => {
    const stay = { kind: 'tabStrip' as const, walkRangeBl: 8, patrolReady: true, patrolTarget: { x: 600, y: 300 }, watchTab: { x: 650, y: 300 } };
    const keys = scoreAll(full({ stay, edgeLook: { windowId: 'w', point: { x: 610, y: 300 } }, huntReady: false })).map((c) => `${c.item.state}:${c.item.variant ?? ''}`);
    for (const k of keys) expect(['walking:patrol', 'inspectingWindow:edge', 'idle:watchTab', 'resting:', 'grooming:', 'fallingAsleep:', 'walking:favorite', 'watchingCursor:']).toContain(k);
    expect(keys).toContain('walking:patrol');
    expect(keys).toContain('idle:watchTab');
    expect(keys).toContain('inspectingWindow:edge');
  });

  it('typing: no hunt or play of any kind is generated from the raw signal, whatever the setting', () => {
    for (const reactToTyping of [true, false]) {
      const v = full({ typingRaw: true, typing: reactToTyping });
      v.behavior = { ...v.behavior, reactToTyping };
      const states = scoreAll(v).map((c) => c.item.state);
      expect(states).not.toContain('chasingCursor');
      expect(states).not.toContain('playing');
    }
  });

  it('the exploration urge lifts trips up in the v1.2 scorer, and only as far as the explore need allows', () => {
    const trip = (v: DecisionView): number => scoreAll(v).find((c) => c.item.state === 'inspectingWindow' && c.item.variant === 'explore')?.score ?? 0;
    const drives = (exploreNeed: number) => ({ socialNeed: 0.3, playNeed: 0.4, exploreNeed, sleepiness: 0.2, mischief: 0.3, huntDrive: 0, irritability: 0, frustration: 0, wariness: 0 });
    expect(trip(full({ exploreUrge: 1, drives: drives(0.5) }))).toBeGreaterThan(1.5 * trip(full({ exploreUrge: 0, drives: drives(0.5) })));
    expect(trip(full({ exploreUrge: 1, drives: drives(0) }))).toBeCloseTo(trip(full({ exploreUrge: 0, drives: drives(0) })), 9);
    // With a maximized window in front nothing is reachable: no trip is generated at all, whatever the urge.
    expect(trip(full({ exploreUrge: 1, perchTarget: null, climbTarget: null, tabStripTarget: null, drives: drives(1) }))).toBe(0);
  });

  it('a stay a cover cut short doubles its trip (the resume token)', () => {
    const trip = (c: Candidate): boolean => c.state === 'inspectingWindow' && c.variant === 'explore';
    const base = scoreAll(full({ placeSeen: () => 'session' })).find((c) => trip(c.item))!.score;
    const resumed = scoreAll(full({ placeSeen: () => 'session', resumePlace: 'w:w' })).find((c) => trip(c.item))!.score;
    expect(resumed).toBeCloseTo(base * 2, 9);
  });

  it('property (ADR 0003 §9.4): with a switch off, 10^4 decisions hold no act of its gated set', () => {
    const r = mulberry32(7);
    const switches = [...new Set(Object.values(SUB_BEHAVIOR_GATES).flat())] as BehaviorId[];
    let checked = 0;
    for (const sw of switches) {
      const disabled = new Set<BehaviorId>([sw]);
      const gated = new Set(SUB_BEHAVIORS.filter((a) => !subBehaviorAllowed(a, disabled)));
      for (let i = 0; i < Math.ceil(10_000 / switches.length); i++) {
        const v = full({
          disabled,
          episode: r() < 0.5 ? 'active' : 'calm',
          drives: { socialNeed: r(), playNeed: r(), exploreNeed: r(), sleepiness: r(), mischief: r(), huntDrive: r(), irritability: r(), frustration: r(), wariness: r() },
          stay: r() < 0.3 ? { kind: 'tabStrip', walkRangeBl: 8, patrolReady: true, patrolTarget: { x: 600, y: 300 }, watchTab: { x: 650, y: 300 } } : null,
        });
        for (const c of scoreAll(v)) {
          checked++;
          for (const act of subActsOf(c.item.state, c.item.variant)) expect(gated.has(act), `${sw}: ${c.item.state}:${c.item.variant}`).toBe(false);
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('the rhythm with nothing to climb (ADR 0003 §1.6, B1c)', () => {
  const ctx = (o: Partial<RhythmContext> = {}): RhythmContext => ({ autonomy: 0.8, energy: 0.8, energyLevel: 0.6, playNeed: 0.3, exploreNeed: 0.3, mischief: 0.2, huntDrive: 0.1, zEff: 0.2, typing: false, typingIntensity: 0, busySwitching: false, video: false, night: false, ...o });

  it('nothing to climb leans the episodes calm', () => {
    expect(rhythmDrive(ctx({ nothingToClimb: true }))).toBeCloseTo(rhythmDrive(ctx()) - RHYTHM_NOTHING_TO_CLIMB_DAMP, 9);
    expect(activeEpisodeProbability(ctx({ nothingToClimb: true }))).toBeLessThan(activeEpisodeProbability(ctx()));
  });

  /** A cat on the floor with a saturated explore need, as the sim hands it to the rhythm. */
  const seen = (env: (h: Harness) => void): RhythmContext => {
    const h = new Harness({ seed: 3 });
    env(h);
    h.run(WAKE_MS + 4000);
    const sim = h.sim as unknown as { rhythmContext(): RhythmContext; cat: { drives: { exploreNeed: number } } };
    sim.cat.drives.exploreNeed = 1;
    return sim.rhythmContext();
  };

  it('a need nothing around can satisfy does not make the cat restless: an empty desktop, a maximized window', () => {
    const empty = seen(() => {});
    expect(empty.nothingToClimb).toBe(true);
    expect(empty.exploreNeed).toBe(0);
    const max = seen((h) => {
      h.env.foreground = { id: 'w', rect: { x: 0, y: 0, width: 1920, height: 1040 }, processName: 'app.exe', category: 'code', minimized: false, maximized: true, fullscreen: false, title: '' } as never;
    });
    expect(max.nothingToClimb).toBe(true);
    expect(max.exploreNeed).toBe(0);
  });

  it('with a window to climb the need counts in full', () => {
    const open = seen((h) => {
      h.env.windows = { w: { x: 300, y: 500, width: 900, height: 540 } };
    });
    expect(open.nothingToClimb).toBe(false);
    expect(open.exploreNeed).toBe(1);
    expect(rhythmDrive(open)).toBeGreaterThan(rhythmDrive(seen(() => {})));
  });
});

describe('startle sensitivity (ADR 0003 §1.2)', () => {
  it('comes from a separate stream: seeded cats keep their other traits, and it follows bornAt and confidence', () => {
    const a = newPersistedCat(mulberry32(42), 1_800_000_000_000);
    const b = newPersistedCat(mulberry32(42), 1_800_000_999_000);
    const { startleSensitivity: sa, ...ra } = a.traits;
    const { startleSensitivity: sb, ...rb } = b.traits;
    expect(ra).toEqual(rb);
    expect(sa).not.toBe(sb);
    expect(a.catId).toBe(b.catId);
    expect(startleSensitivityFor(1_800_000_000_000, 0.9)).toBeLessThan(startleSensitivityFor(1_800_000_000_000, 0.1));
    for (let i = 0; i < 200; i++) {
      const s = startleSensitivityFor(1_800_000_000_000 + i * DAY, 0.5);
      expect(s).toBeGreaterThanOrEqual(0.12);
      expect(s).toBeLessThanOrEqual(0.92);
    }
  });
});

describe('rough-handling memory (ADR 0003 §5.4)', () => {
  it('a throw is still counted 59 minutes later whatever else happened, and goes after an hour', () => {
    const m = new RoughMemory();
    const t0 = 1_800_000_000_000;
    m.add(t0, 'throw');
    // However many other things the cat did in between: only throws, rough drags and annoyed reactions go in the list.
    expect(m.countSince(t0 + 59 * 60_000 - 3600_000)).toBe(1);
    expect(m.countSince(t0 + 61 * 60_000 - 3600_000)).toBe(0);
  });
});
