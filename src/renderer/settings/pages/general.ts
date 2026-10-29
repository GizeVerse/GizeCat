import type { AppStatus, LoginItemStatus } from '../../../shared/ipc';
import { MAX_CAT_NAME_LENGTH, MAX_SHORTCUT_LENGTH, STARTUP_STATES } from '../catalog';
import type { PageContext, PageView } from '../context';
import { button, group, page, row, runAction, segmentedRow, setButtonLabel, setNote, textRow, toggleRow, toggleSwitch, type NoteTone } from '../controls';
import { h, icon } from '../dom';
import { errorText } from '../store';
import { S } from '../strings';
import { validateCatName, validateShortcut } from '../validate';

const G = S.general;

/**
 * The status line under "Start with Windows". Main reports the state as data; the common
 * cases are worded here, anything unusual (stale entry, unreadable registry, a Task Manager
 * disable the user just tried to switch on) uses main's explanation.
 */
export function launchStatusView(s: LoginItemStatus): { text: string; tone: NoteTone } {
  const L = G.launchStatus;
  // Main says why this build may not manage it (dev/portable build, path too long, switched off).
  if (!s.writable) return { text: s.reason ?? L.notAvailable, tone: 'info' };
  if (s.disabledBy === 'windows') return { text: L.windowsDisabled, tone: 'warn' };
  if (s.enabled && s.active) return { text: L.active, tone: 'ok' };
  if (!s.enabled && !s.active) return { text: s.disabledBy === 'external' ? L.removedOutside : L.off, tone: 'info' };
  return { text: s.reason ?? (s.enabled ? L.pending : L.off), tone: 'warn' };
}

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

  // Launch at sign-in is main-owned: the switch runs the enable/disableLaunchAtLogin actions
  // instead of patching settings, and always shows what main reports afterwards.
  const launch = row({ title: G.launchTitle, desc: G.launchDesc, icon: 'startup' });
  const launchSwitch = toggleSwitch(launch.titleId, launch.describedBy);
  launch.control.append(launchSwitch.root);
  launch.note.setAttribute('aria-live', 'polite');
  let launchBusy = false;
  const syncLaunch = (s: LoginItemStatus): void => {
    if (!launchBusy) {
      launchSwitch.input.checked = s.enabled;
      launchSwitch.refresh();
    }
    const line = launchStatusView(s);
    setNote(launch.note, line.text, line.tone);
  };
  launchSwitch.input.addEventListener('change', () => {
    const on = launchSwitch.input.checked;
    launchBusy = true;
    launchSwitch.input.disabled = true;
    launchSwitch.input.setAttribute('aria-busy', 'true');
    setNote(launch.error, null, 'error');
    void (async () => {
      try {
        const res = await ctx.api.action(on ? 'enableLaunchAtLogin' : 'disableLaunchAtLogin');
        if (!res.ok) setNote(launch.error, S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
      } catch (e) {
        setNote(launch.error, S.errors.actionFailed(errorText(e)), 'error');
      }
      launchBusy = false;
      launchSwitch.input.disabled = false;
      launchSwitch.input.removeAttribute('aria-busy');
      try {
        await ctx.refresh();
      } catch {
        // The next broadcast from main brings the switch up to date.
      }
      syncLaunch(ctx.store.view.status.loginItem);
    })();
  });

  const noticeDismiss = button(G.launchNoticeDismiss);
  const notice = h('div', { class: 'callout callout-startup', hidden: true }, [
    icon('startup', 'callout-icon'),
    h('div', {}, [
      h('h3', { class: 'callout-title', text: G.launchNoticeTitle }),
      h('p', { class: 'callout-text', text: G.launchNoticeText }),
      h('div', { class: 'callout-actions' }, [noticeDismiss]),
    ]),
  ]);
  noticeDismiss.addEventListener('click', () => void runAction(ctx, 'dismissLaunchNotice', noticeDismiss, null));

  const startState = segmentedRow(
    ctx,
    'general',
    'startupState',
    STARTUP_STATES.map((v) => ({ value: v, label: G.startupStates[v] })),
    { title: G.startupStateTitle, desc: G.startupStateDesc, icon: 'play' },
  );
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
    group(G.groupStartup, [notice, launch.row, startState.parts.row]),
    group(G.groupShortcuts, [shortcuts.parts.row, shortcut.parts.row]),
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

    syncLaunch(status.loginItem);
    notice.hidden = !status.loginItem.showNotice;

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
