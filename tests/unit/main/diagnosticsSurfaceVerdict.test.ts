// The one-sentence surface verdict (v1.1.1): every branch, in priority order. SIMULATED
// diagnostics (counts and reasons only).
import { describe, expect, it } from 'vitest';
import { describeCounts, FLOOR_ONLY_TEXT, FRONT_MAXIMIZED_TEXT, SURFACE_VERDICT_CODES, surfaceVerdict, type SurfaceVerdictInput } from '../../../src/main/diagnostics/surfaceVerdict';
import { emptySurfaceCounts } from '../../../src/shared/surfaceDiagnostics';
import { decisionDiagnostics, navDiagnostics, providerDiagnostics } from './diagnosticsSurfaceFixture';

/** A cat on the floor that can reach a window top and two sides: the 'exploring' case. */
function input(over: { observers?: SurfaceVerdictInput['observers'] } & Partial<Omit<SurfaceVerdictInput, 'observers'>> = {}): SurfaceVerdictInput {
  return {
    observers: over.observers ?? 'tracked',
    provider: over.provider ?? providerDiagnostics(),
    nav: over.nav ?? navDiagnostics(),
    decision: over.decision ?? decisionDiagnostics(),
  };
}

const nothingListed = providerDiagnostics({ listed: { ...emptySurfaceCounts(), taskbar: 1 }, windowsWithSurfaces: 0 });

describe('surface verdict', () => {
  it('reports unavailable observers first, whatever else is known', () => {
    const v = surfaceVerdict(input({ observers: 'unavailable', provider: providerDiagnostics({ frontMaximized: true }) }));
    expect(v.code).toBe('observersUnavailable');
    expect(v.text).toMatch(/Window tracking is unavailable/);
  });

  it('1.4.0: says the cat keeps to the floor where no window tracking exists, without naming a PC or taskbar', () => {
    const v = surfaceVerdict({ ...input({ observers: 'unavailable' }), floorOnly: true });
    expect(v.code).toBe('observersUnavailable');
    expect(v.text).toBe(FLOOR_ONLY_TEXT);
    expect(v.text).not.toMatch(/\bPC\b|taskbar/);
    expect(surfaceVerdict({ ...input({ observers: 'unavailable' }), floorOnly: false }).text).toMatch(/on this PC/);
  });

  it('says where the cat is while it is up on a window, a side or a tab strip', () => {
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ support: 'windowTop' }) }))).toEqual({ code: 'elevated', text: 'The cat is up on a window top right now.' });
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ support: 'windowSide' }) })).text).toMatch(/climbing a window side/);
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ support: 'tabStrip' }) })).text).toMatch(/tab strip/);
    // A taskbar lies on the floor: not "up".
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ support: 'taskbar' }) })).code).toBe('exploring');
  });

  it('blames a maximized front window when nothing is listed (the user-reported layout)', () => {
    const v = surfaceVerdict(input({ provider: { ...nothingListed, frontMaximized: true } }));
    expect(v).toEqual({ code: 'frontMaximized', text: FRONT_MAXIMIZED_TEXT });
    expect(v.text).toBe('The window in front is maximized, so there is no window edge to climb. Restore it to a normal window and the cat can explore it.');
  });

  it('a listed taskbar alone does not count as something to climb', () => {
    expect(surfaceVerdict(input({ provider: nothingListed })).code).toBe('nothingListed');
  });

  it('names the most common reason when no window offers an edge', () => {
    const minimized = surfaceVerdict(input({ provider: { ...nothingListed, skipped: { minimized: 4, covered: 1 } } }));
    expect(minimized.code).toBe('nothingListed');
    expect(minimized.text).toBe('There are no window edges to climb right now: the open windows are minimized.');
    expect(surfaceVerdict(input({ provider: { ...nothingListed, skipped: { minimized: 1, covered: 3 } } })).text).toMatch(/hidden behind other windows/);
    expect(surfaceVerdict(input({ provider: { ...nothingListed, skipped: {} } })).text).toMatch(/no window offers an edge/);
    expect(surfaceVerdict(input({ provider: { ...nothingListed, windowsConsidered: 0, skipped: {} } })).text).toBe('No app windows are open, so there is nothing to climb besides the floor.');
  });

  it('names the top rejection when edges are listed but none is usable', () => {
    const none = { ...emptySurfaceCounts(), taskbar: 1 };
    const v = surfaceVerdict(input({ nav: navDiagnostics({ accepted: none, reachable: none, rejected: { noHeadroom: 1, nearFloor: 5 } }) }));
    expect(v.code).toBe('noneAccepted');
    expect(v.text).toBe("The cat sees 10 window edges but can't use any of them: they are too close to the floor.");
    expect(surfaceVerdict(input({ nav: navDiagnostics({ accepted: none, rejected: { disabled: 2 } }) })).text).toMatch(/switched off in Settings › Behaviour/);
    expect(surfaceVerdict(input({ nav: navDiagnostics({ accepted: none, rejected: {} }) })).text).toMatch(/none passed its safety checks/);
    const one = providerDiagnostics({ listed: { ...emptySurfaceCounts(), windowTop: 1 } });
    expect(surfaceVerdict(input({ provider: one, nav: navDiagnostics({ accepted: none, rejected: {} }) })).text).toMatch(/^The cat sees 1 window edge but/);
  });

  it('says the edges are out of reach when accepted ones exist but none is reachable from where the cat is', () => {
    const v = surfaceVerdict(input({ nav: navDiagnostics({ reachable: { ...emptySurfaceCounts(), taskbar: 1 } }) }));
    expect(v.code).toBe('noneReachable');
    expect(v.text).toBe(
      "The cat knows 2 window tops, 4 window sides and 1 tab strip but can't reach any from where it is: they are too high to jump to and no window side comes down close enough to climb.",
    );
  });

  it('reports climbing switched off when every elevated destination is disabled', () => {
    const v = surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'disabled', climb: 'disabled', tabStrip: 'disabled' } }) }));
    expect(v.code).toBe('switchedOff');
    expect(v.text).toMatch(/switched off in Settings › Behaviour/);
    // One kind still allowed: not the verdict.
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'available', climb: 'disabled', tabStrip: 'disabled' } }) })).code).toBe('exploring');
  });

  it('reports the break between excursions while nothing is available and something cools down', () => {
    const v = surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'cooldown', climb: 'cooldown', tabStrip: 'noSurfaces' } }) }));
    expect(v.code).toBe('cooldown');
    expect(v.text).toMatch(/taking a break before its next trip up/);
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'cooldown', climb: 'available', tabStrip: 'noSurfaces' } }) })).code).toBe('exploring');
  });

  it('says there is no way up when the cat reaches only window sides and the last look found no top to go to (BEH-1)', () => {
    const sides = { ...emptySurfaceCounts(), taskbar: 1, windowSide: 2 };
    const noWayUp = { perch: 'noSurfaces', climb: 'unreachable', tabStrip: 'noSurfaces' } as const;
    const v = surfaceVerdict(input({ nav: navDiagnostics({ reachable: sides }), decision: decisionDiagnostics({ targets: noWayUp, exploreUrge: 0 }) }));
    expect(v.code).toBe('noWayUp');
    expect(v.text).toBe('The cat can reach 2 window sides, but none leads to a window top it can stand on (the tops have no room above them or are not usable).');
    for (const targets of [
      { perch: 'unreachable', climb: 'unreachable', tabStrip: 'noSurfaces' },
      { perch: 'excluded', climb: 'unreachable', tabStrip: 'unreachable' },
      // One kind switched off is not "all switched off".
      { perch: 'noSurfaces', climb: 'unreachable', tabStrip: 'disabled' },
    ] as const) {
      expect(surfaceVerdict(input({ nav: navDiagnostics({ reachable: sides }), decision: decisionDiagnostics({ targets, exploreUrge: 0 }) })).code).toBe('noWayUp');
    }
    // A top in reach that the last look still could not use: no claim about the tops.
    const withTop = surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'unreachable', climb: 'unreachable', tabStrip: 'noSurfaces' } }) }));
    expect(withTop).toEqual({ code: 'noWayUp', text: 'The cat can reach 1 window top and 2 window sides from where it is, but none of them is a way up it can use right now.' });
  });

  it("the last look in mid-air ('notGrounded') says nothing about the way up: still 'exploring'", () => {
    const sides = { ...emptySurfaceCounts(), windowSide: 2 };
    const v = surfaceVerdict(input({ nav: navDiagnostics({ reachable: sides }), decision: decisionDiagnostics({ targets: { perch: 'noSurfaces', climb: 'notGrounded', tabStrip: 'noSurfaces' }, exploreUrge: 0 }) }));
    expect(v.code).toBe('exploring');
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ targets: { perch: 'notGrounded', climb: 'notGrounded', tabStrip: 'notGrounded' } }) })).code).toBe('exploring');
  });

  it('says there is no way up when the cat knows window sides but no top or tab strip at all, reachable or not', () => {
    const sides = { ...emptySurfaceCounts(), windowSide: 2 };
    const expected = { code: 'noWayUp', text: 'The cat knows 2 window sides, but none leads to a window top it can stand on (the tops have no room above them or are not usable).' };
    // Sides reachable (the sim counts a side it can get onto) or not: no top exists to go to, whatever the last look said.
    expect(surfaceVerdict(input({ nav: navDiagnostics({ accepted: sides, reachable: sides, rejected: { noHeadroom: 1 } }) }))).toEqual(expected);
    expect(surfaceVerdict(input({ nav: navDiagnostics({ accepted: sides, reachable: emptySurfaceCounts(), rejected: {} }), decision: decisionDiagnostics({ targets: { perch: 'notGrounded', climb: 'notGrounded', tabStrip: 'notGrounded' } }) }))).toEqual(expected);
    // A tab strip is a top too.
    expect(surfaceVerdict(input({ nav: navDiagnostics({ accepted: { ...sides, tabStrip: 1 }, reachable: { ...sides, tabStrip: 1 } }) })).code).toBe('exploring');
  });

  it('otherwise says what the cat can reach and how much it wants to explore', () => {
    const v = surfaceVerdict(input());
    expect(v.code).toBe('exploring');
    expect(v.text).toBe('The cat can reach 1 window top and 2 window sides from where it is; its urge to explore is 35%.');
    expect(surfaceVerdict(input({ decision: decisionDiagnostics({ exploreUrge: Number.NaN }) })).text).toMatch(/is 0%\.$/);
  });

  it('covers every code and lists counts in plain English', () => {
    expect(SURFACE_VERDICT_CODES).toHaveLength(10);
    expect(describeCounts(emptySurfaceCounts())).toBe('no window edges');
    expect(describeCounts({ taskbar: 3, windowTop: 0, windowSide: 0, tabStrip: 2 })).toBe('2 tab strips');
    expect(describeCounts({ taskbar: 0, windowTop: 1, windowSide: 1, tabStrip: 0 })).toBe('1 window top and 1 window side');
  });
});
