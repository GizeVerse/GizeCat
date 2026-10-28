import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableDelay, BurstAbortedError, MAX_BURST_FRAMES, runBurst } from '../../../src/main/perception/burst';

/** A clock whose sleep advances time instantly and records each wait. */
function fakeClock() {
  let t = 1000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: (ms: number, signal: AbortSignal) => {
      sleeps.push(ms);
      t += ms;
      return signal.aborted ? Promise.reject(new BurstAbortedError('capture cancelled')) : Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runBurst', () => {
  it('starts frame k no earlier than start + k * interval (start to start)', async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    const frames = await runBurst(
      { frames: 3, intervalMs: 150 },
      (i) => {
        starts.push(clock.now());
        clock.advance(40); // the grab itself takes 40 ms
        return Promise.resolve(`f${i}`);
      },
      { signal: new AbortController().signal, release: () => undefined, clock },
    );
    expect(frames).toEqual(['f0', 'f1', 'f2']);
    expect(starts).toEqual([1000, 1150, 1300]);
    expect(clock.sleeps).toEqual([110, 110]);
  });

  it('a grab slower than the interval is followed at once', async () => {
    const clock = fakeClock();
    const starts: number[] = [];
    await runBurst(
      { frames: 3, intervalMs: 150 },
      () => {
        starts.push(clock.now());
        clock.advance(200);
        return Promise.resolve(0);
      },
      { signal: new AbortController().signal, release: () => undefined, clock },
    );
    expect(starts).toEqual([1000, 1200, 1400]);
    expect(clock.sleeps).toEqual([]);
  });

  it('stillClear is asked before every further frame (not the first) and false ends the burst', async () => {
    const clock = fakeClock();
    const asked: number[] = [];
    let grabs = 0;
    const frames = await runBurst(
      { frames: 3, intervalMs: 150 },
      (i) => {
        grabs++;
        return Promise.resolve(i);
      },
      {
        signal: new AbortController().signal,
        release: () => undefined,
        clock,
        stillClear: () => {
          asked.push(grabs);
          return grabs < 2;
        },
      },
    );
    expect(frames).toEqual([0, 1]);
    expect(asked).toEqual([1, 2]);
  });

  it('a failing grab releases every frame taken and rethrows', async () => {
    const released: string[] = [];
    const err = new Error('grab failed');
    await expect(
      runBurst({ frames: 3, intervalMs: 150 }, (i) => (i === 2 ? Promise.reject(err) : Promise.resolve(`f${i}`)), {
        signal: new AbortController().signal,
        release: (f) => released.push(f),
        clock: fakeClock(),
      }),
    ).rejects.toBe(err);
    expect(released).toEqual(['f0', 'f1']);
  });

  it('an abort while waiting, or right after a grab, releases the frames', async () => {
    const ctl = new AbortController();
    const released: number[] = [];
    const clock = fakeClock();
    await expect(
      runBurst(
        { frames: 3, intervalMs: 150 },
        (i) => {
          if (i === 0) ctl.abort();
          return Promise.resolve(i);
        },
        { signal: ctl.signal, release: (f) => released.push(f), clock },
      ),
    ).rejects.toBeInstanceOf(BurstAbortedError);
    expect(released).toEqual([0]);

    const ctl2 = new AbortController();
    const released2: number[] = [];
    await expect(
      runBurst(
        { frames: 3, intervalMs: 150 },
        (i) => Promise.resolve(i),
        {
          signal: ctl2.signal,
          release: (f) => released2.push(f),
          clock: {
            now: () => 0,
            sleep: () => {
              ctl2.abort();
              return Promise.reject(new BurstAbortedError('capture cancelled'));
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(BurstAbortedError);
    expect(released2).toEqual([0]);
  });

  it('clamps the frame count and takes one frame without a plan', async () => {
    const count = async (plan: Parameters<typeof runBurst>[0]) =>
      (await runBurst(plan, (i) => Promise.resolve(i), { signal: new AbortController().signal, release: () => undefined, clock: fakeClock() })).length;
    expect(await count(undefined)).toBe(1);
    expect(await count(null)).toBe(1);
    expect(await count({ frames: 0, intervalMs: 150 })).toBe(1);
    expect(await count({ frames: Number.NaN, intervalMs: 150 })).toBe(1);
    expect(await count({ frames: 99, intervalMs: 150 })).toBe(MAX_BURST_FRAMES);
  });
});

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = abortableDelay(150, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(149);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });

  it('rejects at once when aborted, before or during the wait', async () => {
    vi.useFakeTimers();
    const pre = new AbortController();
    pre.abort();
    await expect(abortableDelay(150, pre.signal)).rejects.toBeInstanceOf(BurstAbortedError);
    const ctl = new AbortController();
    const p = abortableDelay(150, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(BurstAbortedError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
