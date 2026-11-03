// REAL check of the protocol-2 TabView reader (ADR 0003 §7.1, §16.2 PRV) against OUR OWN windows:
// a Windows Terminal window we launch with a unique name and self-ending tabs, and a File Explorer
// window we open on our own temp folder through the `opennewprocess` verb (never `explorer.exe
// <dir>`, which can add a tab to one of the user's windows; docs/research/v1.2/tab-discovery.md §5).
// Used by tabview.real.test.ts (DESKTOP_CAT_REAL_TABVIEW=1) and scripts/uia-probe.mjs --apps.
//
// Safety rules:
//  - Our window is the one HWND of the app's top-level class that appeared after our launch
//    (class + owning process image only; no title, tab name or content is ever read). Every
//    pre-existing window of the class is left alone and never queried.
//  - Terminal closes itself when its ping tabs end (no input, no close dialog). Explorer is closed
//    with WM_SYSCOMMAND/SC_CLOSE posted to our own window (a posted WM_CLOSE is ignored by a tabbed
//    frame); the Explorer host process is never killed, its exit is only observed.
//  - Explorer requests stay within the shipped rule's limits: at most one request per second.
//  - Owner memory is sampled before the first UI Automation call and after the reads and the watch.
import type { ChildProcess } from 'node:child_process';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import type { Logger } from '../../../src/main/contracts';
import { createTabStripService } from '../../../src/main/uia';
import { spawnUiaHelper, UiaHelperClient, type ChildProcessLike } from '../../../src/main/uia/client';
import { fromWireRect, stripKind, type HelperEvent, type HelperResponse, type WireStrip } from '../../../src/main/uia/protocol';
import { catExtentPx, computeTabStripSegment } from '../../../src/main/uia/segment';
import { createWin32Api } from '../../../src/main/win32';
import { loadWin32Native, type Hwnd } from '../../../src/main/win32/native';
import { defaultSettings } from '../../../src/shared/settings';
import type { LedgeSurface } from '../../../src/shared/surfaces';
import { allowedString, consoleLogger, stringValues } from './probe';
import { enablePerMonitorDpiAwareness, processStats, type ProcessStats } from './realBrowser';

export type TabViewApp = 'terminal' | 'explorer';

const APP_CLASS: Record<TabViewApp, string> = { terminal: 'CASCADIA_HOSTING_WINDOW_CLASS', explorer: 'CabinetWClass' };
const APP_IMAGE: Record<TabViewApp, string> = { terminal: 'windowsterminal.exe', explorer: 'explorer.exe' };
/** Owner growth (private MB) the acceptance allows across our reads and watch (ADR 0003 §16.2 PRV). */
export const OWNER_GROWTH_LIMIT_MB = 2;

type WRect = { x: number; y: number; w: number; h: number };

export interface TabViewProbeResult {
  app: TabViewApp;
  skipped: string | null;
  failures: string[];
  notes: string[];
  /** Windows of the app's class that existed before our launch (count only; never queried). */
  preexistingWindows: number;
  /** Our window's process also hosts windows that existed before (Terminal hosts all windows in one process). */
  sharedOwner: boolean | null;
  /** Explorer: our window belongs to the shell's own process (the taskbar's). */
  ownerIsShell: boolean | null;
  timeToWindowMs: number | null;
  ping: { version: number | null; kinds: string[] } | null;
  firstStripMs: number | null;
  strip: (Pick<WireStrip, 'dpi' | 'count' | 'maximized' | 'vertical' | 'path'> & { kind: string; frame: WRect; container: WRect | null; tabs: WRect[]; newTab: WRect | null; grab: WRect | null; captions: WRect | null; selected: number }) | null;
  /** computeTabStripSegment on the REAL rects, frame-relative px. */
  segment: { ok: boolean; reason: string | null; x0: number | null; x1: number | null; rest: { x0: number; x1: number } | null; focusX: number | null } | null;
  refresh: { n: number; helperMedianMs: number; helperMaxMs: number; roundTripMedianMs: number; roundTripMaxMs: number; minGapMs: number } | null;
  events: { seconds: number; selected: number; structure: number; perSecond: number } | null;
  /** Terminal: a tab added to our window (events seen through the tab-list subscription, count after). */
  added: { events: number; firstEventMs: number | null; countAfter: number | null } | null;
  owner: { before: ProcessStats | null; after: ProcessStats | null; growthMB: number | null } | null;
  helperProcess: ProcessStats | null;
  /** TabStripService with the real Win32 describeWindow: a 'tabview' strip listed for our window. */
  service: { listed: boolean; surface: Pick<LedgeSurface, 'y' | 'x0' | 'x1'> | null; byKind: Record<string, number> | null; reads: number } | null;
  stdoutStrings: string[];
  close: { by: string; windowGone: boolean; ms: number; ownerExited: boolean | null; folderRemoved: boolean | null } | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
};
const round2 = (v: number): number => Math.round(v * 100) / 100;

function powershell(script: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
  });
}

type PostFn = (h: Hwnd, msg: number, w: number, l: number) => number;
let posting: PostFn | null = null;
function postMessage(h: Hwnd, msg: number, w: number, l: number): boolean {
  if (posting === null) {
    const user32 = koffi.load('user32.dll');
    posting = user32.func('int __stdcall PostMessageW(void *h, uint32_t msg, uintptr_t w, intptr_t l)') as unknown as PostFn;
  }
  return posting(h, msg, w, l) !== 0;
}
const WM_SYSCOMMAND = 0x0112;
const SC_CLOSE = 0xf060;

interface Win {
  hwnd: string;
  pid: number;
}

/** Visible top-level windows of a class (class + PID only). */
function windowsOfClass(cls: string): Win[] {
  const n = loadWin32Native();
  const out: Win[] = [];
  for (const h of n.enumTopLevelWindows()) {
    if (n.getClassName(h) !== cls) continue;
    out.push({ hwnd: h.toString(), pid: n.getWindowProcessId(h) });
  }
  return out;
}

function imageBase(pid: number): string {
  const p = loadWin32Native().getProcessImagePath(pid);
  return p ? path.basename(p).toLowerCase() : '';
}

function shellPid(): number | null {
  const tray = windowsOfClass('Shell_TrayWnd')[0];
  return tray ? tray.pid : null;
}

async function waitForNewWindow(app: TabViewApp, before: ReadonlySet<string>, timeoutMs: number): Promise<Win | null> {
  const t0 = Date.now();
  const n = loadWin32Native();
  while (Date.now() - t0 < timeoutMs) {
    for (const w of windowsOfClass(APP_CLASS[app])) {
      if (before.has(w.hwnd)) continue;
      const h = BigInt(w.hwnd);
      if (!n.isWindowVisible(h)) continue;
      if (imageBase(w.pid) !== APP_IMAGE[app]) continue;
      return w;
    }
    await sleep(100);
  }
  return null;
}

function windowGone(hwnd: string): boolean {
  const n = loadWin32Native();
  const h = BigInt(hwnd);
  return !n.isWindow(h) || !n.isWindowVisible(h);
}

async function waitGone(hwnd: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (windowGone(hwnd)) return true;
    await sleep(250);
  }
  return windowGone(hwnd);
}

async function processAlive(pid: number): Promise<boolean> {
  const out = await powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`, 15_000);
  return out?.trim() === 'yes';
}

const rel = (r: WRect | null, f: WRect): WRect | null => (r === null ? null : { x: r.x - f.x, y: r.y - f.y, w: r.w, h: r.h });

function summarizeStrip(s: WireStrip): NonNullable<TabViewProbeResult['strip']> {
  const f = s.frame;
  return {
    kind: stripKind(s),
    frame: f,
    dpi: s.dpi,
    count: s.count,
    container: rel(s.container, f),
    tabs: s.tabs.map((t) => ({ x: t.x - f.x, y: t.y - f.y, w: t.w, h: t.h })),
    selected: s.tabs.findIndex((t) => t.selected),
    newTab: rel(s.newTab, f),
    grab: rel(s.grab, f),
    captions: rel(s.captions, f),
    maximized: s.maximized,
    vertical: s.vertical,
    path: s.path,
  };
}

function segmentOf(s: WireStrip): NonNullable<TabViewProbeResult['segment']> {
  const g = {
    frame: fromWireRect(s.frame),
    work: s.work ? fromWireRect(s.work) : null,
    dpi: s.dpi,
    container: s.container ? fromWireRect(s.container) : null,
    tabs: s.tabs.map((t) => ({ x: t.x, y: t.y, width: t.w, height: t.h, selected: t.selected })),
    count: s.count,
    leftButton: s.leftButton ? fromWireRect(s.leftButton) : null,
    newTab: s.newTab ? fromWireRect(s.newTab) : null,
    grab: s.grab ? fromWireRect(s.grab) : null,
    captions: s.captions ? fromWireRect(s.captions) : null,
    maximized: s.maximized,
    vertical: s.vertical,
  };
  const seg = computeTabStripSegment(g, catExtentPx(1, s.dpi));
  const fx = s.frame.x;
  if (!seg.ok) return { ok: false, reason: seg.reason, x0: null, x1: null, rest: null, focusX: null };
  return { ok: true, reason: null, x0: round2(seg.x0 - fx), x1: round2(seg.x1 - fx), rest: seg.rest ? { x0: round2(seg.rest.x0 - fx), x1: round2(seg.rest.x1 - fx) } : null, focusX: seg.focusX === null ? null : round2(seg.focusX - fx) };
}

/** Launches our own window of the app; returns how to close it. */
async function launch(app: TabViewApp, r: TabViewProbeResult): Promise<{ win: Win; folder: string | null; name: string | null; wt: string | null } | null> {
  const before = new Set(windowsOfClass(APP_CLASS[app]).map((w) => w.hwnd));
  r.preexistingWindows = before.size;
  const t0 = Date.now();
  let folder: string | null = null;
  let windowName: string | null = null;
  let wtPath: string | null = null;
  if (app === 'terminal') {
    const wt = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'wt.exe');
    // An app execution alias (a reparse point stat cannot follow): lstat sees it.
    let present: boolean;
    try {
      fs.lstatSync(wt);
      present = true;
    } catch {
      present = false;
    }
    if (!present) {
      r.skipped = 'Windows Terminal (wt.exe) is not installed';
      return null;
    }
    const name = `dcat-prv-${Math.random().toString(36).slice(2, 10)}`;
    windowName = name;
    wtPath = wt;
    // Two self-ending tabs (no "close all tabs?" dialog): the window closes itself afterwards.
    const ping = ['cmd', '/c', 'ping', '-n', '60', '127.0.0.1'];
    const p = spawn(wt, ['-w', name, '--pos', '300,200', '--size', '100,24', ...ping, ';', 'new-tab', ...ping], { stdio: 'ignore', windowsHide: false });
    p.on('error', () => undefined);
  } else {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-prv-explorer-'));
    if (!/^dcat-prv-explorer-[A-Za-z0-9]{6}$/.test(path.basename(folder))) throw new Error('unexpected temp folder name');
    // A new Explorer process for our own folder (never `explorer.exe <dir>`: it can open as a tab of a user window).
    const out = await powershell(`Start-Process -FilePath '${folder.replace(/'/g, "''")}' -Verb opennewprocess; 'ok'`, 30_000);
    if (out?.trim() !== 'ok') r.notes.push('Start-Process -Verb opennewprocess did not confirm');
  }
  const win = await waitForNewWindow(app, before, 30_000);
  if (win === null) {
    r.failures.push(`no new ${APP_CLASS[app]} window within 30 s`);
    if (folder) fs.rmSync(folder, { recursive: true, force: true });
    return null;
  }
  r.timeToWindowMs = Date.now() - t0;
  r.sharedOwner = windowsOfClass(APP_CLASS[app]).some((w) => w.pid === win.pid && before.has(w.hwnd));
  if (app === 'explorer') r.ownerIsShell = shellPid() === win.pid;
  return { win, folder, name: windowName, wt: wtPath };
}

async function close(app: TabViewApp, win: Win, folder: string | null, r: TabViewProbeResult): Promise<void> {
  const t0 = Date.now();
  let by = 'self';
  let gone: boolean;
  if (app === 'terminal') {
    // The ping tabs end by themselves (about 60 s after the launch).
    gone = await waitGone(win.hwnd, 100_000);
  } else {
    by = 'SC_CLOSE';
    postMessage(BigInt(win.hwnd), WM_SYSCOMMAND, SC_CLOSE, 0);
    gone = await waitGone(win.hwnd, 15_000);
  }
  let folderRemoved: boolean | null = null;
  if (folder) {
    folderRemoved = false;
    for (let i = 0; i < 20 && !folderRemoved; i++) {
      try {
        fs.rmSync(folder, { recursive: true, force: true });
        folderRemoved = !fs.existsSync(folder);
      } catch {
        await sleep(250);
      }
    }
  }
  // Explorer: never killed; exit only observed. Terminal: one process may host other windows.
  const ownerExited = r.sharedOwner || r.ownerIsShell ? null : !(await processAlive(win.pid));
  r.close = { by, windowGone: gone, ms: Date.now() - t0, ownerExited, folderRemoved };
  if (!gone) r.failures.push('our window did not close');
}

export async function probeTabView(app: TabViewApp, helperPath: string, logger: Logger = consoleLogger(`probe.${app}`), opts: { service?: boolean } = {}): Promise<TabViewProbeResult> {
  const r: TabViewProbeResult = {
    app,
    skipped: null,
    failures: [],
    notes: [],
    preexistingWindows: 0,
    sharedOwner: null,
    ownerIsShell: null,
    timeToWindowMs: null,
    ping: null,
    firstStripMs: null,
    strip: null,
    segment: null,
    refresh: null,
    events: null,
    added: null,
    owner: null,
    helperProcess: null,
    service: null,
    stdoutStrings: [],
    close: null,
  };
  const fail = (m: string): void => {
    r.failures.push(m);
  };
  enablePerMonitorDpiAwareness();
  // Explorer stays within the shipped rule's limit: one request per second.
  const gapMs = app === 'explorer' ? 1050 : 100;
  const stdoutStrings = new Set<string>();
  const tap = (p: string): ChildProcessLike => {
    const child = spawnUiaHelper(p) as ChildProcess;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          stringValues(JSON.parse(line), stdoutStrings);
        } catch {
          stdoutStrings.add(`<unparsable line of ${line.length} chars>`);
        }
        nl = buf.indexOf('\n');
      }
    });
    return child;
  };

  const launched = await launch(app, r);
  if (launched === null) return r;
  const { win, folder } = launched;
  const hwnd = win.hwnd;
  let client: UiaHelperClient | null = null;
  const events: HelperEvent[] = [];
  try {
    await sleep(app === 'explorer' ? 2500 : 1500); // let the new window finish building its UI
    const before = (await processStats([win.pid]))[0] ?? null;
    client = new UiaHelperClient({
      helperPath,
      spawn: tap,
      logger,
      now: () => performance.now(),
      requestTimeoutMs: 3000,
      quitGraceMs: 2000,
      onEvent: (ev) => events.push(ev),
      onExit: () => undefined,
    });
    client.start();
    const req = async (q: Parameters<UiaHelperClient['request']>[0]): Promise<{ r: HelperResponse; ms: number }> => {
      const t = performance.now();
      const p = client!.request(q, t);
      const timer = setInterval(() => client?.checkTimeouts(performance.now()), 100);
      try {
        const res = await p;
        return { r: res, ms: performance.now() - t };
      } finally {
        clearInterval(timer);
      }
    };
    const pong = await req({ op: 'ping' });
    r.ping = pong.r.ok ? { version: pong.r.version ?? null, kinds: [...(pong.r.kinds ?? [])] } : { version: null, kinds: [] };
    if (r.ping.version !== 2) fail(`helper protocol ${r.ping.version} != 2`);
    if (!r.ping.kinds.includes('tabview')) fail('helper does not list the tabview reader');

    let lastAt = performance.now();
    const paced = async (q: Parameters<UiaHelperClient['request']>[0]): Promise<{ r: HelperResponse; ms: number }> => {
      const wait = gapMs - (performance.now() - lastAt);
      if (wait > 0) await sleep(wait);
      lastAt = performance.now();
      return req(q);
    };
    const first = await paced({ op: 'strip', hwnd });
    r.firstStripMs = round2(first.ms);
    if (!first.r.ok || !first.r.strip) {
      fail(`first strip: ${first.r.ok ? 'no strip' : first.r.error}`);
      return r;
    }
    r.strip = summarizeStrip(first.r.strip);
    r.segment = segmentOf(first.r.strip);
    if (r.strip.kind !== 'tabview') fail(`strip kind ${r.strip.kind} != tabview`);
    if (!r.segment.ok) fail(`segment not ok: ${r.segment.reason}`);
    const helperMs: number[] = [];
    const roundTrip: number[] = [];
    const gaps: number[] = [];
    const n = app === 'explorer' ? 10 : 20;
    // Gaps between consecutive request starts (the first refresh follows the first strip).
    let prevAt = lastAt;
    for (let i = 0; i < n; i++) {
      const x = await paced({ op: 'strip', hwnd });
      gaps.push(lastAt - prevAt);
      prevAt = lastAt;
      if (!x.r.ok || !x.r.strip) {
        fail(`refresh ${i}: ${x.r.ok ? 'no strip' : x.r.error}`);
        continue;
      }
      helperMs.push(x.r.strip.ms);
      roundTrip.push(x.ms);
    }
    r.refresh = {
      n: helperMs.length,
      helperMedianMs: round2(median(helperMs)),
      helperMaxMs: round2(Math.max(0, ...helperMs)),
      roundTripMedianMs: round2(median(roundTrip)),
      roundTripMaxMs: round2(Math.max(0, ...roundTrip)),
      minGapMs: Math.round(Math.min(...gaps)),
    };
    // Event rate while the tabs run (Terminal: ping prints every second in both tabs).
    const watch = await paced({ op: 'watch', hwnds: [hwnd] });
    if (!watch.r.ok || (watch.r.failed?.length ?? 0) > 0) fail('watch failed');
    const evSeconds = app === 'explorer' ? 5 : 10;
    events.length = 0;
    await sleep(evSeconds * 1000);
    const sel = events.filter((e) => e.event === 'selected').length;
    const str = events.filter((e) => e.event === 'structure').length;
    r.events = { seconds: evSeconds, selected: sel, structure: str, perSecond: round2((sel + str) / evSeconds) };
    if (r.events.perSecond > 2) fail(`helper events ${r.events.perSecond}/s > 2/s`);
    // Owner memory across every UIA phase so far (before adding a tab: a new terminal tab costs its
    // own ~23 MB with or without UI Automation; docs/research/v1.2/tab-discovery.md §4).
    await sleep(1000);
    const after = (await processStats([win.pid]))[0] ?? null;
    const growth = before && after ? round2(after.privateMB - before.privateMB) : null;
    r.owner = { before, after, growthMB: growth };
    if (growth === null) fail('owner memory not measured');
    else if (growth > OWNER_GROWTH_LIMIT_MB) fail(`owner grew ${growth} MB > ${OWNER_GROWTH_LIMIT_MB} MB`);
    if (app === 'terminal' && launched.name !== null) {
      // A tab added to OUR named window (self-ending): the subscription on the tab list must see it.
      events.length = 0;
      const t0 = performance.now();
      const wt = spawn(launched.wt!, ['-w', launched.name, 'new-tab', 'cmd', '/c', 'ping', '-n', '25', '127.0.0.1'], { stdio: 'ignore', windowsHide: false });
      wt.on('error', () => undefined);
      let firstEventMs: number | null = null;
      while (performance.now() - t0 < 4000) {
        if (firstEventMs === null && events.length > 0) firstEventMs = Math.round(performance.now() - t0);
        await sleep(50);
      }
      const read = await paced({ op: 'strip', hwnd });
      r.added = { events: events.length, firstEventMs, countAfter: read.r.ok && read.r.strip ? read.r.strip.count : null };
      if (firstEventMs === null) fail('no helper event for an added tab');
      if (r.added.countAfter !== 3) fail(`tab count after adding ${r.added.countAfter} != 3`);
    }
    await paced({ op: 'watch', hwnds: [] });
    const pid = client.pid;
    r.helperProcess = pid ? ((await processStats([pid]))[0] ?? null) : null;
    client.quit();
    await client.waitForExit(3000);
    client = null;

    if (opts.service !== false) {
      // The main-side path: allow-list (Explorer behind its soak gate: enabled here for the probe only),
      // kind cross-check, segment, listing.
      const win32 = createWin32Api(logger);
      const svc = createTabStripService({
        logger,
        settings: defaultSettings(),
        helperPath,
        describeWindow: (id) => win32.describeWindow(id),
        spawnHelper: tap,
        options: { autoPumpMs: 0, enableExplorerTabs: app === 'explorer' },
      });
      svc.start();
      try {
        const t0 = Date.now();
        let listed: LedgeSurface | null = null;
        while (Date.now() - t0 < 12_000 && listed === null) {
          svc.setInterest([hwnd], performance.now());
          await sleep(app === 'explorer' ? 1100 : 300);
          listed = svc.surfaces().find((s) => s.ownerId === hwnd) ?? null;
        }
        const d = svc.diagnostics();
        r.service = { listed: listed !== null, surface: listed ? { y: listed.y - win32Frame(win32, hwnd).y, x0: round2(listed.x0 - win32Frame(win32, hwnd).x), x1: round2(listed.x1 - win32Frame(win32, hwnd).x) } : null, byKind: (d.byKind as Record<string, number> | undefined) ?? null, reads: d.reads };
        if (!listed) fail('the service listed no strip for our window');
      } finally {
        await svc.dispose();
        win32.dispose();
      }
    }
  } catch (e) {
    fail(`probe error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (client) {
      client.quit();
      await client.waitForExit(3000);
    }
    r.stdoutStrings = [...stdoutStrings].sort();
    const bad = r.stdoutStrings.filter((x) => !allowedString(x));
    if (bad.length > 0) fail(`helper printed ${bad.length} non-protocol string(s)`);
    await close(app, win, folder, r);
  }
  return r;
}

function win32Frame(win32: ReturnType<typeof createWin32Api>, hwnd: string): { x: number; y: number } {
  const rect = win32.getWindowRect(hwnd);
  return rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
}
