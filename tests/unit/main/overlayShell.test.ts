// createOverlayShell (NonRudeHWND + TaskbarCreated on overlay windows) over a MOCKED shell
// native and fake BrowserWindows: handle extraction, non-fatal failures, rate-limited logs.
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

import { createOverlayShell } from '../../../src/main/overlay/overlayWindow';
import { createOverlayShellNative, NON_RUDE_PROP, TASKBAR_CREATED_MESSAGE, type OverlayShellNative } from '../../../src/main/win32/taskbar/windowProps';
import { memoryLogger } from './helpers';

function fakeWin(hwnd: bigint | null): BrowserWindow & { hooked: Map<number, () => void> } {
  const hooked = new Map<number, () => void>();
  const handle = Buffer.alloc(8);
  if (hwnd !== null) handle.writeBigUInt64LE(hwnd);
  const win = {
    hooked,
    getNativeWindowHandle: () => (hwnd === null ? Buffer.alloc(0) : handle),
    hookWindowMessage: (msg: number, cb: () => void) => hooked.set(msg, cb),
  };
  return win as unknown as BrowserWindow & { hooked: Map<number, () => void> };
}

class FakeShell implements OverlayShellNative {
  props = new Map<bigint, number>();
  failSet = false;
  throwAll = false;
  message: number | null = 0xc0de;
  setNonRude(h: bigint): boolean {
    if (this.throwAll) throw new Error('boom');
    if (this.failSet) return false;
    this.props.set(h, 1);
    return true;
  }
  clearNonRude(h: bigint): boolean {
    if (this.throwAll) throw new Error('boom');
    return this.props.delete(h);
  }
  taskbarCreatedMessage(): number | null {
    if (this.throwAll) throw new Error('boom');
    return this.message;
  }
}

describe('overlay shell integration', () => {
  it('sets and removes NonRudeHWND on the overlay window handle', () => {
    const native = new FakeShell();
    const shell = createOverlayShell(memoryLogger(), native);
    const win = fakeWin(0x1234n);
    expect(shell.beforeShow(win, 'A')).toBe(true);
    expect(native.props.get(0x1234n)).toBe(1);
    expect(shell.beforeDestroy(win, 'A')).toBe(true);
    expect(native.props.size).toBe(0);
    expect(shell.beforeDestroy(win, 'A')).toBe(false); // already gone
  });

  it('reports failures as false, logs them rate-limited and never throws', () => {
    const native = new FakeShell();
    const log = memoryLogger();
    const shell = createOverlayShell(log, native);
    native.failSet = true;
    for (let i = 0; i < 10; i++) expect(shell.beforeShow(fakeWin(BigInt(i + 1)), 'A')).toBe(false);
    expect(log.entries.filter((e) => e.msg === 'overlay NonRudeHWND set failed')).toHaveLength(3);
    expect(shell.beforeShow(fakeWin(null), 'B')).toBe(false); // no usable handle
    native.throwAll = true;
    expect(() => shell.beforeShow(fakeWin(7n), 'A')).not.toThrow();
    expect(shell.beforeDestroy(fakeWin(7n), 'A')).toBe(false);
    expect(shell.hookTaskbarCreated(fakeWin(7n), () => undefined)).toBe(false);
  });

  it('hooks the registered TaskbarCreated message on the window', () => {
    const native = new FakeShell();
    const shell = createOverlayShell(memoryLogger(), native);
    const win = fakeWin(9n);
    let calls = 0;
    expect(shell.hookTaskbarCreated(win, () => calls++)).toBe(true);
    win.hooked.get(0xc0de)!();
    expect(calls).toBe(1);
    native.message = null;
    expect(shell.hookTaskbarCreated(fakeWin(10n), () => calls++)).toBe(false);
  });

  it('is inert when the shell bindings are unavailable', () => {
    const shell = createOverlayShell(memoryLogger(), null);
    expect(shell.beforeShow(fakeWin(1n), 'A')).toBe(false);
    expect(shell.beforeDestroy(fakeWin(1n), 'A')).toBe(false);
    expect(shell.hookTaskbarCreated(fakeWin(1n), () => undefined)).toBe(false);
  });

  it('maps onto SetPropW/RemovePropW/RegisterWindowMessageW with the documented names', () => {
    const calls: string[] = [];
    const native = createOverlayShellNative({
      setProp: (h, name, value) => (calls.push(`set ${h} ${name} ${value}`), true),
      removeProp: (h, name) => (calls.push(`remove ${h} ${name}`), 1),
      registerWindowMessage: (name) => (calls.push(`register ${name}`), 0xc123),
    });
    expect(native.setNonRude(5n)).toBe(true);
    expect(native.clearNonRude(5n)).toBe(true);
    expect(native.taskbarCreatedMessage()).toBe(0xc123);
    expect(native.taskbarCreatedMessage()).toBe(0xc123); // registered once
    expect(calls).toEqual([`set 5 ${NON_RUDE_PROP} 1`, `remove 5 ${NON_RUDE_PROP}`, `register ${TASKBAR_CREATED_MESSAGE}`]);
    expect(NON_RUDE_PROP).toBe('NonRudeHWND');
    const bad = createOverlayShellNative({ setProp: () => false, removeProp: () => 0, registerWindowMessage: () => 0 });
    expect(bad.taskbarCreatedMessage()).toBeNull();
    expect(bad.clearNonRude(1n)).toBe(false);
  });
});
