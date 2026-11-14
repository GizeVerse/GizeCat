// Keeps the cat's accessory in step with the cat's name. Every path that can change the name (settings
// patches, a profile import or restore, reset, migration on load) ends in the settings store, so one
// store subscription plus the startup read covers them all. Only a boolean leaves this module.
import { createEggMatcher, createEggTracker, type EggMatcher, type EggState } from '../shared/secretEgg';
import { EMBEDDED_EGG_PAYLOAD } from '../shared/eggBuild';
import type { Settings } from '../shared/settings';

export interface SecretNameSettings {
  get(): Settings;
  onChange(cb: (next: Settings, prev: Settings) => void): () => void;
}

export interface SecretNameOptions {
  settings: SecretNameSettings;
  /** Called when the accessory flips, so idle overlays get a fresh frame. */
  onChange?: (active: boolean) => void;
  /** Tests only; defaults to the matcher built from the embedded payload. */
  matcher?: EggMatcher;
  delayMs?: number;
}

export interface SecretName {
  accessory(): 'heartPendant' | undefined;
  dispose(): void;
}

export function createSecretName(opts: SecretNameOptions): SecretName {
  const matcher = opts.matcher ?? createEggMatcher(EMBEDDED_EGG_PAYLOAD);
  const tracker = createEggTracker(
    matcher,
    (s: EggState) => {
      try {
        opts.onChange?.(s.active);
      } catch {
        // a failing listener must not break the tracker
      }
    },
    opts.delayMs,
  );
  tracker.setName(opts.settings.get().general.catName);
  const off = opts.settings.onChange((next) => tracker.setName(next.general.catName));
  return {
    accessory: () => (tracker.state().active ? 'heartPendant' : undefined),
    dispose() {
      off();
      tracker.dispose();
    },
  };
}
