// Builds the user-exportable diagnostics JSON. Contains no secrets, window
// titles, process lists or images; exclusion lists are reduced to counts and the
// whole report is passed through redaction once more. Pure.
import type { AppStatus, ResourceSample } from '../../shared/ipc';
import { DEFAULT_EXCLUDED_PROCESSES, DEFAULT_EXCLUDED_TITLE_PATTERNS, type Settings } from '../../shared/settings';
import type { WorldGeometry } from '../../shared/world';
import { formatEntry, type LogEntry } from './logger';
import { redactString, redactValue } from './redact';

export const DIAGNOSTICS_LOG_LINES = 500;

export interface DiagnosticsInput {
  generatedAt: Date;
  versions: Record<string, string>;
  os: { platform: string; release: string; arch: string; totalMemoryMB: number; locale?: string };
  world: WorldGeometry;
  settings: Settings;
  apiKeysStored: { anthropic: boolean; openaiCompatible: boolean };
  status: AppStatus;
  cat: Record<string, unknown>;
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
  };
}

export function buildDiagnosticsReport(input: DiagnosticsInput): Record<string, unknown> {
  const logs = input.logs.slice(-DIAGNOSTICS_LOG_LINES).map((e) => redactString(formatEntry(e)));
  const report = {
    kind: 'desktop-cat-diagnostics',
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
    services: input.services,
  };
  // Resource samples are plain numbers and would be truncated by the generic redactor.
  const resources = input.resources.map((r) => ({ at: r.at, cpuPercent: r.cpuPercent, workingSetMB: r.workingSetMB }));
  return { ...(redactValue(report) as Record<string, unknown>), resources, logs };
}
