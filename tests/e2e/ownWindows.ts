// Own windows for the v1.2 REAL E2E (ADR 0003 §15.4): every window these helpers open belongs to
// a process this suite started, is identified by a window-list diff (HWNDs that appeared after the
// launch, by class name and owner PID; never a title), and is the only kind of window they move,
// re-assert as topmost or close. The user's windows are never touched; every lively spec also
// calls restrictSurfacesToPids([own pids]) so they never become surfaces.
//
//   - openFormWindow: a WinForms window in its own PowerShell process (-STA, per-monitor DPI
//     aware, so its bounds are physical px), driven through a command file like the Electron probe
//     window of surfaces.spec.ts; it ends by itself when the test process dies.
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

// ------------------------------------------------------------------ WinForms window (own PowerShell process)

const FORM_SCRIPT = String.raw`
param([string]$OutFile, [string]$CmdFile, [int]$ParentPid, [string]$Layout, [int]$X, [int]$Y, [int]$W, [int]$H, [int]$Topmost)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace DcatE2e -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr v);'
[void][DcatE2e.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Desktop Cat end-to-end test window'
$f.StartPosition = 'Manual'
$f.ShowInTaskbar = $true
$f.BackColor = [System.Drawing.Color]::White
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Desktop Cat end-to-end test window. It closes by itself; please leave it where it is.'
$label.AutoSize = $true
$label.Left = 40; $label.Top = 40
$f.Controls.Add($label)
$f.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
if ($Layout -eq 'maximized') { $f.WindowState = 'Maximized' }
if ($Topmost -eq 1) { $f.TopMost = $true }
$seq = 0
$done = 0
$report = {
  $r = $f.Bounds
  $o = @{ seq = $script:seq; hwnd = $f.Handle.ToInt64().ToString(); pid = $PID; frame = @{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }; state = $f.WindowState.ToString() }
  Add-Content -Path $OutFile -Value (ConvertTo-Json -Compress -InputObject $o)
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $f.Close(); return }
  $lines = @()
  if (Test-Path $CmdFile) { $lines = @(Get-Content $CmdFile) }
  for (; $script:done -lt $lines.Count; $script:done++) {
    $c = ConvertFrom-Json $lines[$script:done]
    if ($c.op -eq 'quit') { $f.Close(); return }
    if ($c.op -eq 'maximize') { $f.WindowState = 'Maximized' }
    if ($c.op -eq 'restore') { $f.WindowState = 'Normal' }
    if ($c.op -eq 'minimize') { $f.WindowState = 'Minimized' }
    if ($c.op -eq 'move') { $f.Bounds = New-Object System.Drawing.Rectangle([int]$c.x, [int]$c.y, [int]$c.width, [int]$c.height) }
    if ($c.op -eq 'front') { $f.TopMost = $true; $f.TopMost = ($Topmost -eq 1) }
    $script:seq = $script:done + 1
    & $report
  }
})
$f.Add_Shown({ & $report; $timer.Start() })
[System.Windows.Forms.Application]::Run($f)
`;

export interface FormReport {
  seq: number;
  hwnd: string;
  pid: number;
  frame: Rect;
  state: string;
}

export interface FormWindow {
  proc: ChildProcess;
  /** The report answering the latest command (or the first one, after it was shown). */
  next(): Promise<FormReport>;
  send(cmd: { op: 'quit' | 'maximize' | 'restore' | 'minimize' | 'front' } | ({ op: 'move' } & Rect)): void;
  close(): Promise<void>;
}

/** A WinForms window in its own process: 'maximized', or floating at `rect` (physical px). */
export function openFormWindow(dir: string, o: { layout: 'maximized' | 'floating'; rect?: Rect; topmost?: boolean }): FormWindow {
  const script = path.join(dir, 'dcat-form.ps1');
  const outFile = path.join(dir, `form-out-${crypto.randomBytes(3).toString('hex')}.jsonl`);
  const cmdFile = `${outFile}.cmd`;
  fs.writeFileSync(script, FORM_SCRIPT);
  fs.writeFileSync(outFile, '');
  fs.writeFileSync(cmdFile, '');
  const r = o.rect ?? { x: 300, y: 160, width: 1000, height: 800 };
  const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutFile', outFile, '-CmdFile', cmdFile, '-ParentPid', String(process.pid), '-Layout', o.layout, '-X', String(r.x), '-Y', String(r.y), '-W', String(r.width), '-H', String(r.height), '-Topmost', o.topmost ? '1' : '0'];
  const proc = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: false });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  let sent = 0;
  const reports = (): FormReport[] =>
    fs
      .readFileSync(outFile, 'utf8')
      .split(/\r?\n/)
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l) as FormReport] : [];
        } catch {
          return [];
        }
      });
  return {
    proc,
    next: async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rep = reports().find((x) => x.seq === sent);
        if (rep) return rep;
        if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`form window did not report (exit ${String(proc.exitCode)})`);
        await sleep(100);
      }
    },
    send: (cmd) => {
      sent++;
      fs.appendFileSync(cmdFile, `${JSON.stringify(cmd)}\n`);
    },
    close: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      fs.appendFileSync(cmdFile, '{"op":"quit"}\n');
      const quit = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
      if (!quit) {
        proc.kill();
        await exited;
      }
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
