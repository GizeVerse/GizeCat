// Shared fakes for the web host's unit tests (no DOM: events, timers and storage are plain objects).
import type { Logger } from '../../../src/main/contracts';
import type { RoutedEvent } from '../../../src/web/pointerRouter';

export interface LogEntry {
  level: 'error' | 'warn' | 'info' | 'debug';
  msg: string;
  data?: Record<string, unknown>;
}

export function memoryLogger(entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const make = (): Logger => ({
    error: (msg, data) => entries.push({ level: 'error', msg, data }),
    warn: (msg, data) => entries.push({ level: 'warn', msg, data }),
    info: (msg, data) => entries.push({ level: 'info', msg, data }),
    debug: (msg, data) => entries.push({ level: 'debug', msg, data }),
    child: () => make(),
  });
  return Object.assign(make(), { entries });
}

/** Manual clock and timers: advance(ms) runs every timer that comes due, in order. */
export function manualTime(start = 1000) {
  let now = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout(fn: () => void, ms: number): unknown {
        const id = nextId++;
        pending.set(id, { at: now + Math.max(0, ms), fn });
        return id;
      },
      clearTimeout(h: unknown): void {
        pending.delete(h as number);
      },
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null;
        for (const e of pending) if (e[1].at <= end && (due === null || e[1].at < due[1].at)) due = e;
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

export type FakeEvent = RoutedEvent & { prevented: boolean; stopped: boolean };

export function fakeEvent(type: string, init: Partial<Omit<RoutedEvent, 'preventDefault' | 'stopPropagation' | 'stopImmediatePropagation'>> = {}): FakeEvent {
  const e: FakeEvent = {
    type,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: 0,
    clientY: 0,
    button: 0,
    buttons: 0,
    detail: 1,
    // Not null: a pointerout with a null relatedTarget means the pointer left the page.
    relatedTarget: {},
    ...init,
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    stopImmediatePropagation() {
      e.stopped = true;
    },
  };
  return e;
}
