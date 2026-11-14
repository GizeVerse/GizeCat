// Shows the extra's text directly under a cat-name input while it is on, and removes it the moment it is
// not. Follows what is typed (input, skipped while an IME composes; note only, never the cat) and what is
// committed (change); committed updates from elsewhere do not touch it while the field is focused and dirty. textContent only. Adds nothing when the build has no payload.
import type { WebSecretName } from './secretName';

export interface SecretNoteDoc {
  createElement(tag: 'p'): HTMLElement;
}

/** Returns a detach function. */
export function attachSecretNote(nameInput: HTMLInputElement, secret: WebSecretName | undefined, doc: SecretNoteDoc = document): () => void {
  if (!secret || !secret.available) return () => undefined;
  let note: HTMLElement | null = null;

  const show = (message: string): void => {
    if (!note) {
      note = doc.createElement('p');
      note.className = 'note';
      note.setAttribute('aria-live', 'polite');
      nameInput.parentNode?.insertBefore(note, nameInput.nextSibling);
    }
    if (note.textContent !== message) note.textContent = message;
  };
  const hide = (): void => {
    note?.remove();
    note = null;
  };
  const render = (): void => {
    const s = secret.state();
    if (s.active) show(s.message);
    else hide();
  };

  const focused = (): boolean => typeof document !== 'undefined' && document.activeElement === (nameInput as unknown as Element);
  const releaseHold = secret.holdNote((committed) => focused() && nameInput.value !== committed);
  const onInput = (e: Event): void => {
    if ((e as InputEvent).isComposing) return;
    secret.setTyped(nameInput.value);
  };
  // The change handler registered before this one has settled the field on the committed value.
  const onChange = (): void => secret.setName(nameInput.value);
  const onCompositionEnd = (): void => secret.setTyped(nameInput.value);
  const onBlur = (): void => secret.setTyped(nameInput.value);
  nameInput.addEventListener('input', onInput);
  nameInput.addEventListener('change', onChange);
  nameInput.addEventListener('compositionend', onCompositionEnd);
  nameInput.addEventListener('blur', onBlur);
  const unsubscribe = secret.subscribe(render);
  render();

  return () => {
    unsubscribe();
    releaseHold();
    nameInput.removeEventListener('blur', onBlur);
    nameInput.removeEventListener('input', onInput);
    nameInput.removeEventListener('change', onChange);
    nameInput.removeEventListener('compositionend', onCompositionEnd);
    hide();
  };
}
