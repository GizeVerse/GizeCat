// Process client for the DesktopCatUia helper: spawns it without a shell, frames stdout into
// size-capped lines, validates every line (protocol.ts), matches responses to requests by id and
// fails requests that outlive their timeout. The clock is injected; timeouts are evaluated when the
// owner calls checkTimeouts(now), so tests are deterministic. Restart policy lives in the owner.
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../contracts';
import {
  encodeRequest,
  MAX_HELPER_LINE_BYTES,
  MAX_REQUEST_ID,
  parseHelperLine,
  QUIT_LINE,
  type HelperEvent,
  type HelperRequest,
  type HelperResponse,
} from './protocol';

/** The parts of a child process the client uses (a real ChildProcess satisfies it). */
export type ChildProcessLike = Pick<ChildProcess, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'kill' | 'once' | 'on'>;

/** Production spawner: no shell, hidden console, all three stdio streams piped. */
export function spawnUiaHelper(path: string): ChildProcessLike {
  return spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

export type TransportErrorCode = 'timeout' | 'exited' | 'not-running' | 'busy' | 'write-failed';

export class HelperTransportError extends Error {
  constructor(readonly code: TransportErrorCode) {
    super(`uia helper: ${code}`);
    this.name = 'HelperTransportError';
  }
}

export interface HelperExit {
  /** The owner asked for it (quit or kill). */
  expected: boolean;
  code: number | null;
  signal: string | null;
  /** Spawn/process error code (e.g. ENOENT, EACCES, EPERM), if the process could not run. */
  error: string | null;
  uptimeMs: number;
}

export interface UiaHelperClientOptions {
  helperPath: string;
  spawn: (path: string) => ChildProcessLike;
  logger: Logger;
  now: () => number;
  requestTimeoutMs: number;
  quitGraceMs: number;
  maxLineBytes?: number;
  maxPending?: number;
  onEvent: (ev: HelperEvent) => void;
  onExit: (exit: HelperExit) => void;
}

export interface UiaHelperClientStats {
  spawns: number;
  lines: number;
  malformed: number;
  oversized: number;
  timeouts: number;
  orphanResponses: number;
  helperErrors: number;
  stderrBytes: number;
  writeErrors: number;
}

interface Pending {
  resolve: (r: HelperResponse) => void;
  reject: (e: HelperTransportError) => void;
  sentAt: number;
}

function errorCode(e: unknown): string {
  if (e !== null && typeof e === 'object' && 'code' in e && typeof e.code === 'string') return e.code.slice(0, 32);
  return e instanceof Error ? e.name.slice(0, 32) : 'unknown';
}

const MAX_LOGGED_PROBLEMS = 3;

export class UiaHelperClient {
  private child: ChildProcessLike | null = null;
  private generation = 0;
  private startedAt = 0;
  private expectedExit = false;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private discarding = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private exitWaiters: Array<() => void> = [];
  private problemsLogged = 0;
  private stderrLogged = false;
  private lastTimeoutCheckAt = Number.NEGATIVE_INFINITY;
  private readonly maxLineBytes: number;
  private readonly maxPending: number;
  private readonly log: Logger;
  readonly stats: UiaHelperClientStats = {
    spawns: 0,
    lines: 0,
    malformed: 0,
    oversized: 0,
    timeouts: 0,
    orphanResponses: 0,
    helperErrors: 0,
    stderrBytes: 0,
    writeErrors: 0,
  };

  constructor(private readonly o: UiaHelperClientOptions) {
    this.maxLineBytes = o.maxLineBytes ?? MAX_HELPER_LINE_BYTES;
    this.maxPending = o.maxPending ?? 8;
    this.log = o.logger;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Running but asked to stop (quit sent or killed); no new requests are accepted. */
  get stopping(): boolean {
    return this.child !== null && this.expectedExit;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Spawns the helper. Returns false when spawning threw synchronously (reported through onExit
   * as an unexpected exit). Asynchronous spawn errors (ENOENT, blocked by policy) arrive the same way.
   */
  start(): boolean {
    if (this.child) return true;
    const gen = ++this.generation;
    this.expectedExit = false;
    this.buffer = '';
    this.discarding = false;
    this.stderrLogged = false;
    this.startedAt = this.o.now();
    this.lastTimeoutCheckAt = this.startedAt;
    let child: ChildProcessLike;
    try {
      child = this.o.spawn(this.o.helperPath);
    } catch (e) {
      this.o.onExit({ expected: false, code: null, signal: null, error: errorCode(e), uptimeMs: 0 });
      return false;
    }
    this.child = child;
    this.stats.spawns++;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      if (gen === this.generation) this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: string | Buffer) => {
      if (gen === this.generation) this.onStderr(chunk);
    });
    child.stdin?.on('error', () => {
      // EPIPE / EOF after the helper died; the close event reports the exit.
      if (gen === this.generation) this.stats.writeErrors++;
    });
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.on('error', (err: Error) => {
      // Spawn failures never produce a pid; other errors (e.g. a failed kill) are not exits.
      if (child.pid === undefined) this.finish(gen, null, null, errorCode(err));
    });
    // 'close' fires after the process ended and its stdio drained, so no response is lost.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => this.finish(gen, code, signal, null));
    return true;
  }

  /** Sends a request. Resolves with the helper's response (ok or error); rejects only on transport failure. */
  request(req: HelperRequest, now: number): Promise<HelperResponse> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || this.expectedExit || !stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new HelperTransportError('not-running'));
    }
    if (this.pending.size >= this.maxPending) return Promise.reject(new HelperTransportError('busy'));
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_REQUEST_ID ? 1 : this.nextId + 1;
    this.lastTimeoutCheckAt = Math.max(this.lastTimeoutCheckAt, now);
    return new Promise<HelperResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt: now });
      try {
        stdin.write(encodeRequest(id, req));
      } catch {
        this.pending.delete(id);
        this.stats.writeErrors++;
        reject(new HelperTransportError('write-failed'));
      }
    });
  }

  /**
   * Fails requests older than the timeout; returns how many timed out. The owner calls this at
   * least every timeout period; a longer gap since the previous call (or request) means the host
   * itself was stalled or suspended, not the helper, so pending requests get a fresh period instead.
   */
  checkTimeouts(now: number): number {
    const gap = now - this.lastTimeoutCheckAt;
    this.lastTimeoutCheckAt = now;
    if (gap > this.o.requestTimeoutMs) {
      for (const p of this.pending.values()) p.sentAt = Math.max(p.sentAt, now);
      return 0;
    }
    let n = 0;
    for (const [id, p] of this.pending) {
      if (now - p.sentAt < this.o.requestTimeoutMs) continue;
      this.pending.delete(id);
      n++;
      p.reject(new HelperTransportError('timeout'));
    }
    this.stats.timeouts += n;
    return n;
  }

  /** Graceful stop: sends quit, closes stdin (the helper exits on EOF too), kills after the grace period. */
  quit(): void {
    const child = this.child;
    if (!child || this.expectedExit) return;
    this.expectedExit = true;
    try {
      child.stdin?.write(QUIT_LINE);
      child.stdin?.end();
    } catch {
      this.stats.writeErrors++;
    }
    this.killTimer = setTimeout(() => {
      if (this.child === child) {
        this.log.warn('uia helper ignored quit; killing it');
        child.kill();
      }
    }, this.o.quitGraceMs);
    this.killTimer.unref?.();
  }

  /** Immediate stop (hung helper). The resulting exit is reported as expected. */
  kill(): void {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Resolves true once the current process (if any) has exited, false after `timeoutMs`. */
  waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.child) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private finish(gen: number, code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    if (gen !== this.generation || this.child === null) return;
    const expected = this.expectedExit;
    this.child = null;
    this.expectedExit = false;
    this.buffer = '';
    this.discarding = false;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    const err = new HelperTransportError('exited');
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const w of waiters) w();
    this.o.onExit({ expected, code, signal: signal ?? null, error, uptimeMs: Math.max(0, this.o.now() - this.startedAt) });
  }

  private onData(chunk: string): void {
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf('\n');
      if (nl < 0) {
        if (!this.discarding) {
          this.buffer += rest;
          if (this.buffer.length > this.maxLineBytes) {
            this.discarding = true;
            this.buffer = '';
            this.overSized();
          }
        }
        return;
      }
      const part = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const line = this.buffer + part;
      this.buffer = '';
      if (line.length > this.maxLineBytes || Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.overSized();
        continue;
      }
      this.handleLine(line);
    }
  }

  private overSized(): void {
    this.stats.oversized++;
    if (this.problemsLogged++ < MAX_LOGGED_PROBLEMS) this.log.warn('uia helper line too long; dropped', { maxBytes: this.maxLineBytes });
  }

  private handleLine(line: string): void {
    if (line.trim().length === 0) return;
    this.stats.lines++;
    const msg = parseHelperLine(line);
    if (msg === null) {
      this.stats.malformed++;
      // Never log the content: only its size.
      if (this.problemsLogged++ < MAX_LOGGED_PROBLEMS) this.log.warn('uia helper sent a malformed line; dropped', { length: line.length });
      return;
    }
    if (msg.kind === 'event') {
      this.o.onEvent(msg.event);
      return;
    }
    const id = msg.response.id;
    if (id === null) {
      this.stats.helperErrors++;
      if (!msg.response.ok && this.problemsLogged++ < MAX_LOGGED_PROBLEMS) this.log.warn('uia helper reported an error', { error: msg.response.error });
      return;
    }
    const p = this.pending.get(id);
    if (!p) {
      this.stats.orphanResponses++;
      return;
    }
    this.pending.delete(id);
    p.resolve(msg.response);
  }

  private onStderr(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stats.stderrBytes += Buffer.byteLength(text, 'utf8');
    if (!this.stderrLogged) {
      this.stderrLogged = true;
      // Unhandled .NET exceptions land here (type and stack; the helper never writes names).
      this.log.warn('uia helper wrote to stderr', { head: text.slice(0, 200) });
    }
  }
}
