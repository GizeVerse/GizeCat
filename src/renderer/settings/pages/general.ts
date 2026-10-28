import type { AppStatus } from '../../../shared/ipc';
import { MAX_CAT_NAME_LENGTH, MAX_SHORTCUT_LENGTH } from '../catalog';
import type { PageContext, PageView } from '../context';
import { button, group, page, row, runAction, setButtonLabel, setNote, textRow, toggleRow } from '../controls';
import { h } from '../dom';
import { S } from '../strings';
import { validateCatName, validateShortcut } from '../validate';

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

export function generalPage(ctx: PageContext): PageView {
  const name = textRow(ctx, 'general', 'catName', {
    title: G.nameTitle,
    desc: G.nameDesc,
    icon: 'rename',
    validate: validateCatName,
    toValue: (v) => v,
    maxLength: MAX_CAT_NAME_LENGTH + 8,
    spellcheck: false,
  });

  const call = row({ title: G.callTitle, desc: G.callDesc, icon: 'people' });
  const callBtn = button(G.callButton(ctx.store.settings.general.catName));
  call.control.append(callBtn);
  callBtn.addEventListener('click', () => void runAction(ctx, 'callCat', callBtn, call.note));

  const visibility = row({ title: G.visibilityTitle, desc: G.visibilityDesc, icon: 'view' });
  const visBtn = button(G.hide);
  visibility.control.append(visBtn);
  visBtn.addEventListener('click', () => {
    void runAction(ctx, ctx.store.view.status.visible ? 'hide' : 'show', visBtn, visibility.note);
  });

  const pause = row({ title: G.pauseTitle, desc: G.pauseDesc, icon: 'pause' });
  const pauseBtn = button(G.pause);
  pause.control.append(pauseBtn);
  pauseBtn.addEventListener('click', () => {
    void runAction(ctx, ctx.store.view.status.paused ? 'resume' : 'pause', pauseBtn, pause.note);
  });

  const launch = toggleRow(ctx, 'general', 'launchAtLogin', { title: G.launchTitle, desc: G.launchDesc, icon: 'startup' });
  const shortcuts = toggleRow(ctx, 'general', 'shortcutsEnabled', { title: G.shortcutsTitle, desc: G.shortcutsDesc, icon: 'keyboard' });
  const shortcut = textRow(ctx, 'general', 'toggleShortcut', {
    title: G.shortcutTitle,
    desc: G.shortcutDesc,
    icon: 'hide',
    hint: S.validation.shortcutHint,
    validate: validateShortcut,
    toValue: (v) => v,
    maxLength: MAX_SHORTCUT_LENGTH,
    placeholder: G.shortcutPlaceholder,
  });
  const registration = h('div', { class: 'row-note', 'aria-live': 'polite', hidden: true });
  shortcut.parts.row.insertBefore(registration, shortcut.parts.note);

  const quit = row({ title: G.quitTitle, desc: G.quitDesc, icon: 'power' });
  const quitBtn = button(G.quit);
  quit.control.append(quitBtn);
  quitBtn.addEventListener('click', () => void runAction(ctx, 'quit', quitBtn, quit.note));

  const element = page(G.title, [
    group(G.groupCat, [name.parts.row, call.row, visibility.row, pause.row]),
    group(G.groupStartup, [launch.parts.row, shortcuts.parts.row, shortcut.parts.row]),
    group(G.groupApp, [quit.row]),
  ]);

  ctx.store.subscribe((view) => {
    const { status, settings } = view;
    setButtonLabel(callBtn, G.callButton(settings.general.catName));
    setButtonLabel(visBtn, status.visible ? G.hide : G.show);
    setButtonLabel(pauseBtn, status.paused ? G.resume : G.pause);
    const callState = callButtonState(status);
    callBtn.disabled = callState.disabled;
    if (callState.note) setNote(call.note, callState.note, 'info');
    else if (call.note.classList.contains('tone-info')) setNote(call.note, null);
    if (!status.visible) setNote(visibility.note, G.hiddenNow, 'info');
    else if (visibility.note.classList.contains('tone-info')) setNote(visibility.note, null);
    if (status.paused) setNote(pause.note, G.pausedNow, 'info');
    else if (pause.note.classList.contains('tone-info')) setNote(pause.note, null);

    const wantsLaunch = ctx.store.intended('general', 'launchAtLogin');
    setNote(launch.parts.note, wantsLaunch && !status.launchAtLoginActive && !ctx.store.isSettling('general.launchAtLogin') ? G.launchInactive : null, 'warn');

    const enabled = ctx.store.intended('general', 'shortcutsEnabled');
    shortcut.input.disabled = !enabled;
    shortcut.parts.row.classList.toggle('is-disabled', !enabled);
    if (!enabled) setNote(registration, G.shortcutOff, 'info');
    else if (ctx.store.isSettling('general.toggleShortcut') || ctx.store.isSettling('general.shortcutsEnabled')) setNote(registration, null);
    else if (status.shortcutRegistered) setNote(registration, G.shortcutRegistered, 'ok');
    else setNote(registration, G.shortcutNotRegistered, 'error');
  });

  return { id: 'general', title: G.title, element };
}
