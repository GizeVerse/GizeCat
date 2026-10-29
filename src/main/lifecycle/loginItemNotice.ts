// The one-time "Desktop Cat now starts when you sign in" notice (ADR 0002 §1, startup.md §4
// option a). Startup turned on by default (a new install, or a v1 `false` that may never have
// been a choice) is announced once with a Windows notification, not only in the Settings ›
// General callout: a v1 user who upgrades gets no window at all, so the callout alone could go
// unseen. Electron-free: the notification surface (the tray icon) is injected.
import type { LoginItemStatus } from '../../shared/ipc';
import type { Logger } from '../contracts';

export const LAUNCH_NOTICE = {
  title: 'Desktop Cat now starts with Windows',
  body: 'Your cat appears when you sign in. To change this, click here for Settings › General, or use Task Manager › Startup apps.',
} as const;

export interface NoticeHandlers {
  /** Windows displayed the notification. */
  onShown(): void;
  onClick(): void;
}

export interface NoticeSurface {
  /** Asks Windows to show a notification. False when it could not be asked. */
  notify(notice: { title: string; body: string }, handlers: NoticeHandlers): boolean;
}

export interface LaunchNoticeOptions {
  status: LoginItemStatus;
  /** Test mode (E2E runs): no notification is ever put on the desktop. */
  test: boolean;
  /** Started from the Run entry: the notice waits for a start by the user. */
  launchedAtLogin: boolean;
  /** null when there is no tray icon. */
  surface: NoticeSurface | null;
  /** Records that the notice has been seen (also hides the Settings callout). */
  markShown(): void;
  /** Opens Settings › General. */
  openSettings(): void;
  logger: Logger;
}

/**
 * Asks for the notification when the notice is due. It is marked as shown only once Windows has
 * displayed it, so a notification suppressed by Do not disturb is offered again at the next start
 * by the user (the Settings callout stays meanwhile). Returns whether it was asked for. Never throws.
 */
export function announceLaunchAtLogin(o: LaunchNoticeOptions): boolean {
  if (o.test || o.launchedAtLogin || !o.status.showNotice || !o.surface) return false;
  let marked = false;
  const shown = (): void => {
    if (marked) return;
    marked = true;
    o.logger.info('launch at sign-in notice shown');
    o.markShown();
  };
  try {
    const asked = o.surface.notify(LAUNCH_NOTICE, {
      onShown: shown,
      onClick: () => {
        shown();
        o.openSettings();
      },
    });
    if (!asked) o.logger.warn('launch at sign-in notice could not be shown');
    return asked;
  } catch (err) {
    o.logger.warn('launch at sign-in notice failed', { error: err });
    return false;
  }
}
