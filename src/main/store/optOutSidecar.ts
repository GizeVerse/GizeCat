// v1.2 opt-out sidecar (ADR 0003 §9.3). Desktop Cat 1.1.1 reads a v3 settings file fine, but its
// first save drops behavior.disabledExtras, so a later re-upgrade would switch the v1.2 opt-outs
// back on. The list is therefore mirrored into behavior-opt-outs.json next to settings.json, a file
// 1.1.1 never touches. On load the effective list is the union of both (the same tolerant, bounded
// rule as the settings list); an id leaves the sidecar only when the user switches that behaviour
// back on in v1.2 or later (the sidecar always mirrors the effective list after a load or patch).
// Electron-free and pure apart from the JsonStore it is given.
import path from 'node:path';
import { normalizeOptOutList } from '../../shared/settings';

export const OPT_OUT_SIDECAR_FILE = 'behavior-opt-outs.json';
export const OPT_OUT_SIDECAR_KIND = 'desktop-cat-opt-outs';
export const OPT_OUT_SIDECAR_VERSION = 1;

export interface OptOutSidecarFile {
  kind: typeof OPT_OUT_SIDECAR_KIND;
  version: typeof OPT_OUT_SIDECAR_VERSION;
  /** Mirror of behavior.disabledExtras (ids only: short camelCase slugs). */
  disabledExtras: string[];
}

/** Where the sidecar lives for a settings file: the same folder. */
export function optOutSidecarPath(settingsFile: string): string {
  return path.join(path.dirname(settingsFile), OPT_OUT_SIDECAR_FILE);
}

/** The ids a stored sidecar holds (tolerant: anything malformed counts as none, bad entries are dropped one by one). */
export function readOptOutSidecar(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const v = value as Record<string, unknown>;
  if (v.kind !== OPT_OUT_SIDECAR_KIND) return [];
  return normalizeOptOutList(v.disabledExtras);
}

export function optOutSidecarFile(list: readonly string[]): OptOutSidecarFile {
  return { kind: OPT_OUT_SIDECAR_KIND, version: OPT_OUT_SIDECAR_VERSION, disabledExtras: normalizeOptOutList([...list]) };
}

/** The effective list: the settings list first, then what only the sidecar remembers (bounded, no duplicates). */
export function unionOptOuts(settingsList: readonly string[], sidecarList: readonly string[]): string[] {
  return normalizeOptOutList([...settingsList, ...sidecarList]);
}

export function sameOptOuts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
