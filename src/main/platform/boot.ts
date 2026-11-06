// Decisions taken before app 'ready' (ADR 0004 §6). Pure, so they are unit-tested on every host.
//
// Linux display backend: Electron chooses X11 or Wayland before the main script runs
// (app.commandLine.appendSwitch('ozone-platform') has no effect; review H1), and since
// Electron 38 a Wayland session runs native Wayland. The app does not switch backends itself:
// both native Wayland and XWayland get no overlay (review H2), so only an X11 session shows
// the cat. explicitOzone() reads what the user passed, for the platform identity.
import { BRAND } from '../../shared/brand';

/** The ozone platform the user chose explicitly (--ozone-platform, else a concrete --ozone-platform-hint), or null. */
export function explicitOzone(getSwitch: (name: string) => string): string | null {
  const platform = getSwitch('ozone-platform').trim().toLowerCase();
  if (platform) return platform;
  const hint = getSwitch('ozone-platform-hint').trim().toLowerCase();
  return hint === 'x11' || hint === 'wayland' ? hint : null;
}

export type SandboxDecision = 'ok' | 'warn' | 'refuse';

/** A packaged build never runs its renderers without the Chromium sandbox (CLAUDE.md invariant; audit R5). */
export function sandboxDecision(packaged: boolean, noSandboxSwitch: boolean): SandboxDecision {
  if (!noSandboxSwitch) return 'ok';
  return packaged ? 'refuse' : 'warn';
}

export const NO_SANDBOX_TITLE = `${BRAND.product} cannot start safely`;
export const NO_SANDBOX_MESSAGE =
  `${BRAND.product} was started with --no-sandbox, which turns off the protection that keeps its windows isolated from your system. It does not run that way. ` +
  'On Linux this usually means the system blocks the Chromium sandbox for this package (for example an AppImage on Ubuntu 24.04 or later); install a package that supports the sandbox instead.';
