// Hunting in ordinary use (ADR 0003 §4): the prey signal of a cursor hanging around, the press hold by where the
// hand is, the crouch that waits, prey that hops away and the gates that stay strict. SIMULATED: the real sim and
// Mover with an injected environment.
import { describe, expect, it } from 'vitest';
import type { HuntRecord } from '../../../../src/shared/behaviorProfile';
import {
  BUSY_HAND_REST_MS,
  CROUCH_PRESS_GRACE_MS,
  CROUCH_STILL_MAX_MS,
  CURSOR_PRESENCE_MS,
  CURSOR_PRESENCE_Q,
  HUNT_LOST_GRACE_MS,
  PRESS_HOLD_BUSY_MS,
  PRESS_HOLD_FAR_MS,
  PRESS_HOLD_MS,
  STILL_CURSOR_MS,
  TASKBAR_HIDE_HOLD_MS,
  huntGate,
  pounceHoldMs,
  pressHoldMs,
  preySalience,
  stepHuntDrive,
  type HuntGateInput,
  type PreyInput,
} from '../../../../src/core/behavior/hunt';
import { Harness, settingsWith, WAKE_MS } from './fixtures';

const MIN = 60_000;
const BW = 84;
const FLOOR = 1040;

const prey = (o: Partial<PreyInput> = {}): PreyInput => ({ dxBw: 2, dyBh: 1, speedDip: 0, erratic: false, idleMs: 0, crouching: false, flick: false, sameDisplay: true, ...o });
const open: HuntGateInput = { off: false, typingRaw: false, sinceTypingMs: Infinity, buttonDown: false, sincePressMs: Infinity, pettingZone: false, taskbar: false, stripContainer: false, caption: false, wary: false, command: false, unavailable: false };

describe('the prey signal (ADR 0003 §4.1)', () => {
  it('a cursor resting in the watch band stays of interest for a while, then stops being prey', () => {
    const still = (idleMs: number): number => preySalience(prey({ idleMs })).q;
    expect(still(STILL_CURSOR_MS + 1)).toBe(CURSOR_PRESENCE_Q);
    expect(still(CURSOR_PRESENCE_MS)).toBe(CURSOR_PRESENCE_Q);
    expect(still(CURSOR_PRESENCE_MS + 1)).toBe(0);
  });

  it('fast movement counts for more than presence, and the far part of the band for less than the near one', () => {
    expect(preySalience(prey({ speedDip: 400 })).q).toBeGreaterThan(CURSOR_PRESENCE_Q);
    expect(preySalience(prey({ dxBw: 6 })).qHat).toBeLessThan(preySalience(prey({ dxBw: 1 })).qHat);
    expect(preySalience(prey({ dxBw: 4 })).qHat).toBeCloseTo(CURSOR_PRESENCE_Q / 2, 5);
  });

  it('outside the watch band or on another display there is no prey, resting or not', () => {
    expect(preySalience(prey({ dxBw: 7.5 })).q).toBe(0);
    expect(preySalience(prey({ dyBh: 5 })).q).toBe(0);
    expect(preySalience(prey({ sameDisplay: false, speedDip: 800 })).q).toBe(0);
  });

  it('the drive builds from it and relaxes without it; the petting zone empties it fast', () => {
    const up = stepHuntDrive(0.1, 0.5, 0.2, 0.05, 1, false);
    expect(up).toBeGreaterThan(0.1);
    expect(stepHuntDrive(0.5, 0, 0.2, 0.05, 1, false)).toBeLessThan(0.5);
    expect(stepHuntDrive(0.5, 0.8, 0.2, 0.05, 1, true)).toBeLessThan(stepHuntDrive(0.5, 0, 0.2, 0.05, 1, false));
  });
});

describe('the press hold (ADR 0003 §4.3)', () => {
  it('lasts by where the hand is: strict near the cat, short with press and cursor far, long for a hand at work', () => {
    expect(pressHoldMs(false, false)).toBe(PRESS_HOLD_MS);
    expect(pressHoldMs(true, false)).toBe(PRESS_HOLD_FAR_MS);
    expect(pressHoldMs(true, true)).toBe(PRESS_HOLD_BUSY_MS);
    expect(pressHoldMs(false, true)).toBe(PRESS_HOLD_BUSY_MS);
    expect(PRESS_HOLD_FAR_MS).toBeLessThan(PRESS_HOLD_MS);
    expect(PRESS_HOLD_MS).toBeLessThan(PRESS_HOLD_BUSY_MS);
    // A leap only asks how far the hand is: a hand at work far away is not in its way, a near one always is.
    expect(pounceHoldMs(true)).toBe(PRESS_HOLD_FAR_MS);
    expect(pounceHoldMs(false)).toBe(PRESS_HOLD_MS);
  });

  it('the gate follows it, and a button held down or typing hold whatever the distance', () => {
    const g = (o: Partial<HuntGateInput>): string | null => huntGate({ ...open, ...o });
    expect(g({ sincePressMs: PRESS_HOLD_FAR_MS + 1, pressFar: true })).toBeNull();
    expect(g({ sincePressMs: PRESS_HOLD_FAR_MS - 1, pressFar: true })).toBe('button');
    expect(g({ sincePressMs: PRESS_HOLD_FAR_MS + 1 })).toBe('button');
    expect(g({ sincePressMs: PRESS_HOLD_MS + 1 })).toBeNull();
    expect(g({ sincePressMs: PRESS_HOLD_MS + 1, pressFar: true, pressBusy: true })).toBe('button');
    expect(g({ buttonDown: true, pressFar: true })).toBe('button');
    expect(g({ typingRaw: true, pressFar: true })).toBe('typing');
    expect(g({ sinceTypingMs: 2999 })).toBe('typing');
  });
});

/** A cat on the floor with hunting at full, its records and the cursor's place by hand. */
function rig(seed: number): { h: Harness; hunts: HuntRecord[] } {
  const hunts: HuntRecord[] = [];
  const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1 } }), hooks: { onHunt: (r) => hunts.push(r) } });
  h.env.pointerButtonPresses = 0;
  h.run(WAKE_MS);
  return { h, hunts };
}

const running = (h: Harness): boolean => h.last!.state === 'chasingCursor';
const huntPhase = (h: Harness): string | null => h.sim.debugInfo().phase ?? null;

/** Rests the cursor `dxBw` body widths from the cat and keeps the user around, nudging it now and then, until a hunt runs. */
function untilHunt(h: Harness, dxBw: number, maxMs = 15 * MIN): boolean {
  let i = 0;
  while (h.now < maxMs + 20 * MIN) {
    h.env.userIdleMs = 0;
    const nudge = i % 300 === 0 ? 6 : 0;
    h.env.cursor = { x: h.last!.x + dxBw * BW + nudge, y: FLOOR - 40, speed: 0 };
    h.step();
    i++;
    if (running(h)) return true;
    if (i * 33 > maxMs) return false;
  }
  return false;
}

describe('hunting a cursor that hangs around (no flick, no fast movement)', () => {
  it('it builds up, stalks and pounces: the cursor at rest is enough', () => {
    let hunted = 0;
    let pounced = 0;
    for (const seed of [1, 2, 3]) {
      const { h, hunts } = rig(seed);
      let i = 0;
      let at = 3.5;
      h.run(25 * MIN, 33, (hh) => {
        // A hand resting on the mouse, changing sides now and then: never fast, never a flick.
        if (i++ % 450 === 0) at = -at;
        hh.env.userIdleMs = 0;
        hh.env.cursor = { x: hh.last!.x + at * BW, y: FLOOR - 40, speed: 0 };
      });
      hunted += hunts.length;
      pounced += hunts.reduce((a, r) => a + r.pounces, 0);
      for (const r of hunts) if (r.pounces > 0) expect(r.minClearanceDip ?? -1).toBeGreaterThanOrEqual(8);
    }
    expect(hunted).toBeGreaterThan(0);
    expect(pounced).toBeGreaterThan(0);
  }, 120_000);

  it('a cursor inside the petting zone is never hunted, however long it stays', () => {
    const { h, hunts } = rig(4);
    h.run(10 * MIN, 33, (hh) => {
      hh.env.userIdleMs = 0;
      hh.env.cursor = { x: hh.last!.x + 0.4 * BW, y: hh.last!.y - 30, speed: 0 };
    });
    expect(hunts).toEqual([]);
    expect(h.transitions.some((t) => t.to === 'chasingCursor')).toBe(false);
  });
});

describe('a hand at work is left alone; a hand at rest is not at work', () => {
  /** The hand commutes through the band with a press every 5 s; `rest` ms of rest after every third press. */
  function hand(seed: number, rest: number, ms: number): { hunts: HuntRecord[]; starts: number[]; h: Harness } {
    const { h, hunts } = rig(seed);
    const starts: number[] = [];
    let presses = 0;
    let lastPress = -Infinity;
    let restUntil = -Infinity;
    let wasNoticing = false;
    h.run(ms, 33, (hh, i) => {
      hh.env.userIdleMs = 0;
      const resting = hh.now < restUntil;
      if (!resting && hh.now - lastPress >= 5000) {
        presses++;
        lastPress = hh.now;
        hh.env.pointerButtonPresses = presses;
        if (presses % 3 === 0 && rest > 0) restUntil = hh.now + rest;
      }
      const x = hh.last!.x + 5.5 * BW + (resting ? 0 : 60 * Math.sin(i / 10));
      hh.env.cursor = { x, y: FLOOR - 40, speed: resting ? 0 : 400 };
      // The notice is how every hunt starts; the chase coming back after a landing is the same hunt.
      const noticing = running(hh) && huntPhase(hh) === 'notice';
      if (noticing && !wasNoticing) starts.push(hh.now - lastPress);
      wasNoticing = noticing;
    });
    return { hunts, starts, h };
  }

  it('a press every 5 s with the cursor on the move: no hunt at all', () => {
    const { starts } = hand(5, 0, 15 * MIN);
    expect(starts).toEqual([]);
  }, 60_000);

  it('the same hand coming to rest for less than the long hold is hunted before the long hold is over', () => {
    const rest = PRESS_HOLD_BUSY_MS - 500;
    const starts = [5, 6, 7].flatMap((seed) => hand(seed, rest, 25 * MIN).starts);
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) {
      // It rested first: never before the rest rule lets go, never after the rest ended.
      expect(s).toBeGreaterThanOrEqual(BUSY_HAND_REST_MS - 100);
      expect(s).toBeLessThan(rest + 200);
    }
  }, 120_000);
});

describe('a press during a hunt (ADR 0003 §4.3)', () => {
  it('close to the cat ends it at once (click)', () => {
    const { h, hunts } = rig(8);
    expect(untilHunt(h, 2.5)).toBe(true);
    h.env.pointerButtonPresses = 1;
    h.run(600, 33, (hh) => {
      hh.env.cursor = { x: hh.last!.x + 2.5 * BW, y: FLOOR - 40, speed: 0 };
    });
    expect(hunts.at(-1)?.outcome).toBe('interrupted');
    expect(hunts.at(-1)?.gate).toBe('click');
    expect(running(h)).toBe(false);
  });

  it('far from it is the user\'s own business: the hunt goes on', () => {
    const { h, hunts } = rig(8);
    expect(untilHunt(h, 5.5)).toBe(true);
    h.env.pointerButtonPresses = 1;
    h.run(600, 33, (hh) => {
      hh.env.cursor = { x: hh.last!.x + 5.5 * BW, y: FLOOR - 40, speed: 0 };
    });
    expect(hunts).toEqual([]);
    expect(running(h)).toBe(true);
  });

  it('no pounce ever follows a press sooner than the hold allows, near or far', () => {
    for (const dx of [2.5, 5.5] as const) {
      const presses: number[] = [];
      const pounces: number[] = [];
      for (const seed of [1, 2, 3, 4]) {
        const { h, hunts } = rig(seed);
        let n = 0;
        let last = 0;
        h.run(20 * MIN, 33, (hh, i) => {
          hh.env.userIdleMs = 0;
          // Lingering in reach, moving now and then, with a press every 14 s.
          const moving = i % 60 < 20;
          hh.env.cursor = { x: hh.last!.x + dx * BW + (moving ? 12 * Math.sin(i) : 0), y: FLOOR - 40, speed: moving ? 300 : 0 };
          if (hh.now - last >= 14_000) {
            last = hh.now;
            n++;
            hh.env.pointerButtonPresses = n;
            presses.push(hh.now + seed * 1e9);
          }
        });
        for (const r of hunts) for (const t of r.pounceTimes) pounces.push(t + seed * 1e9);
      }
      expect(pounces.length, `dx ${dx}`).toBeGreaterThan(0);
      const hold = dx < 4 ? PRESS_HOLD_MS : PRESS_HOLD_FAR_MS;
      for (const t of pounces) {
        const before = presses.filter((p) => p <= t);
        const gap = t - Math.max(...before);
        expect(gap, `dx ${dx}`).toBeGreaterThanOrEqual(hold);
      }
    }
  }, 240_000);
});

describe('prey that hops away and a crouch that waits (ADR 0003 §4.2)', () => {
  it('the cursor gone out of the band mid-stalk: it lies low for it, the hunt does not end', () => {
    const { h, hunts } = rig(11);
    expect(untilHunt(h, 3)).toBe(true);
    h.run(1400, 33, (hh) => {
      hh.env.cursor = { x: hh.last!.x + 3 * BW, y: FLOOR - 40, speed: 0 };
    });
    expect(running(h)).toBe(true);
    // Gone upward, far out of the band.
    const out = { x: h.last!.x + 3 * BW, y: FLOOR - 700, speed: 900 };
    h.run(HUNT_LOST_GRACE_MS + 500, 33, (hh) => {
      hh.env.cursor = { ...out, speed: 0 };
    });
    expect(hunts).toEqual([]);
    expect(running(h)).toBe(true);
    expect(huntPhase(h)).toBe('crouch');
    // The wait is bounded: it ends by itself, with a leap at the place the prey left or with lost interest.
    h.run(CROUCH_STILL_MAX_MS + CROUCH_PRESS_GRACE_MS + 3000, 33, (hh) => {
      hh.env.cursor = { ...out, speed: 0 };
    });
    expect(hunts.length).toBe(1);
    expect(['missed', 'caught', 'lostInterest']).toContain(hunts[0]!.outcome);
  });

  it('at the end of a wait it mostly leaps: most hunts on a still cursor in reach pounce', () => {
    let hunts = 0;
    let pounced = 0;
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
      const r = rig(seed);
      if (!untilHunt(r.h, 3)) continue;
      // The cursor stays exactly where the hunt found it.
      r.h.run(30_000);
      if (r.hunts.length === 0) continue;
      hunts++;
      if (r.hunts[0]!.pounces > 0) pounced++;
    }
    expect(hunts).toBeGreaterThanOrEqual(4);
    expect(pounced / hunts).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('a press just before the wait ends delays the leap, it does not call it off', () => {
    let hunts = 0;
    let pounced = 0;
    for (const seed of [51, 52, 53, 54, 55, 56, 57, 58]) {
      const hunted: HuntRecord[] = [];
      // A long budget: only the crouch's own wait ends it here.
      const h = new Harness({ seed, settings: settingsWith({ behavior: { cursorPlay: 1, chaseDurationSec: 20 } }), hooks: { onHunt: (r) => hunted.push(r) } });
      h.env.pointerButtonPresses = 0;
      h.run(WAKE_MS);
      if (!untilHunt(h, 3)) continue;
      // The hand has gone up the screen, out of the band; the cat lies low for it.
      h.env.cursor = { x: h.last!.x + 3 * BW, y: FLOOR - 700, speed: 0 };
      if (!h.runUntil(() => huntPhase(h) === 'crouch', 8000)) continue;
      const wait = (h.sim as unknown as { hunt: { crouchWaitMs: number } }).hunt.crouchWaitMs;
      h.run(Math.max(0, wait - 500));
      if (huntPhase(h) !== 'crouch') continue;
      // Far from the cat: the hold is short, it is simply still running when the wait ends.
      h.env.pointerButtonPresses = 1;
      h.run(PRESS_HOLD_FAR_MS + 2500);
      if (hunted.length === 0) continue;
      hunts++;
      if (hunted[0]!.pounces > 0) pounced++;
    }
    expect(hunts).toBeGreaterThanOrEqual(4);
    expect(pounced / hunts).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it('a leap past the end of what it stands on is shortened, not given up (the surface end is no reason to stop hunting)', () => {
    const { h, hunts } = rig(31);
    // Close to the right end of the floor, the prey beyond the walkable range.
    h.env.foreground = null;
    h.run(25 * MIN, 33, (hh, i) => {
      hh.env.userIdleMs = 0;
      const right = hh.world.displays[0]!.workAreaPx.x + hh.world.displays[0]!.workAreaPx.width;
      const moving = i % 120 < 30;
      hh.env.cursor = { x: right - 8 + (moving ? 4 * Math.sin(i) : 0), y: FLOOR - 30, speed: moving ? 300 : 0 };
    });
    expect(hunts.reduce((a, r) => a + r.pounces, 0)).toBeGreaterThan(0);
    for (const r of hunts) if (r.pounces > 0) expect(r.minClearanceDip ?? -1).toBeGreaterThanOrEqual(8);
  }, 60_000);
});

describe('a taskbar just used (ADR 0003 §4.3)', () => {
  it('holds hunts back a good while after it slid away: the hand that used it is at work', () => {
    expect(TASKBAR_HIDE_HOLD_MS).toBeGreaterThanOrEqual(5000);
    const { h } = rig(40);
    let drive = false;
    h.run(3 * MIN, 33, (hh, i) => {
      hh.env.userIdleMs = 0;
      hh.env.cursor = { x: hh.last!.x + 2.5 * BW + (i % 30 < 10 ? 10 : 0), y: FLOOR - 40, speed: i % 30 < 10 ? 500 : 0 };
      drive ||= running(hh);
    });
    expect(drive || h.sim.debugInfo().huntDrive! > 0).toBe(true);
    h.step([{ type: 'taskbar.hidden', surfaceId: 'taskbar:tb', displayId: '1', edge: 'bottom' }]);
    const at = h.now;
    let startedSoon = false;
    h.run(TASKBAR_HIDE_HOLD_MS - 500, 33, (hh) => {
      hh.env.userIdleMs = 0;
      hh.env.cursor = { x: hh.last!.x + 2.5 * BW, y: FLOOR - 40, speed: 0 };
      if (hh.transitions.some((t) => t.to === 'chasingCursor' && t.at > at)) startedSoon = true;
    });
    expect(startedSoon).toBe(false);
  });
});
