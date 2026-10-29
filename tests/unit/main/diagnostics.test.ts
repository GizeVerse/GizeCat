import { describe, expect, it } from 'vitest';
import { buildDiagnosticsReport, REGISTERED_PATH_PLACEHOLDER } from '../../../src/main/diagnostics/diagnosticsReport';
import { scrubUserProfile } from '../../../src/main/diagnostics/redact';
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

  // startup#9 / privacy-docs#2: the exe path the app registered for sign-in holds the Windows account name.
  it('contains no user profile path or account name, also from the registered startup path', () => {
    const profile = 'C:\\Users\\Jane Doe';
    const exe = `${profile}\\AppData\\Local\\Programs\\DesktopCat\\DesktopCat.exe`;
    const settings = defaultSettings();
    settings.loginItem = { ...settings.loginItem, preference: 'enabled', decidedBy: 'user', registeredPath: exe };
    const report = buildDiagnosticsReport({
      generatedAt: new Date('2026-10-29T00:00:00Z'),
      versions: { app: '1.1.0' },
      os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
      world: { version: 1, displays: [] },
      settings,
      userProfile: profile,
      apiKeysStored: { anthropic: false, openaiCompatible: false },
      status,
      cat: {},
      // Any service detail or log line that carries a path under the profile, in either slash style or letter case.
      services: { uiaHelper: { exe: `${profile}\\AppData\\Local\\Programs\\DesktopCat\\resources\\uia.exe` }, cache: 'c:/users/jane doe/AppData/Roaming/Desktop Cat' },
      resources: [],
      logs: [{ at: 1, level: 'warn', scope: 'store', msg: 'could not read', data: { file: `${profile}\\AppData\\Roaming\\Desktop Cat\\settings.json` } }],
    });
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/Jane|Doe/i);
    expect(json).not.toMatch(/C:\\\\Users\\\\/i);
    expect((report.settings as { loginItem: Record<string, unknown> }).loginItem).toMatchObject({ preference: 'enabled', registeredPath: REGISTERED_PATH_PLACEHOLDER });
    expect((report.services as { uiaHelper: { exe: string } }).uiaHelper.exe).toBe('%USERPROFILE%\\AppData\\Local\\Programs\\DesktopCat\\resources\\uia.exe');
    expect((report.logs as string[])[0]).toContain('%USERPROFILE%');
    // Whether a path was registered stays visible.
    settings.loginItem = { ...settings.loginItem, registeredPath: null };
    const none = buildDiagnosticsReport({ ...baseInput(), settings });
    expect((none.settings as { loginItem: Record<string, unknown> }).loginItem.registeredPath).toBeNull();
  });

  it('without a known profile the registered path is still left out', () => {
    const settings = defaultSettings();
    settings.loginItem = { ...settings.loginItem, registeredPath: 'D:\\Jane\\DesktopCat\\DesktopCat.exe' };
    expect(JSON.stringify(buildDiagnosticsReport({ ...baseInput(), settings }))).not.toMatch(/Jane/);
  });
});

function baseInput(): Parameters<typeof buildDiagnosticsReport>[0] {
  return {
    generatedAt: new Date('2026-10-29T00:00:00Z'),
    versions: { app: '1.1.0' },
    os: { platform: 'win32', release: '10.0.26200', arch: 'x64', totalMemoryMB: 16000 },
    world: { version: 1, displays: [] },
    settings: defaultSettings(),
    apiKeysStored: { anthropic: false, openaiCompatible: false },
    status,
    cat: {},
    services: {},
    resources: [],
    logs: [],
  };
}

describe('scrubUserProfile', () => {
  const profile = 'C:\\Users\\Ann';
  it.each([
    ['backslashes', 'C:\\Users\\Ann\\AppData\\x.log', '%USERPROFILE%\\AppData\\x.log'],
    ['JSON-escaped backslashes', '{"f":"C:\\\\Users\\\\Ann\\\\AppData"}', '{"f":"%USERPROFILE%\\\\AppData"}'],
    ['forward slashes, other case', 'c:/users/ANN/Desktop', '%USERPROFILE%/Desktop'],
    ['the folder itself', 'home is C:\\Users\\Ann.', 'home is %USERPROFILE%.'],
    ['several occurrences', 'C:\\Users\\Ann\\a C:\\Users\\Ann\\b', '%USERPROFILE%\\a %USERPROFILE%\\b'],
  ])('replaces the profile: %s', (_name, input, want) => {
    expect(scrubUserProfile(input, profile)).toBe(want);
  });

  it('leaves other folders that only start with the same name alone, also for non-ASCII names', () => {
    expect(scrubUserProfile('C:\\Users\\Anna\\x', profile)).toBe('C:\\Users\\Anna\\x');
    expect(scrubUserProfile('C:\\Users\\Ann-Marie\\x', profile)).toBe('C:\\Users\\Ann-Marie\\x');
    expect(scrubUserProfile('C:\\Users\\Çağrı\\x', 'C:\\Users\\Çağ')).toBe('C:\\Users\\Çağrı\\x');
    expect(scrubUserProfile('C:\\Users\\çAĞ\\x', 'C:\\Users\\Çağ')).toBe('%USERPROFILE%\\x');
  });

  it('ignores a profile that is a drive root, and names with regex characters are matched literally', () => {
    expect(scrubUserProfile('C:\\x', 'C:\\')).toBe('C:\\x');
    expect(scrubUserProfile('C:\\Users\\a.b (c)\\x C:\\Users\\aXb (c)\\x', 'C:\\Users\\a.b (c)')).toBe('%USERPROFILE%\\x C:\\Users\\aXb (c)\\x');
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
