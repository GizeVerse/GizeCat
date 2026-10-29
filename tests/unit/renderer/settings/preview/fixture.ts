// Deterministic SettingsViewState for the visual preview harness.
import type { CatSummary } from '../../../../../src/shared/catState';
import type { ResourceSample, SettingsViewState } from '../../../../../src/shared/ipc';
import { defaultSettings } from '../../../../../src/shared/settings';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface FixtureVersions {
  electron: string;
  chrome: string;
  node: string;
}

function resources(now: number): ResourceSample[] {
  const out: ResourceSample[] = [];
  for (let i = 0; i < 40; i++) {
    out.push({
      at: now - (39 - i) * 30_000,
      cpuPercent: Math.max(0, 0.7 + 0.45 * Math.sin(i / 3) + (i % 9 === 0 ? 1.6 : 0)),
      workingSetMB: 182 + i * 0.7 + 6 * Math.sin(i / 4),
    });
  }
  return out;
}

function cat(now: number, name: string): CatSummary {
  return {
    name,
    catId: 'preview-cat-0001',
    bornAt: now - 12 * 24 * HOUR,
    state: 'resting',
    traits: { curiosity: 0.72, playfulness: 0.58, affection: 0.64, confidence: 0.41, energyLevel: 0.55, laziness: 0.38 },
    stats: { energy: 0.81, boredom: 0.22, bond: 0.47, annoyance: 0.05, fear: 0 },
    counters: {
      pets: 214,
      clicks: 1320,
      doubleClicks: 61,
      drags: 48,
      throws: 9,
      chasesStarted: 77,
      chasesEngaged: 41,
      chasesIgnored: 36,
      attentionRequests: 25,
      attentionAnswered: 19,
      windowsInspected: 156,
      naps: 88,
      sessions: 23,
    },
    preferences: { petRatePerHour: 3.4, cursorPlayAcceptance: 0.53, attentionAcceptance: 0.76 },
    favoriteSpotCount: 3,
    // The simulation's own kinds and detail tokens (src/core/behavior/memory.ts).
    recent: [
      { at: now - 40_000, kind: 'pet' },
      { at: now - 6 * MIN, kind: 'nap' },
      { at: now - 23 * MIN, kind: 'chase', detail: 'engaged' },
      { at: now - 2 * HOUR, kind: 'inspect', detail: 'window' },
      { at: now - 5 * HOUR, kind: 'attention', detail: 'answered' },
      { at: now - 26 * HOUR, kind: 'startle' },
      { at: now - 3 * 24 * HOUR, kind: 'play', detail: 'pawAt' },
    ],
  };
}

export function previewView(now: number, versions: FixtureVersions): SettingsViewState {
  const settings = defaultSettings();
  settings.behavior.disabledBehaviors = ['zoomies'];
  return {
    settings,
    status: {
      version: '1.0.0',
      visible: true,
      paused: false,
      interactionsEnabled: true,
      catState: 'resting',
      displayCount: 2,
      perception: {
        mode: 'off',
        paused: false,
        blockedReason: null,
        lastCaptureAt: null,
        capturesThisHour: 0,
        aiProviderLabel: null,
        lastError: null,
      },
      windowAwareness: 'event-hooks',
      loginItem: { enabled: true, preference: 'unset', disabledBy: null, active: true, writable: true, reason: null, showNotice: false },
      shortcutRegistered: true,
      startedAt: now - 3 * HOUR - 12 * MIN,
    },
    cat: cat(now, settings.general.catName),
    apiKeys: { anthropic: false, openaiCompatible: false },
    resources: resources(now),
    versions: { app: '1.0.0', electron: versions.electron, chrome: versions.chrome, node: versions.node, os: 'Windows 11 (preview fixture)' },
    paths: { userData: 'C:\\Users\\preview\\AppData\\Roaming\\Desktop Cat', logs: 'C:\\Users\\preview\\AppData\\Roaming\\Desktop Cat\\logs' },
  };
}
