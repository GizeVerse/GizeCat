// Test harness for the tab-strip service and helper client: a fake helper process (fakeHelper.ts,
// MOCKED), a manual clock, scripted window descriptions and a memory logger.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { ChildProcessLike } from '../../../src/main/uia/client';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { WindowInfo } from '../../../src/shared/world';
import { memoryLogger, removeDir, tempDir } from '../main/helpers';
import type { FakeHelperState } from './fakeHelper';

export const FAKE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakeHelper.ts');

export interface LoggedRequest {
  pid: number;
  line: string;
}

export interface FakeHelperHarness {
  dir: string;
  setState(state: FakeHelperState): void;
  patchState(patch: Partial<FakeHelperState>): void;
  state(): FakeHelperState;
  /** Queues one event for the running fake helper. */
  emit(event: 'selected' | 'structure', hwnd: string): void;
  requests(): LoggedRequest[];
  /** Parsed requests of one op (start markers and quit lines excluded). */
  ops(op: string): Array<{ id: number; op: string; hwnd?: string; hwnds?: string[] }>;
  starts(): number;
  spawnHelper: (p: string) => ChildProcessLike;
  /** Every process spawned through spawnHelper (for cleanup). */
  children: ChildProcessLike[];
  cleanup(): Promise<void>;
}

export function fakeHelperHarness(initial: FakeHelperState = {}): FakeHelperHarness {
  const dir = tempDir('dcat-uia-');
  const statePath = path.join(dir, 'state.json');
  const logPath = path.join(dir, 'requests.jsonl');
  let current: FakeHelperState = { ...initial };
  let seq = 0;
  const write = (): void => {
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current));
    // Windows refuses the replace while the fake helper has the file open for reading: retry.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, statePath);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 200) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  };
  write();
  const children: ChildProcessLike[] = [];
  const requests = (): LoggedRequest[] => {
    let text: string;
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LoggedRequest);
  };
  return {
    dir,
    setState(state) {
      current = { ...state, events: current.events };
      write();
    },
    patchState(patch) {
      current = { ...current, ...patch };
      write();
    },
    state: () => current,
    emit(event, hwnd) {
      seq++;
      current = { ...current, events: [...(current.events ?? []), { seq, event, hwnd }] };
      write();
    },
    requests,
    ops(op) {
      return requests()
        .filter((r) => r.line !== '<start>')
        .map((r) => JSON.parse(r.line) as { id: number; op: string; hwnd?: string; hwnds?: string[] })
        .filter((r) => r.op === op);
    },
    starts: () => requests().filter((r) => r.line === '<start>').length,
    spawnHelper: (_p: string) => {
      const child = spawn(process.execPath, ['--no-warnings', FAKE_HELPER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, FAKE_UIA_STATE: statePath, FAKE_UIA_LOG: logPath },
      });
      children.push(child);
      return child;
    },
    children,
    async cleanup() {
      await Promise.all(
        children.map(
          (c) =>
            new Promise<void>((resolve) => {
              const cp = c as ChildProcessLike & { exitCode: number | null; signalCode: string | null };
              if (cp.exitCode !== null || cp.signalCode !== null) {
                resolve();
                return;
              }
              const timer = setTimeout(resolve, 3000);
              c.once('close', () => {
                clearTimeout(timer);
                resolve();
              });
              c.kill();
            }),
        ),
      );
      removeDir(dir);
    },
  };
}

/**
 * vi.waitFor with a timeout suited to real child processes (spawning Node can take well over a
 * second on a loaded machine); resolves as soon as the assertion passes.
 */
export function eventually<T>(fn: () => T | Promise<T>, timeoutMs = 8000): Promise<T> {
  return vi.waitFor(fn, { timeout: timeoutMs, interval: 20 });
}

export class ManualClock {
  t = 1_000_000;
  readonly now = (): number => this.t;
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}

export function settingsWith(opts: { tabStrips?: boolean; size?: number } = {}): Settings {
  const s = defaultSettings();
  const disabled = s.behavior.disabledBehaviors.filter((b) => b !== 'tabStrips');
  return {
    ...s,
    behavior: { ...s.behavior, disabledBehaviors: opts.tabStrips === false ? [...disabled, 'tabStrips'] : disabled },
    appearance: { ...s.appearance, size: opts.size ?? 1 },
  };
}

/** Scripted Win32Api.describeWindow. */
export class FakeWindows {
  private readonly map = new Map<string, WindowInfo>();
  readonly calls: string[] = [];

  set(id: string, patch: Partial<WindowInfo> = {}): WindowInfo {
    const prev = this.map.get(id);
    const info: WindowInfo = {
      id,
      rect: { x: 133, y: 125, width: 1359, height: 867 },
      processName: 'msedge.exe',
      category: 'browser',
      minimized: false,
      maximized: false,
      fullscreen: false,
      excluded: false,
      ...prev,
      ...patch,
    };
    this.map.set(id, info);
    return info;
  }

  remove(id: string): void {
    this.map.delete(id);
  }

  readonly describe = (id: string): WindowInfo | null => {
    this.calls.push(id);
    return this.map.get(id) ?? null;
  };
}

export { memoryLogger, removeDir };
