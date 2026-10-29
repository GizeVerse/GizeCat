// REAL koffi type resolution (Windows only): the v1.1 shell bindings add APPBARDATA, a struct with
// a pointer member. Declared in the wrong order relative to the anonymous koffi.proto types,
// koffi 3.3.4 gave MONITORINFO and WNDENUMPROC the same anonymous name and koffi.pointer(MONITORINFO)
// resolved to a callback (docs/research/v1.1/taskbar.md, pitfall 2). Read-only: no window is
// created and no property is set on any window.
import { describe, expect, it } from 'vitest';
import { loadShellNative, loadWin32Native, nativeTypeReport } from '../../../src/main/win32/native';

describe.runIf(process.platform === 'win32')('native koffi pointer types (real koffi)', () => {
  it('keeps struct pointers as pointers and callback pointers as callbacks', () => {
    loadWin32Native();
    loadShellNative();
    const report = nativeTypeReport();
    expect(report.map((t) => t.name).sort()).toEqual(['APPBARDATA', 'LASTINPUTINFO', 'MONITORINFO', 'POINT', 'RECT', 'WINEVENTPROC', 'WNDENUMPROC']);
    for (const t of report) expect(`${t.name}: ${t.primitive}`).toBe(`${t.name}: ${t.kind === 'struct-pointer' ? 'Pointer' : 'Callback'}`);
    // The root cause of the clash: two distinct types sharing one anonymous koffi name.
    expect(new Set(report.map((t) => t.typeName)).size).toBe(report.length);
  });

  it('lays out APPBARDATA as the x64 SDK does (48 bytes)', () => {
    loadShellNative();
    const abd = nativeTypeReport().find((t) => t.name === 'APPBARDATA');
    expect(abd?.size).toBe(48);
    expect(abd?.offsets).toEqual({ cbSize: 0, hWnd: 8, uCallbackMessage: 16, uEdge: 20, rc: 24, lParam: 40 });
    const mi = nativeTypeReport().find((t) => t.name === 'MONITORINFO');
    expect(mi?.size).toBe(40);
  });

  it('binds the shell calls and answers read-only queries', () => {
    const shell = loadShellNative();
    // Registered messages live in 0xC000..0xFFFF; the same name always yields the same id.
    const msg = shell.registerWindowMessage('TaskbarCreated');
    expect(msg).toBeGreaterThanOrEqual(0xc000);
    expect(msg).toBeLessThanOrEqual(0xffff);
    expect(shell.registerWindowMessage('TaskbarCreated')).toBe(msg);
    expect(Number.isInteger(shell.appBarGetState())).toBe(true);
    const pos = shell.appBarGetTaskbarPos();
    // No Explorer taskbar (e.g. a service session) is a valid answer; otherwise a well-formed rect and ABE_* edge.
    if (pos !== null) {
      expect([0, 1, 2, 3]).toContain(pos.edge);
      expect(pos.rect.right).toBeGreaterThan(pos.rect.left);
      expect(pos.rect.bottom).toBeGreaterThan(pos.rect.top);
    }
    const tray = shell.findWindow('Shell_TrayWnd');
    expect(tray === null || typeof tray === 'bigint').toBe(true);
    const first = shell.findNextWindow('Shell_TrayWnd', null);
    expect(first).toEqual(tray);
  });
});
