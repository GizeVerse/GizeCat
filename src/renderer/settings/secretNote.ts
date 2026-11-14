// A short line under the cat-name field. The settings window is its own sandboxed bundle, so it
// evaluates the name itself; the typed text goes to the tracker and nowhere else.
import { EMBEDDED_EGG_PAYLOAD } from '../../shared/eggBuild';
import { createEggMatcher, createEggTracker, type EggMatcher, type EggState } from '../../shared/secretEgg';
import { h } from './dom';

export interface SecretNoteTarget {
  /** The row element and the node the line is inserted before (the row's own note). */
  row: HTMLElement;
  before: HTMLElement;
  input: HTMLInputElement;
  /** Fires on every store update (restart, profile restore); the field has re-synced by the next microtask. */
  subscribe(listener: () => void): () => void;
  /** Tests only. */
  matcher?: EggMatcher;
  delayMs?: number;
}

/** Returns a dispose function; attaches nothing when no payload is embedded. */
export function attachSecretNote(t: SecretNoteTarget): () => void {
  const matcher = t.matcher ?? createEggMatcher(EMBEDDED_EGG_PAYLOAD);
  if (!matcher.available) return () => undefined;
  let note: HTMLElement | null = null;
  const render = (s: EggState): void => {
    if (!s.active) {
      note?.remove();
      note = null;
      return;
    }
    if (!note) {
      note = h('div', { class: 'row-note name-note tone-info', 'aria-live': 'polite' });
      t.row.insertBefore(note, t.before);
    }
    note.textContent = s.message;
  };
  const tracker = createEggTracker(matcher, render, t.delayMs);
  const sync = (): void => tracker.setName(t.input.value);
  const syncLater = (): void => queueMicrotask(sync);
  sync();
  t.input.addEventListener('input', sync);
  t.input.addEventListener('change', syncLater);
  t.input.addEventListener('blur', syncLater);
  // Escape restores the committed text without an input event; this listener runs after the field's own.
  t.input.addEventListener('keydown', syncLater);
  const off = t.subscribe(syncLater);
  return () => {
    off();
    t.input.removeEventListener('input', sync);
    t.input.removeEventListener('change', syncLater);
    t.input.removeEventListener('blur', syncLater);
    t.input.removeEventListener('keydown', syncLater);
    tracker.dispose();
    note?.remove();
    note = null;
  };
}
