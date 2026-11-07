// macOS Dock icon (ADR 0004 §6, decision D4): "Show GizeCat in the Dock" (general.showDockIcon,
// on by default) switches the activation policy at run time. 'regular' is the default policy of
// every Electron app (Dock icon and menu bar); 'accessory' removes the Dock icon and leaves the
// menu-bar icon. Never LSUIElement: it is static, would take the menu bar from everyone, and would
// remove the user's choice. Without a Dock icon the app stays reachable through the menu-bar icon
// and by opening it again (Spotlight, Finder, Launchpad), which emits 'activate' and opens
// Settings (index.ts); whether 'activate' fires for an accessory app is UNVERIFIED (no Mac run).
// Electron-free: the app is injected. Callers use it on darwin only (platform.dockPolicyConfigurable).
import type { Logger } from '../contracts';

export interface DockTarget {
  setActivationPolicy(policy: 'regular' | 'accessory'): void;
  /** Electron's app.dock (macOS only; undefined elsewhere). */
  readonly dock?: { show(): Promise<void> } | undefined;
}

export type DockPolicy = 'regular' | 'accessory';

export function dockPolicyFor(showDockIcon: boolean): DockPolicy {
  return showDockIcon ? 'regular' : 'accessory';
}

/** Applies the Dock choice. Never throws; returns whether the policy call went through. */
export function applyDockPolicy(target: DockTarget, showDockIcon: boolean, log: Logger): boolean {
  const policy = dockPolicyFor(showDockIcon);
  try {
    target.setActivationPolicy(policy);
    if (policy === 'regular') {
      // Coming back from 'accessory': show() resolves once the icon is in the Dock again.
      const shown = target.dock?.show();
      if (shown) shown.catch((err: unknown) => log.warn('showing the Dock icon failed', { error: err }));
    }
    log.info('dock policy applied', { policy });
    return true;
  } catch (err) {
    log.error('setting the Dock policy failed', { error: err, policy });
    return false;
  }
}
