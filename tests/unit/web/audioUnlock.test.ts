// One gesture-unlocked AudioContext for the web host (src/web/audioUnlock.ts): unlock creates or
// resumes it; the sound player's idle close only suspends it; a closed context is replaced.
// MOCKED: the AudioContext is a stub (no audio device; iPad behaviour is UNVERIFIED).
import { describe, expect, it } from 'vitest';
import { browserAudioMaker, createSharedAudio, type SuspendableAudioContext } from '../../../src/web/audioUnlock';
import { createSoundPlayer, IDLE_CLOSE_MS } from '../../../src/renderer/overlay/sound';

class StubContext {
  static made: StubContext[] = [];
  state = 'suspended';
  currentTime = 0;
  readonly sampleRate = 8000;
  resumes = 0;
  suspends = 0;
  closes = 0;
  starts = 0;
  readonly destination = { connect: () => undefined, disconnect: () => undefined };
  constructor() {
    StubContext.made.push(this);
  }
  private param() {
    return { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
  }
  private node() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createOscillator() {
    return { ...this.node(), type: '', frequency: this.param(), start: () => this.starts++, stop: () => undefined };
  }
  createBufferSource() {
    return { ...this.node(), buffer: null, loop: false, start: () => this.starts++, stop: () => undefined };
  }
  createGain() {
    return { ...this.node(), gain: this.param() };
  }
  createBiquadFilter() {
    return { ...this.node(), type: '', frequency: this.param(), Q: this.param() };
  }
  createBuffer(_c: number, length: number) {
    const d = new Float32Array(length);
    return { getChannelData: () => d };
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.closes++;
    this.state = 'closed';
    return Promise.resolve();
  }
}

const make = (): SuspendableAudioContext => new StubContext();

describe('shared audio', () => {
  it('makes no context until asked; unlock creates it and resumes it', () => {
    StubContext.made = [];
    const a = createSharedAudio(make);
    expect(a.state).toBe('none');
    expect(StubContext.made).toHaveLength(0);
    a.unlock();
    expect(StubContext.made).toHaveLength(1);
    expect(StubContext.made[0]!.resumes).toBe(1);
    expect(a.state).toBe('running');
    a.unlock();
    expect(StubContext.made).toHaveLength(1);
    expect(StubContext.made[0]!.resumes, 'already running').toBe(1);
  });

  it("the player's idle close suspends the one context instead of closing it; the next cue reuses it", () => {
    StubContext.made = [];
    const a = createSharedAudio(make);
    a.unlock();
    let now = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const player = createSoundPlayer({
      now: () => now,
      audio: a.factory,
      setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
      clearTimer: () => undefined,
    });
    player.play({ kind: 'chirp', at: 10_000, volume: 0.5 }, 10_000);
    const ctx = StubContext.made[0]!;
    expect(ctx.starts).toBeGreaterThan(0);
    now += IDLE_CLOSE_MS + 2000;
    for (const t of timers.splice(0)) if (t.at <= now) t.fn();
    expect(ctx.closes).toBe(0);
    expect(ctx.suspends).toBe(1);
    player.play({ kind: 'trill', at: 30_000, volume: 0.5 }, 30_000);
    expect(StubContext.made).toHaveLength(1);
    // The suspended context is resumed by the player for the cue.
    expect(ctx.resumes).toBe(2);
  });

  it('replaces a context the browser closed, and throws from factory() when none can be made', () => {
    StubContext.made = [];
    const a = createSharedAudio(make);
    a.unlock();
    StubContext.made[0]!.state = 'closed';
    a.unlock();
    expect(StubContext.made).toHaveLength(2);
    const none = createSharedAudio(() => {
      throw new Error('no audio');
    });
    expect(() => none.unlock()).not.toThrow();
    expect(() => none.factory()).toThrow();
    expect(none.state).toBe('none');
  });

  it('finds AudioContext or webkitAudioContext on the global, else throws when used', () => {
    StubContext.made = [];
    browserAudioMaker({ AudioContext: StubContext })();
    browserAudioMaker({ webkitAudioContext: StubContext })();
    expect(StubContext.made).toHaveLength(2);
    expect(() => browserAudioMaker({})()).toThrow();
  });
});
