// REAL end-to-end check of the tab-strip pipeline against our own throwaway browser instance:
// real DesktopCatUia.exe, real UiaHelperClient and TabStripService, real Win32 describeWindow.
// Used by helper.real.test.ts (DESKTOP_CAT_REAL_BROWSER=1) and scripts/uia-probe.mjs.
// Never touches the user's own windows (see realBrowser.ts) and never sends input.
//
// Web-content accessibility guard (activation.ts): the active tab is a heavy page, every process
// of the instance is sampled before any UI Automation query and after the reads and the watch, and
// a process that grew past the threshold fails the probe. A positive control on a second throwaway
// instance makes the naive query the helper must never make; that one has to trip the same check,
// or the probe fails because the guard could not have seen an activation.
import type { ChildProcess } from 'node:child_process';
import type { Logger } from '../../../src/main/contracts';
import { createTabStripService, catExtentPx } from '../../../src/main/uia';
import { spawnUiaHelper, UiaHelperClient, type ChildProcessLike } from '../../../src/main/uia/client';
import type { HelperResponse, WireStrip } from '../../../src/main/uia/protocol';
import { createWin32Api } from '../../../src/main/win32';
import { defaultSettings } from '../../../src/shared/settings';
import type { SimEvent } from '../../../src/shared/sim';
import type { LedgeSurface } from '../../../src/shared/surfaces';
import { checkActivation, heavyPageUrl, settled, ACTIVATION_GROWTH_MB, type ActivationCheck, type ProcSample } from './activation';
import {
  closeBrowser,
  enablePerMonitorDpiAwareness,
  fileVersion,
  findBrowser,
  instancePids,
  launchBrowser,
  naiveTabItemQuery,
  openTabs,
  processStats,
  showWindow,
  SW_MAXIMIZE,
  SW_RESTORE,
  waitForBrowserWindow,
  type BrowserInstance,
  type BrowserKind,
  type CloseReport,
  type ProcessStats,
} from './realBrowser';

type Rect = { x: number; y: number; w: number; h: number };

export interface BrowserProbeResult {
  kind: BrowserKind;
  skipped: string | null;
  version: string | null;
  failures: string[];
  notes: string[];
  timeToWindowMs: number | null;
  firstStripMs: number | null;
  strip: Pick<WireStrip, 'frame' | 'dpi' | 'count' | 'leftButton' | 'newTab' | 'grab' | 'captions' | 'maximized' | 'vertical' | 'path'> & { tabs: Rect[]; selected: number } | null;
  surface: Pick<LedgeSurface, 'id' | 'y' | 'x0' | 'x1' | 'rest' | 'focusX'> | null;
  refresh: { n: number; helperMedianMs: number; helperMaxMs: number; roundTripMedianMs: number; roundTripMaxMs: number } | null;
  added: { launcherExit: number | null; launcherMs: number; eventMs: number | null; change: string | null; countAfter: number | null } | null;
  helperEvents: { selected: number; structure: number } | null;
  maximized: { reported: boolean; listedWhileMaximized: boolean; restored: boolean } | null;
  /** The service's helper (after the run) and the direct client's helper. */
  helperProcess: ProcessStats | null;
  directHelperProcess: ProcessStats | null;
  /** Web-content accessibility guard and its positive control (activation.ts). */
  activation: {
    thresholdMB: number;
    /** The heavy page (first tab) was the active one. */
    heavyTabSelected: boolean | null;
    /** Our instance before any UIA query vs after the strip reads, the service listing and the watch. */
    uia: ActivationSummary | null;
    /** A second instance before vs after the naive descendant query (must be detected). */
    control: (ActivationSummary & { tabItems: number[] | null; queryMs: number | null }) | null;
  };
  stdoutStrings: string[];
  close: CloseReport | null;
  controlClose: CloseReport | null;
}

export interface ActivationSummary {
  processes: number;
  maxGrowthMB: number;
  /** The process that grew most is the browser process (otherwise a renderer, GPU or utility process). */
  growthInBrowserProcess: boolean;
  /** Largest CPU time one process spent between the samples. */
  maxCpuMs: number;
  detected: boolean;
}

/** Tabs of every probe instance: the heavy page (active, first) and two blank ones. */
const probeUrls = (): string[] => [heavyPageUrl(), 'about:blank', 'about:blank'];
const PROBE_WINDOW = { x: 100, y: 100, width: 1100, height: 700 };

function summarize(c: ActivationCheck, browserPid: number): ActivationSummary {
  return {
    processes: c.deltas.length,
    maxGrowthMB: c.maxGrowthMB,
    growthInBrowserProcess: c.pid === browserPid,
    maxCpuMs: Math.max(0, ...c.deltas.map((d) => d.cpuMs)),
    detected: c.detected,
  };
}

const sampleOf = async (pids: Iterable<number>): Promise<ProcSample[]> => processStats([...pids]);

/**
 * Every process of the instance once it is idle: two samples 1 s apart with the same processes and
 * no process more than 2 MB apart (the heavy page has been built), at most ~20 tries.
 */
async function settledSample(inst: BrowserInstance): Promise<ProcSample[]> {
  let prev = await sampleOf(await instancePids(inst));
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const next = await sampleOf(await instancePids(inst));
    if (settled(prev, next, 2)) return next;
    prev = next;
  }
  return prev;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2;
};

/** Every string value in a JSON document (keys excluded). */
export function stringValues(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) stringValues(x, out);
}

/** Strings the helper may legitimately print: fixed protocol words, decimal HWNDs, exception type names. */
const PROTOCOL_WORDS = new Set([
  'class',
  'bfs',
  // Protocol 2: reader kinds (strip `kind`, ping `kinds`).
  'chromium',
  'tabview',
  'selected',
  'structure',
  'permonitorv2',
  'permonitor',
  'preset',
  'unaware',
  'bad-json',
  'bad-request',
  'bad-op',
  'too-long',
  'busy',
  'gone',
  'rejected',
  'hidden',
  'minimized',
  'hung',
  'not-found',
  'unavailable',
  'internal',
]);
export const allowedString = (x: string): boolean => PROTOCOL_WORDS.has(x) || /^[0-9]{1,20}$/.test(x) || /^[A-Za-z]{1,56}Exception$/.test(x);

export function consoleLogger(scope = 'probe', verbose = false): Logger {
  const make = (s: string): Logger => ({
    error: (msg, data) => console.error(`[${s}] ERROR ${msg}`, data ?? ''),
    warn: (msg, data) => console.warn(`[${s}] WARN ${msg}`, data ?? ''),
    info: (msg, data) => (verbose ? console.log(`[${s}] ${msg}`, data ?? '') : undefined),
    debug: () => undefined,
    child: (sub) => make(`${s}.${sub}`),
  });
  return make(scope);
}

export async function probeBrowser(kind: BrowserKind, helperPath: string, logger: Logger = consoleLogger()): Promise<BrowserProbeResult> {
  const r: BrowserProbeResult = {
    kind,
    skipped: null,
    version: null,
    failures: [],
    notes: [],
    timeToWindowMs: null,
    firstStripMs: null,
    strip: null,
    surface: null,
    refresh: null,
    added: null,
    helperEvents: null,
    maximized: null,
    helperProcess: null,
    directHelperProcess: null,
    activation: { thresholdMB: ACTIVATION_GROWTH_MB, heavyTabSelected: null, uia: null, control: null },
    stdoutStrings: [],
    close: null,
    controlClose: null,
  };
  const fail = (msg: string): void => {
    r.failures.push(msg);
  };
  const exe = findBrowser(kind);
  if (exe === null) {
    r.skipped = `${kind} is not installed`;
    return r;
  }
  enablePerMonitorDpiAwareness();
  r.version = await fileVersion(exe);
  const win32 = createWin32Api(logger);
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

  const t0 = Date.now();
  const inst = launchBrowser(kind, exe, { ...PROBE_WINDOW, urls: probeUrls() });
  let client: UiaHelperClient | null = null;
  let svc: ReturnType<typeof createTabStripService> | null = null;
  try {
    const win = await waitForBrowserWindow(inst);
    r.timeToWindowMs = Date.now() - t0;
    const hwnd = win.hwnd;
    // Before any UI Automation query: every process of the instance, idle.
    const before = await settledSample(inst);

    // ---------------------------------------------------------------- direct client
    client = new UiaHelperClient({
      helperPath,
      spawn: tap,
      logger,
      now: () => performance.now(),
      requestTimeoutMs: 1500,
      quitGraceMs: 2000,
      onEvent: () => undefined,
      onExit: (e) => {
        if (!e.expected) fail(`direct helper exited unexpectedly (code ${e.code}, error ${e.error})`);
      },
    });
    const c = client;
    const ask = async (req: Parameters<UiaHelperClient['request']>[0]): Promise<HelperResponse> => {
      const p = c.request(req, performance.now());
      const timer = setInterval(() => c.checkTimeouts(performance.now()), 100);
      try {
        return await p;
      } finally {
        clearInterval(timer);
      }
    };
    c.start();
    const pong = await ask({ op: 'ping' });
    if (!pong.ok || pong.dpi !== 'permonitorv2') fail(`ping: ${JSON.stringify(pong)}`);

    let strip: WireStrip | null = null;
    const tFirst = performance.now();
    for (let i = 0; i < 100; i++) {
      const res = await ask({ op: 'strip', hwnd });
      if (r.firstStripMs === null) r.firstStripMs = Math.round((performance.now() - tFirst) * 10) / 10;
      if (res.ok && res.strip && res.strip.count === 3) {
        strip = res.strip;
        break;
      }
      await sleep(100);
    }
    if (strip === null) {
      fail('no strip with 3 tabs within 10 s');
      return r;
    }
    const sel = strip.tabs.findIndex((t) => t.selected);
    r.strip = {
      frame: strip.frame,
      dpi: strip.dpi,
      count: strip.count,
      leftButton: strip.leftButton,
      newTab: strip.newTab,
      grab: strip.grab,
      captions: strip.captions,
      maximized: strip.maximized,
      vertical: strip.vertical,
      path: strip.path,
      tabs: strip.tabs.map((t) => ({ x: t.x - strip.frame.x, y: t.y - strip.frame.y, w: t.w, h: t.h })),
      selected: sel,
    };
    const f = strip.frame;
    if (strip.tabs.length !== 3) fail(`expected 3 tab rects, got ${strip.tabs.length}`);
    for (const t of strip.tabs) {
      if (t.y !== f.y || t.x < f.x || t.x + t.w > f.x + f.w || t.h < 20 || t.h > 120) fail(`implausible tab rect ${JSON.stringify(t)} for frame ${JSON.stringify(f)}`);
    }
    if (sel < 0) fail('no selected tab reported');
    r.activation.heavyTabSelected = sel === 0;
    if (sel !== 0) r.notes.push(`tab ${sel} is active, not the heavy page (the positive control shows whether the check still sees an activation)`);
    if (strip.captions === null || strip.captions.x < f.x + f.w / 2) fail('caption buttons not found on the right');
    if (strip.leftButton === null) fail('tab actions / tab search button not found');
    if (strip.newTab === null) fail('new-tab button not found');
    if (strip.maximized || strip.vertical) fail('window unexpectedly maximized/vertical');
    if (strip.path !== 'class') r.notes.push(`discovery used the ${strip.path} fallback`);

    const helperMs: number[] = [];
    const rtMs: number[] = [];
    for (let i = 0; i < 20; i++) {
      const tq = performance.now();
      const res = await ask({ op: 'strip', hwnd });
      rtMs.push(performance.now() - tq);
      if (res.ok && res.strip) helperMs.push(res.strip.ms);
    }
    const round = (x: number): number => Math.round(x * 100) / 100;
    r.refresh = {
      n: helperMs.length,
      helperMedianMs: round(median(helperMs)),
      helperMaxMs: round(Math.max(...helperMs)),
      roundTripMedianMs: round(median(rtMs)),
      roundTripMaxMs: round(Math.max(...rtMs)),
    };

    // ---------------------------------------------------------------- service
    const service = createTabStripService({ logger, settings: defaultSettings(), helperPath, describeWindow: (id) => win32.describeWindow(id), spawnHelper: tap });
    svc = service;
    service.start();
    const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        service.setInterest([hwnd], performance.now());
        if (cond()) return true;
        await sleep(50);
      }
      return cond();
    };
    const mine = (): LedgeSurface | undefined => service.surfaces().find((s) => s.ownerId === hwnd);
    if (!(await until(() => mine() !== undefined, 8000))) {
      fail(`service listed no strip (status ${service.status}, reason ${service.statusReason})`);
      return r;
    }
    const s = mine()!;
    r.surface = { id: s.id, y: s.y, x0: s.x0, x1: s.x1, rest: s.rest, focusX: s.focusX };
    const cat = catExtentPx(1, strip.dpi);
    const half = cat.width / 2;
    if (s.id !== `tabStrip:${hwnd}` || s.kind !== 'tabStrip') fail(`bad surface id/kind ${s.id} ${s.kind}`);
    if (s.y !== f.y) fail(`surface y ${s.y} != frame top ${f.y}`);
    if (s.x0 - half < f.x || s.x1 + half > f.x + f.w) fail('segment leaves the frame');
    if (strip.captions && s.x1 + half > strip.captions.x) fail('segment reaches the caption buttons');
    if (strip.newTab && s.x1 + half > strip.newTab.x) fail('segment reaches the new-tab button');
    if (strip.grab && s.x1 + half > strip.grab.x) fail('segment reaches the grab handle');
    if (strip.leftButton && s.x0 - half < strip.leftButton.x + strip.leftButton.w) fail('segment reaches the tab actions/search button');
    if (s.x1 - s.x0 < 200) fail(`segment implausibly short (${s.x1 - s.x0})`);

    // After the reads and the event subscription (before the extra tab, which adds a process and
    // grows the browser): the same processes again, once the browser had time to build a tree.
    if (!(await until(() => service.debugInfo().watched > 0, 3000))) r.notes.push('the service did not subscribe to events within 3 s');
    await sleep(2000);
    const uiaCheck = checkActivation(before, await sampleOf(before.map((p) => p.pid)));
    r.activation.uia = summarize(uiaCheck, win.pid);
    if (uiaCheck.detected) {
      fail(`web-content accessibility switched on? process ${uiaCheck.pid}${uiaCheck.pid === win.pid ? ' (browser)' : ''} grew by ${uiaCheck.maxGrowthMB} MB during the UIA reads (threshold ${uiaCheck.thresholdMB} MB)`);
    }

    // ---------------------------------------------------------------- one more tab
    service.drainEvents();
    const events: SimEvent[] = [];
    const tAdd = Date.now();
    const launched = await openTabs(inst, ['about:blank']);
    let eventMs: number | null = null;
    await until(() => {
      events.push(...service.drainEvents());
      const hit = events.some((e) => e.type === 'tabs.changed' && e.ownerId === hwnd && e.change === 'added');
      if (hit && eventMs === null) eventMs = Date.now() - tAdd;
      return hit;
    }, 8000);
    const change = events.find((e) => e.type === 'tabs.changed' && e.ownerId === hwnd);
    const after = await ask({ op: 'strip', hwnd });
    const countAfter = after.ok && after.strip ? after.strip.count : null;
    r.added = { launcherExit: launched.code, launcherMs: launched.ms, eventMs, change: change?.type === 'tabs.changed' ? change.change : null, countAfter };
    if (eventMs === null) fail(`no tabs.changed 'added' event within 8 s (got ${JSON.stringify(events)})`);
    if (countAfter !== 4) fail(`tab count after opening one tab: ${countAfter}`);
    await sleep(500);
    const dbg = service.debugInfo();
    r.helperEvents = { ...dbg.eventsIn };
    if (dbg.eventsIn.selected + dbg.eventsIn.structure === 0) r.notes.push('no UIA selected/structure event arrived (polling found the tab)');

    // ---------------------------------------------------------------- maximize / restore (our own window)
    showWindow(hwnd, SW_MAXIMIZE);
    let maxReported = false;
    for (let i = 0; i < 40 && !maxReported; i++) {
      await sleep(100);
      const res = await ask({ op: 'strip', hwnd });
      maxReported = res.ok && res.strip?.maximized === true;
    }
    await until(() => mine() === undefined, 3000);
    const listedWhileMax = mine() !== undefined;
    showWindow(hwnd, SW_RESTORE);
    let restored = false;
    for (let i = 0; i < 40 && !restored; i++) {
      await sleep(100);
      const res = await ask({ op: 'strip', hwnd });
      restored = res.ok && res.strip?.maximized === false;
    }
    const relisted = await until(() => mine() !== undefined, 5000);
    r.maximized = { reported: maxReported, listedWhileMaximized: listedWhileMax, restored: restored && relisted };
    if (!maxReported) fail('helper did not report the maximized state');
    if (listedWhileMax) fail('strip still listed while maximized');
    if (!restored || !relisted) fail('strip not back after restore');

    // ---------------------------------------------------------------- costs
    const helperPid = service.debugInfo().helper.pid;
    const helperStats = await processStats([helperPid ?? 0, client.pid ?? 0]);
    r.helperProcess = helperStats.find((p) => p.pid === helperPid) ?? null;
    r.directHelperProcess = helperStats.find((p) => p.pid === client?.pid) ?? null;
  } catch (e) {
    fail(`exception: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (svc) await svc.dispose();
    if (client) {
      client.quit();
      await client.waitForExit(3000);
    }
    r.close = await closeBrowser(inst);
    if (r.close.leftOver > 0) fail(`${r.close.leftOver} browser processes left over`);
    if (!r.close.profileRemoved) fail('temp profile not removed');
    win32.dispose();
    r.stdoutStrings = [...stdoutStrings].sort();
    const bad = r.stdoutStrings.filter((x) => !allowedString(x));
    if (bad.length > 0) fail(`helper printed ${bad.length} non-protocol string(s)`);
  }
  if (r.activation.uia !== null) await positiveControl(kind, exe, r, fail);
  return r;
}

/**
 * A second throwaway instance, same pages: the naive descendant query must trip the same check,
 * otherwise a pass of the guard above proves nothing.
 */
async function positiveControl(kind: BrowserKind, exe: string, r: BrowserProbeResult, fail: (msg: string) => void): Promise<void> {
  const inst = launchBrowser(kind, exe, { ...PROBE_WINDOW, urls: probeUrls() });
  try {
    const win = await waitForBrowserWindow(inst);
    const before = await settledSample(inst);
    const q = await naiveTabItemQuery(win.hwnd);
    await sleep(2000);
    const check = checkActivation(before, await sampleOf(before.map((p) => p.pid)));
    r.activation.control = { ...summarize(check, win.pid), tabItems: q?.counts ?? null, queryMs: q?.ms ?? null };
    if (q === null) fail('positive control: the naive UI Automation query failed');
    else if (!check.detected) {
      fail(`positive control: the naive query grew no process by more than ${check.thresholdMB} MB (max ${check.maxGrowthMB} MB), so the activation check could not have seen an activation`);
    }
  } catch (e) {
    fail(`positive control: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    r.controlClose = await closeBrowser(inst);
    if (r.controlClose.leftOver > 0) fail(`positive control: ${r.controlClose.leftOver} browser processes left over`);
    if (!r.controlClose.profileRemoved) fail('positive control: temp profile not removed');
  }
}
