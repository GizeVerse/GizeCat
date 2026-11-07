// Own windows for the v1.2 REAL E2E (ADR 0003 §15.4): every window these helpers open belongs to
// a process this suite started, is identified by a window-list diff (HWNDs that appeared after the
// launch, by class name and owner PID; never a title), and is the only kind of window they move,
// re-assert as topmost or close. The user's windows are never touched; every lively spec also
// calls restrictSurfacesToPids([own pids]) so they never become surfaces.
//
//   - openOwnWindow: an Electron window in its own process, driven through a command file like the
//     probe window of surfaces.spec.ts; shown without activation, no taskbar button; it ends by
//     itself when the test process dies.
//   - openTerminalWindow: a named Windows Terminal window (wt -w dcat-e2e-<rand>) with
//     self-ending tabs; only its own HWND is closed (one process hosts every Terminal window, so
//     process exit is never asserted and a Terminal already running for the user is a skip).
//   - openExplorerWindow: an Explorer window on an own temp folder via the shell verb
//     'opennewprocess' (its own explorer.exe), closed with SC_CLOSE; explorer.exe is never killed.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import type { Rect } from '../../src/shared/geometry';
import { loadWin32Native, type Hwnd } from '../../src/main/win32/native';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ Win32 (class names, PIDs, our own windows only)

interface OwnNative {
  /** WM_SYSCOMMAND SC_CLOSE to one of OUR windows. */
  scClose(h: Hwnd): boolean;
  /** SetWindowPos on one of OUR windows (no activation). */
  setPos(h: Hwnd, r: Rect): boolean;
  /** HWND_TOPMOST without moving, sizing or activating one of OUR windows. */
  topmost(h: Hwnd): boolean;
}

let own: OwnNative | null = null;
function ownNative(): OwnNative {
  if (own) return own;
  const user32 = koffi.load('user32.dll');
  const PostMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32_t', 'uintptr_t', 'intptr_t']);
  const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'int', ['void *', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32_t']);
  const WM_SYSCOMMAND = 0x0112;
  const SC_CLOSE = 0xf060;
  const SWP_NOZORDER_NOACTIVATE = 0x0004 | 0x0010;
  const SWP_NOSIZE_NOMOVE_NOACTIVATE = 0x0001 | 0x0002 | 0x0010;
  own = {
    scClose: (h) => Number(PostMessageW(h, WM_SYSCOMMAND, SC_CLOSE, 0)) !== 0,
    setPos: (h, r) => Number(SetWindowPos(h, 0, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), SWP_NOZORDER_NOACTIVATE)) !== 0,
    topmost: (h) => Number(SetWindowPos(h, -1, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE_NOACTIVATE)) !== 0,
  };
  return own;
}

export interface TopWindow {
  hwnd: string;
  pid: number;
  className: string;
}

/** Visible top-level windows of a class (class name and owner PID only; never a title). */
export function windowsOfClass(className: string): TopWindow[] {
  const n = loadWin32Native();
  const out: TopWindow[] = [];
  for (const h of n.enumTopLevelWindows()) {
    if (!n.isWindowVisible(h)) continue;
    const cls = n.getClassName(h);
    if (cls !== className) continue;
    out.push({ hwnd: h.toString(), pid: n.getWindowProcessId(h), className: cls });
  }
  return out;
}

/** GetWindowRect of a window (geometry only). */
export function rectOf(hwnd: string): Rect | null {
  const r = loadWin32Native().getWindowRect(BigInt(hwnd));
  return r ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
}

/** The visible frame of a window (DWM extended frame bounds, else GetWindowRect), physical px. */
export function frameOf(hwnd: string): Rect | null {
  const n = loadWin32Native();
  const h = BigInt(hwnd);
  const r = n.getExtendedFrameBounds(h) ?? n.getWindowRect(h);
  return r ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
}

/** Waits for windows of `className` that were not in `before` (the window-list diff). */
export async function newWindowsOfClass(className: string, before: ReadonlySet<string>, timeoutMs = 20_000): Promise<TopWindow[]> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const fresh = windowsOfClass(className).filter((w) => !before.has(w.hwnd));
    if (fresh.length) return fresh;
    await sleep(200);
  }
  return [];
}

/**
 * Re-asserts OUR windows as topmost every `everyMs` (in order: the last ends in front) so the
 * user's windows cannot cover the scenario, then the app-under-test's `overlays` above them (a
 * topmost window asserted later would otherwise hide the cat), until the returned stop function
 * is called. Specs still check the z-order (overlay above our window) before every WindowFromPoint.
 */
export function keepTopmost(hwnds: readonly string[], overlays: readonly string[] = [], everyMs = 1000): () => void {
  const n = ownNative();
  const tick = (): void => {
    for (const h of hwnds) n.topmost(BigInt(h));
    for (const h of overlays) n.topmost(BigInt(h));
  };
  tick();
  const t = setInterval(tick, everyMs);
  return () => clearInterval(t);
}

export function moveOwnWindow(hwnd: string, r: Rect): boolean {
  return ownNative().setPos(BigInt(hwnd), r);
}

export function closeOwnWindow(hwnd: string): boolean {
  return ownNative().scClose(BigInt(hwnd));
}

// ------------------------------------------------------------------ Own Electron window (own process)

// A separate Electron process, to the cat an ordinary app window. Shown without activation and
// without a taskbar button: a background process cannot take the foreground, and a refused
// activation flashes the taskbar button, which keeps an auto-hide taskbar revealed and so changes
// what the cat sees. It says what it is, cannot be moved by hand, and ends by itself when the test
// process goes.
const OWN_WINDOW_SCRIPT = String.raw`
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const out = process.env.DCAT_WIN_OUT, cmdFile = process.env.DCAT_WIN_CMD, parentPid = Number(process.env.DCAT_WIN_PARENT);
const layout = process.env.DCAT_WIN_LAYOUT, rect = process.env.DCAT_WIN_RECT ? JSON.parse(process.env.DCAT_WIN_RECT) : null;
const write = (o) => fs.appendFileSync(out, JSON.stringify(o) + '\n');
process.on('uncaughtException', (e) => { try { write({ error: String((e && e.stack) || e) }); } finally { app.exit(1); } });
function bounds() {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  if (rect) return screen.screenToDipRect(null, rect);
  if (layout !== 'typical') return { x: wa.x + 80, y: wa.y + 80, width: Math.round(wa.width * 0.6), height: Math.round(wa.height * 0.6) };
  // About 70 % of the primary work area, centred, its bottom edge ~180 px above the work-area bottom.
  const width = Math.round(wa.width * 0.7);
  const bottom = wa.y + wa.height - Math.round(180 / d.scaleFactor);
  const height = Math.min(Math.round(wa.height * 0.7), bottom - wa.y - Math.round(120 / d.scaleFactor));
  return { x: wa.x + Math.round((wa.width - width) / 2), y: bottom - height, width, height };
}
app.whenReady().then(() => {
  const fixed = layout === 'maximized' || layout === 'hidden' ? {} : { movable: false, resizable: false, minimizable: false, maximizable: false };
  const w = new BrowserWindow({ ...bounds(), ...fixed, show: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#ffffff', title: 'dcat-e2e' });
  w.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><body style="font:20px sans-serif;margin:40px">Desktop Cat end-to-end test window. It closes by itself within a few minutes; please leave it where it is.</body>'));
  if (layout === 'maximized') w.maximize();
  else if (layout !== 'hidden') w.showInactive();
  const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0).toString();
  // The helper ends itself only through app.exit (or the test kills the process), neither of which
  // emits 'close': a 'close' is a close request from outside the test (its close button, Alt+F4 or
  // another program), and the window then goes. Nothing touches the window after that, so the
  // record is not buried under an "Object has been destroyed" error.
  let closed = false;
  w.on('close', () => { closed = true; write({ closedFromOutside: true, at: Date.now() }); });
  let seq = 0;
  const report = () => { if (!closed && !w.isDestroyed()) write({ seq, hwnd, pid: process.pid, state: w.isMinimized() ? 'minimized' : w.isMaximized() ? 'maximized' : w.isVisible() ? 'normal' : 'hidden' }); };
  setTimeout(report, 800);
  let done = 0;
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { app.exit(0); return; }
    if (closed || w.isDestroyed()) return;
    let lines = [];
    try { lines = fs.readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean); } catch { return; }
    for (; done < lines.length; done++) {
      const c = JSON.parse(lines[done]);
      if (c.op === 'quit') { app.exit(0); return; }
      if (c.op === 'maximize') w.maximize();
      if (c.op === 'restore') w.restore();
      if (c.op === 'minimize') w.minimize();
      seq = done + 1;
      setTimeout(report, 300);
    }
  }, 50);
});
`;

export interface OwnWindowReport {
  seq: number;
  hwnd: string;
  pid: number;
  state: string;
}

export interface OwnWindow {
  proc: ChildProcess;
  /** The report answering the latest command (or the first one, after it was created). */
  next(): Promise<OwnWindowReport>;
  send(cmd: { op: 'maximize' | 'restore' | 'minimize' }): void;
  /** True once its window was closed from outside the test (an environment event, not an app failure). */
  closedFromOutside(): boolean;
  /** Asks it to quit, ends it if it does not, deletes its profile; resolves once it has exited. */
  close(): Promise<void>;
}

/**
 * 'typical': about 70 % of the work area, its bottom ~180 px above the floor. 'floating': at `rect`
 * (physical px). 'maximized': maximized at once. 'hidden': created but not shown (send 'maximize' to
 * bring it up in a fraction of a second, for the covered-support case).
 */
export function openOwnWindow(o: { layout: 'typical' | 'floating' | 'maximized' | 'hidden'; rect?: Rect }): OwnWindow {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-e2e-own-'));
  const script = path.join(dir, 'own-window.cjs');
  const outFile = path.join(dir, 'out.jsonl');
  const cmdFile = path.join(dir, 'cmd.jsonl');
  fs.writeFileSync(script, OWN_WINDOW_SCRIPT);
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(cmdFile, '');
  const env: Record<string, string> = {};
  // Not the test runner's Node options (its TS loader) nor this app's switches.
  const skip = (k: string): boolean => /^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/i.test(k) || k.toUpperCase().startsWith('DESKTOP_CAT_');
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !skip(k)) env[k] = v;
  Object.assign(env, { DCAT_WIN_OUT: outFile, DCAT_WIN_CMD: cmdFile, DCAT_WIN_PARENT: String(process.pid), DCAT_WIN_LAYOUT: o.layout, DCAT_WIN_RECT: o.rect ? JSON.stringify(o.rect) : '', ELECTRON_ENABLE_LOGGING: '0' });
  const root = path.resolve(__dirname, '..', '..');
  const exe = path.join(root, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim());
  const proc = spawn(exe, [script, `--user-data-dir=${path.join(dir, 'profile')}`], { env, stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let sent = 0;
  type Line = OwnWindowReport | { error: string } | { closedFromOutside: true };
  // The folder is gone once close() has run.
  const readOut = (): string | null => {
    try {
      return fs.readFileSync(outFile, 'utf8');
    } catch {
      return null;
    }
  };
  const reports = (): Line[] => {
    const text = readOut();
    if (text === null) return [];
    return text.split(/\r?\n/).flatMap((l) => {
      // A line still being written is skipped until it is complete.
      try {
        return l ? [JSON.parse(l) as Line] : [];
      } catch {
        return [];
      }
    });
  };
  const closedFromOutside = (): boolean => reports().some((x) => 'closedFromOutside' in x);
  return {
    proc,
    next: async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const all = reports();
        // The answer, if it came; else the cause: a close from outside before any error it led to.
        const rep = all.find((x): x is OwnWindowReport => 'seq' in x && x.seq === sent);
        if (rep) return rep;
        if (all.some((x) => 'closedFromOutside' in x)) throw new Error('own window was closed from outside the test');
        const failed = all.find((x): x is { error: string } => 'error' in x);
        if (failed) throw new Error(`own window failed: ${failed.error}`);
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`own window did not report (exit ${String(proc.exitCode)})`);
        await sleep(100);
      }
    },
    closedFromOutside,
    send: (cmd) => {
      sent++;
      fs.appendFileSync(cmdFile, `${JSON.stringify(cmd)}\n`);
    },
    close: async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        fs.appendFileSync(cmdFile, '{"op":"quit"}\n');
        const quit = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
        if (!quit) {
          proc.kill();
          await exited;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// ------------------------------------------------------------------ Windows Terminal (own named window)

export const TERMINAL_CLASS = 'CASCADIA_HOSTING_WINDOW_CLASS';

export interface TerminalWindow {
  name: string;
  hwnd: string;
  pid: number;
  /** Opens another self-ending tab in OUR window (`wt -w <name> new-tab`). */
  newTab(command: string[]): Promise<void>;
  /** SC_CLOSE to our window only (never the process: it hosts every Terminal window). */
  close(): void;
}

const run = (file: string, args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err) => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0));
  });

/**
 * A named Terminal window with one self-ending tab. Returns null (the spec skips) when wt.exe is
 * missing, or when the new window's process already owned other windows (the user's Terminal):
 * restricting surfaces to that PID would include the user's windows.
 */
export async function openTerminalWindow(command: string[] = ['cmd', '/c', 'timeout', '/t', '600']): Promise<TerminalWindow | null> {
  const before = new Set(windowsOfClass(TERMINAL_CLASS).map((w) => w.hwnd));
  const preexistingPids = new Set(windowsOfClass(TERMINAL_CLASS).map((w) => w.pid));
  const name = `dcat-e2e-${crypto.randomBytes(4).toString('hex')}`;
  const code = await run('wt.exe', ['-w', name, 'new-tab', '--', ...command]);
  if (code !== 0) return null;
  const fresh = await newWindowsOfClass(TERMINAL_CLASS, before);
  const w = fresh[0];
  if (!w) return null;
  if (preexistingPids.has(w.pid)) {
    closeOwnWindow(w.hwnd);
    return null;
  }
  return {
    name,
    hwnd: w.hwnd,
    pid: w.pid,
    newTab: async (cmd) => void (await run('wt.exe', ['-w', name, 'new-tab', '--', ...cmd])),
    close: () => void closeOwnWindow(w.hwnd),
  };
}

// ------------------------------------------------------------------ File Explorer (own process, own folder)

export const EXPLORER_CLASS = 'CabinetWClass';

export interface ExplorerWindow {
  folder: string;
  hwnd: string;
  pid: number;
  /** SC_CLOSE to our window; waits up to `graceMs` for its process to go (best effort, never killed). */
  close(graceMs?: number): Promise<{ processExited: boolean }>;
}

/** The shell's own Explorer (the taskbar's process), which our window must never belong to. */
function shellPid(): number | null {
  const n = loadWin32Native();
  for (const h of n.enumTopLevelWindows()) if (n.getClassName(h) === 'Shell_TrayWnd') return n.getWindowProcessId(h);
  return null;
}

/**
 * An Explorer window on a fresh temp folder via the 'opennewprocess' verb. Returns null (the spec
 * skips) when no new window appears or it landed in the shell's process (then it is closed again
 * and nothing else is touched).
 */
export async function openExplorerWindow(): Promise<ExplorerWindow | null> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dcat-e2e-explorer-'));
  const before = new Set(windowsOfClass(EXPLORER_CLASS).map((w) => w.hwnd));
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${q(folder)} -Verb opennewprocess`]);
  const fresh = await newWindowsOfClass(EXPLORER_CLASS, before);
  const w = fresh[0];
  if (!w) return null;
  if (w.pid === shellPid()) {
    closeOwnWindow(w.hwnd);
    return null;
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    folder,
    hwnd: w.hwnd,
    pid: w.pid,
    close: async (graceMs = 10_000) => {
      closeOwnWindow(w.hwnd);
      const t0 = Date.now();
      while (alive(w.pid) && Date.now() - t0 < graceMs) await sleep(250);
      fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return { processExited: !alive(w.pid) };
    },
  };
}
