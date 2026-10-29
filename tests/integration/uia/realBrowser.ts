// Throwaway Edge/Chrome instances for the REAL tab-strip checks (helper.real.test.ts and
// scripts/uia-probe.mjs). Only processes this module launched are ever touched:
//  - each instance gets a fresh temp --user-data-dir with a random name (a separate browser
//    instance from any the user has open). Every process of the instance carries that path on its
//    command line, so "ours" = browser processes whose command line contains it (a WMI filter
//    evaluated by Windows; the launcher PID itself exits after handing off, so PID trees are not
//    reliable, and a recycled PID never carries our path);
//  - windows are found by class name + owning PID only (no titles are read);
//  - shutdown posts WM_CLOSE to our own windows, waits, and only then force-ends what is left of
//    our own processes, one PID at a time; the profile directory is deleted afterwards.
// No mouse or keyboard input is ever sent. Window state changes (maximize/restore) use
// ShowWindowAsync on our own window.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import { loadWin32Native, type Hwnd } from '../../../src/main/win32/native';

export type BrowserKind = 'edge' | 'chrome';

export const BROWSER_EXE_NAMES: Record<BrowserKind, string> = { edge: 'msedge.exe', chrome: 'chrome.exe' };

/** Fixed install locations only (no registry or PATH lookups). */
export function findBrowser(kind: BrowserKind): string | null {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const candidates =
    kind === 'edge'
      ? [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function powershell(script: string, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Product version of an executable (file version resource), or null. */
export async function fileVersion(exe: string): Promise<string | null> {
  const out = await powershell(`(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`, 20_000);
  return out?.trim() || null;
}

// ------------------------------------------------------------------ native bits

interface ExtraNative {
  setPerMonitorDpiAware(): boolean;
  postClose(h: Hwnd): boolean;
  showWindow(h: Hwnd, cmd: number): boolean;
}

let extra: ExtraNative | null = null;

function native(): ExtraNative {
  if (extra) return extra;
  const user32 = koffi.load('user32.dll');
  const SetDpi = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t value)') as (v: number) => number;
  const PostMessageW = user32.func('int __stdcall PostMessageW(void *h, uint32_t msg, uintptr_t w, intptr_t l)') as (h: Hwnd, m: number, w: number, l: number) => number;
  const ShowWindowAsync = user32.func('int __stdcall ShowWindowAsync(void *h, int cmd)') as (h: Hwnd, cmd: number) => number;
  extra = {
    setPerMonitorDpiAware: () => SetDpi(-4) !== 0,
    postClose: (h) => PostMessageW(h, 0x0010, 0, 0) !== 0,
    showWindow: (h, cmd) => ShowWindowAsync(h, cmd) !== 0,
  };
  return extra;
}

/** Call before any geometry is read so this process sees physical px (like the helper). */
export function enablePerMonitorDpiAwareness(): boolean {
  return native().setPerMonitorDpiAware();
}

export const SW_MAXIMIZE = 3;
export const SW_RESTORE = 9;

// ------------------------------------------------------------------ instances

export interface BrowserInstance {
  kind: BrowserKind;
  exe: string;
  profileDir: string;
  /** Random directory name: the marker on every command line of this instance. */
  marker: string;
  launcherPid: number;
}

export interface LaunchOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  urls: string[];
}

function baseArgs(inst: { profileDir: string }): string[] {
  return [
    `--user-data-dir=${inst.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
  ];
}

export function launchBrowser(kind: BrowserKind, exe: string, o: LaunchOptions): BrowserInstance {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `dcat-uia-${kind}-`));
  const marker = path.basename(profileDir);
  if (!/^dcat-uia-(edge|chrome)-[A-Za-z0-9]{6}$/.test(marker)) throw new Error('unexpected temp profile name');
  const args = [...baseArgs({ profileDir }), `--window-position=${o.x},${o.y}`, `--window-size=${o.width},${o.height}`, ...o.urls];
  const launcher = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  launcher.on('error', () => undefined);
  if (launcher.pid === undefined) throw new Error(`could not start ${kind}`);
  return { kind, exe, profileDir, marker, launcherPid: launcher.pid };
}

/** PIDs of this instance: browser processes whose command line contains our unique profile name. */
export async function instancePids(inst: BrowserInstance): Promise<Set<number>> {
  const filter = `Name='${BROWSER_EXE_NAMES[inst.kind]}' AND CommandLine LIKE '%${inst.marker}%'`;
  const out = await powershell(`Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { $_.ProcessId }`);
  const pids = new Set<number>();
  for (const line of (out ?? '').split(/\r?\n/)) {
    const n = Number(line.trim());
    if (line.trim() !== '' && Number.isInteger(n) && n > 0) pids.add(n);
  }
  return pids;
}

export interface BrowserWindow {
  hwnd: string;
  pid: number;
  frame: { x: number; y: number; width: number; height: number };
}

/** Visible top-level Chrome_WidgetWin_1 windows owned by our processes (class name + PID only). */
export function windowsOf(pids: ReadonlySet<number>): BrowserWindow[] {
  const n = loadWin32Native();
  const out: BrowserWindow[] = [];
  for (const h of n.enumTopLevelWindows()) {
    const pid = n.getWindowProcessId(h);
    if (!pids.has(pid)) continue;
    if (!n.isWindowVisible(h) || n.getClassName(h) !== 'Chrome_WidgetWin_1') continue;
    const r = n.getExtendedFrameBounds(h) ?? n.getWindowRect(h);
    if (r === null) continue;
    out.push({ hwnd: h.toString(), pid, frame: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } });
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The instance's main browser window (largest of ours), waiting up to timeoutMs. */
export async function waitForBrowserWindow(inst: BrowserInstance, timeoutMs = 30_000): Promise<BrowserWindow> {
  const t0 = Date.now();
  let pids = new Set<number>();
  let pidsAt = 0;
  while (Date.now() - t0 < timeoutMs) {
    // Our PID set changes rarely; refresh it about once a second, enumerate windows often.
    if (pids.size === 0 || Date.now() - pidsAt > 1000) {
      pids = await instancePids(inst);
      pidsAt = Date.now();
    }
    const wins = windowsOf(pids).filter((w) => w.frame.width >= 400 && w.frame.height >= 300);
    wins.sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height);
    if (wins[0]) return wins[0];
    await sleep(50);
  }
  throw new Error(`${inst.kind}: no browser window within ${timeoutMs} ms`);
}

/** Opens URLs as new tabs in the running instance (a second launch with the same profile). Resolves with the launcher's exit code. */
export function openTabs(inst: BrowserInstance, urls: string[]): Promise<{ code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    // A hand-off launcher: it passes the URLs to the running instance and exits.
    const p = spawn(inst.exe, [...baseArgs(inst), ...urls], { stdio: 'ignore', windowsHide: false });
    p.on('error', () => resolve({ code: null, ms: Date.now() - t0 }));
    p.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
  });
}

export function showWindow(hwnd: string, cmd: number): boolean {
  return native().showWindow(BigInt(hwnd), cmd);
}

export interface ProcessStats {
  pid: number;
  workingSetMB: number;
  privateMB: number;
  cpuMs: number;
}

/** Memory/CPU of OUR processes (Get-Process by id). */
export async function processStats(pids: number[]): Promise<ProcessStats[]> {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (list.length === 0) return [];
  const out = await powershell(
    `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1} {2} {3}' -f $_.Id, $_.WorkingSet64, $_.PrivateMemorySize64, [int64]$_.TotalProcessorTime.TotalMilliseconds }`,
  );
  const stats: ProcessStats[] = [];
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+) (\d+)$/.exec(line.trim());
    if (!m) continue;
    const mb = (v: string | undefined): number => Math.round((Number(v) / 2 ** 20) * 10) / 10;
    stats.push({ pid: Number(m[1]), workingSetMB: mb(m[2]), privateMB: mb(m[3]), cpuMs: Number(m[4]) });
  }
  return stats;
}

export interface CloseReport {
  closedWindows: number;
  exitedGracefully: boolean;
  forceEnded: number;
  leftOver: number;
  profileRemoved: boolean;
}

/** WM_CLOSE to our windows, wait, force-end only what remains of OUR processes, delete the profile. */
export async function closeBrowser(inst: BrowserInstance, graceMs = 15_000): Promise<CloseReport> {
  let closed = 0;
  let left = await instancePids(inst);
  try {
    for (const w of windowsOf(left)) if (native().postClose(BigInt(w.hwnd))) closed++;
  } catch {
    /* fall through to the forced path */
  }
  const t0 = Date.now();
  while (left.size > 0 && Date.now() - t0 < graceMs) {
    await sleep(500);
    left = await instancePids(inst);
  }
  const graceful = left.size === 0;
  let forced = 0;
  for (const pid of left) {
    // One PID at a time (no /T): only processes verified as ours are ended.
    await new Promise<void>((resolve) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 15_000 }, (err) => {
        if (!err) forced++;
        resolve();
      });
    });
  }
  if (forced > 0) await sleep(500);
  const leftOver = (await instancePids(inst)).size;
  let removed = false;
  for (let i = 0; i < 20 && !removed; i++) {
    try {
      fs.rmSync(inst.profileDir, { recursive: true, force: true });
      removed = !fs.existsSync(inst.profileDir);
    } catch {
      await sleep(250);
    }
  }
  return { closedWindows: closed, exitedGracefully: graceful, forceEnded: forced, leftOver, profileRemoved: removed };
}
