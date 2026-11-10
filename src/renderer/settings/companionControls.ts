// Rows that act on the running cat (call, show/hide, pause). They used to live on the General page and
// now belong to the Companion page; the pause row also appears on Accessibility & Focus with its own
// words, so it is built here once. They send actions, not settings, and always follow what main reports.
import type { AppStatus } from '../../shared/ipc';
import type { PageContext } from './context';
import { button, row, runAction, setButtonLabel, setNote, type RowParts } from './controls';
import { S } from './strings';

const G = S.general;

/**
 * The simulation ignores a call while the cat is paused (main still reports success),
 * so the button is off then, as in the tray and the cat's menu, and says why. It is
 * also off while the cat is hidden; the visibility row explains that case.
 */
export function callButtonState(status: Pick<AppStatus, 'visible' | 'paused'>): { disabled: boolean; note: string | null } {
  if (!status.visible) return { disabled: true, note: null };
  if (status.paused) return { disabled: true, note: G.callPaused };
  return { disabled: false, note: null };
}

export interface ActionRow {
  parts: RowParts;
  /** Brings the row in line with main's status (called on every view). */
  sync(status: AppStatus, catName: string): void;
}

export function callRow(ctx: PageContext): ActionRow {
  const parts = row({ title: G.callTitle, desc: G.callDesc, icon: 'people' });
  const btn = button(G.callButton(ctx.store.settings.general.catName));
  parts.control.append(btn);
  btn.addEventListener('click', () => void runAction(ctx, 'callCat', btn, parts.note));
  return {
    parts,
    sync(status, catName) {
      setButtonLabel(btn, G.callButton(catName));
      const state = callButtonState(status);
      btn.disabled = state.disabled;
      if (state.note) setNote(parts.note, state.note, 'info');
      else if (parts.note.classList.contains('tone-info')) setNote(parts.note, null);
    },
  };
}

export function visibilityRow(ctx: PageContext): ActionRow {
  const parts = row({ title: G.visibilityTitle, desc: G.visibilityDesc, icon: 'view' });
  const btn = button(G.hide);
  parts.control.append(btn);
  btn.addEventListener('click', () => {
    void runAction(ctx, ctx.store.view.status.visible ? 'hide' : 'show', btn, parts.note);
  });
  return {
    parts,
    sync(status) {
      setButtonLabel(btn, status.visible ? G.hide : G.show);
      if (!status.visible) setNote(parts.note, G.hiddenNow, 'info');
      else if (parts.note.classList.contains('tone-info')) setNote(parts.note, null);
    },
  };
}

export interface PauseWords {
  title: string;
  desc: string;
  pause: string;
  resume: string;
  pausedNow: string;
}

export function pauseRow(ctx: PageContext, words: PauseWords): ActionRow {
  const parts = row({ title: words.title, desc: words.desc, icon: 'pause' });
  const btn = button(words.pause);
  parts.control.append(btn);
  btn.addEventListener('click', () => {
    void runAction(ctx, ctx.store.view.status.paused ? 'resume' : 'pause', btn, parts.note);
  });
  return {
    parts,
    sync(status) {
      setButtonLabel(btn, status.paused ? words.resume : words.pause);
      if (status.paused) setNote(parts.note, words.pausedNow, 'info');
      else if (parts.note.classList.contains('tone-info')) setNote(parts.note, null);
    },
  };
}

/** Keeps `rows` in step with every view from main (and renders once now). */
export function keepInSync(ctx: PageContext, rows: readonly ActionRow[]): void {
  ctx.store.subscribe((view) => {
    for (const r of rows) r.sync(view.status, view.settings.general.catName);
  });
}
