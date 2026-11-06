// Builds the user-exportable diagnostics JSON. Contains no secrets, window
// titles, process lists, images or the user's profile path (it holds the Windows
// account name); exclusion lists are reduced to counts and the whole report is
// passed through redaction once more. Pure.
import type { BehaviorProfileSnapshot } from '../../shared/behaviorProfile';
import { parseBehaviorProfile } from '../../shared/behaviorProfileSchema';
import { IDENTITY } from '../../shared/identity';
import type { AppStatus, ResourceSample } from '../../shared/ipc';
import { DEFAULT_EXCLUDED_PROCESSES, DEFAULT_EXCLUDED_TITLE_PATTERNS, type Settings } from '../../shared/settings';
import type { SurfaceDiagnostics } from '../../shared/surfaceDiagnostics';
import type { WorldGeometry } from '../../shared/world';
import { formatEntry, type LogEntry } from './logger';
import { redactString, redactValue, scrubUserProfile } from './redact';

export const DIAGNOSTICS_LOG_LINES = 500;

export interface DiagnosticsInput {
  generatedAt: Date;
  versions: Record<string, string>;
  os: { platform: string; release: string; arch: string; totalMemoryMB: number; locale?: string };
  world: WorldGeometry;
  settings: Settings;
  /** The user's profile folder (os.homedir()), replaced by %USERPROFILE% wherever it appears. */
  userProfile?: string;
  apiKeysStored: { anthropic: boolean; openaiCompatible: boolean };
  status: AppStatus;
  cat: Record<string, unknown>;
  /** v1.1.1: why the cat can or cannot leave the floor (counts, kinds, reasons, geometry; no titles or ids). */
  surfaces?: SurfaceDiagnostics | null;
  /**
   * v1.2 (ADR 0003 §11): the sim's behaviour profile, exported as the `behaviorProfile` section
   * after validation against the strict BehaviorProfileSchema (kinds, counts and durations of this
   * session; never which windows or apps). Missing or invalid: the section is null.
   */
  behaviorProfile?: BehaviorProfileSnapshot | null;
  services: Record<string, unknown>;
  resources: readonly ResourceSample[];
  logs: readonly LogEntry[];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Strips credentials from URLs (http://user:pass@host). */
function scrubUrl(u: string): string {
  try {
    const url = new URL(u);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString();
  } catch {
    return redactString(u);
  }
}

export function settingsForDiagnostics(s: Settings): Record<string, unknown> {
  const { excludedProcesses, excludedTitlePatterns, ...perception } = s.perception;
  return {
    ...s,
    perception: {
      ...perception,
      excludedProcesses: { count: excludedProcesses.length, isDefault: sameList(excludedProcesses, DEFAULT_EXCLUDED_PROCESSES) },
      excludedTitlePatterns: { count: excludedTitlePatterns.length, isDefault: sameList(excludedTitlePatterns, DEFAULT_EXCLUDED_TITLE_PATTERNS) },
    },
    ai: { ...s.ai, ollamaBaseUrl: scrubUrl(s.ai.ollamaBaseUrl), openaiBaseUrl: scrubUrl(s.ai.openaiBaseUrl) },
    // The exe path the app registered lies under the user's profile; services.loginItem says whether it is this exe.
    loginItem: { ...s.loginItem, registeredPath: s.loginItem.registeredPath === null ? null : REGISTERED_PATH_PLACEHOLDER },
  };
}

export const REGISTERED_PATH_PLACEHOLDER = '[path]';

/** Applies `fn` to every string in a redacted (plain JSON) value. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** The validated profile for the export, or null (absent, or it failed the strict schema). Never throws. */
export function exportedBehaviorProfile(profile: unknown): BehaviorProfileSnapshot | null {
  if (profile === null || profile === undefined) return null;
  try {
    return parseBehaviorProfile(profile);
  } catch {
    return null;
  }
}

export function buildDiagnosticsReport(input: DiagnosticsInput): Record<string, unknown> {
  const logs = input.logs.slice(-DIAGNOSTICS_LOG_LINES).map((e) => redactString(formatEntry(e)));
  const report = {
    kind: IDENTITY.diagnosticsKind,
    formatVersion: 1,
    generatedAt: input.generatedAt.toISOString(),
    versions: input.versions,
    os: input.os,
    displays: input.world.displays.map((d) => ({
      id: d.id,
      primary: d.primary,
      scaleFactor: d.scaleFactor,
      boundsDip: d.boundsDip,
      workAreaDip: d.workAreaDip,
      boundsPx: d.boundsPx,
      workAreaPx: d.workAreaPx,
    })),
    settings: settingsForDiagnostics(input.settings),
    apiKeysStored: input.apiKeysStored,
    status: input.status,
    cat: input.cat,
    surfaces: input.surfaces ?? null,
    behaviorProfile: exportedBehaviorProfile(input.behaviorProfile),
    services: input.services,
  };
  // Resource samples are plain numbers and would be truncated by the generic redactor.
  const resources = input.resources.map((r) => ({ at: r.at, cpuPercent: r.cpuPercent, workingSetMB: r.workingSetMB }));
  const profile = input.userProfile;
  const scrub = (v: unknown): unknown => (profile ? mapStrings(v, (str) => scrubUserProfile(str, profile)) : v);
  return { ...(scrub(redactValue(report)) as Record<string, unknown>), resources, logs: scrub(logs) };
}
