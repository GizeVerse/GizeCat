// Overlay IPC budgets: bursts of pointer moves (high-refresh displays) must never cost
// the presses and releases that follow them.
import { describe, expect, it } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { IPC, type OverlayPointerEvent } from '../../../src/shared/ipc';
import type { HitRegion } from '../../../src/shared/cat';
import { OVERLAY_MESSAGES_PER_SECOND, OVERLAY_POINTER_EVENTS_PER_SECOND, registerIpcHandlers, type IpcDeps } from '../../../src/main/ipc/handlers';
import { memoryLogger } from './helpers';

function setup() {
  let now = 0;
  const listeners = new Map<string, (event: IpcMainEvent, payload: unknown) => void>();
  const pointer: OverlayPointerEvent[] = [];
  const regions: HitRegion[] = [];
  const deps = {
    ipcMain: {
      on: (channel: string, fn: (event: IpcMainEvent, payload: unknown) => void) => listeners.set(channel, fn),
      removeAllListeners: () => undefined,
      handle: () => undefined,
      removeHandler: () => undefined,
    },
    registry: { register: () => undefined, unregister: () => undefined, kindOf: () => 'overlay', ids: () => [7] },
    logger: memoryLogger(),
    overlays: {
      handleReady: () => undefined,
      handlePointer: (_id: number, ev: OverlayPointerEvent) => pointer.push(ev),
      handleHitRegion: (_id: number, r: HitRegion) => regions.push(r),
      handleRendererError: () => undefined,
    },
    clock: () => now,
  } as unknown as IpcDeps;
  registerIpcHandlers(deps);
  const event = { sender: { id: 7 }, senderFrame: { url: 'desktop-cat://app/renderer/overlay/index.html?display=1', parent: null } } as unknown as IpcMainEvent;
  const send = (channel: string, payload: unknown): void => listeners.get(channel)!(event, payload);
  const ev = (kind: OverlayPointerEvent['kind'], x = 10): OverlayPointerEvent => ({ kind, x, y: 10, button: kind === 'move' ? -1 : 0, buttons: kind === 'up' ? 0 : 1, t: now + 1 });
  return {
    pointer,
    regions,
    send,
    ev,
    at(ms: number) {
      now = ms;
    },
  };
}

describe('overlay IPC rate limiting', () => {
  it('delivers press and release after a full second of moves at a 360 Hz refresh', () => {
    const s = setup();
    s.at(0);
    s.send(IPC.overlayPointer, s.ev('down'));
    for (let i = 0; i < 360; i++) {
      s.at(1 + (i * 990) / 360);
      s.send(IPC.overlayPointer, s.ev('move', i));
      if (i % 24 === 0) s.send(IPC.overlayHitRegion, { rects: [{ x: i, y: 0, width: 10, height: 10 }] });
    }
    s.at(995);
    s.send(IPC.overlayPointer, s.ev('up'));
    s.send(IPC.overlayPointer, s.ev('down'));
    const kinds = s.pointer.map((e) => e.kind);
    expect(kinds[0]).toBe('down');
    expect(kinds.slice(-2)).toEqual(['up', 'down']);
    // The shared budget still applies to moves and hit regions.
    const shared = kinds.filter((k) => k === 'move').length + s.regions.length;
    expect(shared).toBe(OVERLAY_MESSAGES_PER_SECOND);
  });

  it('caps state-changing pointer events with their own budget', () => {
    const s = setup();
    s.at(0);
    for (let i = 0; i < OVERLAY_POINTER_EVENTS_PER_SECOND + 30; i++) s.send(IPC.overlayPointer, s.ev(i % 2 === 0 ? 'enter' : 'leave'));
    expect(s.pointer.length).toBe(OVERLAY_POINTER_EVENTS_PER_SECOND);
    // ... without touching the move budget.
    s.send(IPC.overlayPointer, s.ev('move'));
    expect(s.pointer.at(-1)!.kind).toBe('move');
    s.at(1000);
    s.send(IPC.overlayPointer, s.ev('up'));
    expect(s.pointer.at(-1)!.kind).toBe('up');
  });

  it('a forged kind cannot borrow the discrete budget past validation', () => {
    const s = setup();
    s.at(0);
    s.send(IPC.overlayPointer, { kind: 'up', x: 'nope' });
    expect(s.pointer).toEqual([]);
  });
});
