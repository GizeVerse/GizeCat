// v1.2 tab-strip allow-list (ADR 0003 §7; docs/research/v1.2/tab-discovery.md §6). Replaces the
// provider's `category === 'browser'` test and the service's TAB_STRIP_BROWSERS: only windows of
// these apps are ever sent to the UI Automation helper, which applies the same table again with
// Win32 data only (top-level class, full image path, a required child window class) BEFORE any UIA
// call (native/uia-helper/Native.cs TabWindowRules). Never a class-only or "any XAML island" match:
// an unknown toolkit may host web content or start an accessibility engine on first contact.
import type { LivelyBehavior, ToggleableBehavior } from '../../shared/settings';
import type { TabStripKind } from './protocol';

/** Content-free name of an allow-listed app (counts-only request log, diagnostics). */
export type TabStripAppSlug = 'edge' | 'chrome' | 'explorer' | 'terminal';

/** File Explorer is the shell's own process (taskbar, desktop): it gets extra protection (ADR 0003 §7.2). */
export interface TabStripAppLimits {
  /** At most this many requests (reads and subscriptions) per second for all windows of the app. */
  maxRequestsPerSec: number;
  /** At most this many windows of the app are ever measured at once. */
  maxWindows: number;
  /** Request timeout for this app's windows (ms; the default applies when absent). */
  timeoutMs: number;
  /** Read last in each polling cycle (it cannot starve the other apps). */
  last: boolean;
}

export interface TabStripAppRule {
  kind: TabStripKind;
  slug: TabStripAppSlug;
  /** Lower-case executable basename (WindowInfo.processName). */
  processName: string;
  /** Win32 class of the top-level window (checked by the helper). */
  topLevelClass: string;
  /** Win32 class of a child window that must exist (FindWindowEx, class only), or null. */
  requiredChildClass: string | null;
  /**
   * Shipped switch: an off rule is never queried. Chromium and Terminal are on with the protocol-2
   * helper; Explorer is off unless its REAL soak passed (EXPLORER_SOAK_PASSED).
   */
  enabled: boolean;
  /** Opt-outs that switch this app off ('tabStrips' switches every app off). */
  optOuts: ReadonlyArray<ToggleableBehavior | LivelyBehavior>;
  limits?: TabStripAppLimits;
}

/**
 * Soak gate (ADR 0003 §7.2, Q8): the Explorer rule ships off unless a REAL soak (>= 2 h on this
 * machine with the cat on Explorer strips, no TaskbarCreated, <= 1 helper timeout per hour) passed.
 * Not run yet: UNVERIFIED, so Explorer tab strips are off (Terminal on). Flip only with the soak's
 * evidence in docs/TEST_REPORT.md.
 */
export const EXPLORER_SOAK_PASSED = false;

export const EXPLORER_LIMITS: TabStripAppLimits = { maxRequestsPerSec: 1, maxWindows: 3, timeoutMs: 2500, last: true };

export const TAB_STRIP_APPS: readonly TabStripAppRule[] = [
  { kind: 'chromium', slug: 'edge', processName: 'msedge.exe', topLevelClass: 'Chrome_WidgetWin_1', requiredChildClass: null, enabled: true, optOuts: ['tabStrips'] },
  { kind: 'chromium', slug: 'chrome', processName: 'chrome.exe', topLevelClass: 'Chrome_WidgetWin_1', requiredChildClass: null, enabled: true, optOuts: ['tabStrips'] },
  {
    kind: 'tabview',
    slug: 'explorer',
    processName: 'explorer.exe',
    topLevelClass: 'CabinetWClass',
    requiredChildClass: 'Microsoft.UI.Content.DesktopChildSiteBridge',
    enabled: EXPLORER_SOAK_PASSED,
    optOuts: ['tabStrips', 'explorerTabs'],
    limits: EXPLORER_LIMITS,
  },
  {
    kind: 'tabview',
    slug: 'terminal',
    processName: 'windowsterminal.exe',
    topLevelClass: 'CASCADIA_HOSTING_WINDOW_CLASS',
    requiredChildClass: 'Windows.UI.Composition.DesktopWindowContentBridge',
    enabled: true,
    optOuts: ['tabStrips', 'terminalTabs'],
  },
];

/**
 * Never sent to the helper, whatever a future table says: first UIA contact switches on Gecko's or
 * Chromium's web accessibility (Firefox, Electron/VS Code) or risks the user's session (Notepad
 * restores and rewrites its saved tabs; UNVERIFIED, enable only after a REAL probe on a clean profile).
 */
export const UIA_NEVER_QUERY: ReadonlySet<string> = new Set<string>(['firefox.exe', 'code.exe', 'notepad.exe']);

/** Run-time switches on top of the shipped table (the service's kill switch, the soak/test mode). */
export interface TabStripRuleOverrides {
  /** true: the Explorer rule is on although not shipped on (REAL soak and probes only); false: off (kill switch). */
  explorer?: boolean;
}

/** The rule for a process name whatever its switches (null: not allow-listed, or never queried). */
export function tabStripAppRule(processName: string): TabStripAppRule | null {
  const name = processName.toLowerCase();
  if (UIA_NEVER_QUERY.has(name)) return null;
  return TAB_STRIP_APPS.find((r) => r.processName === name) ?? null;
}

/** The rule for a window's process, or null when its tab strip is never read (off, opted out, or not allow-listed). */
export function tabStripRuleFor(processName: string, disabled: ReadonlySet<string>, overrides: TabStripRuleOverrides = {}): TabStripAppRule | null {
  const rule = tabStripAppRule(processName);
  if (rule === null) return null;
  const enabled = rule.slug === 'explorer' && overrides.explorer !== undefined ? overrides.explorer : rule.enabled;
  if (!enabled || rule.optOuts.some((id) => disabled.has(id))) return null;
  return rule;
}
