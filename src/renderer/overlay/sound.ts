// Optional procedural cat sounds for the overlay renderer (ADR 0003 §10). Synthesized with Web
// Audio from oscillators, a noise buffer and filters: no assets, no microphone, no network.
// Main only puts a cue on a snapshot while settings.sound is on, and only on the overlay holding
// the cat's anchor (overlayManager); this player is the second line of defence: it plays each cue
// once (per `at`), never one that is stale against the snapshot (a recreated overlay must not
// replay it), at most one per MIN_GAP_MS, and closes its AudioContext after IDLE_CLOSE_MS of
// silence (a suspended context can hold a Windows audio power request). Nothing here can throw
// into the frame loop.
import { SOUND_CUES, type CatSoundCue, type SoundCue } from '../../shared/cat';
import { seededRandom } from './cat/math';

/** Cues older than this (ms of sim time) against the snapshot that carries them are dropped. */
export const STALE_CUE_MS = 500;
/** At most one cue per this many ms (sim time and wall time both). */
export const MIN_GAP_MS = 1500;
/** The AudioContext is closed after this long (ms, wall time) without sound. */
export const IDLE_CLOSE_MS = 10_000;
/** Volume when the cue carries none (settings.sound.volume default). */
export const DEFAULT_VOLUME = 0.4;
/** Overall level: synthesized cues are loud at full scale, so 1.0 volume maps to this peak gain. */
const MASTER = 0.35;
/** After a failed AudioContext creation, wait this long (ms) before trying again. */
const RETRY_MS = 30_000;

/** Length (s) of each cue as synthesized (purr: only while petted, ADR 0003 §10, <= 8 s). */
export const CUE_DURATION_S: Readonly<Record<SoundCue, number>> = {
  meow: 0.62,
  chirp: 0.3,
  trill: 0.48,
  purr: 2.4,
  hiss: 0.9,
  growl: 0.95,
  thud: 0.2,
};

// The slice of Web Audio this player uses (the real AudioContext satisfies it; tests use a fake).
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}
export interface AudioNodeLike {
  /** To a node (audio path) or a param (modulation: an LFO into a gain). */
  connect(destination: AudioNodeLike | AudioParamLike): unknown;
  disconnect(): void;
}
export interface OscillatorNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}
export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}
export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}
export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  resume(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SoundPlayerContext {
  /** Wall clock (ms), e.g. performance.now. */
  now: () => number;
  /** Creates the AudioContext on the first cue; absent = the browser's AudioContext (none: silent). */
  audio?: () => AudioContextLike;
  /** Timers for the idle close; absent = globalThis setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SoundPlayer {
  /** Plays `cue` (from a snapshot whose sim time is `snapshotT`) unless it is a repeat, stale, too soon or sound is unavailable. */
  play(cue: CatSoundCue, snapshotT: number): void;
  /** Stops any sound and closes the AudioContext now; a later cue opens a new one. */
  close(): void;
  /** close(), and never play again (the overlay is going away). */
  dispose(): void;
}

const CUES: ReadonlySet<string> = new Set(SOUND_CUES);

function defaultAudio(): AudioContextLike {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
  if (!Ctor) throw new Error('no AudioContext');
  return new Ctor();
}

export function createSoundPlayer(ctx: SoundPlayerContext): SoundPlayer {
  const makeAudio = ctx.audio ?? defaultAudio;
  const setTimer = ctx.setTimer ?? ((fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms));
  const clearTimer = ctx.clearTimer ?? ((h: unknown): void => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  let ac: AudioContextLike | null = null;
  let noise: AudioBufferLike | null = null;
  let disposed = false;
  let lastAt = Number.NEGATIVE_INFINITY;
  let lastWall = Number.NEGATIVE_INFINITY;
  let retryAt = Number.NEGATIVE_INFINITY;
  let idleTimer: unknown = null;
  /** The playing cue's output gain and when (context time) it ends; a new cue fades it out. */
  let voice: { out: GainNodeLike; end: number } | null = null;

  const safeNow = (): number => {
    try {
      const t = ctx.now();
      return Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };

  const cancelIdle = (): void => {
    if (idleTimer === null) return;
    try {
      clearTimer(idleTimer);
    } catch {
      // ignore
    }
    idleTimer = null;
  };

  const shut = (): void => {
    cancelIdle();
    const a = ac;
    ac = null;
    noise = null;
    voice = null;
    if (!a) return;
    try {
      void a.close().catch(() => undefined);
    } catch {
      // A context that cannot close is dropped anyway.
    }
  };

  const scheduleIdle = (ms: number): void => {
    cancelIdle();
    try {
      idleTimer = setTimer(() => {
        idleTimer = null;
        shut();
      }, ms);
    } catch {
      idleTimer = null;
    }
  };

  const context = (): AudioContextLike | null => {
    if (ac) return ac;
    const now = safeNow();
    if (now < retryAt) return null;
    try {
      ac = makeAudio();
    } catch {
      ac = null;
      retryAt = now + RETRY_MS;
      return null;
    }
    return ac;
  };

  const noiseBuffer = (a: AudioContextLike): AudioBufferLike => {
    if (noise) return noise;
    const len = Math.max(1, Math.round(a.sampleRate * 1));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    const rnd = seededRandom(0x5eed);
    for (let i = 0; i < data.length; i++) data[i] = rnd() * 2 - 1;
    noise = buf;
    return buf;
  };

  return {
    play(cue: CatSoundCue, snapshotT: number): void {
      if (disposed || !cue || typeof cue.kind !== 'string' || !CUES.has(cue.kind)) return;
      const at = cue.at;
      if (!Number.isFinite(at) || !Number.isFinite(snapshotT)) return;
      // Once per `at`, oldest first; never a cue from long ago or from the future.
      if (at <= lastAt) return;
      if (snapshotT - at > STALE_CUE_MS || at - snapshotT > STALE_CUE_MS) return;
      const wall = safeNow();
      if (at - lastAt < MIN_GAP_MS || wall - lastWall < MIN_GAP_MS) return;
      const vol = cue.volume === undefined ? DEFAULT_VOLUME : Number.isFinite(cue.volume) ? Math.min(1, Math.max(0, cue.volume)) : 0;
      lastAt = at;
      lastWall = wall;
      if (vol <= 0) return;
      const a = context();
      if (!a) return;
      try {
        if (a.state === 'suspended') void a.resume().catch(() => undefined);
        const t0 = a.currentTime + 0.01;
        if (voice && voice.end > t0) {
          // One cue at a time: the previous one fades out quickly.
          voice.out.gain.setValueAtTime(voice.out.gain.value, t0);
          voice.out.gain.linearRampToValueAtTime(0, t0 + 0.06);
        }
        const out = a.createGain();
        out.gain.value = vol * MASTER;
        out.connect(a.destination);
        const dur = CUE_DURATION_S[cue.kind];
        synth(a, cue.kind, out, t0, dur, () => noiseBuffer(a));
        voice = { out, end: t0 + dur };
        scheduleIdle(dur * 1000 + IDLE_CLOSE_MS);
      } catch {
        // A failing graph must never reach the frame loop; drop the context and start fresh next time.
        shut();
      }
    },
    close(): void {
      shut();
    },
    dispose(): void {
      disposed = true;
      shut();
    },
  };
}

// ---------------------------------------------------------------------------
// Synthesis. Every source is started at t0 and stopped by t0 + dur, so nothing keeps playing.

function envelope(g: GainNodeLike, t0: number, attack: number, hold: number, release: number, peak = 1): void {
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setValueAtTime(peak, t0 + attack + hold);
  g.gain.linearRampToValueAtTime(0, t0 + attack + hold + release);
}

function osc(a: AudioContextLike, type: string, freq: number, t0: number, dur: number): OscillatorNodeLike {
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  o.start(t0);
  o.stop(t0 + dur);
  return o;
}

function noiseSource(a: AudioContextLike, buf: AudioBufferLike, t0: number, dur: number): AudioBufferSourceNodeLike {
  const n = a.createBufferSource();
  n.buffer = buf;
  n.loop = true;
  n.start(t0);
  n.stop(t0 + dur);
  return n;
}

function filter(a: AudioContextLike, type: string, freq: number, q: number, t0: number): BiquadFilterNodeLike {
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  f.Q.setValueAtTime(q, t0);
  return f;
}

function synth(a: AudioContextLike, kind: SoundCue, out: GainNodeLike, t0: number, dur: number, noise: () => AudioBufferLike): void {
  const env = a.createGain();
  env.connect(out);
  switch (kind) {
    case 'meow': {
      // "mi-a-ow": a sawtooth through a sweeping formant, pitch up then down.
      const o = osc(a, 'sawtooth', 520, t0, dur);
      o.frequency.linearRampToValueAtTime(760, t0 + 0.18);
      o.frequency.linearRampToValueAtTime(430, t0 + dur);
      const f = filter(a, 'bandpass', 900, 4, t0);
      f.frequency.linearRampToValueAtTime(1700, t0 + 0.2);
      f.frequency.linearRampToValueAtTime(800, t0 + dur);
      o.connect(f);
      f.connect(env);
      envelope(env, t0, 0.04, dur - 0.24, 0.2, 0.9);
      break;
    }
    case 'chirp': {
      // Two quick rising chirps.
      const o = osc(a, 'triangle', 1100, t0, dur);
      o.frequency.exponentialRampToValueAtTime(2300, t0 + 0.11);
      o.frequency.setValueAtTime(1200, t0 + 0.15);
      o.frequency.exponentialRampToValueAtTime(2500, t0 + 0.27);
      o.connect(env);
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(0.7, t0 + 0.02);
      env.gain.linearRampToValueAtTime(0, t0 + 0.12);
      env.gain.linearRampToValueAtTime(0.7, t0 + 0.17);
      env.gain.linearRampToValueAtTime(0, t0 + dur);
      break;
    }
    case 'trill': {
      // A rolling, rising coo: a tone amplitude-modulated at ~28 Hz.
      const o = osc(a, 'triangle', 560, t0, dur);
      o.frequency.linearRampToValueAtTime(720, t0 + dur);
      const am = a.createGain();
      am.gain.value = 0.5;
      const lfo = osc(a, 'sine', 28, t0, dur);
      const depth = a.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth);
      depth.connect(am.gain);
      o.connect(am);
      am.connect(env);
      envelope(env, t0, 0.05, dur - 0.17, 0.12, 0.8);
      break;
    }
    case 'purr': {
      // Low, rumbling noise pulsed at ~25 Hz.
      const n = noiseSource(a, noise(), t0, dur);
      const lp = filter(a, 'lowpass', 180, 1, t0);
      const am = a.createGain();
      am.gain.value = 0.5;
      const lfo = osc(a, 'sine', 25, t0, dur);
      const depth = a.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth);
      depth.connect(am.gain);
      n.connect(lp);
      lp.connect(am);
      am.connect(env);
      envelope(env, t0, 0.3, dur - 0.8, 0.5, 0.9);
      break;
    }
    case 'hiss': {
      // Breathy high noise.
      const n = noiseSource(a, noise(), t0, dur);
      const hp = filter(a, 'highpass', 2600, 0.7, t0);
      const bp = filter(a, 'bandpass', 5200, 0.8, t0);
      n.connect(hp);
      hp.connect(bp);
      bp.connect(env);
      envelope(env, t0, 0.03, dur - 0.33, 0.3, 1);
      break;
    }
    case 'growl': {
      // A low sawtooth roughened at ~18 Hz, dull through a low-pass.
      const o = osc(a, 'sawtooth', 95, t0, dur);
      o.frequency.linearRampToValueAtTime(80, t0 + dur);
      const lp = filter(a, 'lowpass', 600, 1, t0);
      const am = a.createGain();
      am.gain.value = 0.6;
      const lfo = osc(a, 'sine', 18, t0, dur);
      const depth = a.createGain();
      depth.gain.value = 0.4;
      lfo.connect(depth);
      depth.connect(am.gain);
      o.connect(lp);
      lp.connect(am);
      am.connect(env);
      envelope(env, t0, 0.08, dur - 0.33, 0.25, 0.9);
      break;
    }
    case 'thud': {
      // A soft landing: a falling sine and a dull click.
      const o = osc(a, 'sine', 95, t0, dur);
      o.frequency.exponentialRampToValueAtTime(45, t0 + dur);
      o.connect(env);
      const n = noiseSource(a, noise(), t0, 0.05);
      const lp = filter(a, 'lowpass', 400, 0.7, t0);
      n.connect(lp);
      lp.connect(env);
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(1, t0 + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      break;
    }
  }
}
