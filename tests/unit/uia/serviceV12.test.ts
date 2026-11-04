// v1.2 TabStripService (ADR 0003 §7.2, §7.3; PRV) against the fake helper process (MOCKED helper; real
// child processes and pipes): the allow-list (Terminal on, Explorer behind its soak gate), the kind
// cross-check, the Explorer limits and kill switch, the T6 retention and the diagnostics by kind.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTabStripService, type TabStripServiceImpl, type TabStripServiceOptions } from '../../../src/main/uia';
import { EXPLORER_SOAK_PASSED } from '../../../src/main/uia/allowList';
import type { Settings } from '../../../src/shared/settings';
import type { WindowInfo } from '../../../src/shared/world';
import type { FakeHelperState } from './fakeHelper';
import { tabviewStrip, wireStrip } from './fixtures';
import { eventually, FakeWindows, fakeHelperHarness, ManualClock, memoryLogger, removeDir, settingsWith, type FakeHelperHarness } from './harness';
import { tempDir } from '../main/helpers';

const EDGE = '65552';
const TERM = '131090';
const EXPL = '262200';
const EXPL2 = '262202';
const EXPL3 = '262204';
const EXPL4 = '262206';
const CODE = '393300';

const TERMINAL: Partial<WindowInfo> = { processName: 'windowsterminal.exe', category: 'terminal', rect: { x: 299, y: 200, width: 1243, height: 624 } };
const EXPLORER: Partial<WindowInfo> = { processName: 'explorer.exe', category: 'system', rect: { x: 411, y: 290, width: 1080, height: 665 } };

interface Rig {
  h: FakeHelperHarness;
  clock: ManualClock;
  wins: FakeWindows;
  svc: TabStripServiceImpl;
  log: ReturnType<typeof memoryLogger>;
}

const rigs: Rig[] = [];
const dirs: string[] = [];

function rig(state: FakeHelperState, o: { settings?: Settings; options?: Partial<TabStripServiceOptions>; healthFile?: string; appVersion?: string } = {}): Rig {
  const h = fakeHelperHarness(state);
  const clock = new ManualClock();
  const wins = new FakeWindows();
  const log = memoryLogger();
  const svc = createTabStripService({
    logger: log,
    settings: o.settings ?? settingsWith({ tabStrips: true }),
    helperPath: 'C:\\fake\\DesktopCatUia.exe',
    describeWindow: wins.describe,
    now: clock.now,
    spawnHelper: h.spawnHelper,
    options: { autoPumpMs: 0, ...o.options },
    healthFile: o.healthFile ?? null,
    appVersion: o.appVersion ?? '1.2.0',
  });
  const r = { h, clock, wins, svc, log };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.svc.dispose();
    await r.h.cleanup();
  }
  for (const d of dirs.splice(0)) removeDir(d);
});

const stripOps = (r: Rig, hwnd: string): number => r.h.ops('strip').filter((q) => q.hwnd === hwnd).length;
const listed = (r: Rig, hwnd: string) => r.svc.surfaces().find((s) => s.ownerId === hwnd) ?? null;

async function waitForStrip(r: Rig, hwnd: string): Promise<void> {
  await eventually(() => expect(listed(r, hwnd)).not.toBeNull());
}

async function stepAndRead(r: Rig, ms: number, ids: string[], reads = 1): Promise<void> {
  const done = r.svc.debugInfo().readsDone;
  r.svc.setInterest(ids, r.clock.advance(ms));
  await eventually(() => expect(r.svc.debugInfo().readsDone).toBe(done + reads));
}

function withOptOut(...ids: string[]): Settings {
  const s = settingsWith({ tabStrips: true });
  return { ...s, behavior: { ...s.behavior, disabledExtras: ids } };
}

describe('v1.2 allow-list: Terminal on, Explorer behind its soak gate, others never queried', () => {
  it('reads a Windows Terminal window and lists its TabView strip (REAL geometry), counted by kind', async () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM], r.clock.now());
    await waitForStrip(r, TERM);
    // The segment of the measured strip: 100.5..583.5 px from the frame's left edge, feet on its top.
    expect(listed(r, TERM)).toMatchObject({ kind: 'tabStrip', y: 200, x0: 299 + 100.5, x1: 299 + 583.5, focusX: 299 + 489 });
    expect(r.svc.diagnostics().byKind).toEqual({ chromium: 0, tabview: 1 });
    // The counts-only request log: one read (and, once listed, its subscription), all Terminal.
    await eventually(() => expect(r.h.ops('watch').length).toBeGreaterThanOrEqual(1));
    const log = r.svc.debugInfo().requestsByApp;
    expect(log.terminal).toBe(stripOps(r, TERM) + r.h.ops('watch').length);
    expect(log.edge + log.chrome + log.explorer).toBe(0);
  });

  it('ships the Explorer rule off: an Explorer window is never queried ("appOff"), unless the soak/test mode turns it on', async () => {
    expect(EXPLORER_SOAK_PASSED).toBe(false);
    const r = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }), [EDGE]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(EXPL, EXPLORER);
    r.wins.set(EDGE);
    r.svc.setInterest([EXPL, EDGE], r.clock.now());
    await waitForStrip(r, EDGE);
    expect(stripOps(r, EXPL)).toBe(0);
    expect(r.svc.readsApp('explorer.exe')).toBe(false);
    const on = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }) } }, { options: { enableExplorerTabs: true } });
    on.svc.start();
    on.wins.set(EXPL, EXPLORER);
    on.svc.setInterest([EXPL], on.clock.now());
    await waitForStrip(on, EXPL);
    expect(listed(on, EXPL)).toMatchObject({ x0: 411 + 67.5, x1: 411 + 256.5 });
  });

  it('never queries VS Code, Firefox or Notepad, and says why', () => {
    const r = rig({ strips: {} });
    r.svc.start();
    r.wins.set(CODE, { processName: 'code.exe', category: 'code' });
    r.svc.setInterest([CODE], r.clock.now());
    expect(r.svc.diagnostics().lastRejection).toBe('unsupportedApp');
    for (const exe of ['code.exe', 'firefox.exe', 'notepad.exe']) expect(r.svc.readsApp(exe)).toBe(false);
    expect(r.svc.debugInfo().helper.spawns).toBe(0);
    expect(r.h.ops('strip')).toHaveLength(0);
  });

  it('the terminalTabs opt-out (and tabStrips) switch Terminal off: never queried', () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } }, { settings: withOptOut('terminalTabs') });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM], r.clock.now());
    expect(r.svc.diagnostics().lastRejection).toBe('appOff');
    expect(r.svc.readsApp('windowsterminal.exe')).toBe(false);
    expect(r.svc.readsApp('msedge.exe')).toBe(true);
    expect(r.h.ops('strip')).toHaveLength(0);
  });

  it('turning the opt-out on drops a Terminal window that is being read', async () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM], r.clock.now());
    await waitForStrip(r, TERM);
    r.svc.updateSettings(withOptOut('terminalTabs'));
    r.svc.setInterest([TERM], r.clock.advance(300));
    expect(listed(r, TERM)).toBeNull();
    expect(r.svc.debugInfo().windows).toBe(0);
  });
});

describe('v1.2 kind cross-check', () => {
  it('drops a strip whose reader kind differs from the app rule (a Chromium strip for a Terminal window, a TabView one for Edge)', async () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal', kind: 'chromium' }), [EDGE]: { ...wireStrip({ browser: 'edge' }), kind: 'tabview' } } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.wins.set(EDGE);
    r.svc.setInterest([TERM, EDGE], r.clock.now());
    await eventually(() => expect(r.svc.debugInfo().readErrors).toBe(2));
    expect(r.svc.surfaces()).toEqual([]);
    expect(r.svc.diagnostics().lastRejection).toBe('kindMismatch');
    expect(r.log.entries.some((e) => e.msg === 'tab strip of an unexpected reader kind dropped')).toBe(true);
  });

  it('a protocol-1 strip without kind is Chromium: accepted for Edge, dropped for Terminal', async () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal', kind: null }), [EDGE]: wireStrip({ browser: 'edge' }) } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.wins.set(EDGE);
    r.svc.setInterest([TERM, EDGE], r.clock.now());
    await waitForStrip(r, EDGE);
    await eventually(() => expect(r.svc.debugInfo().readErrors).toBe(1));
    expect(listed(r, TERM)).toBeNull();
  });
});

describe('v1.2 Explorer limits (the shell is its process)', () => {
  const explorers = (r: Rig, ids: string[]) => ids.forEach((id, i) => r.wins.set(id, { ...EXPLORER, rect: { x: 100 + i * 10, y: 290, width: 1080, height: 665 } }));

  it('at most one Explorer request (read or subscription) per second for all its windows, and at most 3 Explorer windows', async () => {
    const strips = Object.fromEntries([EXPL, EXPL2, EXPL3, EXPL4].map((id) => [id, tabviewStrip({ app: 'explorer' })]));
    const r = rig({ strips }, { options: { enableExplorerTabs: true, maxInterest: 4 } });
    r.svc.start();
    explorers(r, [EXPL, EXPL2, EXPL3, EXPL4]);
    r.svc.setInterest([EXPL, EXPL2, EXPL3, EXPL4], r.clock.now());
    await eventually(() => expect(r.svc.debugInfo().readsDone).toBe(1));
    expect(r.svc.diagnostics().lastRejection).toBe('appLimit');
    expect(r.svc.debugInfo().windows).toBe(3);
    // 6 s in 100 ms host steps, letting the helper answer between steps.
    const sentAt: number[] = [r.clock.now()];
    for (let i = 0; i < 60; i++) {
      const before = r.svc.debugInfo().requestsByApp.explorer;
      r.svc.setInterest([EXPL, EXPL2, EXPL3], r.clock.advance(100));
      if (r.svc.debugInfo().requestsByApp.explorer > before) sentAt.push(r.clock.now());
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(sentAt.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < sentAt.length; i++) expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(1000);
    // Every Explorer request the helper received is counted (never more than one per second).
    const toExplorer = [...r.h.ops('strip'), ...r.h.ops('watch')].length;
    expect(toExplorer).toBeLessThanOrEqual(sentAt.length);
    expect(stripOps(r, EXPL4)).toBe(0);
  });

  it('reads Explorer last in a cycle: Edge first', async () => {
    const r = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }), [EDGE]: wireStrip({ browser: 'edge' }) } }, { options: { enableExplorerTabs: true, maxInFlight: 1 } });
    r.svc.start();
    r.wins.set(EXPL, EXPLORER);
    r.wins.set(EDGE);
    r.svc.setInterest([EXPL, EDGE], r.clock.now());
    await waitForStrip(r, EDGE);
    await eventually(() => expect(stripOps(r, EXPL)).toBe(1));
    expect(r.h.ops('strip').map((q) => q.hwnd)).toEqual([EDGE, EXPL]);
  });

  it('gives Explorer its own longer timeout: no stall at 1.5 or 2 s, quarantined at 2.5 s', async () => {
    const r = rig({ strips: {}, hangHwnds: [EXPL] }, { options: { enableExplorerTabs: true } });
    r.svc.start();
    r.wins.set(EXPL, EXPLORER);
    r.svc.setInterest([EXPL], r.clock.now());
    await eventually(() => expect(stripOps(r, EXPL)).toBe(1));
    // Steps shorter than the default timeout (a longer gap would count as a host stall).
    for (let i = 0; i < 4; i++) {
      r.svc.setInterest([EXPL], r.clock.advance(500));
      expect(r.svc.debugInfo().stalled).toBe(0);
    }
    r.svc.setInterest([EXPL], r.clock.advance(500));
    expect(r.svc.debugInfo().stalled).toBe(1);
    expect(r.svc.diagnostics().lastRejection).toBe('timeout');
  });
});

describe('v1.2 Explorer kill switch', () => {
  async function readExplorer(r: Rig): Promise<void> {
    r.svc.start();
    r.wins.set(EXPL, EXPLORER);
    r.svc.setInterest([EXPL], r.clock.now());
    await waitForStrip(r, EXPL);
  }

  it('the shell restarting within 10 min of an Explorer read turns Explorer off for the session (and drops its windows)', async () => {
    const r = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }), [TERM]: tabviewStrip({ app: 'terminal' }) } }, { options: { enableExplorerTabs: true } });
    await readExplorer(r);
    r.svc.noteTaskbarCreated(r.clock.advance(9 * 60_000));
    expect(r.svc.debugInfo().explorer).toMatchObject({ killSwitch: 'session', rule: 'off', strikes: 1 });
    expect(listed(r, EXPL)).toBeNull();
    expect(r.svc.readsApp('explorer.exe')).toBe(false);
    // Terminal keeps working.
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM, EXPL], r.clock.advance(100));
    await waitForStrip(r, TERM);
    expect(r.log.entries.some((e) => e.level === 'warn' && e.msg.startsWith('explorer restarted soon after'))).toBe(true);
  });

  it('a shell restart long after the last Explorer read (or with no Explorer read at all) changes nothing', async () => {
    const r = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }) } }, { options: { enableExplorerTabs: true } });
    r.svc.noteTaskbarCreated(r.clock.now());
    expect(r.svc.debugInfo().explorer.killSwitch).toBe('on');
    await readExplorer(r);
    r.svc.noteTaskbarCreated(r.clock.advance(10 * 60_000 + 1));
    expect(r.svc.debugInfo().explorer.killSwitch).toBe('on');
  });

  it('a second strike turns Explorer off until the next app version (uia-health.json)', async () => {
    const dir = tempDir('dcat-uia-health-');
    dirs.push(dir);
    const file = path.join(dir, 'uia-health.json');
    const first = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }) } }, { options: { enableExplorerTabs: true }, healthFile: file });
    await readExplorer(first);
    first.svc.noteTaskbarCreated(first.clock.advance(1000));
    expect(first.svc.debugInfo().explorer.killSwitch).toBe('session');
    // Next launch: allowed again (one strike), then the second strike.
    const second = rig({ strips: { [EXPL]: tabviewStrip({ app: 'explorer' }) } }, { options: { enableExplorerTabs: true }, healthFile: file });
    expect(second.svc.debugInfo().explorer.killSwitch).toBe('on');
    await readExplorer(second);
    second.svc.noteTaskbarCreated(second.clock.advance(1000));
    expect(second.svc.debugInfo().explorer).toMatchObject({ killSwitch: 'version', strikes: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ schema: 1, appVersion: '1.2.0', explorerStrikes: 2, explorerDisabled: true });
    // Same version: off from the start, even in test mode. A new version starts over.
    const third = rig({ strips: {} }, { options: { enableExplorerTabs: true }, healthFile: file });
    expect(third.svc.debugInfo().explorer.killSwitch).toBe('version');
    expect(third.svc.readsApp('explorer.exe')).toBe(false);
    const upgraded = rig({ strips: {} }, { options: { enableExplorerTabs: true }, healthFile: file, appVersion: '1.2.1' });
    expect(upgraded.svc.debugInfo().explorer.killSwitch).toBe('on');
  });
});

describe('v1.2 T6: a failed read keeps the last good strip for up to 10 s', () => {
  async function terminalWithStrip(): Promise<Rig> {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM], r.clock.now());
    await waitForStrip(r, TERM);
    expect(listed(r, TERM)?.confidence).toBe(1);
    // From now on the reader cannot find the strip (e.g. Terminal rebuilding its title bar).
    r.h.patchState({ strips: { [TERM]: { error: 'not-found' } } });
    await stepAndRead(r, 1000, [TERM]);
    return r;
  }

  it('lists the retained strip at confidence 0.5 falling to 0.3, then drops it after 10 s', async () => {
    const r = await terminalWithStrip();
    const s = listed(r, TERM);
    expect(s).toMatchObject({ x0: 299 + 100.5, x1: 299 + 583.5 });
    expect(s?.confidence).toBe(0.5);
    r.clock.advance(5000);
    expect(listed(r, TERM)?.confidence).toBe(0.4);
    r.clock.advance(4900);
    expect(listed(r, TERM)?.confidence).toBeCloseTo(0.3, 5);
    r.clock.advance(200);
    expect(listed(r, TERM)).toBeNull();
    expect(r.svc.debugInfo().retained).toBe(0);
  });

  it('a retained strip follows the window and stays clamped to its frame minus the caption buttons', async () => {
    const r = await terminalWithStrip();
    r.wins.set(TERM, { rect: { x: 399, y: 260, width: 1243, height: 624 } });
    r.clock.advance(300);
    expect(listed(r, TERM)).toMatchObject({ y: 260, x0: 399 + 100.5, x1: 399 + 583.5 });
    // 3 px narrower (within the tolerance): still listed, never beyond the caption buttons.
    r.wins.set(TERM, { rect: { x: 399, y: 260, width: 1240, height: 624 } });
    r.clock.advance(300);
    const s = listed(r, TERM)!;
    expect(s.x1).toBeLessThanOrEqual(399 + 1240 - 179);
  });

  it('drops the retained strip at once on a width change of more than 4 px or a maximize', async () => {
    const r = await terminalWithStrip();
    r.wins.set(TERM, { rect: { x: 299, y: 200, width: 1238, height: 624 } });
    r.clock.advance(300);
    expect(listed(r, TERM)).toBeNull();
    const m = await terminalWithStrip();
    m.wins.set(TERM, { maximized: true });
    m.clock.advance(300);
    expect(listed(m, TERM)).toBeNull();
    m.wins.set(TERM, { maximized: false });
    m.clock.advance(300);
    expect(listed(m, TERM)).toBeNull();
  });

  it('a good read ends the retention (full confidence again)', async () => {
    const r = await terminalWithStrip();
    r.h.patchState({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
    // The retry backoff after one failure is 2 s.
    await stepAndRead(r, 2000, [TERM]);
    expect(listed(r, TERM)?.confidence).toBe(1);
    r.clock.advance(15_000);
    expect(listed(r, TERM)).not.toBeNull();
  });

  describe('also after a read that timed out, whose window sits in quarantine unread (TAB-2)', () => {
    /** A strip is listed, then the window's UI thread blocks once for the 1.5 s read timeout, and recovers. */
    async function timedOut(): Promise<Rig> {
      const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
      r.svc.start();
      r.wins.set(TERM, TERMINAL);
      r.svc.setInterest([TERM], r.clock.now());
      await waitForStrip(r, TERM);
      r.h.patchState({ hangHwnds: [TERM] });
      r.svc.setInterest([TERM], r.clock.advance(1000));
      await eventually(() => expect(stripOps(r, TERM)).toBe(2));
      r.svc.setInterest([TERM], r.clock.advance(1500));
      await eventually(() => expect(r.svc.debugInfo().stalled).toBe(1));
      r.h.patchState({ hangHwnds: [] });
      return r;
    }

    it('lists the last good strip as retained, and drops it after 10 s although no read happens', async () => {
      const r = await timedOut();
      expect(listed(r, TERM)?.confidence).toBe(0.5);
      expect(r.svc.debugInfo().retained).toBe(1);
      r.clock.advance(9900);
      expect(listed(r, TERM)).not.toBeNull();
      r.clock.advance(200);
      expect(listed(r, TERM)).toBeNull();
      expect(r.svc.debugInfo()).toMatchObject({ retained: 0, stalled: 1 });
    });

    it('drops it at once on a width change of more than 4 px', async () => {
      const r = await timedOut();
      r.wins.set(TERM, { rect: { x: 299, y: 200, width: 943, height: 624 } });
      r.clock.advance(300);
      expect(listed(r, TERM)).toBeNull();
    });

    it('drops it at once on a maximize', async () => {
      const r = await timedOut();
      r.wins.set(TERM, { maximized: true });
      r.clock.advance(300);
      expect(listed(r, TERM)).toBeNull();
    });

    it('reads it again after the quarantine: full confidence, and the retention over', async () => {
      const r = await timedOut();
      r.clock.advance(15_000);
      expect(listed(r, TERM)).toBeNull();
      r.clock.advance(16_000);
      // The helper was replaced after the timeout: pumped until the replacement has read it.
      await eventually(() => {
        r.svc.setInterest([TERM], r.clock.advance(100));
        expect(listed(r, TERM)?.confidence).toBe(1);
      });
      expect(r.svc.debugInfo().retained).toBe(0);
    });

    it('a window the helper found hung keeps its listing, but not across a width change or a maximize', async () => {
      const hung = async (): Promise<Rig> => {
        const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
        r.svc.start();
        r.wins.set(TERM, TERMINAL);
        r.svc.setInterest([TERM], r.clock.now());
        await waitForStrip(r, TERM);
        r.h.patchState({ strips: { [TERM]: { error: 'hung' } } });
        await stepAndRead(r, 1000, [TERM]);
        expect(r.svc.debugInfo().stalled).toBe(1);
        return r;
      };
      const r = await hung();
      r.clock.advance(12_000);
      expect(listed(r, TERM), 'it cannot have moved while hung').not.toBeNull();
      r.wins.set(TERM, { rect: { x: 299, y: 200, width: 943, height: 624 } });
      r.clock.advance(300);
      expect(listed(r, TERM)).toBeNull();
      const m = await hung();
      m.wins.set(TERM, { maximized: true });
      m.clock.advance(300);
      expect(listed(m, TERM)).toBeNull();
    });
  });

  it('a strip of the wrong kind is never retained', async () => {
    const r = rig({ strips: { [TERM]: tabviewStrip({ app: 'terminal' }) } });
    r.svc.start();
    r.wins.set(TERM, TERMINAL);
    r.svc.setInterest([TERM], r.clock.now());
    await waitForStrip(r, TERM);
    r.h.patchState({ strips: { [TERM]: tabviewStrip({ app: 'terminal', kind: 'chromium' }) } });
    await stepAndRead(r, 1000, [TERM]);
    expect(listed(r, TERM)).toBeNull();
  });
});
