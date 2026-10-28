import { describe, expect, it } from 'vitest';
import { CircuitBreaker, RateLimiter } from '../../../../src/core/perception/limits';

const MIN = 60_000;

describe('RateLimiter', () => {
  it('enforces the minimum interval', () => {
    const l = new RateLimiter({ minIntervalMs: 20_000, maxPerWindow: 100 });
    expect(l.check(0)).toEqual({ ok: true });
    l.record(0);
    expect(l.check(19_999)).toEqual({ ok: false, reason: 'interval', retryInMs: 1 });
    expect(l.check(20_000)).toEqual({ ok: true });
  });

  it('enforces a sliding hourly budget', () => {
    const l = new RateLimiter({ minIntervalMs: 0, maxPerWindow: 3 });
    l.record(0);
    l.record(1000);
    l.record(2000);
    const c = l.check(3000);
    expect(c).toEqual({ ok: false, reason: 'budget', retryInMs: 3_600_000 - 3000 });
    expect(l.count(3000)).toBe(3);
    expect(l.check(3_600_000).ok).toBe(true); // first stamp slid out
    expect(l.count(3_600_000)).toBe(2);
    expect(l.count(3_602_001)).toBe(0);
  });

  it('survives the clock jumping backwards without blocking for long', () => {
    const l = new RateLimiter({ minIntervalMs: 10_000, maxPerWindow: 10 });
    l.record(1_000_000);
    const back = 1_000;
    const c = l.check(back);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.retryInMs).toBeLessThanOrEqual(10_000);
    expect(l.check(back + 10_000).ok).toBe(true);
  });

  it('can be reconfigured and reset', () => {
    const l = new RateLimiter({ minIntervalMs: 60_000, maxPerWindow: 1 });
    l.record(0);
    l.configure({ minIntervalMs: 0, maxPerWindow: 5 });
    expect(l.check(1).ok).toBe(true);
    l.reset();
    expect(l.count(2)).toBe(0);
  });
});

describe('CircuitBreaker', () => {
  it('opens after 3 consecutive failures and half-opens after 1 minute', () => {
    const b = new CircuitBreaker();
    b.recordFailure(0);
    b.recordFailure(1);
    expect(b.state(2)).toBe('closed');
    b.recordFailure(2);
    expect(b.state(3)).toBe('open');
    expect(b.canRequest(MIN)).toBe(false);
    expect(b.retryInMs(2)).toBe(MIN);
    expect(b.state(2 + MIN)).toBe('half-open');
  });

  it('a success in between resets the consecutive count', () => {
    const b = new CircuitBreaker();
    b.recordFailure(0);
    b.recordFailure(1);
    b.recordSuccess();
    b.recordFailure(2);
    b.recordFailure(3);
    expect(b.state(4)).toBe('closed');
  });

  it('allows exactly one half-open probe', () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.recordFailure(0);
    expect(b.tryAcquire(MIN)).toBe(true);
    expect(b.tryAcquire(MIN)).toBe(false);
    expect(b.canRequest(MIN)).toBe(false);
    b.releaseProbe();
    expect(b.tryAcquire(MIN)).toBe(true);
  });

  it('backs off exponentially from 1 to 30 minutes and recovers on success', () => {
    const b = new CircuitBreaker();
    let now = 0;
    for (let i = 0; i < 3; i++) b.recordFailure(now);
    const waits: number[] = [b.retryInMs(now)];
    for (let trip = 0; trip < 7; trip++) {
      now += b.retryInMs(now);
      expect(b.tryAcquire(now)).toBe(true);
      b.recordFailure(now); // failed probe re-opens immediately
      waits.push(b.retryInMs(now));
    }
    expect(waits.map((w) => w / MIN)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    now += b.retryInMs(now);
    expect(b.tryAcquire(now)).toBe(true);
    b.recordSuccess();
    expect(b.state(now)).toBe('closed');
    for (let i = 0; i < 3; i++) b.recordFailure(now);
    expect(b.retryInMs(now)).toBe(MIN);
  });

  it('closed breaker always allows requests', () => {
    const b = new CircuitBreaker();
    expect(b.tryAcquire(0)).toBe(true);
    expect(b.tryAcquire(0)).toBe(true);
  });
});
