import { afterEach, describe, expect, it } from 'vitest';
import { makeFrame } from '../../../src/core/perception/frame';
import type { PerceptionService } from '../../../src/main/contracts';
import { createPerceptionServiceWith } from '../../../src/main/perception/service';
import type { PerceptionStatus } from '../../../src/shared/perception';
import type { Settings } from '../../../src/shared/settings';
import type { SimEvent } from '../../../src/shared/sim';
import {
  CONSENT,
  FakeCapturer,
  FakeClock,
  FakeHost,
  JPEG_MARKER,
  MockAdapter,
  REPORT,
  aiLocal,
  flush,
  localStats,
  makeSettings,
  memorySecrets,
  mockFactory,
  recordingLogger,
  window,
} from './fakes';

const noFetch: typeof fetch = () => Promise.reject(new Error('network is not allowed in unit tests'));
const JPEG_B64 = Buffer.from(JPEG_MARKER).toString('base64');
const live: PerceptionService[] = [];
afterEach(() => {
  for (const s of live.splice(0)) s.dispose();
});

function setup(settings: Settings) {
  const clock = new FakeClock();
  const host = new FakeHost();
  const cap = new FakeCapturer();
  const adapter = new MockAdapter();
  const factory = mockFactory(adapter);
  const logger = recordingLogger();
  const svc = createPerceptionServiceWith({ logger, host, secrets: memorySecrets('sk-test-SECRET-KEY-123'), settings, now: clock.now, capture: cap, adapterFactory: factory, fetchImpl: noFetch });
  live.push(svc);
  return { svc, clock, host, cap, adapter, factory, logger };
}

const ofType = <T extends SimEvent['type']>(evs: SimEvent[], t: T) => evs.filter((e): e is Extract<SimEvent, { type: T }> => e.type === t);

async function requestAndSettle(t: ReturnType<typeof setup>, reason: 'curious' | 'watching' | 'periodic' | 'event' = 'event') {
  t.svc.request(reason, null);
  await flush();
}

describe('privacy: nothing is captured unless allowed', () => {
  it('default settings (off): never captures, status off', async () => {
    const t = setup(makeSettings());
    for (let i = 0; i < 5; i++) {
      t.clock.advance(60_000);
      await requestAndSettle(t, 'curious');
    }
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.mode).toBe('off');
    expect(t.svc.status.blockedReason).toBeNull();
    expect((await t.svc.preview()).ok).toBe(false);
    expect(t.cap.requests).toHaveLength(0);
  });

  it('consent missing: never captures, not even for preview or AI test', async () => {
    const t = setup(makeSettings({ perception: { visualMode: 'ai', consentAt: null }, ai: { provider: 'ollama', ollamaModel: 'm' } }));
    for (let i = 0; i < 5; i++) {
      t.clock.advance(60_000);
      await requestAndSettle(t, 'curious');
    }
    const p = await t.svc.preview();
    expect(p.ok).toBe(false);
    expect(p.blockedReason).toMatch(/consent/i);
    await t.svc.testAi(); // synthetic image only
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ mode: 'off', blockedReason: expect.stringMatching(/consent/i) });
  });

  it('paused (runtime or persisted): never captures, preview and AI test refused', async () => {
    const t = setup(aiLocal());
    t.svc.setPaused(true);
    await requestAndSettle(t, 'curious');
    expect((await t.svc.preview()).ok).toBe(false);
    expect((await t.svc.testAi()).ok).toBe(false);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ paused: true, blockedReason: expect.stringMatching(/paused/i) });

    t.svc.setPaused(false);
    t.svc.updateSettings(aiLocal({ perception: { paused: true } }));
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.paused).toBe(true);

    t.svc.updateSettings(aiLocal());
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(1);
  });

  it('excluded foreground app: blocked with a reason', async () => {
    const t = setup(localStats());
    t.host.foreground = window({ excluded: true, processName: 'keepassxc.exe' });
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/private app/i);
    expect((await t.svc.preview()).blockedReason).toMatch(/private app/i);
  });

  it('excluded window inside the capture area: blocked', async () => {
    const t = setup(localStats());
    t.host.excludedAt = (p) => p.x > 1100 && p.x < 1300 && p.y > 600 && p.y < 800;
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/private window/i);
  });

  it('locked screen: blocked', async () => {
    const t = setup(localStats());
    t.host.locked = true;
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/locked/i);
  });

  it('a blocked gate is not re-evaluated on every request (bounded host calls)', async () => {
    const t = setup(localStats());
    let samples = 0;
    t.host.excludedAt = () => {
      samples++;
      return true;
    };
    for (let i = 0; i < 100; i++) t.svc.request('event', null);
    await flush();
    expect(samples).toBe(1); // first sample hit -> blocked, then throttled
    t.host.excludedAt = () => false;
    t.clock.advance(1_999);
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    t.clock.advance(1);
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
    expect(t.svc.status.blockedReason).toBeNull();
  });

  it('a request dropped by the throttle is replayed once, so the status follows the screen (real clock)', async () => {
    const host = new FakeHost();
    const cap = new FakeCapturer();
    const svc = createPerceptionServiceWith({ logger: recordingLogger(), host, secrets: memorySecrets(), settings: localStats(), capture: cap, fetchImpl: noFetch });
    live.push(svc);
    host.foreground = window({ excluded: true });
    svc.request('event', null);
    await flush();
    expect(svc.status.blockedReason).toMatch(/private app/i);
    host.foreground = window();
    svc.request('event', null); // e.g. the foreground-change request, inside the 2 s window
    await flush();
    expect(cap.requests).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 2300));
    await flush();
    expect(cap.requests).toHaveLength(1);
    expect(svc.status.blockedReason).toBeNull();
  });

  it('host state unavailable: fails closed', async () => {
    const t = setup(localStats());
    t.host.isLocked = () => {
      throw new Error('gone');
    };
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/could not check/i);
  });

  it('cloud refused without allowCloud: local stats run, no JPEG is made, the adapter is never built', async () => {
    for (const ai of [
      { provider: 'anthropic' as const },
      { provider: 'openai-compatible' as const, openaiBaseUrl: 'https://api.example.com/v1', openaiModel: 'gpt-x' },
      { provider: 'ollama' as const, ollamaModel: 'gpt-oss:120b-cloud' },
    ]) {
      const t = setup(aiLocal({ ai }));
      await requestAndSettle(t, 'curious');
      expect(t.cap.requests).toHaveLength(1);
      expect(t.cap.requests[0]!.jpeg).toBeNull();
      expect(t.factory.calls).toBe(0);
      expect(t.adapter.calls).toHaveLength(0);
      expect(t.svc.status).toMatchObject({ mode: 'local-stats', aiProviderLabel: null, blockedReason: expect.stringMatching(/Allow cloud/) });
      const test = await t.svc.testAi();
      expect(test).toMatchObject({ ok: false, message: expect.stringMatching(/Allow cloud/) });
      expect((await t.svc.listModels()).ok).toBe(false);
      expect(t.factory.calls).toBe(0);
    }
  });

  it('the world changing during capture drops the frame (post-capture re-check)', async () => {
    const t = setup(aiLocal());
    t.cap.during = () => {
      t.host.foreground = window({ excluded: true });
    };
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(1);
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/private app/i);
  });

  it('revoking consent mid-capture drops the frame', async () => {
    const t = setup(aiLocal());
    t.cap.during = () => t.svc.updateSettings(aiLocal({ perception: { consentAt: null } }));
    await requestAndSettle(t, 'curious');
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
  });

  it('switching to a cloud provider mid-capture stops the AI call (egress re-checked at send time)', async () => {
    const t = setup(aiLocal());
    t.cap.during = () => t.svc.updateSettings(aiLocal({ ai: { provider: 'anthropic', allowCloud: false } }));
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(0);
  });
});

describe('local statistics (Tier B)', () => {
  it('captures the region around the cat, masks the cat, emits a visual summary', async () => {
    const t = setup(localStats());
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
    const req = t.cap.requests[0]!;
    expect(req.regionPx).toEqual({ x: 800, y: 500, width: 800, height: 500 });
    expect(req.jpeg).toBeNull();
    expect(req.analysisMaxWidth).toBe(256);
    expect(req.maskRectsPx[0]).toEqual({ x: 1138, y: 688, width: 124, height: 124 });
    const visual = ofType(t.svc.drainEvents(), 'perception.visual');
    expect(visual).toHaveLength(1);
    expect(visual[0]!.summary.events).toContain('dark');
    expect(visual[0]!.summary.regionPx).toEqual(req.regionPx);
    expect(visual[0]!.summary.features.changeFraction).toBeNull();
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', lastCaptureAt: t.clock.t, capturesThisHour: 1, lastError: null, blockedReason: null });
  });

  it('respects the minimum capture interval and reports change between frames', async () => {
    const t = setup(localStats());
    await requestAndSettle(t);
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
    t.clock.advance(19_999);
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
    t.clock.advance(1);
    t.svc.drainEvents();
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(2);
    const [ev] = ofType(t.svc.drainEvents(), 'perception.visual');
    expect(ev!.summary.features.changeFraction).toBe(1);
    expect(ev!.summary.events).toContain('bigChange');
    expect(ev!.summary.changeCenterPx).toEqual({ x: 1200, y: 750 });
  });

  it('only one capture runs at a time', async () => {
    const t = setup(localStats({ perception: { minIntervalSec: 5 } }));
    let release!: () => void;
    t.cap.gate = new Promise((r) => (release = r));
    t.svc.request('event', null);
    t.clock.advance(10_000);
    t.svc.request('event', null);
    await flush();
    expect(t.cap.requests).toHaveLength(1);
    release();
    await flush();
  });

  it('a quiet unchanged screen produces no repeated events once labels are empty', async () => {
    const t = setup(localStats());
    // mid-grey, mid-edges: no labels apply
    t.cap.frameFor = () => makeFrame(256, 160, (x, y) => ((x >> 2) + (y >> 4)) % 7 === 0 ? [140, 140, 140] : [120, 120, 120]);
    await requestAndSettle(t);
    t.svc.drainEvents();
    t.clock.advance(20_000);
    await requestAndSettle(t);
    const evs = ofType(t.svc.drainEvents(), 'perception.visual');
    for (const e of evs) expect(e.summary.events.length > 0 || (e.summary.features.changeFraction ?? 0) >= 0.05).toBe(true);
  });

  it('the event queue is bounded', async () => {
    const t = setup(localStats({ perception: { minIntervalSec: 5 } }));
    for (let i = 0; i < 45; i++) {
      await requestAndSettle(t);
      t.clock.advance(5_000);
    }
    expect(t.cap.requests.length).toBeGreaterThanOrEqual(40);
    expect(t.svc.drainEvents().length).toBe(32);
    expect(t.svc.drainEvents()).toEqual([]);
  });
});

describe('AI vision (Tier C)', () => {
  it('sends the masked JPEG to the adapter and emits a validated scene report', async () => {
    const t = setup(aiLocal());
    expect(t.svc.status).toMatchObject({ mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)' });
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests[0]!.jpeg).toEqual({ maxWidth: 512, quality: 60 });
    expect(t.adapter.calls).toHaveLength(1);
    expect(t.adapter.calls[0]!.base64).toBe(JPEG_B64);
    const ai = ofType(t.svc.drainEvents(), 'perception.ai');
    expect(ai).toEqual([{ type: 'perception.ai', report: REPORT, regionPx: { x: 800, y: 500, width: 800, height: 500 } }]);
  });

  it('respects the AI interval and only asks after a significant change or curiosity', async () => {
    const t = setup(aiLocal());
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(1);
    t.clock.advance(20_000); // capture allowed, AI (30 s) not
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(2);
    expect(t.cap.requests[1]!.jpeg).toBeNull();
    expect(t.adapter.calls).toHaveLength(1);

    t.cap.frameFor = () => makeFrame(256, 160, () => [90, 90, 90]);
    t.clock.advance(40_000);
    await requestAndSettle(t, 'periodic'); // new baseline after the frame change: big change -> AI
    expect(t.adapter.calls).toHaveLength(2);
    t.clock.advance(40_000);
    await requestAndSettle(t, 'periodic'); // unchanged screen, not curious -> no AI
    expect(t.cap.requests).toHaveLength(4);
    expect(t.adapter.calls).toHaveLength(2);
    t.clock.advance(40_000);
    await requestAndSettle(t, 'curious'); // curiosity -> AI
    expect(t.adapter.calls).toHaveLength(3);
  });

  it('enforces the hourly AI budget', async () => {
    const t = setup(aiLocal({ ai: { minIntervalSec: 30, maxPerHour: 2 } }));
    for (let i = 0; i < 5; i++) {
      await requestAndSettle(t, 'curious');
      t.clock.advance(31_000);
    }
    expect(t.adapter.calls).toHaveLength(2);
  });

  it('junk from the model is not emitted and is reported', async () => {
    const t = setup(aiLocal());
    t.adapter.impl = () => Promise.resolve({ ok: false, kind: 'invalid-output', message: 'The model answer did not match the expected format.', latencyMs: 5 });
    await requestAndSettle(t, 'curious');
    expect(ofType(t.svc.drainEvents(), 'perception.ai')).toEqual([]);
    expect(t.svc.status.lastError).toMatch(/expected format/);
  });

  it('circuit breaker: 3 failures open it for 1 minute, then one probe', async () => {
    const t = setup(aiLocal());
    t.adapter.impl = () => Promise.resolve({ ok: false, kind: 'network', message: 'Could not connect to Ollama (this PC). Is it running?', latencyMs: 2 });
    for (let i = 0; i < 3; i++) {
      await requestAndSettle(t, 'curious');
      t.clock.advance(31_000);
    }
    expect(t.adapter.calls).toHaveLength(3);
    expect(t.svc.status.lastError).toMatch(/paused for 1 min/);
    // 31 s after the third failure: still open
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(3);
    expect(t.cap.requests.at(-1)!.jpeg).toBeNull();
    t.clock.advance(31_000); // 62 s after the trip: half-open probe
    t.adapter.impl = () => Promise.resolve({ ok: true, report: REPORT, latencyMs: 3 });
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(4);
    expect(t.svc.status.lastError).toBeNull();
    expect(ofType(t.svc.drainEvents(), 'perception.ai')).toHaveLength(1);
  });

  it('setPaused(true) aborts an in-flight AI request immediately', async () => {
    const t = setup(aiLocal());
    t.adapter.impl = (_img, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', message: 'The request was cancelled.', latencyMs: 0 })));
    await requestAndSettle(t, 'curious');
    const signal = t.adapter.calls[0]!.signal!;
    expect(signal.aborted).toBe(false);
    t.svc.setPaused(true);
    expect(signal.aborted).toBe(true);
    await flush();
    expect(ofType(t.svc.drainEvents(), 'perception.ai')).toEqual([]);
    expect(t.svc.status.lastError).toBeNull();
    t.svc.setPaused(false);
    t.adapter.impl = () => Promise.resolve({ ok: true, report: REPORT, latencyMs: 3 });
    t.clock.advance(31_000);
    await requestAndSettle(t, 'curious');
    expect(ofType(t.svc.drainEvents(), 'perception.ai')).toHaveLength(1); // breaker untouched by the abort
  });

  it('setPaused(true) during a capture discards the frame', async () => {
    const t = setup(aiLocal());
    let release!: () => void;
    t.cap.gate = new Promise((r) => (release = r));
    t.svc.request('curious', null);
    await flush();
    t.svc.setPaused(true);
    release();
    await flush();
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
  });

  it('turning AI settings off aborts the in-flight request', async () => {
    const t = setup(aiLocal());
    t.adapter.impl = (_img, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', message: 'x', latencyMs: 0 })));
    await requestAndSettle(t, 'curious');
    t.svc.updateSettings(localStats());
    expect(t.adapter.calls[0]!.signal!.aborted).toBe(true);
    expect(t.svc.status.mode).toBe('local-stats');
  });

  it('missing model or key: AI reported as not running, no JPEG made, no call', async () => {
    const t = setup(aiLocal({ ai: { ollamaModel: '' } }));
    expect(t.svc.status.blockedReason).toMatch(/Choose an Ollama vision model/);
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests[0]!.jpeg).toBeNull();
    expect(t.adapter.calls).toHaveLength(0);

    const noKey = createPerceptionServiceWith({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(null),
      settings: aiLocal({ ai: { provider: 'anthropic', allowCloud: true } }),
      now: new FakeClock().now,
      capture: new FakeCapturer(),
      adapterFactory: mockFactory(new MockAdapter()),
      fetchImpl: noFetch,
    });
    expect(noKey.status).toMatchObject({ mode: 'ai-cloud', aiProviderLabel: 'Anthropic (cloud)', blockedReason: expect.stringMatching(/No Anthropic API key/) });
    noKey.dispose();
  });

  it('provider none: AI reported as not running', () => {
    const t = setup(aiLocal({ ai: { provider: 'none' } }));
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', blockedReason: expect.stringMatching(/No AI provider/) });
  });

  it('logs never contain image data, captions or keys', async () => {
    const t = setup(aiLocal());
    await requestAndSettle(t, 'curious');
    t.adapter.impl = () => Promise.resolve({ ok: false, kind: 'http', message: 'Ollama reported a server error (HTTP 500).', status: 500, latencyMs: 1 });
    t.clock.advance(31_000);
    await requestAndSettle(t, 'curious');
    const text = JSON.stringify(t.logger.entries);
    expect(text).not.toContain(JPEG_B64);
    expect(text).not.toContain(REPORT.caption);
    expect(text).not.toContain('SECRET-KEY');
    expect(t.logger.entries.some((e) => e.msg.includes('ai request failed'))).toBe(true);
  });
});

describe('preview, test, models, status, dispose', () => {
  it('preview returns the masked analysis frame as PNG + summary, rate-limited, without touching the main baseline', async () => {
    const t = setup(localStats());
    const p = await t.svc.preview();
    expect(p.ok).toBe(true);
    expect(p.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(p.summary!.events).toContain('dark');
    expect(t.cap.requests[0]!.jpeg).toBeNull();
    expect(t.cap.requests[0]!.maskRectsPx.length).toBeGreaterThan(0);
    expect(t.svc.drainEvents()).toEqual([]);
    expect((await t.svc.preview()).blockedReason).toMatch(/wait/i);
    await requestAndSettle(t);
    const [ev] = ofType(t.svc.drainEvents(), 'perception.visual');
    expect(ev!.summary.features.changeFraction).toBeNull();
    expect(t.svc.status.capturesThisHour).toBe(2);
  });

  it('testAi uses a synthetic image, never the screen', async () => {
    const t = setup(aiLocal());
    const r = await t.svc.testAi();
    expect(r).toMatchObject({ ok: true, report: REPORT, latencyMs: 12 });
    expect(r.message).toMatch(/answered in 12 ms/);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.cap.jpegCalls).toBe(1);
    expect(t.adapter.calls[0]!.base64).toBe(JPEG_B64);
    expect((await t.svc.testAi()).message).toMatch(/wait/i);
  });

  it('listModels goes through the adapter', async () => {
    const t = setup(aiLocal());
    expect(await t.svc.listModels()).toEqual({ ok: true, models: ['qwen3-vl:4b-instruct'] });
  });

  it('status changes are notified; unsubscribe stops them', () => {
    const t = setup(localStats());
    const seen: PerceptionStatus[] = [];
    const off = t.svc.onStatusChange((s) => seen.push(s));
    t.svc.setPaused(true);
    expect(seen.at(-1)).toMatchObject({ paused: true });
    t.svc.setPaused(true);
    expect(seen).toHaveLength(1);
    off();
    t.svc.setPaused(false);
    expect(seen).toHaveLength(1);
  });

  it('a throwing status listener does not break the service', async () => {
    const t = setup(localStats());
    t.svc.onStatusChange(() => {
      throw new Error('ui gone');
    });
    t.svc.setPaused(true);
    t.svc.setPaused(false);
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
  });

  it('dispose aborts work and makes the service inert', async () => {
    const t = setup(aiLocal());
    t.adapter.impl = (_img, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', message: 'x', latencyMs: 0 })));
    await requestAndSettle(t, 'curious');
    t.svc.dispose();
    expect(t.adapter.calls[0]!.signal!.aborted).toBe(true);
    t.clock.advance(60_000);
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(1);
    expect(t.svc.drainEvents()).toEqual([]);
    expect((await t.svc.preview()).ok).toBe(false);
  });

  it('settings with consent use the default 20 s interval and 120/h capture budget', async () => {
    const t = setup(localStats({ perception: { minIntervalSec: 5, consentAt: CONSENT } }));
    for (let i = 0; i < 130; i++) {
      await requestAndSettle(t);
      t.clock.advance(5_000);
    }
    expect(t.cap.requests.length).toBe(120);
  });
});
