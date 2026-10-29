// The overlay preload validates every surface-outline frame (zod/mini schema) before the
// page sees it. MOCKED: Electron's contextBridge and ipcRenderer; the real preload module.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { OverlayApi } from '../../../src/shared/ipc';
import { MAX_DEBUG_LINES } from '../../../src/shared/surfaceDiagnostics';
import type { SurfaceLinesPayload } from '../../../src/shared/surfaceDiagnosticsSchema';

const bridge = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event: unknown, value: unknown) => void>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const state: { exposed: unknown } = { exposed: null };
  return {
    state,
    listeners,
    sent,
    emit(channel: string, value: unknown) {
      for (const fn of listeners.get(channel) ?? []) fn({}, value);
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      bridge.state.exposed = api;
    },
  },
  ipcRenderer: {
    on: (channel: string, fn: (event: unknown, value: unknown) => void) => {
      bridge.listeners.set(channel, [...(bridge.listeners.get(channel) ?? []), fn]);
    },
    removeListener: (channel: string, fn: (event: unknown, value: unknown) => void) => {
      bridge.listeners.set(
        channel,
        (bridge.listeners.get(channel) ?? []).filter((f) => f !== fn),
      );
    },
    send: (channel: string, payload: unknown) => bridge.sent.push({ channel, payload }),
  },
}));

let api: OverlayApi;
beforeAll(async () => {
  await import('../../../src/preload/overlay');
  api = bridge.state.exposed as OverlayApi;
});

describe('overlay preload: surface outline frames', () => {
  const line = { kind: 'windowSide', role: 'reachable', x0: 1, y0: 2, x1: 1, y1: 300 };

  it('passes valid frames (including the empty clearing frame) and drops malformed ones', () => {
    const got: SurfaceLinesPayload[] = [];
    const off = api.onSurfaceLines((p) => got.push(p));
    bridge.emit('overlay:surface-lines', { lines: [line] });
    bridge.emit('overlay:surface-lines', { lines: [] });
    bridge.emit('overlay:surface-lines', { lines: [{ ...line, title: 'Inbox' }] });
    bridge.emit('overlay:surface-lines', { lines: [{ ...line, x1: Number.NaN }] });
    bridge.emit('overlay:surface-lines', { lines: Array.from({ length: MAX_DEBUG_LINES + 1 }, () => line) });
    bridge.emit('overlay:surface-lines', 'lines');
    expect(got).toEqual([{ lines: [line] }, { lines: [] }]);
    off();
    bridge.emit('overlay:surface-lines', { lines: [line] });
    expect(got).toHaveLength(2);
    // A malformed frame is not an error worth reporting.
    expect(bridge.sent.filter((m) => m.channel === 'overlay:error')).toEqual([]);
  });
});
