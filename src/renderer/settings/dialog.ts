// In-page modal built on <dialog>: focus is trapped by the browser, Escape cancels,
// and focus returns to the element that opened it.
import { h, icon, uid, type Child } from './dom';
import { S } from './strings';

export interface DialogSpec {
  title: string;
  body: readonly Child[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'caution' | 'danger';
}

export function openDialog(spec: DialogSpec): Promise<boolean> {
  const tone = spec.tone ?? 'default';
  const titleId = uid('dlg-t');
  const bodyId = uid('dlg-b');
  const confirm = h('button', { type: 'button', class: `btn ${tone === 'danger' ? 'btn-danger' : 'btn-accent'}`, text: spec.confirmLabel });
  const cancel = h('button', { type: 'button', class: 'btn btn-standard', text: spec.cancelLabel ?? S.common.cancel });
  const dialog = h('dialog', { class: `modal tone-${tone}`, 'aria-labelledby': titleId, 'aria-describedby': bodyId }, [
    h('div', { class: 'modal-content' }, [
      h('div', { class: 'modal-head' }, [
        tone === 'default' ? null : icon(tone === 'danger' ? 'warning' : 'shield', 'modal-icon'),
        h('h2', { class: 'modal-title', id: titleId, text: spec.title }),
      ]),
      h('div', { class: 'modal-body', id: bodyId }, spec.body),
    ]),
    h('div', { class: 'modal-footer' }, [confirm, cancel]),
  ]);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(dialog);
  return new Promise<boolean>((resolve) => {
    confirm.addEventListener('click', () => dialog.close('confirm'));
    cancel.addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
    dialog.addEventListener(
      'close',
      () => {
        const confirmed = dialog.returnValue === 'confirm';
        dialog.remove();
        if (opener?.isConnected) opener.focus();
        resolve(confirmed);
      },
      { once: true },
    );
    dialog.showModal();
    cancel.focus();
  });
}

export function confirmDanger(title: string, text: string, confirmLabel: string): Promise<boolean> {
  return openDialog({ title, body: [h('p', { text })], confirmLabel, tone: 'danger' });
}
