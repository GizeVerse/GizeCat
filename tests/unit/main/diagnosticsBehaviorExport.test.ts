// v1.2 (ADR 0003 §11): the diagnostics export gains a `behaviorProfile` section, validated against
// the strict BehaviorProfileSchema; anything that fails it is left out (null), never exported raw.
import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, exportedBehaviorProfile, type DiagnosticsInput } from '../../../src/main/diagnostics/diagnosticsReport';
import type { BehaviorProfileSnapshot } from '../../../src/shared/behaviorProfile';
import type { AppStatus } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';
import { fullProfile } from './diagnosticsBehaviorFixture';

const status: AppStatus = {
  version: '1.2.0',
  visible: true,
  paused: false,
  interactionsEnabled: true,
  catState: 'idle',
  displayCount: 1,
  perception: { mode: 'off', paused: false, blockedReason: null, lastCaptureAt: null, capturesThisHour: 0, aiProviderLabel: null, lastError: null },
  windowAwareness: 'event-hooks',
  loginItem: { enabled: true, preference: 'unset', disabledBy: null, active: false, writable: false, reason: null, showNotice: false },
  shortcutRegistered: true,
  startedAt: 0,
};

function input(behaviorProfile: unknown): DiagnosticsInput {
  return {
    generatedAt: new Date('2026-10-29T12:00:00Z'),
    versions: { app: '1.2.0' },
    os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
    world: { version: 1, displays: [] },
    settings: defaultSettings(),
    apiKeysStored: { anthropic: false, openaiCompatible: false },
    status,
    cat: {},
    behaviorProfile: behaviorProfile as BehaviorProfileSnapshot | null,
    services: {},
    resources: [],
    logs: [],
  };
}

describe('diagnostics export: behaviour profile section', () => {
  it('exports the validated profile in full (counts, kinds, durations; nested records survive redaction)', () => {
    const report = buildDiagnosticsReport(input(fullProfile()));
    expect(report.behaviorProfile).toEqual(JSON.parse(JSON.stringify(fullProfile())));
  });

  it('is null when there is no profile', () => {
    expect(buildDiagnosticsReport(input(undefined)).behaviorProfile).toBeNull();
    expect(buildDiagnosticsReport(input(null)).behaviorProfile).toBeNull();
  });

  it('leaves out a profile that fails the schema, so nothing it carried reaches the file', () => {
    const leaky = { ...fullProfile(), windowTitle: 'Inbox - Mail', recentStays: [{ ...fullProfile().recentStays[0], surfaceId: 'windowTop:197482' }] };
    const report = buildDiagnosticsReport(input(leaky));
    expect(report.behaviorProfile).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/Inbox|197482/);
  });

  it('never throws, whatever the producer handed over', () => {
    const hostile = {
      get since(): number {
        throw new Error('boom');
      },
    };
    expect(exportedBehaviorProfile(hostile)).toBeNull();
    expect(exportedBehaviorProfile('profile')).toBeNull();
    expect(exportedBehaviorProfile(fullProfile())).toEqual(fullProfile());
  });
});
