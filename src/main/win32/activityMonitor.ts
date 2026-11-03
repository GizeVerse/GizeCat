// ActivityMonitor (src/main/contracts.ts): coarse, content-free activity signals.
//
// Privacy: no keyboard hook, no key codes, no text. The only inputs are the system idle
// time (GetLastInputInfo), the cursor position the host samples, and the mouse buttons.
// "Keyboard-like" activity is inferred as "some input happened while the cursor did not move
// and no mouse button was held or pressed". v1.2 (ADR 0003 §4.3, §13 Q2): with the Win32 input
// extension the left, right and middle buttons are read (mouse buttons only, never keys), and a
// click between two samples (the content-free press counter moved) no longer counts as typing;
// without it, only the primary button held at the sample is seen, as before. Scrolling the wheel
// and pen/touch input still count as keyboard-like.
import { distance } from '../../shared/geometry';
import type { Point } from '../../shared/geometry';
import type { SimEvent } from '../../shared/sim';
import type { ActivityMonitor, Logger, Win32Api } from '../contracts';
import { BoundedQueue } from './collections';
import { hasWin32InputExtensions } from './win32Api';

export interface ActivityMonitorOptions {
  /** Fallback clock (ms) for samples given a non-finite timestamp. */
  now?: () => number;
  /** ms since the last input of any kind; defaults to api.getIdleMs(). */
  idleProvider?: () => number;
  /** Idle time at which a second activity.userIdle fires (the cat's sleep threshold). */
  sleepThresholdMs?: number;
}

export interface ActivityMonitorExtras {
  setSleepThresholdMs(ms: number): void;
}

export const ACTIVITY = {
  /** Idle shorter than expected by more than this means new input (GetTickCount is ~16 ms coarse). */
  inputEpsilonMs: 40,
  typingStartAfterMs: 2000,
  /** Pauses up to this long keep a keyboard-like run going. */
  typingGapMs: 1500,
  typingEndAfterMs: 4000,
  intensityBuckets: 30,
  bucketMs: 1000,
  idleMs: 60_000,
  defaultSleepThresholdMs: 5 * 60_000,
  speedTauMs: 100,
  /** Larger sample gaps are treated as discontinuities (no speed estimate). */
  maxSampleGapMs: 250,
  flickSpeed: 2500,
  flickSustainMs: 80,
  flickCooldownMs: 4000,
} as const;

export function createActivityMonitor(api: Win32Api, logger: Logger, opts: ActivityMonitorOptions = {}): ActivityMonitor & ActivityMonitorExtras {
  const log = logger.child('activity');
  const clock = opts.now ?? (() => performance.now());
  const readIdle = opts.idleProvider ?? (() => api.getIdleMs());
  const events = new BoundedQueue<SimEvent>(64);
  const bucketIdx = new Array<number>(ACTIVITY.intensityBuckets).fill(-1);
  const input = hasWin32InputExtensions(api) ? api : null;
  /** Press count at the previous sample (v1.2 input extension), null before the first. */
  let lastPresses: number | null = null;

  /**
   * Read once per sample: a mouse button is held now, or was pressed since the previous sample
   * (clicks are not typing). Without the input extension: the primary button held, as in v1.1.
   */
  function mouseActivity(): boolean {
    if (input === null) return api.isLeftButtonDown();
    const b = input.mouseButtons();
    const pressed = lastPresses !== null && b.presses !== lastPresses;
    lastPresses = b.presses;
    return b.down || pressed;
  }

  let sleepThresholdMs = opts.sleepThresholdMs ?? ACTIVITY.defaultSleepThresholdMs;
  let running = false;
  let prevT: number | null = null;
  let prevCursor: Point | null = null;
  let prevIdle: number | null = null;
  let idleMs = 0;
  let idleNotified = false;
  let sleepNotified = false;
  let runStart: number | null = null;
  let lastKeyAt: number | null = null;
  let typing = false;
  let typingSince = 0;
  let speed = 0;
  let fastSince: number | null = null;
  let fastPeak = 0;
  let flickedThisRun = false;
  let lastFlickAt = -Infinity;
  let lastSampleAt: number | null = null;
  let errorCount = 0;

  function resetBaseline(): void {
    prevT = null;
    prevCursor = null;
    prevIdle = null;
    speed = 0;
    fastSince = null;
    flickedThisRun = false;
  }

  function markBucket(t: number): void {
    const idx = Math.floor(t / ACTIVITY.bucketMs);
    bucketIdx[idx % ACTIVITY.intensityBuckets] = idx;
  }

  function intensityAt(t: number): number {
    const cur = Math.floor(t / ACTIVITY.bucketMs);
    let active = 0;
    for (const idx of bucketIdx) if (idx >= 0 && idx <= cur && cur - idx < ACTIVITY.intensityBuckets) active++;
    return active / ACTIVITY.intensityBuckets;
  }

  function onKeyboardLike(t: number): void {
    if (lastKeyAt === null || t - lastKeyAt > ACTIVITY.typingGapMs) runStart = t;
    lastKeyAt = t;
    markBucket(t);
  }

  function updateTyping(t: number): void {
    if (!typing && runStart !== null && lastKeyAt !== null && lastKeyAt - runStart >= ACTIVITY.typingStartAfterMs && t - lastKeyAt <= ACTIVITY.typingGapMs) {
      typing = true;
      typingSince = runStart;
      events.push({ type: 'activity.typingStart' });
    } else if (typing && lastKeyAt !== null && t - lastKeyAt >= ACTIVITY.typingEndAfterMs) {
      typing = false;
      events.push({ type: 'activity.typingEnd', durationMs: Math.max(0, Math.round(lastKeyAt - typingSince)) });
    }
  }

  function updateCursor(t: number, dt: number, cursor: Point | null): boolean {
    if (cursor === null || prevCursor === null) {
      speed = 0;
      fastSince = null;
      flickedThisRun = false;
      return false;
    }
    const d = distance(cursor, prevCursor);
    if (dt <= 0 || dt > ACTIVITY.maxSampleGapMs) {
      fastSince = null;
      return d > 0;
    }
    const inst = (d / dt) * 1000;
    speed += (1 - Math.exp(-dt / ACTIVITY.speedTauMs)) * (inst - speed);
    if (inst > ACTIVITY.flickSpeed) {
      if (fastSince === null) {
        fastSince = t - dt;
        fastPeak = 0;
      }
      fastPeak = Math.max(fastPeak, inst);
      if (!flickedThisRun && t - fastSince >= ACTIVITY.flickSustainMs && t - lastFlickAt >= ACTIVITY.flickCooldownMs) {
        flickedThisRun = true;
        lastFlickAt = t;
        events.push({ type: 'cursor.flick', speed: Math.round(fastPeak), at: { x: cursor.x, y: cursor.y } });
      }
    } else {
      fastSince = null;
      flickedThisRun = false;
    }
    return d > 0;
  }

  function updateIdle(t: number, dt: number, idle: number, cursorMoved: boolean, cursorKnown: boolean, mouse: () => boolean): void {
    if (prevIdle !== null && idle < prevIdle + dt - ACTIVITY.inputEpsilonMs) {
      // New input since the previous sample. The stretch it ended is from the previous
      // last-input time to this one (at most one sample interval too long).
      const stretch = Math.max(prevIdle, prevIdle + dt - idle);
      if (stretch >= ACTIVITY.idleMs) events.push({ type: 'activity.userReturned', idleMs: Math.round(stretch) });
      idleNotified = false;
      sleepNotified = false;
      if (cursorKnown && !cursorMoved && !mouse()) onKeyboardLike(t);
    }
    if (!idleNotified && idle >= ACTIVITY.idleMs) {
      idleNotified = true;
      events.push({ type: 'activity.userIdle', idleMs: Math.round(idle) });
      if (sleepThresholdMs <= ACTIVITY.idleMs) sleepNotified = true;
    }
    if (!sleepNotified && idle >= sleepThresholdMs) {
      sleepNotified = true;
      events.push({ type: 'activity.userIdle', idleMs: Math.round(idle) });
    }
  }

  function sample(nowIn: number, cursor: Point | null): void {
    if (!running) return;
    const t = Number.isFinite(nowIn) ? nowIn : clock();
    try {
      if (prevT !== null && t < prevT) resetBaseline();
      const dt = prevT === null ? 0 : t - prevT;
      const validCursor = cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y) ? cursor : null;
      const cursorMoved = updateCursor(t, dt, validCursor);
      const raw = readIdle();
      const idle = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
      // With the input extension the buttons are read every sample (so a press counts once, at the
      // sample after it); v1.1 path: the primary button only when new input is seen.
      const mouseNow = input !== null ? mouseActivity() : null;
      const mouse = (): boolean => mouseNow ?? mouseActivity();
      if (idle !== null) {
        if (prevT !== null) updateIdle(t, dt, idle, cursorMoved, validCursor !== null, mouse);
        idleMs = idle;
      }
      updateTyping(t);
      prevT = t;
      lastSampleAt = t;
      prevCursor = validCursor ? { x: validCursor.x, y: validCursor.y } : null;
      prevIdle = idle;
    } catch (e) {
      errorCount++;
      if (errorCount <= 3 || errorCount % 1000 === 0) log.warn('activity sample failed', { count: errorCount, error: e instanceof Error ? e.message : String(e) });
      resetBaseline();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      resetBaseline();
    },
    stop() {
      running = false;
      if (typing) {
        typing = false;
        events.push({ type: 'activity.typingEnd', durationMs: Math.max(0, Math.round((lastKeyAt ?? typingSince) - typingSince)) });
      }
      runStart = null;
      lastKeyAt = null;
      resetBaseline();
    },
    sample,
    drainEvents: () => events.drain(),
    get idleMs() {
      return idleMs;
    },
    get typing() {
      return typing;
    },
    get typingIntensity() {
      return lastSampleAt === null ? 0 : intensityAt(lastSampleAt);
    },
    get cursorSpeed() {
      return speed;
    },
    setSleepThresholdMs(ms: number) {
      if (Number.isFinite(ms) && ms > 0) sleepThresholdMs = ms;
    },
  };
}
