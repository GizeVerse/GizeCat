// Which privacy exclusions the window layer applies for the current settings.
import { hasConsent } from '../../core/perception/privacy';
import type { Settings } from '../../shared/settings';

export interface WindowExclusions {
  processes: readonly string[];
  titlePatterns: readonly string[];
}

/** True while screen analysis can run: a visual mode is chosen, consent is recorded and it is not privacy-paused. */
export function titleChecksActive(settings: Settings): boolean {
  const p = settings.perception;
  return p.visualMode !== 'off' && hasConsent(settings) && !p.paused;
}

/**
 * Exclusions for WindowTracker.setExclusions. Window titles are read (in memory) only to
 * match title patterns, and docs/PRIVACY.md promises that happens only while screen
 * analysis is enabled, so the patterns are installed only then. Process rules need only
 * executable names and apply at all times.
 */
export function windowExclusionsFor(settings: Settings): WindowExclusions {
  const p = settings.perception;
  return { processes: p.excludedProcesses, titlePatterns: titleChecksActive(settings) ? p.excludedTitlePatterns : [] };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

export function sameWindowExclusions(a: WindowExclusions, b: WindowExclusions): boolean {
  return sameList(a.processes, b.processes) && sameList(a.titlePatterns, b.titlePatterns);
}
