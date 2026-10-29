// 'Inspect windows' and 'Sit on windows' are independent switches.
import { describe, expect, it } from 'vitest';
import type { ToggleableBehavior } from '../../../../src/shared/settings';
import type { SimEvent } from '../../../../src/shared/sim';
import { defaultSettings } from '../../../../src/shared/settings';
import type { DecisionView } from '../../../../src/core/behavior/decide';
import { scoreCandidates } from '../../../../src/core/behavior/decide';
import { Harness, onWindowSurface, settingsWith } from './fixtures';

const MIN = 60_000;

function view(disabled: ToggleableBehavior[]): DecisionView {
  const behavior = { ...defaultSettings().behavior, autonomy: 1, disabledBehaviors: disabled };
  return {
    traits: { playfulness: 0.5, curiosity: 0.9, affection: 0.5, laziness: 0.2, confidence: 0.8, energyLevel: 0.6, startleSensitivity: 0.5 },
    stats: { energy: 0.9, boredom: 0.8, bond: 0.3, annoyance: 0, fear: 0 },
    prefs: { cursorPlayAcceptance: 0.5, attentionAcceptance: 0.5, petRatePerHour: 0, roughRatePerHour: 0 },
    behavior,
    disabled: new Set(disabled),
    localHour: 14,
    typing: false,
    userIdleMs: 0,
    busySwitching: false,
    mediaForeground: false,
    screen: null,
    recentRough: 0,
    darkBias: 0,
    quietMs: 0,
    awakeMs: 0,
    cursor: null,
    foreground: null,
    favoriteSpot: null,
    perchTarget: { windowId: 'w', point: { x: 900, y: 800 } },
    wanderTarget: null,
    cornerTarget: null,
    typingIntensity: 0,
    standingOn: 'floor',
    climbTarget: null,
    tabStripTarget: null,
    edgeLook: null,
    surpriseReady: false,
    exploreUrge: 0,
    downTarget: null,
    elevatedMs: 0,
    recentStates: [],
    current: 'idle',
    isCoolingDown: () => false,
  };
}

const explores = (disabled: ToggleableBehavior[]): boolean => scoreCandidates(view(disabled)).some((c) => c.item.state === 'inspectingWindow' && c.item.variant === 'explore');

describe('window toggles', () => {
  it('the autonomous jump onto a window top follows "Sit on windows" only', () => {
    expect(explores([])).toBe(true);
    expect(explores(['inspectWindows'])).toBe(true);
    expect(explores(['perchOnWindows'])).toBe(false);
  });

  it('with "Inspect windows" off and "Sit on windows" on, the cat still perches on windows by itself, but never inspects them', () => {
    let perched = 0;
    for (const seed of [1, 2, 3]) {
      const h = new Harness({ seed, settings: settingsWith({ behavior: { autonomy: 1, disabledBehaviors: ['inspectWindows'] } }) });
      h.env.windows = { w: { x: 600, y: 820, width: 800, height: 220 } };
      let inspected = false;
      let onWindow = false;
      h.run(60 * MIN, 100, (hh, i) => {
        if (hh.last!.state === 'inspectingWindow' && hh.sim.debugInfo().variant !== 'explore') inspected = true;
        if (onWindowSurface(hh.last!.support)) onWindow = true;
        const ev: SimEvent[] = [];
        if (i % 600 === 0) ev.push({ type: 'window.shown', window: { id: `n${i}`, rect: { x: 300, y: 200, width: 1200, height: 700 }, processName: 'a.exe', category: 'browser', minimized: false, maximized: false, fullscreen: false, excluded: false } });
        return ev;
      });
      expect(inspected).toBe(false);
      if (onWindow) perched++;
    }
    expect(perched).toBeGreaterThanOrEqual(2);
  });

  it('with "Sit on windows" off the cat never stands on a window, whatever "Inspect windows" says', () => {
    const h = new Harness({ seed: 4, settings: settingsWith({ behavior: { autonomy: 1, disabledBehaviors: ['perchOnWindows'] } }) });
    h.env.windows = { w: { x: 600, y: 820, width: 800, height: 220 } };
    h.keepOutputs = true;
    h.run(30 * MIN, 100);
    expect(h.outputs.some((o) => onWindowSurface(o.support))).toBe(false);
  });
});
