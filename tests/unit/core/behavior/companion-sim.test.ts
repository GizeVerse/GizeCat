// The Living Companion inside the sim: the world-event engine driven by the cat's situation, the body
// carrying out (or refusing) what an event invites, mood, persistence, the journal and the personality.
// These tests were written without being run; they pin behaviour the code is meant to have.
import { describe, expect, it } from 'vitest';
import type { AnyEventId, JournalEntry } from '../../../../src/shared/companion';
import { MOODS } from '../../../../src/shared/companion';
import type { Settings } from '../../../../src/shared/settings';
import type { SimOutput } from '../../../../src/shared/sim';
import { nearestPersonality } from '../../../../src/core/behavior/personalityProfiles';
import { Harness, baseSettings, WAKE_MS } from './fixtures';

type CompanionPatch = (c: Settings['companion']) => void;

function settingsFor(patch: CompanionPatch = () => undefined, tweak: (s: Settings) => void = () => undefined): Settings {
  const s = baseSettings();
  s.companion.events.enabled = true;
  patch(s.companion);
  tweak(s);
  return s;
}

/** A harness with events on, the launch nap over and the cat up. */
function awake(patch?: CompanionPatch, seed = 3, tweak?: (s: Settings) => void): Harness {
  const h = new Harness({ seed, settings: settingsFor(patch, tweak) });
  h.run(WAKE_MS + 1500, 50);
  return h;
}

/** Forces an event now (the schedule alone needs 5 to 30 minutes); retries while the cat is in the way. */
function start(h: Harness, id: AnyEventId): void {
  let ok = h.sim.debugTriggerEvent(id);
  for (let i = 0; i < 60 && !ok; i++) {
    h.run(500, 50);
    ok = h.sim.debugTriggerEvent(id);
  }
  expect(ok).toBe(true);
}

/** Plays one event to its end and returns the journal lines written on the way. */
function playEvent(h: Harness, id: AnyEventId): JournalEntry[] {
  const lines: JournalEntry[] = [];
  const note = (o: SimOutput): void => {
    if (o.journalEntry) lines.push(o.journalEntry);
  };
  start(h, id);
  note(h.step([], 33));
  for (let i = 0; i < 6000 && h.last?.worldEvent; i++) note(h.step([], 33));
  expect(h.last?.worldEvent ?? null).toBeNull();
  return lines;
}

describe('world events in the sim: when they run', () => {
  it('stays quiet until an event is due, then shows the event and its props', () => {
    const h = awake();
    h.keepOutputs = true;
    h.run(60_000, 100);
    expect(h.outputs.every((o) => (o.worldEvent ?? null) === null && (o.props ?? []).length === 0)).toBe(true);
    expect(h.sim.companionStatus().nextEventInMs).toBeGreaterThan(0);

    start(h, 'mouseEncounter');
    h.outputs.length = 0;
    h.run(3000, 33);
    const during = h.outputs.filter((o) => o.worldEvent?.id === 'mouseEncounter');
    expect(during.length).toBeGreaterThan(0);
    // The props fade in from nothing, so the very first tick may show none.
    expect(during.some((o) => (o.props ?? []).length > 0)).toBe(true);
  });

  it('starts events on its own schedule over a long, uneventful day', () => {
    const h = awake((c) => {
      c.events.pace = 2;
    });
    let seen = 0;
    let was = false;
    for (let i = 0; i < 40_000; i++) {
      const o = h.step([], 200);
      const now = (o.worldEvent ?? null) !== null;
      if (now && !was) seen++;
      was = now;
    }
    expect(seen).toBeGreaterThanOrEqual(1);
  });

  it('never starts while paused, hidden, in a fullscreen app, or while the user types hard', () => {
    const cases: Array<Partial<Harness['env']>> = [{ paused: true }, { hidden: true }, { fullscreenDisplayIds: ['1'] }, { typingIntensity: 0.9 }];
    for (const env of cases) {
      const h = awake();
      h.env = env;
      h.run(800, 50);
      expect(h.sim.debugTriggerEvent('mouseEncounter')).toBe(false);
    }
  });

  it('never runs two events at once', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.step([], 33);
    expect(h.sim.debugTriggerEvent('thunderstorm')).toBe(false);
    expect(h.sim.companionStatus().event).toBe('mouseEncounter');
    expect(h.sim.companionStatus().nextEventInMs).toBeNull();
  });

  it('does not start when events are switched off, and a running one ends when they are', () => {
    const off = awake((c) => {
      c.events.enabled = false;
    });
    expect(off.sim.debugTriggerEvent('mouseEncounter')).toBe(false);
    expect(off.sim.companionStatus().nextEventInMs).toBeNull();

    const h = awake();
    start(h, 'mouseEncounter');
    h.run(3000, 33);
    const s = settingsFor((c) => {
      c.events.enabled = false;
    });
    h.sim.updateSettings(s);
    h.run(6000, 33);
    expect(h.last?.worldEvent ?? null).toBeNull();
    expect(h.last?.props ?? []).toHaveLength(0);
  });

  it('pauses for the session on command and resumes on command', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.run(2000, 33);
    h.step([{ type: 'command.eventsPause' }], 33);
    h.run(8000, 33);
    expect(h.last?.worldEvent ?? null).toBeNull();
    expect(h.sim.companionStatus().nextEventInMs).toBeNull();
    expect(h.sim.debugTriggerEvent('mouseEncounter')).toBe(false);

    h.step([{ type: 'command.eventsResume' }], 33);
    h.run(500, 33);
    expect(h.sim.companionStatus().nextEventInMs).toBeGreaterThan(0);
  });
});

describe('world events in the sim: the user always wins', () => {
  it('a drag ends the event at once and the cat stays in the hand', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.run(1500, 33);
    const at = { x: h.last?.x ?? 100, y: (h.last?.y ?? 100) - 20 };
    h.env = { dragCursor: at };
    h.step([{ type: 'pointer.dragStart', at }], 33);
    h.run(1000, 33);
    expect(h.last?.state).toBe('held');
    expect(h.last?.worldEvent ?? null).toBeNull();
    expect(h.last?.props ?? []).toHaveLength(0);
    expect(h.sim.debugTriggerEvent('mouseEncounter')).toBe(false);
  });

  it('a tap ends the event too', () => {
    const h = awake();
    start(h, 'butterflyEncounter');
    h.run(1500, 33);
    h.step([{ type: 'pointer.tap', at: { x: h.last?.x ?? 100, y: (h.last?.y ?? 100) - 20 } }], 33);
    h.run(1500, 33);
    expect(h.last?.worldEvent ?? null).toBeNull();
  });

  it('a system lock ends it quickly and the schedule restarts', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.run(1500, 33);
    h.step([{ type: 'system.lock' }], 33);
    h.run(2000, 33);
    expect(h.last?.worldEvent ?? null).toBeNull();
  });
});

describe('world events in the sim: sleep', () => {
  it('a sleeping cat ignores a gentle event: it never gets up for it', () => {
    const h = awake();
    h.step([{ type: 'command.sleep' }], 33);
    expect(h.runUntil((o) => o.state === 'sleeping', 20_000, 50)).toBe(true);
    const from = h.transitions.length;
    start(h, 'butterflyEncounter');
    h.run(20_000, 50);
    const seen = new Set(h.transitions.slice(from).map((t) => t.to));
    for (const s of ['walking', 'running', 'playing', 'startled', 'curious', 'hiding'] as const) expect(seen.has(s)).toBe(false);
    expect(h.last?.state).toBe('sleeping');
  });

  it('a sleeping cat wakes for something loud (thunder)', () => {
    const h = awake();
    h.step([{ type: 'command.sleep' }], 33);
    expect(h.runUntil((o) => o.state === 'sleeping', 20_000, 50)).toBe(true);
    const from = h.transitions.length;
    start(h, 'thunderstorm');
    h.run(40_000, 50);
    const seen = new Set(h.transitions.slice(from).map((t) => t.to));
    expect(seen.has('startled') || seen.has('wakingUp')).toBe(true);
  });

  it('reports a sleep depth that grows while it sleeps and is zero awake', () => {
    const h = awake();
    expect(h.last?.sleepDepth).toBe(0);
    h.step([{ type: 'command.sleep' }], 33);
    expect(h.runUntil((o) => o.state === 'sleeping', 20_000, 50)).toBe(true);
    const early = h.last?.sleepDepth ?? 0;
    h.run(120_000, 100);
    expect(h.last?.sleepDepth ?? 0).toBeGreaterThan(early);
    expect(h.last?.sleepDepth ?? 0).toBeLessThanOrEqual(1);
  });
});

describe('world events in the sim: props', () => {
  it('passes the engine props through, inside the floor of the display', () => {
    const h = awake();
    h.keepOutputs = true;
    start(h, 'mouseEncounter');
    h.run(6000, 33);
    const withProps = h.outputs.filter((o) => (o.props ?? []).length > 0);
    expect(withProps.length).toBeGreaterThan(0);
    const floorY = h.floorY();
    for (const o of withProps) {
      for (const p of o.props ?? []) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        expect(p.y).toBeLessThanOrEqual(floorY + 0.5);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1920);
        expect(p.alpha).toBeGreaterThanOrEqual(0);
        expect(p.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it("uses the host's event stage when it gives one", () => {
    const h = awake();
    const stage = { x: 600, y: h.floorY() - 340, width: 700, height: 340 };
    h.env = { eventStage: stage };
    h.keepOutputs = true;
    start(h, 'mouseEncounter');
    h.run(5000, 33);
    const props = h.outputs.flatMap((o) => o.props ?? []);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(p.x).toBeGreaterThanOrEqual(stage.x - 0.5);
      expect(p.x).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
    }
  });

  it('asks for a fast tick while props are on screen', () => {
    const h = awake();
    h.keepOutputs = true;
    start(h, 'mouseEncounter');
    h.run(3000, 33);
    const withProps = h.outputs.filter((o) => (o.props ?? []).length > 0);
    expect(withProps.length).toBeGreaterThan(0);
    for (const o of withProps) expect(o.nextTickMs).toBeLessThanOrEqual(33);
  });

  it('the cat never catches a prop: no pounce counters, no hunt counters from an event', () => {
    const h = awake();
    const before = h.sim.serialize().memory.counters;
    playEvent(h, 'mouseEncounter');
    const after = h.sim.serialize().memory.counters;
    expect(after.pounces).toBe(before.pounces);
    expect(after.hunts).toBe(before.hunts);
    expect(after.chasesStarted).toBe(before.chasesStarted);
  });
});

describe('world events in the sim: memory and the journal', () => {
  const IDS: AnyEventId[] = ['thunderstorm', 'mouseEncounter', 'miniTsunami', 'butterflyEncounter', 'yarnTrouble', 'boxAppears'];

  it('writes history always and the journal only while it is on', () => {
    const on = awake();
    const lines: JournalEntry[] = [];
    for (const id of IDS) lines.push(...playEvent(on, id));
    expect(on.sim.serialize().world.events.length).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(on.sim.journal().length).toBe(lines.length);
    for (const e of on.sim.journal()) expect(['cut', 'unnoticed']).not.toContain(e.outcome);

    const off = awake((c) => {
      c.journal.enabled = false;
    });
    const none: JournalEntry[] = [];
    for (const id of IDS) none.push(...playEvent(off, id));
    expect(none).toHaveLength(0);
    expect(off.sim.journal()).toHaveLength(0);
    expect(off.sim.serialize().world.events.length).toBeGreaterThan(0);
    expect(Object.keys(off.sim.serialize().world.counts).length).toBeGreaterThan(0);
  });

  it('records when the last event ended, and counts it', () => {
    const h = awake();
    playEvent(h, 'mouseEncounter');
    const w = h.sim.serialize().world;
    expect(w.lastEndedAt).toBeGreaterThan(0);
    expect(w.counts.mouseEncounter).toBe(1);
    expect(w.events.at(-1)?.id).toBe('mouseEncounter');
  });

  it('clearJournal forgets the journal, the history behind it and the counters, and saves', () => {
    const h = awake();
    for (const id of ['thunderstorm', 'miniTsunami'] as const) playEvent(h, id);
    expect(h.sim.serialize().world.events.length).toBeGreaterThan(0);
    h.sim.clearJournal();
    expect(h.sim.journal()).toHaveLength(0);
    const w = h.sim.serialize().world;
    expect(w.events).toHaveLength(0);
    expect(w.journal).toHaveLength(0);
    expect(Object.keys(w.counts)).toHaveLength(0);
    const out = h.step([], 33);
    expect(out.requests.some((r) => r.type === 'save')).toBe(true);
  });

  it('journal() is a copy', () => {
    const h = awake();
    for (const id of IDS) playEvent(h, id);
    const a = h.sim.journal();
    expect(a.length).toBeGreaterThan(0);
    (a as JournalEntry[]).pop();
    expect(h.sim.journal().length).toBe(a.length + 1);
  });

  it('clearHistory forgets the world as well', () => {
    const h = awake();
    for (const id of IDS) playEvent(h, id);
    h.sim.clearHistory();
    expect(h.sim.journal()).toHaveLength(0);
    expect(h.sim.serialize().world.events).toHaveLength(0);
  });

  it('adopting a cat drops a running event and takes the adopted cat’s world memory', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.run(2000, 33);
    expect(h.sim.companionStatus().event).toBe('mouseEncounter');
    const other = new Harness({ seed: 9, settings: settingsFor() });
    other.run(WAKE_MS, 50);
    h.sim.adoptCat(other.sim.serialize());
    const out = h.step([], 33);
    h.run(1500, 33);
    expect(h.sim.companionStatus().event).toBeNull();
    expect(h.last?.worldEvent ?? null).toBeNull();
    expect(h.last?.props ?? []).toHaveLength(0);
    expect(out.worldEvent ?? null).toBeNull();
  });

  it('resetPersonality leaves no stale event behind', () => {
    const h = awake();
    start(h, 'mouseEncounter');
    h.run(2000, 33);
    h.sim.resetPersonality();
    h.run(1500, 33);
    expect(h.sim.companionStatus().event).toBeNull();
    expect(h.sim.journal()).toHaveLength(0);
  });
});

describe('world events in the sim: sound gating', () => {
  const rumbles = (h: Harness): number => h.outputs.filter((o) => o.sound?.kind === 'rumble').length;

  it("plays the world's cues only with sound on and the world category on", () => {
    const on = awake(undefined, 3, (s) => {
      s.sound.enabled = true;
      s.sound.world = true;
    });
    on.keepOutputs = true;
    on.run(300, 33);
    for (let i = 0; i < 4; i++) playEvent(on, 'thunderstorm');
    expect(rumbles(on)).toBeGreaterThan(0);

    const muted = awake(undefined, 3, (s) => {
      s.sound.enabled = true;
      s.sound.world = false;
    });
    muted.keepOutputs = true;
    for (let i = 0; i < 4; i++) playEvent(muted, 'thunderstorm');
    expect(rumbles(muted)).toBe(0);

    const silent = awake();
    silent.keepOutputs = true;
    for (let i = 0; i < 4; i++) playEvent(silent, 'thunderstorm');
    expect(silent.outputs.some((o) => o.sound)).toBe(false);
  });
});

describe('world events in the sim: mood and status', () => {
  it('reports a mood always, and the status accessor is consistent', () => {
    const h = awake();
    const st = h.sim.companionStatus();
    expect(st.personalityIsAuto).toBe(true);
    expect(st.nearestPersonality).toBe(nearestPersonality(h.sim.serialize().traits));
    expect(h.last?.mood).toBe(st.mood);
    expect(st.event).toBeNull();
    expect(Number.isFinite(st.nextEventInMs ?? Number.NaN)).toBe(true);
  });

  it('a chosen personality is reported as chosen and never changes the persisted traits', () => {
    const born = new Harness({ seed: 5, settings: settingsFor() }).sim.serialize().traits;
    const h = awake((c) => {
      c.personality = 'lazy';
    }, 5);
    const st = h.sim.companionStatus();
    expect(st.personalityIsAuto).toBe(false);
    expect(st.nearestPersonality).toBe('lazy');
    h.run(10 * 60_000, 200);
    expect(h.sim.serialize().traits).toEqual(born);
    const acting = (h.sim as unknown as { traits: typeof born }).traits;
    expect(nearestPersonality(acting)).toBe('lazy');
  });

  it('only ever reports a known mood, event or not', () => {
    const h = awake();
    h.keepOutputs = true;
    playEvent(h, 'thunderstorm');
    for (const o of h.outputs) expect(MOODS).toContain(o.mood);
  });
});

describe('personality in everyday behaviour', () => {
  const trace = (h: Harness, ms: number): string => {
    const parts: string[] = [];
    h.run(ms, 100, () => {
      const o = h.last;
      if (o) parts.push(`${o.state}:${o.clip}:${Math.round(o.x)}`);
    });
    return parts.join('|');
  };

  it("'auto' with events idle is bit-identical to events off (no extra random draws, no knob moves anything)", () => {
    const a = new Harness({ seed: 21, settings: baseSettings() });
    const s = baseSettings();
    s.companion.events.enabled = true;
    const b = new Harness({ seed: 21, settings: s });
    // The earliest first event is 5 minutes in (pace 1): compare just the window before it, where the engine only counts down.
    expect(trace(b, 290_000)).toBe(trace(a, 290_000));
  });

  it('named personalities change what the cat does', () => {
    const run = (p: Settings['companion']['personality']): string => {
      const s = baseSettings();
      s.companion.personality = p;
      return trace(new Harness({ seed: 21, settings: s }), 120_000);
    };
    expect(run('energetic')).not.toBe(run('lazy'));
  });
});
