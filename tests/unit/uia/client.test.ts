// UiaHelperClient against the fake helper process (MOCKED helper, real child process and pipes).
// Timeouts use the injected clock: requests carry the caller's `now`, checkTimeouts(now) decides.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelperTransportError, spawnUiaHelper, UiaHelperClient, type HelperExit } from '../../../src/main/uia/client';
import type { HelperEvent } from '../../../src/main/uia/protocol';
import { eventually, fakeHelperHarness, ManualClock, memoryLogger, type FakeHelperHarness } from './harness';
import { wireStrip } from './fixtures';

const H = '65552';

interface Rig {
  h: FakeHelperHarness;
  clock: ManualClock;
  client: UiaHelperClient;
  exits: HelperExit[];
  events: HelperEvent[];
  log: ReturnType<typeof memoryLogger>;
}

const rigs: Rig[] = [];

function rig(state: Parameters<typeof fakeHelperHarness>[0] = {}, opts: { maxLineBytes?: number; quitGraceMs?: number; maxPending?: number } = {}): Rig {
  const h = fakeHelperHarness(state);
  const clock = new ManualClock();
  const exits: HelperExit[] = [];
  const events: HelperEvent[] = [];
  const log = memoryLogger();
  const client = new UiaHelperClient({
    helperPath: 'fake.exe',
    spawn: h.spawnHelper,
    logger: log,
    now: clock.now,
    requestTimeoutMs: 1500,
    quitGraceMs: opts.quitGraceMs ?? 2000,
    maxLineBytes: opts.maxLineBytes,
    maxPending: opts.maxPending,
    onEvent: (e) => events.push(e),
    onExit: (e) => exits.push(e),
  });
  const r = { h, clock, client, exits, events, log };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.client.kill();
    await r.client.waitForExit(3000);
    await r.h.cleanup();
  }
});

describe('UiaHelperClient', () => {
  it('matches responses to requests', async () => {
    const r = rig({ strips: { [H]: wireStrip({ browser: 'edge' }) } });
    expect(r.client.start()).toBe(true);
    const pong = await r.client.request({ op: 'ping' }, r.clock.now());
    expect(pong).toMatchObject({ ok: true, pong: true, version: 1, dpi: 'permonitorv2' });
    const [a, b] = await Promise.all([r.client.request({ op: 'strip', hwnd: H }, r.clock.now()), r.client.request({ op: 'strip', hwnd: '999' }, r.clock.now())]);
    expect(a.ok && a.strip?.tabs.length).toBe(3);
    expect(b).toMatchObject({ ok: false, error: 'not-found' });
    expect(r.client.pendingCount).toBe(0);
  });

  it('fails requests that outlive the timeout (injected clock)', async () => {
    const r = rig({ hang: ['strip'] });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    const p = r.client.request({ op: 'strip', hwnd: H }, r.clock.now());
    const settled = vi.fn();
    p.catch(settled);
    r.clock.advance(1499);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(0);
    r.clock.advance(1);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(1);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
    expect(r.client.stats.timeouts).toBe(1);
    // The helper is still running; the owner decides what to do (the service kills it).
    expect(r.client.running).toBe(true);
  });

  it('names the requests that timed out, in the order they were sent (the first is the one the helper is stuck in)', async () => {
    const r = rig({ strips: { [H]: wireStrip({ browser: 'edge' }) }, hangHwnds: ['777'] });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    const stuck = r.client.request({ op: 'strip', hwnd: '777' }, r.clock.now());
    const behind = r.client.request({ op: 'strip', hwnd: H }, r.clock.advance(100));
    const later = r.client.request({ op: 'watch', hwnds: [H] }, r.clock.advance(100));
    for (const p of [stuck, behind, later]) p.catch(() => undefined);
    const timedOut: Parameters<UiaHelperClient['request']>[0][] = [];
    r.clock.advance(1400);
    expect(r.client.checkTimeouts(r.clock.now(), timedOut)).toBe(2);
    expect(timedOut).toEqual([
      { op: 'strip', hwnd: '777' },
      { op: 'strip', hwnd: H },
    ]);
    await expect(behind).rejects.toMatchObject({ code: 'timeout' });
    expect(r.client.pendingCount).toBe(1);
  });

  it('treats a long gap between checks as a host stall (sleep/resume), not a helper hang', async () => {
    const r = rig({ hang: ['strip'] });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    const p = r.client.request({ op: 'strip', hwnd: H }, r.clock.now());
    p.catch(() => undefined);
    r.clock.advance(10_000);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(0);
    r.clock.advance(1000);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(0);
    r.clock.advance(500);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(1);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('drops malformed lines and keeps going', async () => {
    const r = rig({ garbageBefore: true });
    r.client.start();
    const pong = await r.client.request({ op: 'ping' }, r.clock.now());
    expect(pong.ok).toBe(true);
    expect(r.client.stats.malformed).toBe(1);
    // Only the size is logged, never the content.
    const warn = r.log.entries.find((e) => e.msg.includes('malformed'));
    expect(warn?.data).toEqual({ length: '{"id":'.length });
  });

  it('drops lines over the size cap (64 KB default) without parsing them', async () => {
    const r = rig({ oversizeBefore: 70 * 1024 });
    r.client.start();
    const pong = await r.client.request({ op: 'ping' }, r.clock.now());
    expect(pong.ok).toBe(true);
    expect(r.client.stats.oversized).toBe(1);
    expect(r.client.stats.orphanResponses).toBe(0);
  });

  it('honours a smaller cap', async () => {
    const r = rig({ strips: { [H]: wireStrip({ browser: 'edge', tabs: 24 }) } }, { maxLineBytes: 512 });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    const p = r.client.request({ op: 'strip', hwnd: H }, r.clock.now());
    await eventually(() => expect(r.client.stats.oversized).toBe(1));
    r.clock.advance(1500);
    expect(r.client.checkTimeouts(r.clock.now())).toBe(1);
    await expect(p).rejects.toBeInstanceOf(HelperTransportError);
  });

  it('a crash rejects pending requests and reports an unexpected exit', async () => {
    const r = rig({ exitAfterRequests: 1 });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    await expect(r.client.request({ op: 'strip', hwnd: H }, r.clock.now())).rejects.toMatchObject({ code: 'exited' });
    await eventually(() => expect(r.exits).toHaveLength(1));
    expect(r.exits[0]).toMatchObject({ expected: false, code: 3, error: null });
    expect(r.client.running).toBe(false);
    await expect(r.client.request({ op: 'ping' }, r.clock.now())).rejects.toMatchObject({ code: 'not-running' });
  });

  it('quit is an expected exit', async () => {
    const r = rig();
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    r.client.quit();
    expect(r.client.stopping).toBe(true);
    await expect(r.client.request({ op: 'ping' }, r.clock.now())).rejects.toMatchObject({ code: 'not-running' });
    expect(await r.client.waitForExit(5000)).toBe(true);
    expect(r.exits).toEqual([expect.objectContaining({ expected: true, code: 0 })]);
  });

  it('kills a helper that ignores quit after the grace period', async () => {
    const r = rig({ ignoreQuit: true }, { quitGraceMs: 100 });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    r.client.quit();
    expect(await r.client.waitForExit(5000)).toBe(true);
    expect(r.exits[0]?.expected).toBe(true);
    expect(r.log.entries.some((e) => e.msg.includes('ignored quit'))).toBe(true);
  });

  it('forwards events and refuses more than maxPending requests', async () => {
    const r = rig({ hang: ['strip'] }, { maxPending: 2 });
    r.client.start();
    await r.client.request({ op: 'ping' }, r.clock.now());
    r.h.emit('selected', H);
    await eventually(() => expect(r.events).toEqual([{ event: 'selected', hwnd: H }]));
    const a = r.client.request({ op: 'strip', hwnd: H }, r.clock.now());
    const b = r.client.request({ op: 'strip', hwnd: H }, r.clock.now());
    a.catch(() => undefined);
    b.catch(() => undefined);
    await expect(r.client.request({ op: 'strip', hwnd: H }, r.clock.now())).rejects.toMatchObject({ code: 'busy' });
  });

  it('reports a helper that cannot be spawned (ENOENT) as an unexpected exit', async () => {
    const exits: HelperExit[] = [];
    const client = new UiaHelperClient({
      helperPath: 'C:\\definitely\\not\\here\\DesktopCatUia.exe',
      spawn: spawnUiaHelper,
      logger: memoryLogger(),
      now: () => 0,
      requestTimeoutMs: 1500,
      quitGraceMs: 100,
      onEvent: () => undefined,
      onExit: (e) => exits.push(e),
    });
    client.start();
    await eventually(() => expect(exits).toHaveLength(1));
    expect(exits[0]).toMatchObject({ expected: false, error: 'ENOENT' });
    expect(client.running).toBe(false);
  });
});
