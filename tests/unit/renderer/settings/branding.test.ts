// The settings window's product names (ADR 0004 §9): GizeCat everywhere, "Desktop Cat" only where
// the text tells the user what to find or click in Windows (the installed name) and in the About
// heading's "formerly". DOM-free: walks every string the window can show.
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../../../src/shared/brand';
import { S } from '../../../../src/renderer/settings/strings';

/** Every string in S, by path; functions are called with placeholder arguments where they allow it. */
function leaves(value: unknown, at: string, out: Array<readonly [string, string]>): void {
  if (typeof value === 'string') out.push([at, value]);
  else if (typeof value === 'function') {
    let result: unknown;
    try {
      result = (value as (...args: unknown[]) => unknown)('x', 'y', 'z');
    } catch {
      return; // needs typed arguments; its fixed text is covered by the page tests
    }
    leaves(result, `${at}()`, out);
  } else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, `${at}[${i}]`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) leaves(v, at ? `${at}.${k}` : k, out);
}

const ALL: Array<readonly [string, string]> = [];
leaves(S, '', ALL);
const text = (p: string): string => ALL.find(([at]) => at === p)?.[1] ?? '';

describe('settings window: product names', () => {
  it('calls the app GizeCat in titles, the brand, the startup choices and the quit row', () => {
    expect(S.app.title).toBe('GizeCat Settings');
    expect(S.app.pageTitle('General')).toBe('General · GizeCat');
    expect(S.app.brand).toBe(BRAND.product);
    expect(S.general.startupStateTitle).toBe('When GizeCat starts');
    expect(S.general.launchNoticeTitle).toBe('GizeCat now starts with Windows');
    expect(S.general.quitTitle).toBe('Quit GizeCat');
    expect(S.diagnostics.versions.app).toBe('GizeCat');
  });

  it('About reads "GizeCat — a GizeVerse character (formerly Desktop Cat)"', () => {
    expect(`${S.app.brand}${S.about.identity}`).toBe('GizeCat — a GizeVerse character (formerly Desktop Cat)');
  });

  it('names Desktop Cat only where Windows (or macOS Finder) shows that name, or as the former name', () => {
    // Task Manager › Startup apps and Settings › Apps list the installed name (BRAND.installedName).
    expect(text('general.launchStatus.windowsDisabled')).toContain('open Task Manager › Startup apps and enable the Desktop Cat entry');
    expect(text('about.uninstall')).toContain('Settings › Apps › Installed apps, find Desktop Cat and choose Uninstall');
    const old = ALL.filter(([, s]) => s.includes('Desktop Cat')).map(([at]) => at);
    // 1.4.0: macOS Finder shows the app under the same installed name (Applications › Desktop Cat).
    expect(text('about.uninstallMac')).toContain('drag Desktop Cat from Applications to the Trash');
    expect(old.sort()).toEqual(['about.identity', 'about.uninstall', 'about.uninstallMac', 'general.launchStatus.windowsDisabled']);
  });

  it('the walk reaches the strings it checks', () => {
    expect(ALL.length).toBeGreaterThan(300);
    expect(ALL.filter(([, s]) => s.includes('GizeCat')).length).toBeGreaterThan(15);
  });
});
