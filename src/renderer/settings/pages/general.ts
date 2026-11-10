import type { AppStatus, LoginItemStatus } from '../../../shared/ipc';
import type { RuntimeCapability } from '../../../shared/platform';
import { MAX_SHORTCUT_LENGTH, STARTUP_STATES } from '../catalog';
import type { PageContext, PageView } from '../context';
import { button, group, page, row, runAction, segmentedRow, setNote, textRow, toggleRow, toggleSwitch, type NoteTone } from '../controls';
import { h, icon } from '../dom';
import { displayAccelerator } from '../format';
import { errorText } from '../store';
import { platformWording, S, type PlatformWording } from '../strings';
import { validateShortcut } from '../validate';

const G = S.general;

/**
 * The status line under "Start with Windows". Main reports the state as data, live from the
 * registry; the common cases are worded here, anything unusual (stale entry, unreadable
 * registry, a Task Manager disable the user just tried to switch on, an entry left after an
 * opt-out) uses main's explanation.
 */
export function launchStatusView(s: LoginItemStatus): { text: string; tone: NoteTone } {
  const L = G.launchStatus;
  // Main says why this build may not manage it (dev/portable build, path too long, switched off).
  if (!s.writable) return { text: s.reason ?? L.notAvailable, tone: 'info' };
  if (s.enabled && s.active) return { text: L.active, tone: 'ok' };
  // Only while Windows really does not start it: what the registry shows wins over the recorded reason.
  if (s.disabledBy === 'windows' && !s.active) return { text: L.windowsDisabled, tone: 'warn' };
  if (!s.enabled && !s.active) return { text: s.disabledBy === 'external' ? L.removedOutside : L.off, tone: 'info' };
  return { text: s.reason ?? (s.enabled ? L.pending : L.off), tone: 'warn' };
}

/**
 * macOS (1.4.0): the status line under "Open at login". Main's reason covers the macOS states
 * (waiting for approval, not registered, not found, on outside the app); `openSettings` asks for
 * the "Open Login Items settings" button while the user wants it on and macOS does not open the app.
 */
export function launchStatusViewMac(s: LoginItemStatus): { text: string; tone: NoteTone; openSettings: boolean } {
  const L = G.launchStatusMac;
  if (!s.writable) return { text: s.reason ?? L.notAvailable, tone: 'info', openSettings: false };
  if (s.enabled && s.active) return { text: s.reason ?? L.active, tone: 'ok', openSettings: false };
  if (!s.enabled && !s.active) return { text: L.off, tone: 'info', openSettings: false };
  return { text: s.reason ?? L.pending, tone: 'warn', openSettings: s.enabled && !s.active };
}

export type LaunchRowView = { showSwitch: true; title?: string } | { showSwitch: false; title: string; reason: string };

/**
 * Whether the launch-at-sign-in row offers its switch (GizeVerse, ADR 0004 §7). Off Windows, when
 * main reports the loginItem capability unavailable, the switch is hidden and main's reason is
 * shown instead. On Windows the row stays exactly as it was, also in development builds (where
 * the capability is unavailable too), and so it does without a platform report. macOS (1.4.0)
 * titles the row "Open at login", its own term.
 */
export function launchRowView(status: Pick<AppStatus, 'platform'>): LaunchRowView {
  const platform = status.platform;
  if (!platform || platform.id === 'win32') return { showSwitch: true };
  const mac = platform.id === 'darwin';
  const cap = platform.capabilities.loginItem as RuntimeCapability | undefined;
  if (!cap || cap.available) return mac ? { showSwitch: true, title: G.launchTitleMac } : { showSwitch: true };
  return { showSwitch: false, title: mac ? G.launchTitleMac : G.launchTitleElsewhere, reason: cap.reason ?? G.launchStatus.unsupported };
}

/** macOS only (1.4.0): the "Show GizeCat in the Dock" row (general.showDockIcon); hidden elsewhere. */
export function dockRowVisible(status: Pick<AppStatus, 'platform'>): boolean {
  return status.platform?.id === 'darwin';
}

/** The description of "When GizeCat starts" (1.4.0): Windows keeps its text; macOS says "at login". */
export function startupStateDesc(wording: PlatformWording): string {
  if (wording === 'mac') return G.startupStateDescMac;
  return wording === 'elsewhere' ? G.startupStateDescElsewhere : G.startupStateDesc;
}

/** The shortcut row's hint and placeholder (1.4.0): macOS names Option and Command. */
export function shortcutFieldText(wording: PlatformWording): { hint: string; placeholder: string } {
  return wording === 'mac'
    ? { hint: S.validation.shortcutHintMac, placeholder: G.shortcutPlaceholderMac }
    : { hint: S.validation.shortcutHint, placeholder: G.shortcutPlaceholder };
}

// Moved to the Companion page with the other rows that act on the running cat; re-exported for callers.
export { callButtonState } from '../companionControls';

export function generalPage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);

  // Launch at sign-in is main-owned: the switch runs the enable/disableLaunchAtLogin actions
  // instead of patching settings, and always shows what main reports afterwards.
  const launch = row({ title: G.launchTitle, desc: G.launchDesc, icon: 'startup' });
  const launchSwitch = toggleSwitch(launch.titleId, launch.describedBy);
  launch.control.append(launchSwitch.root);
  launch.note.setAttribute('aria-live', 'polite');
  const launchTitle = launch.row.querySelector<HTMLElement>('.row-title');
  // macOS (1.4.0): opens System Settings › General › Login Items (main uses a constant URL).
  const loginItemsBtn = button(G.launchOpenLoginItems);
  const launchActions = h('div', { class: 'callout-actions', hidden: true }, [loginItemsBtn]);
  launch.row.insertBefore(launchActions, launch.note);
  loginItemsBtn.addEventListener('click', () => void runAction(ctx, 'openLoginItemsSettings', loginItemsBtn, launch.error));
  let launchBusy = false;
  let unavailableShown: string | null = null;
  const syncLaunch = (s: LoginItemStatus, mac: boolean): void => {
    if (!launchBusy) {
      launchSwitch.input.checked = s.enabled;
      launchSwitch.refresh();
    }
    if (mac) {
      const line = launchStatusViewMac(s);
      setNote(launch.note, line.text, line.tone);
      launchActions.hidden = !line.openSettings;
      return;
    }
    const line = launchStatusView(s);
    setNote(launch.note, line.text, line.tone);
  };
  /** Shows the switch with main's state, or (off Windows, unavailable) only the reason. */
  const syncLaunchRow = (status: AppStatus): void => {
    const view = launchRowView(status);
    const title = view.showSwitch ? (view.title ?? G.launchTitle) : view.title;
    if (launchTitle && launchTitle.textContent !== title) launchTitle.textContent = title;
    launchSwitch.root.hidden = !view.showSwitch;
    if (view.showSwitch) {
      unavailableShown = null;
      syncLaunch(status.loginItem, status.platform?.id === 'darwin');
    } else {
      launchActions.hidden = true;
      if (unavailableShown !== view.reason) {
        // Only a changed sentence is announced (main broadcasts on every state change).
        unavailableShown = view.reason;
        setNote(launch.note, view.reason, 'info');
      }
    }
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
      syncLaunch(ctx.store.view.status.loginItem, ctx.store.view.status.platform?.id === 'darwin');
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
    { title: G.startupStateTitle, desc: startupStateDesc(wording), icon: 'play' },
  );
  const shortcuts = toggleRow(ctx, 'general', 'shortcutsEnabled', { title: G.shortcutsTitle, desc: G.shortcutsDesc, icon: 'keyboard' });
  const shortcut = textRow(ctx, 'general', 'toggleShortcut', {
    title: G.shortcutTitle,
    desc: G.shortcutDesc,
    icon: 'hide',
    hint: shortcutFieldText(wording).hint,
    validate: (text) => validateShortcut(text, wording),
    toValue: (v) => v,
    display: (stored) => displayAccelerator(stored, wording),
    maxLength: MAX_SHORTCUT_LENGTH,
    placeholder: shortcutFieldText(wording).placeholder,
  });
  const registration = h('div', { class: 'row-note', 'aria-live': 'polite', hidden: true });
  shortcut.parts.row.insertBefore(registration, shortcut.parts.note);

  // macOS only (1.4.0, D4): the Dock icon (activation policy in main); hidden on every other platform.
  const dock = toggleRow(ctx, 'general', 'showDockIcon', { title: G.dockTitle, desc: G.dockDesc, icon: 'pin' });
  dock.parts.row.hidden = !dockRowVisible(ctx.store.view.status);

  const quit = row({ title: G.quitTitle, desc: G.quitDesc, icon: 'power' });
  const quitBtn = button(G.quit);
  quit.control.append(quitBtn);
  quitBtn.addEventListener('click', () => void runAction(ctx, 'quit', quitBtn, quit.note));

  const element = page(G.title, [
    group(G.groupStartup, [notice, launch.row, startState.parts.row]),
    group(G.groupShortcuts, [shortcuts.parts.row, shortcut.parts.row]),
    group(G.groupApp, [dock.parts.row, quit.row]),
  ]);

  ctx.store.subscribe((view) => {
    const { status } = view;
    syncLaunchRow(status);
    notice.hidden = !status.loginItem.showNotice;
    dock.parts.row.hidden = !dockRowVisible(status);

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
