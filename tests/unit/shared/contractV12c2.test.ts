// v1.2 contract amendment C2 (ADR 0003 "Review"): the critics' measurement fixes (fall causes,
// arrival routes, planned-landing outcomes), the variant-aware activity class, the new profile
// fields, the sub-behaviour gates that keep every v2 opt-out meaningful, the closest-preset hint,
// the gait and hit-extent constants, the pounce front extent, the diagnostics additions, and what a
// 1.1.1 downgrade really does with a v1.2 settings file (against a frozen copy of its schema).
import { describe, expect, it } from 'vitest';
import { activityClassOf, ACTIVITY_CLASS, type ExcursionRecord } from '../../../src/shared/behaviorProfile';
import { arrivalRouteOf, BehaviorProfileRecorder, fallCauseOf } from '../../../src/core/behavior/profile';
import { SUB_BEHAVIOR_GATES, SUB_BEHAVIORS, subBehaviorAllowed, type SubBehavior } from '../../../src/shared/behaviorGates';
import { defaultSettings, disabledBehaviorSet, LIVELY_BEHAVIORS, migrateSettings, TOGGLEABLE_BEHAVIORS, type BehaviorId } from '../../../src/shared/settings';
import { closestPreset, PRESET_VALUES } from '../../../src/shared/settingsPresets';
import { CAT_BASE_WIDTH_DIP, GAIT_LIMIT_DIP, HIT_CLEARANCE_DIP, HIT_FRONT_EXTENT_DIP } from '../../../src/shared/cat';
import { MOVEMENT, Mover, type LandingInfo, type MoverConfig } from '../../../src/core/movement';
import { parseSurfaceDiagnostics } from '../../../src/shared/surfaceDiagnosticsSchema';
import { migrateSettings as migrateSettingsV111 } from '../../fixtures/v1.1.1/settings';
import { SurfaceDriver } from '../core/movement/surfaceDriver';
import { Harness, SINGLE, topId } from '../core/behavior/fixtures';
import { fullDiagnostics } from '../main/diagnosticsSurfaceFixture';

type FallInfo = Pick<LandingInfo, 'slipped' | 'plannedOutcome' | 'forced'>;
const info = (o: Partial<FallInfo> = {}): FallInfo => ({ slipped: false, plannedOutcome: null, forced: false, ...o });

describe('C2: fall and arrival accounting (B9, B10 measurable)', () => {
  it('a deliberate slip is a slip; a planned jump that missed is a physics error; a vanished target is environmental', () => {
    expect(fallCauseOf('jump', null, info({ plannedOutcome: 'landed' }))).toBeNull();
    expect(fallCauseOf('jump', null, info({ plannedOutcome: 'missed' }))).toBe('physics');
    expect(fallCauseOf('jump', null, info({ plannedOutcome: 'gone' }))).toBe('gone');
    expect(fallCauseOf('jump', null, info({ slipped: true, plannedOutcome: 'missed' }))).toBe('slip');
    expect(fallCauseOf('step', null, info())).toBeNull();
    expect(fallCauseOf('throw', null, info({ forced: true }))).toBe('thrown');
    expect(fallCauseOf('drop', null, info())).toBe('dropped');
    expect(fallCauseOf('perch', null, info())).toBe('gone');
    expect(fallCauseOf('retracted', 'occluded', info())).toBe('covered');
    expect(fallCauseOf('retracted', 'headroom', info())).toBe('physics');
    expect(fallCauseOf('retracted', 'retracted', info())).toBe('retracted');
    expect(fallCauseOf(null, null, info({ forced: true }))).toBe('physics');
    expect(fallCauseOf(null, null, info())).toBeNull();
  });

  it('arrival routes come from the previous attachment and the last flight', () => {
    expect(arrivalRouteOf('wall', null)).toBe('climb');
    expect(arrivalRouteOf('held', null)).toBe('carried');
    expect(arrivalRouteOf('ground', null)).toBe('walk');
    expect(arrivalRouteOf('air', 'jump')).toBe('jump');
    expect(arrivalRouteOf('air', 'drop')).toBe('carried');
    expect(arrivalRouteOf('air', 'throw')).toBe('carried');
    expect(arrivalRouteOf('air', null)).toBe('other');
  });

  const CFG: MoverConfig = { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true };
  const driver = (): SurfaceDriver => new SurfaceDriver(new Mover(SINGLE, CFG, { displayId: '1', xFrac: 0.5 }), SINGLE);
  const firstLanding = (d: SurfaceDriver, maxMs: number): LandingInfo | null => {
    let landed: LandingInfo | null = null;
    d.until((r) => {
      if (r.landed) landed = r.landed;
      return r.landed !== null;
    }, maxMs);
    return landed;
  };

  it('the mover reports how a planned jump ended against the support it aimed at', () => {
    const ok = driver();
    ok.windows = { w: { x: 1100, y: 800, width: 500, height: 240 } };
    ok.goal({ x: 1400, y: 799 });
    expect(firstLanding(ok, 20_000)).toMatchObject({ intentional: true, plannedSupportId: topId('w'), plannedOutcome: 'landed' });

    const gone = driver();
    gone.windows = { w: { x: 1100, y: 750, width: 500, height: 290 } };
    gone.goal({ x: 1300, y: 749 });
    expect(gone.until((r) => r.tookOff, 20_000)).toBe(true);
    gone.step();
    gone.windows = {};
    expect(firstLanding(gone, 3000)).toMatchObject({ plannedSupportId: topId('w'), plannedOutcome: 'gone' });

    const moved = driver();
    moved.windows = { w: { x: 1100, y: 750, width: 500, height: 290 } };
    moved.goal({ x: 1300, y: 749 });
    expect(moved.until((r) => r.tookOff, 20_000)).toBe(true);
    moved.step();
    moved.windows = { w: { x: 1700, y: 750, width: 500, height: 290 } };
    expect(firstLanding(moved, 3000)).toMatchObject({ plannedSupportId: topId('w'), plannedOutcome: 'missed' });

    const dropped = driver();
    dropped.m.startDrag({ x: dropped.m.x, y: dropped.m.y });
    dropped.dragCursor = { x: 960, y: 300 };
    dropped.step();
    dropped.dragCursor = null;
    dropped.m.endDrag(null, { x: 0, y: 0 }, dropped.now, true);
    expect(firstLanding(dropped, 3000)).toMatchObject({ plannedSupportId: null, plannedOutcome: null });
  });

  it('a stay the cat was dropped onto is recorded as carried (the route survives enterLanding)', () => {
    const records: ExcursionRecord[] = [];
    const h = new Harness({ seed: 5, hooks: { onExcursion: (r) => records.push(r) } });
    h.env.windows = { w: { x: 600, y: 600, width: 700, height: 400 } };
    h.run(6000);
    const before = records.length;
    h.step([{ type: 'pointer.dragStart', at: { x: h.last!.x, y: h.last!.y - 30 } }]);
    h.env.dragCursor = { x: 950, y: 420 };
    h.step();
    h.step();
    h.step([{ type: 'pointer.dragEnd', at: { x: 950, y: 420 }, velocity: { x: 0, y: 0 } }]);
    h.env.dragCursor = null;
    h.run(3000);
    const arrive = records.slice(before).find((r) => r.phase === 'arrive');
    expect(arrive).toBeDefined();
    expect(arrive!.surfaceKind).toBe('windowTop');
    expect(arrive!.arrivedBy).toBe('carried');
  });
});

describe('C2: activity classes and the new profile fields', () => {
  it('a trip up counts as active by its variant; everything else keeps its state class', () => {
    expect(activityClassOf('inspectingWindow', 'explore')).toBe('active');
    expect(activityClassOf('inspectingWindow', 'edge')).toBe('calm');
    expect(activityClassOf('inspectingWindow', null)).toBe(ACTIVITY_CLASS.inspectingWindow);
    expect(activityClassOf('walking', 'wander')).toBe('active');
  });

  it('the recorder counts naps, mood exposure, stuck resets, slips and edge peeks', () => {
    const r = new BehaviorProfileRecorder(0);
    r.addTime('idle', 1000);
    r.addTime('sleeping', 5000);
    r.addTime('sleeping', 5000);
    r.addTime('inspectingWindow', 4000, 'explore');
    r.addTime('sleeping', 1000);
    r.addMoods({ wary: 0.31, irritable: 0.5, fearful: Number.NaN }, 2000);
    r.addMoods({ wary: 0.9, irritable: 0.9, fearful: 0.9 }, -5);
    r.decision({ at: 1, state: 'idle', variant: null, cause: 'watchdog', activityClass: 'calm', utility: null, bestUtility: null, candidates: 0, episode: 'calm', standingOn: 'floor', typing: false });
    r.slip({ at: 2, kind: 'scramble', risk: 0.4 });
    r.fall({ at: 3, cause: 'slip', heightDip: 100, impact: 'medium', jumpKind: 'up' });
    r.slip({ at: 3, kind: 'miss', risk: 0.6 });
    r.edgeVisit({ at: 4, side: 'left', covered: true, topReached: false, holdMs: 0, leave: 'climbDown' });
    r.edgeVisit({ at: 5, side: 'right', covered: false, topReached: true, holdMs: 6000, leave: 'wallJump' });
    const s = r.snapshot(10);
    expect(s.sleeps).toBe(2);
    expect(s.timeMs.active).toBe(4000);
    expect(s.moodMs).toEqual({ wary: 2000, irritable: 0, fearful: 0 });
    expect(s.stuckResets).toBe(1);
    expect(s.slips).toBe(2);
    expect(s.falls.byCause.slip).toBe(1);
    expect(s.screenEdgeVisits).toBe(2);
    expect(s.screenEdgePeeks).toBe(1);
  });

  it('the sim tags its decisions with the activity class', () => {
    const classes: string[] = [];
    const h = new Harness({ seed: 9, hooks: { onDecision: (d) => classes.push(d.activityClass) } });
    h.run(120_000);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(['asleep', 'calm', 'active', 'interaction', 'reaction', 'physical', 'away']).toContain(c);
  });
});

describe('C2: v2 opt-outs gate the new acts (never re-enabled under a new name)', () => {
  const known = new Set<string>([...TOGGLEABLE_BEHAVIORS, ...LIVELY_BEHAVIORS]);
  const off = (id: BehaviorId): ReadonlySet<BehaviorId> =>
    disabledBehaviorSet({
      disabledBehaviors: (TOGGLEABLE_BEHAVIORS as readonly string[]).includes(id) ? [id as (typeof TOGGLEABLE_BEHAVIORS)[number]] : [],
      disabledExtras: (LIVELY_BEHAVIORS as readonly string[]).includes(id) ? [id] : [],
    });
  const blocked = (id: BehaviorId): SubBehavior[] => SUB_BEHAVIORS.filter((a) => !subBehaviorAllowed(a, off(id)));

  it('every act has gates naming only real switches, and nothing is gated with everything on', () => {
    for (const a of SUB_BEHAVIORS) {
      expect(SUB_BEHAVIOR_GATES[a].length, a).toBeGreaterThan(0);
      for (const g of SUB_BEHAVIOR_GATES[a]) expect(known.has(g), `${a} -> ${g}`).toBe(true);
      expect(subBehaviorAllowed(a, new Set()), a).toBe(true);
    }
  });

  it('the v2 switches the critics named remove every new act under them', () => {
    expect(blocked('pawAtCursor')).toEqual(expect.arrayContaining(['huntBat', 'huntJumpSwat', 'mischiefSwat', 'overstimSwat', 'defensiveSwat']));
    expect(blocked('pawAtCursor')).not.toContain('huntStalk');
    expect(blocked('taskbarPlay')).toEqual(['taskbarTarget']);
    expect(blocked('zoomies')).toEqual(expect.arrayContaining(['zoomies', 'reactionZoomie']));
    expect(blocked('grooming')).toEqual(['groom']);
    expect(blocked('chaseCursor')).toEqual(expect.arrayContaining(['huntStalk', 'huntPounce', 'huntJumpSwat', 'huntBat', 'ambush', 'reactionPounce']));
    expect(blocked('climbWindows')).toEqual(expect.arrayContaining(['screenEdgeClimb', 'screenEdgeWallJump', 'windowWallJump']));
    expect(blocked('inspectWindows')).toEqual(expect.arrayContaining(['inspectWindow', 'edgeSit']));
    expect(blocked('inspectWindows')).not.toContain('tripUp');
    expect(blocked('tabStrips')).toEqual(expect.arrayContaining(['watchTab', 'tabReaction']));
    expect(blocked('hissing')).toEqual(expect.arrayContaining(['defensiveHiss', 'defensiveSwat']));
  });

  it('every switch except the state-level and provider-level ones gates at least one new act', () => {
    const stateOrProviderOnly = new Set(['seekAttention', 'explorerTabs', 'terminalTabs']);
    for (const id of known) if (!stateOrProviderOnly.has(id)) expect(blocked(id as BehaviorId).length, id).toBeGreaterThan(0);
  });
});

describe('C2: presets, gaits, hit extents, pounce clearance', () => {
  it('the closest preset names what a custom setting is near (the user: Playful)', () => {
    const user = { behavior: { ...PRESET_VALUES.playful.behavior, autonomy: 0.8, cursorPlay: 0.7 }, interaction: { ...PRESET_VALUES.playful.interaction } };
    expect(closestPreset(user)).toBe('playful');
    expect(closestPreset(PRESET_VALUES.calm)).toBe('calm');
    expect(closestPreset(PRESET_VALUES.mischievous)).toBe('mischievous');
  });

  it("the mover's paces stay within their clips' clean-gait limits at speed 1", () => {
    expect(MOVEMENT.stalkDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.stalk);
    expect(MOVEMENT.slowDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.walk);
    expect(MOVEMENT.walkDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.walk);
    expect(MOVEMENT.chaseDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.run);
    expect(MOVEMENT.runDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.run);
    expect(MOVEMENT.sprintDip).toBeLessThanOrEqual(GAIT_LIMIT_DIP.sprint);
    for (const v of Object.values(HIT_FRONT_EXTENT_DIP)) {
      expect(v).toBeGreaterThan(HIT_CLEARANCE_DIP);
      expect(v).toBeLessThan(CAT_BASE_WIDTH_DIP);
    }
  });

  it('pounceAt measures the clearance from the landing pose front, not the anchor', () => {
    const d = driver2();
    d.step();
    const bw = d.m.bodyWidth;
    const target = d.m.x - 2 * bw;
    expect(d.m.pounceAt(d.now, { x: target, y: d.m.y }, { crouchMs: 600, shortPx: 10, maxDistPx: 3 * bw, frontExtentPx: 30 })).toBe(true);
    expect(d.until((r) => r.landed !== null, 3000)).toBe(true);
    expect(d.m.x).toBeCloseTo(target + 40, 0);
  });

  function driver2(): SurfaceDriver {
    return new SurfaceDriver(new Mover(SINGLE, { size: 1, movementSpeed: 1, allowMultiMonitor: true, perchOnWindows: true }, { displayId: '1', xFrac: 0.5 }), SINGLE);
  }
});

describe('C2: surface diagnostics carry the TabView and screen-edge fields (strictly)', () => {
  it('accepts the optional fields and rejects anything beyond them', () => {
    const d = fullDiagnostics();
    const withNew = {
      ...d,
      provider: {
        ...d.provider,
        tabStrips: { ...d.provider.tabStrips, lastRejection: 'unsupportedApp', byKind: { chromium: 1, tabview: 2 } },
        screenEdges: { bands: 2, clearSpans: 1, coveredSpans: 1, guard: 'active', failClosed: 0 },
      },
    };
    expect(parseSurfaceDiagnostics(withNew)?.provider.screenEdges?.guard).toBe('active');
    expect(parseSurfaceDiagnostics(d)).not.toBeNull();
    expect(parseSurfaceDiagnostics({ ...withNew, provider: { ...withNew.provider, screenEdges: { ...withNew.provider.screenEdges, windowId: 'x' } } })).toBeNull();
    expect(parseSurfaceDiagnostics({ ...withNew, provider: { ...withNew.provider, tabStrips: { ...withNew.provider.tabStrips, byKind: { notepad: 1 } } } })).toBeNull();
  });
});

describe('C2: a 1.1.1 downgrade, against a frozen copy of its settings schema', () => {
  it('1.1.1 reads a v1.2 file, keeps the v2 opt-outs and values, and drops the v1.2-only keys; re-upgrading loses disabledExtras (the sidecar restores them)', () => {
    const d = defaultSettings();
    const v3 = JSON.parse(
      JSON.stringify({ ...d, behavior: { ...d.behavior, autonomy: 0.8, cursorPlay: 0.7, disabledBehaviors: ['zoomies', 'taskbarPlay'], disabledExtras: ['pounce', 'slips'] } }),
    ) as Record<string, unknown>;
    const old = migrateSettingsV111(v3);
    expect(old.schemaVersion).toBe(2);
    expect(old.behavior.disabledBehaviors).toEqual(['zoomies', 'taskbarPlay']);
    expect(old.behavior.autonomy).toBe(0.8);
    expect(old.behavior.cursorPlay).toBe(0.7);
    expect(old.behavior).not.toHaveProperty('disabledExtras');
    expect(old).not.toHaveProperty('sound');
    expect(JSON.stringify(old.perception)).toBe(JSON.stringify(d.perception));
    const back = migrateSettings(JSON.parse(JSON.stringify(old)));
    expect(back.behavior.disabledBehaviors).toEqual(['zoomies', 'taskbarPlay']);
    expect(back.behavior.disabledExtras).toEqual([]);
    expect(disabledBehaviorSet(back.behavior).has('zoomies')).toBe(true);
  });
});
