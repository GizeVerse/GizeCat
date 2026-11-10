import { describe, expect, it } from 'vitest';
import type { BehaviorState } from '../../../../src/shared/cat';
import { ANIM_CLIPS, BEHAVIOR_STATES } from '../../../../src/shared/cat';
import { canTransition, CLIP_MAP, clipFor, findPath, STATE_SPECS, TRANSITIONS } from '../../../../src/core/behavior';
import { guardsFor, isCountedTransition, mayInterrupt, PHYSICAL_STATES } from '../../../../src/core/behavior/states';

function reachableFrom(start: BehaviorState): Set<BehaviorState> {
  const seen = new Set<BehaviorState>([start]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift() as BehaviorState;
    for (const n of TRANSITIONS[s]) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

describe('transition table', () => {
  it('defines every state, references only known states and has no self loops', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...BEHAVIOR_STATES].sort());
    for (const s of BEHAVIOR_STATES) {
      expect(TRANSITIONS[s].length).toBeGreaterThan(0);
      for (const t of TRANSITIONS[s]) {
        expect(BEHAVIOR_STATES).toContain(t);
        expect(t).not.toBe(s);
      }
      expect(new Set(TRANSITIONS[s]).size).toBe(TRANSITIONS[s].length);
    }
  });

  it('every state is reachable from sleeping and from idle, and can get back to idle', () => {
    for (const start of ['sleeping', 'idle'] as const) expect(reachableFrom(start).size).toBe(BEHAVIOR_STATES.length);
    for (const s of BEHAVIOR_STATES) expect(reachableFrom(s).has('idle')).toBe(true);
  });

  it('makes impossible transitions impossible', () => {
    expect(canTransition('sleeping', 'running')).toBe(false);
    expect(canTransition('sleeping', 'playing')).toBe(false);
    expect(canTransition('sleeping', 'chasingCursor')).toBe(false);
    expect(canTransition('wakingUp', 'running')).toBe(false);
    expect(canTransition('held', 'walking')).toBe(false);
    expect(canTransition('falling', 'idle')).toBe(false);
    expect(canTransition('away', 'running')).toBe(false);
    const path = findPath('sleeping', 'running');
    expect(path?.[0]).toBe('wakingUp');
    expect(path?.[path.length - 1]).toBe('running');
  });

  it('lets every grounded state be picked up, lose its footing or be hidden', () => {
    for (const s of BEHAVIOR_STATES) {
      if (s === 'away' || s === 'held') continue;
      expect(canTransition(s, 'held')).toBe(true);
      if (s !== 'falling') expect(canTransition(s, 'falling')).toBe(true);
      expect(canTransition(s, 'away')).toBe(true);
    }
  });

  it('only passes through non-physical intermediates', () => {
    for (const from of BEHAVIOR_STATES) {
      for (const to of BEHAVIOR_STATES) {
        if (from === to) continue;
        const path = findPath(from, to);
        if (!path) continue;
        let cur = from;
        for (const [i, s] of path.entries()) {
          expect(canTransition(cur, s)).toBe(true);
          if (i < path.length - 1) expect(PHYSICAL_STATES.has(s) || s === 'away').toBe(false);
          cur = s;
        }
      }
    }
  });

  it('has sane specs', () => {
    for (const s of BEHAVIOR_STATES) {
      const spec = STATE_SPECS[s];
      expect(spec.dwellMs[0]).toBeLessThanOrEqual(spec.dwellMs[1]);
      expect(spec.tickMs).toBeGreaterThanOrEqual(33);
      expect(spec.tickMs).toBeLessThanOrEqual(500);
    }
    expect(STATE_SPECS.held.priority).toBeGreaterThan(STATE_SPECS.startled.priority);
    expect(mayInterrupt('resting', 'beingPetted', 0)).toBe(true);
    expect(mayInterrupt('startled', 'curious', 100_000)).toBe(false);
    expect(mayInterrupt('idle', 'curious', 0)).toBe(true);
    expect(mayInterrupt('curious', 'watchingUser', 0)).toBe(false);
    expect(mayInterrupt('curious', 'watchingUser', 5000)).toBe(true);
  });

  it('exempts physical and lifecycle changes from guards and the budget', () => {
    expect(guardsFor('physical')).toEqual({ budget: false, cooldown: false, interrupt: false });
    expect(guardsFor('autonomous')).toEqual({ budget: true, cooldown: true, interrupt: true });
    expect(isCountedTransition('idle', 'walking', 'autonomous')).toBe(true);
    expect(isCountedTransition('walking', 'jumping', 'physical')).toBe(false);
    expect(isCountedTransition('landing', 'walking', 'completion')).toBe(false);
    expect(isCountedTransition('idle', 'away', 'lifecycle')).toBe(false);
  });
});

describe('clip mapping', () => {
  const still = { groundSpeed: 0, runThreshold: 140, moveThreshold: 6, vy: 0 };
  const walking = { ...still, groundSpeed: 70 };
  const running = { ...still, groundSpeed: 260 };

  it('maps every state and phase to a real clip', () => {
    for (const s of BEHAVIOR_STATES) {
      for (const phase of Object.keys(CLIP_MAP[s])) {
        for (const m of [still, walking, running, { ...still, vy: -100 }, { ...still, vy: 100 }]) {
          expect(ANIM_CLIPS).toContain(clipFor(s, phase as Parameters<typeof clipFor>[1], m));
        }
      }
    }
  });

  it('uses the documented clips', () => {
    expect(clipFor('walking', 'approach', walking)).toBe('walk');
    expect(clipFor('walking', 'approach', still)).toBe('stand');
    expect(clipFor('chasingCursor', 'approach', { ...still, groundSpeed: 210 })).toBe('run');
    expect(clipFor('sleeping', 'main', still)).toBe('sleep');
    expect(clipFor('wakingUp', 'stretch', still)).toBe('wake');
    expect(clipFor('wakingUp', 'settle', still)).toBe('sit');
    expect(clipFor('fallingAsleep', 'yawn', still)).toBe('yawn');
    expect(clipFor('fallingAsleep', 'loaf', still)).toBe('loaf');
    expect(clipFor('curious', 'look', still)).toBe('sit');
    expect(clipFor('playing', 'zoomies', running)).toBe('run');
    expect(clipFor('playing', 'rollOver', still)).toBe('rollOver');
    expect(clipFor('playing', 'pawAt', still)).toBe('pawAt');
    expect(clipFor('hiding', 'hide', still)).toBe('hide');
    expect(clipFor('seekingAttention', 'meow', still)).toBe('meow');
    expect(clipFor('beingPetted', 'main', still)).toBe('petted');
    expect(clipFor('grooming', 'main', still)).toBe('groom');
    // Living Companion body care and the laser body (simLaser.ts).
    expect(clipFor('grooming', 'paw', still)).toBe('groom');
    expect(clipFor('grooming', 'scratch', still)).toBe('scratch');
    expect(clipFor('grooming', 'shake', still)).toBe('shake');
    expect(clipFor('fallingAsleep', 'sit', still)).toBe('sit');
    expect(clipFor('fallingAsleep', 'stretch', still)).toBe('stretch');
    expect(clipFor('walking', 'sit', still)).toBe('sit');
    expect(clipFor('walking', 'pawAt', still)).toBe('pawAt');
    expect(clipFor('walking', 'loaf', still)).toBe('loaf');
    expect(clipFor('jumping', 'crouch', still)).toBe('crouch');
    expect(clipFor('jumping', 'air', { ...still, vy: -50 })).toBe('jump');
    expect(clipFor('jumping', 'air', { ...still, vy: 50 })).toBe('fall');
    expect(clipFor('landing', 'main', still)).toBe('land');
    expect(clipFor('held', 'main', still)).toBe('held');
    expect(clipFor('startled', 'main', still)).toBe('startle');
    expect(clipFor('annoyed', 'main', still)).toBe('annoyed');
  });
});
