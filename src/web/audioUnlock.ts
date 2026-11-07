// One AudioContext for the web host's cat sounds (1.4.0), unlocked by a user gesture.
//
// Browsers start Web Audio only from a user gesture; iPadOS and iOS Safari are the strictest. The
// overlay's sound player (src/renderer/overlay/sound.ts) creates its context lazily on the first cue
// (outside any gesture) and closes it after 10 s of silence; a fresh context made later, outside a
// gesture, may stay silent on iOS. So the web host owns ONE context:
// - unlock() runs inside click/touchend handlers (the Sound button, the sheet's sound switch, and a
//   passive page listener while sound is on): it creates the context or resumes it;
// - factory() is the player's `audio` option: a wrapper over that one context whose close()
//   suspends instead of closing, so the unlocked context survives the player's idle close.
// The page's ringer/silent setting is respected (navigator.audioSession is not touched).
// Behaviour on a real iPad is UNVERIFIED. Never throws into the page.
import type { AudioContextLike } from '../renderer/overlay/sound';

/** The real AudioContext satisfies it: the player's slice plus suspend(). */
export interface SuspendableAudioContext extends AudioContextLike {
  suspend(): Promise<unknown>;
}

export interface SharedAudio {
  /** Call inside a user-gesture handler: creates the context, or resumes a suspended one. */
  unlock(): void;
  /** For OverlayRuntime's `audio` option; throws when no context can be made (the player then stays silent and retries later). */
  readonly factory: () => AudioContextLike;
  /** 'none' before the first context, else the context's state ('suspended', 'running', ...). */
  readonly state: string;
}

export function createSharedAudio(make: () => SuspendableAudioContext): SharedAudio {
  let ctx: SuspendableAudioContext | null = null;
  let failed = false;

  const ensure = (): SuspendableAudioContext | null => {
    // A context the browser closed cannot run again: make a new one.
    if (ctx && ctx.state !== 'closed') return ctx;
    ctx = null;
    try {
      ctx = make();
      failed = false;
    } catch {
      ctx = null;
      failed = true;
    }
    return ctx;
  };

  const resume = (c: SuspendableAudioContext): void => {
    try {
      if (c.state !== 'running') void c.resume().catch(() => undefined);
    } catch {
      // A context that cannot resume stays silent.
    }
  };

  function wrap(c: SuspendableAudioContext): AudioContextLike {
    return {
      get currentTime() {
        return c.currentTime;
      },
      get sampleRate() {
        return c.sampleRate;
      },
      get state() {
        return c.state;
      },
      get destination() {
        return c.destination;
      },
      createOscillator: () => c.createOscillator(),
      createGain: () => c.createGain(),
      createBiquadFilter: () => c.createBiquadFilter(),
      createBuffer: (channels, length, sampleRate) => c.createBuffer(channels, length, sampleRate),
      createBufferSource: () => c.createBufferSource(),
      resume: () => c.resume(),
      // The player's idle close: keep the unlocked context, only stop it from running.
      close: () => {
        try {
          return c.state === 'closed' ? Promise.resolve() : c.suspend();
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    };
  }

  return {
    unlock() {
      const c = ensure();
      if (c) resume(c);
    },
    factory: () => {
      const c = ensure();
      if (!c) throw new Error(failed ? 'AudioContext unavailable' : 'no AudioContext');
      return wrap(c);
    },
    get state() {
      return ctx ? ctx.state : 'none';
    },
  };
}

/** The browser's AudioContext (webkitAudioContext on older Safari), or a throwing maker without one. */
export function browserAudioMaker(global: object): () => SuspendableAudioContext {
  const g = global as { AudioContext?: new () => SuspendableAudioContext; webkitAudioContext?: new () => SuspendableAudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return () => {
    if (!Ctor) throw new Error('no AudioContext');
    return new Ctor();
  };
}
