// v1.2 (ADR 0003 §10): the overlay's procedural sound player against a fake AudioContext: no
// context until a cue arrives, each cue once per `at`, nothing stale or too soon, every source
// stopped by the end of its cue, the context closed after 10 s of silence and on dispose, and no
// failure ever reaching the caller.
import { describe, expect, it } from 'vitest';
import { SOUND_CUES, type CatSoundCue, type SoundCue } from '../../../src/shared/cat';
import {
  createSoundPlayer,
  CUE_DURATION_S,
  DEFAULT_VOLUME,
  IDLE_CLOSE_MS,
  MIN_GAP_MS,
  STALE_CUE_MS,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
} from '../../../src/renderer/overlay/sound';

class FakeParam implements AudioParamLike {
  value = 0;
  readonly events: Array<[string, number, number]> = [];
  setValueAtTime(v: number, t: number): void {
    this.events.push(['set', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.events.push(['lin', v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.events.push(['exp', v, t]);
  }
  /** Highest value this param is ever set or ramped to (or holds). */
  peak(): number {
    return Math.max(this.value, ...this.events.map((e) => e[1]));
  }
}

class FakeNode implements AudioNodeLike {
  readonly outs: Array<AudioNodeLike | AudioParamLike> = [];
  connect(d: AudioNodeLike | AudioParamLike): void {
    this.outs.push(d);
  }
  disconnect(): void {
    this.outs.length = 0;
  }
}

class FakeSource extends FakeNode {
  type = '';
  buffer: AudioBufferLike | null = null;
  loop = false;
  readonly frequency = new FakeParam();
  startAt = Number.NaN;
  stopAt = Number.NaN;
  start(t = 0): void {
    this.startAt = t;
  }
  stop(t = 0): void {
    this.stopAt = t;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeFilter extends FakeNode {
  type = '';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

class FakeAudio implements AudioContextLike {
  currentTime = 5;
  readonly sampleRate = 8000;
  state = 'running';
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  closed = 0;
  resumed = 0;
  createOscillator(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBufferSource(): FakeSource {
    return this.createOscillator();
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createBuffer(_c: number, length: number): AudioBufferLike {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume(): Promise<void> {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed++;
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** A player with a fake clock, fake timers and a counting AudioContext factory. */
function rig(audio: () => AudioContextLike = () => new FakeAudio()) {
  let now = 1000;
  const made: AudioContextLike[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let id = 0;
  const player = createSoundPlayer({
    now: () => now,
    audio: () => {
      const a = audio();
      made.push(a);
      return a;
    },
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [k, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(k);
        t.fn();
      }
    }
  };
  return { player, made, advance, timers, fake: () => made.at(-1) as FakeAudio };
}

const cue = (kind: SoundCue, at: number, volume?: number): CatSoundCue => (volume === undefined ? { kind, at } : { kind, at, volume });

describe('sound player', () => {
  it('creates no AudioContext until a cue plays', () => {
    const r = rig();
    expect(r.made).toHaveLength(0);
    r.player.play(cue('meow', 10_000), 10_050);
    expect(r.made).toHaveLength(1);
    expect(r.fake().sources.length).toBeGreaterThan(0);
  });

  it('plays a cue once per `at`, however many snapshots carry it', () => {
    const r = rig();
    for (let i = 0; i < 6; i++) r.player.play(cue('chirp', 20_000), 20_000 + i * 33);
    const a = r.fake();
    const starts = a.sources.length;
    expect(starts).toBeGreaterThan(0);
    r.advance(MIN_GAP_MS + 10);
    r.player.play(cue('chirp', 20_000), 20_000 + 400);
    expect(a.sources.length).toBe(starts);
  });

  it('drops a stale cue (a recreated overlay must not replay it) and one from the future', () => {
    const r = rig();
    r.player.play(cue('hiss', 30_000), 30_000 + STALE_CUE_MS + 1);
    r.player.play(cue('hiss', 40_000), 40_000 - STALE_CUE_MS - 1);
    expect(r.made).toHaveLength(0);
    r.player.play(cue('hiss', 50_000), 50_000 + STALE_CUE_MS - 1);
    expect(r.made).toHaveLength(1);
  });

  it('plays at most one cue per 1.5 s (sim time and wall time) and never an older one', () => {
    const r = rig();
    r.player.play(cue('meow', 10_000), 10_000);
    const a = r.fake();
    const n = a.sources.length;
    r.advance(MIN_GAP_MS - 100);
    r.player.play(cue('trill', 10_000 + MIN_GAP_MS - 100), 10_000 + MIN_GAP_MS - 100);
    expect(a.sources.length, 'too soon').toBe(n);
    r.advance(200);
    r.player.play(cue('trill', 9_000), 9_000);
    expect(a.sources.length, 'older than the last').toBe(n);
    // Sim time far ahead (a fast sim clock), but wall time too soon: still dropped.
    r.player.play(cue('trill', 30_000), 30_000);
    r.advance(10);
    r.player.play(cue('trill', 60_000), 60_000);
    const afterOne = a.sources.length;
    expect(afterOne).toBeGreaterThan(n);
    r.player.play(cue('growl', 90_000), 90_000);
    expect(a.sources.length, 'wall-clock gap').toBe(afterOne);
  });

  it('every cue kind schedules sources that start at once and all stop by the end of the cue', () => {
    for (const kind of SOUND_CUES) {
      const r = rig();
      r.player.play(cue(kind, 1000), 1000);
      const a = r.fake();
      expect(a.sources.length, kind).toBeGreaterThan(0);
      for (const s of a.sources) {
        expect(s.startAt, kind).toBeGreaterThanOrEqual(a.currentTime);
        expect(s.stopAt, kind).toBeGreaterThan(s.startAt);
        expect(s.stopAt, kind).toBeLessThanOrEqual(a.currentTime + 0.01 + CUE_DURATION_S[kind] + 1e-9);
      }
      expect(CUE_DURATION_S[kind], kind).toBeLessThanOrEqual(kind === 'purr' ? 8 : 1.2);
      // Something reaches the speakers, through the cue's own output gain.
      expect(a.gains.some((g) => g.outs.includes(a.destination)), kind).toBe(true);
    }
  });

  it("the world's cues (squeak, rumble, chime, splash) are short, soft and never louder than the cat's own loudest", () => {
    /** Highest level any gain stage of the cue reaches, apart from the final output gain (which carries the user's volume). */
    const peak = (kind: SoundCue): number => {
      const r = rig();
      r.player.play(cue(kind, 1000), 1000);
      const a = r.fake();
      return Math.max(...a.gains.filter((g) => !g.outs.includes(a.destination)).map((g) => g.gain.peak()));
    };
    const world: SoundCue[] = ['squeak', 'rumble', 'chime', 'splash'];
    const own = SOUND_CUES.filter((k) => !world.includes(k));
    const loudestOwn = Math.max(...own.map(peak));
    for (const kind of world) {
      expect(peak(kind), kind).toBeLessThanOrEqual(0.6);
      expect(peak(kind), kind).toBeLessThanOrEqual(loudestOwn);
      expect(CUE_DURATION_S[kind], kind).toBeLessThanOrEqual(1);
      expect(CUE_DURATION_S[kind], kind).toBeGreaterThan(0.1);
    }
    // The rumble is the one to be careful with: low and gentle, never a sudden jolt.
    expect(CUE_DURATION_S.rumble).toBeLessThanOrEqual(0.9);
    expect(peak('rumble')).toBeLessThanOrEqual(0.55);
  });

  it('every cue of the world set has a synthesized voice that sounds when played (the context gets sources)', () => {
    for (const kind of ['squeak', 'rumble', 'chime', 'splash'] as const) {
      const r = rig();
      r.player.play(cue(kind, 1000, 1), 1000);
      expect(r.fake().sources.length, kind).toBeGreaterThanOrEqual(1);
      // The output stage is the one gain wired to the speakers and sits at volume * master (<= 0.35).
      const a = r.fake();
      const out = a.gains.find((g) => g.outs.includes(a.destination))!;
      expect(out.gain.value, kind).toBeLessThanOrEqual(0.35 + 1e-12);
    }
  });

  it('applies the volume (absent = 0.4) and stays silent at 0', () => {
    const peakOut = (volume?: number): number => {
      const r = rig();
      r.player.play(cue('meow', 1000, volume), 1000);
      const a = r.made.at(-1) as FakeAudio | undefined;
      if (!a) return 0;
      const out = a.gains.find((g) => g.outs.includes(a.destination))!;
      return out.gain.value;
    };
    expect(peakOut(1)).toBeGreaterThan(peakOut(0.2));
    expect(peakOut()).toBeCloseTo(peakOut(DEFAULT_VOLUME), 12);
    expect(peakOut(1)).toBeLessThanOrEqual(0.5);
    const r = rig();
    r.player.play(cue('meow', 1000, 0), 1000);
    expect(r.made, 'no context for a silent cue').toHaveLength(0);
  });

  it('closes the AudioContext after 10 s of silence and opens a new one for the next cue', () => {
    const r = rig();
    r.player.play(cue('thud', 1000), 1000);
    const a = r.fake();
    r.advance(CUE_DURATION_S.thud * 1000 + IDLE_CLOSE_MS - 50);
    expect(a.closed).toBe(0);
    r.advance(100);
    expect(a.closed).toBe(1);
    r.player.play(cue('meow', 20_000), 20_000);
    expect(r.made).toHaveLength(2);
    expect(r.fake()).not.toBe(a);
  });

  it('a new cue postpones the idle close', () => {
    const r = rig();
    r.player.play(cue('meow', 1000), 1000);
    const a = r.fake();
    r.advance(8000);
    r.player.play(cue('chirp', 9000), 9000);
    r.advance(8000);
    expect(a.closed).toBe(0);
    r.advance(IDLE_CLOSE_MS);
    expect(a.closed).toBe(1);
    expect(r.timers.size).toBe(0);
  });

  it('a new cue fades out the one still playing (one sound at a time)', () => {
    const r = rig();
    r.player.play(cue('purr', 1000), 1000);
    const a = r.fake();
    const first = a.gains.find((g) => g.outs.includes(a.destination))!;
    r.advance(MIN_GAP_MS + 1);
    a.currentTime += 1.5;
    r.player.play(cue('meow', 1000 + MIN_GAP_MS + 1), 1000 + MIN_GAP_MS + 1);
    const ramp = first.gain.events.find((e) => e[0] === 'lin' && e[1] === 0);
    expect(ramp).toBeDefined();
    expect(ramp![2]).toBeLessThan(a.currentTime + 0.2);
  });

  it('resumes a suspended context', () => {
    const r = rig(() => {
      const f = new FakeAudio();
      f.state = 'suspended';
      return f;
    });
    r.player.play(cue('trill', 1000), 1000);
    expect(r.fake().resumed).toBe(1);
  });

  it('close() and dispose() close the context; after dispose nothing plays again', () => {
    const r = rig();
    r.player.play(cue('meow', 1000), 1000);
    const a = r.fake();
    r.player.close();
    expect(a.closed).toBe(1);
    expect(r.timers.size).toBe(0);
    r.advance(MIN_GAP_MS + 1);
    r.player.play(cue('meow', 5000), 5000);
    expect(r.made).toHaveLength(2);
    r.player.dispose();
    expect(r.fake().closed).toBe(1);
    r.advance(MIN_GAP_MS + 1);
    r.player.play(cue('meow', 9000), 9000);
    expect(r.made).toHaveLength(2);
  });

  it('never throws: a failing factory, a throwing graph and garbage cues are absorbed', () => {
    const bad = rig(() => {
      throw new Error('no audio device');
    });
    expect(() => bad.player.play(cue('meow', 1000), 1000)).not.toThrow();
    const broken = rig(() => {
      const f = new FakeAudio();
      f.createGain = () => {
        throw new Error('graph');
      };
      return f;
    });
    expect(() => broken.player.play(cue('hiss', 1000), 1000)).not.toThrow();
    expect((broken.made[0] as FakeAudio).closed, 'a failed graph drops its context').toBe(1);
    const r = rig();
    for (const junk of [null, {}, { kind: 'bark', at: 1 }, { kind: 'meow', at: Number.NaN }, { kind: 'meow', at: 1, volume: Number.NaN }]) {
      expect(() => r.player.play(junk as unknown as CatSoundCue, 1)).not.toThrow();
    }
    expect(() => r.player.play(cue('meow', 1), Number.NaN)).not.toThrow();
    expect(r.made).toHaveLength(0);
  });

  it('without Web Audio (no AudioContext global) it stays silent', () => {
    const player = createSoundPlayer({ now: () => 0 });
    expect(() => player.play(cue('meow', 1000), 1000)).not.toThrow();
    player.dispose();
  });
});
