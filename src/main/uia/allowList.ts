// v1.2 tab-strip allow-list (ADR 0003 §7; docs/research/v1.2/tab-discovery.md §6). Replaces the
// provider's `category === 'browser'` test and the service's TAB_STRIP_BROWSERS: only windows of
// these apps are ever sent to the UI Automation helper, which applies the same table again with
// Win32 data only (top-level class, image name, a required child window class) BEFORE any UIA
// call. Never a class-only or "any XAML island" match: an unknown toolkit may host web content
// or start an accessibility engine on first contact.
import type { LivelyBehavior, ToggleableBehavior } from '../../shared/settings';
import type { TabStripKind } from './protocol';

export interface TabStripAppRule {
  kind: TabStripKind;
  /** Lower-case executable basename (WindowInfo.processName). */
  processName: string;
  /** Win32 class of the top-level window (checked by the helper). */
  topLevelClass: string;
  /** Win32 class of a child window that must exist (FindWindowEx, class only), or null. */
  requiredChildClass: string | null;
  /**
   * Shipped switch. Rules are off until the protocol-2 helper that reads them ships (the provider
   * package turns them on in the same change as the native side); an off rule is never queried.
   */
  enabled: boolean;
  /** Opt-outs that switch this app off ('tabStrips' switches every app off). */
  optOuts: ReadonlyArray<ToggleableBehavior | LivelyBehavior>;
}

export const TAB_STRIP_APPS: readonly TabStripAppRule[] = [
  { kind: 'chromium', processName: 'msedge.exe', topLevelClass: 'Chrome_WidgetWin_1', requiredChildClass: null, enabled: true, optOuts: ['tabStrips'] },
  { kind: 'chromium', processName: 'chrome.exe', topLevelClass: 'Chrome_WidgetWin_1', requiredChildClass: null, enabled: true, optOuts: ['tabStrips'] },
  {
    kind: 'tabview',
    processName: 'explorer.exe',
    topLevelClass: 'CabinetWClass',
    requiredChildClass: 'Microsoft.UI.Content.DesktopChildSiteBridge',
    enabled: false,
    optOuts: ['tabStrips', 'explorerTabs'],
  },
  {
    kind: 'tabview',
    processName: 'windowsterminal.exe',
    topLevelClass: 'CASCADIA_HOSTING_WINDOW_CLASS',
    requiredChildClass: 'Windows.UI.Composition.DesktopWindowContentBridge',
    enabled: false,
    optOuts: ['tabStrips', 'terminalTabs'],
  },
];

/**
 * Never sent to the helper, whatever a future table says: first UIA contact switches on Gecko's or
 * Chromium's web accessibility (Firefox, Electron/VS Code) or risks the user's session (Notepad
 * restores and rewrites its saved tabs; UNVERIFIED, enable only after a REAL probe on a clean profile).
 */
export const UIA_NEVER_QUERY: ReadonlySet<string> = new Set<string>(['firefox.exe', 'code.exe', 'notepad.exe']);

/** The rule for a window's process, or null when its tab strip is never read (off, opted out, or not allow-listed). */
export function tabStripRuleFor(processName: string, disabled: ReadonlySet<string>): TabStripAppRule | null {
  const name = processName.toLowerCase();
  if (UIA_NEVER_QUERY.has(name)) return null;
  const rule = TAB_STRIP_APPS.find((r) => r.processName === name);
  if (!rule || !rule.enabled || rule.optOuts.some((id) => disabled.has(id))) return null;
  return rule;
}
