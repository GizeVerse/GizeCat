import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport } from '../../../src/main/diagnostics/diagnosticsReport';
import { createResourceMonitor, summarizeMetrics } from '../../../src/main/diagnostics/resourceMonitor';
import type { LogEntry } from '../../../src/main/diagnostics/logger';
import type { AppStatus } from '../../../src/shared/ipc';
import { defaultSettings } from '../../../src/shared/settings';

const status: AppStatus = {
  version: '1.0.0',
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

describe('diagnostics report', () => {
  it('contains no secrets, titles or exclusion contents and caps logs at 500 lines', () => {
    const settings = defaultSettings();
    settings.ai.openaiBaseUrl = 'http://user:pa55word@127.0.0.1:1234/v1?token=abc';
    settings.perception.excludedTitlePatterns = ['my private bank name'];
    const logs: LogEntry[] = Array.from({ length: 700 }, (_, i) => ({ at: i, level: 'info', scope: 'app', msg: `line ${i}` }));
    logs.push({ at: 999, level: 'warn', scope: 'ai', msg: 'header Authorization: Bearer leakedtoken123' });
    const report = buildDiagnosticsReport({
      generatedAt: new Date('2026-10-28T00:00:00Z'),
      versions: { app: '1.0.0' },
      os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
      world: { version: 1, displays: [] },
      settings,
      apiKeysStored: { anthropic: true, openaiCompatible: false },
      status,
      cat: { state: 'idle', title: 'should vanish' },
      services: {},
      resources: Array.from({ length: 120 }, (_, i) => ({ at: i, cpuPercent: 1, workingSetMB: 300 })),
      logs,
    });
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/pa55word|leakedtoken123|my private bank name|should vanish|token=abc/);
    expect((report.logs as string[]).length).toBe(500);
    expect((report.resources as unknown[]).length).toBe(120);
    expect(report.apiKeysStored).toEqual({ anthropic: true, openaiCompatible: false });
    const perception = (report.settings as { perception: Record<string, unknown> }).perception;
    expect(perception.excludedTitlePatterns).toEqual({ count: 1, isDefault: false });
    expect(perception.excludedProcesses).toMatchObject({ isDefault: true });
  });
});

describe('resource monitor', () => {
  it('sums CPU and working set across processes', () => {
    expect(
      summarizeMetrics(
        [
          { cpu: { percentCPUUsage: 1.234 }, memory: { workingSetSize: 102400 } },
          { cpu: { percentCPUUsage: 0.5 }, memory: { workingSetSize: 51200 } },
        ],
        7,
      ),
    ).toEqual({ at: 7, cpuPercent: 1.73, workingSetMB: 150 });
  });

  it('keeps a bounded ring of samples and tolerates failures', () => {
    let fail = false;
    let t = 0;
    const m = createResourceMonitor({
      getMetrics: () => {
        if (fail) throw new Error('metrics unavailable');
        return [{ cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1024 } }];
      },
      capacity: 3,
      now: () => ++t,
    });
    for (let i = 0; i < 5; i++) m.sampleNow();
    fail = true;
    expect(m.sampleNow()).toBeNull();
    expect(m.samples().map((s) => s.at)).toEqual([3, 4, 5]);
  });
});
