// The web host's end of the name-dependent extra (src/shared/secretEgg.ts): one tracker fed with the cat
// name, a subscription for the panels' note and the accessory the cat wears while it is on. Holds nothing
// but the live state: never stored, never exported, never logged.
import { createEggMatcher, createEggTracker, EGG_OFF, type EggMatcher, type EggState, type EggTracker } from '../shared/secretEgg';
import { EMBEDDED_EGG_PAYLOAD } from '../shared/eggBuild';

export interface WebSecretName {
  /** False when the build carries no payload: the panels add nothing. */
  readonly available: boolean;
  /** The COMMITTED name (startup, settings change, restore, reset): drives the cat's accessory, and the note unless held. */
  setName(name: string): void;
  /** What is typed in a name input: drives the note only, never the cat. */
  setTyped(name: string): void;
  /** While the returned-from-register predicate says true for a committed name, committed updates leave the note alone. */
  holdNote(hold: (committed: string) => boolean): () => void;
  /** The note's state (follows typing). */
  state(): EggState;
  /** The cat's accessory: 'heartPendant' only while the committed name is on. */
  accessory(): 'heartPendant' | undefined;
  /** Called on every change of the note's state; returns the unsubscribe. */
  subscribe(cb: (s: EggState) => void): () => void;
  /** Called on every change of the cat's state; returns the unsubscribe. */
  onAccessoryChange(cb: (s: EggState) => void): () => void;
  dispose(): void;
}

export function createWebSecretName(matcher: EggMatcher = createEggMatcher(EMBEDDED_EGG_PAYLOAD), delayMs?: number): WebSecretName {
  const noteListeners = new Set<(s: EggState) => void>();
  const catListeners = new Set<(s: EggState) => void>();
  const holds = new Set<(committed: string) => boolean>();
  const fan = (set: Set<(s: EggState) => void>) => (s: EggState): void => {
    for (const cb of [...set]) {
      try {
        cb(s);
      } catch {
        // a listener must not break the others
      }
    }
  };
  const cat: EggTracker = createEggTracker(matcher, fan(catListeners), delayMs);
  const note: EggTracker = createEggTracker(matcher, fan(noteListeners), delayMs);
  const unlisten = (set: Set<(s: EggState) => void>, cb: (s: EggState) => void) => () => {
    set.delete(cb);
  };
  return {
    available: matcher.available,
    setName(name) {
      cat.setName(name);
      let held = false;
      for (const h of [...holds]) {
        try {
          if (h(name)) held = true;
        } catch {
          // a hold must not break the update
        }
      }
      if (!held) note.setName(name);
    },
    setTyped: (name) => note.setName(name),
    holdNote(hold) {
      holds.add(hold);
      return () => {
        holds.delete(hold);
      };
    },
    state: () => note.state(),
    accessory: () => (cat.state().active ? 'heartPendant' : undefined),
    subscribe(cb) {
      noteListeners.add(cb);
      return unlisten(noteListeners, cb);
    },
    onAccessoryChange(cb) {
      catListeners.add(cb);
      return unlisten(catListeners, cb);
    },
    dispose() {
      cat.dispose();
      note.dispose();
      noteListeners.clear();
      catListeners.clear();
      holds.clear();
    },
  };
}

export { EGG_OFF };
