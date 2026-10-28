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

/** `prepare` runs before the service exists (it asks the server about the model right away). */
function setup(settings: Settings, prepare?: (adapter: MockAdapter) => void) {
  const clock = new FakeClock();
  const host = new FakeHost();
  const cap = new FakeCapturer();
  const adapter = new MockAdapter();
  prepare?.(adapter);
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

  it('paused (runtime or persisted): never captures or previews; only the user pause refuses the synthetic AI test', async () => {
    const t = setup(aiLocal());
    // Runtime pause = the host's temporary suspension (cat hidden / screen locked).
    t.svc.setPaused(true);
    await requestAndSettle(t, 'curious');
    expect((await t.svc.preview()).ok).toBe(false);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ paused: true, blockedReason: expect.stringMatching(/paused/i) });
    // The AI test only sends a synthetic picture, so a hidden cat does not block it.
    const test = await t.svc.testAi();
    expect(test.ok).toBe(true);
    expect(t.cap.requests).toHaveLength(0);

    t.svc.setPaused(false);
    t.svc.updateSettings(aiLocal({ perception: { paused: true } }));
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.paused).toBe(true);
    expect((await t.svc.testAi()).message).toMatch(/paused/i);

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

  it('a private dialog or popup in front (not an app window) blocks capture via the host verdict', async () => {
    const t = setup(localStats());
    t.host.foreground = window({ excluded: false, processName: 'notepad.exe' });
    t.host.foregroundExcluded = true;
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/private app/i);
    expect((await t.svc.preview()).ok).toBe(false);
  });

  it('the foreground verdict failing blocks capture (fail closed)', async () => {
    const t = setup(localStats());
    t.host.isForegroundExcluded = () => {
      throw new Error('enumeration failed');
    };
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).not.toBeNull();
  });

  it('a mask covering the whole region (fail-closed answer) blocks instead of analysing a black frame', async () => {
    const t = setup(localStats());
    t.host.excludedRects = [{ x: -100000, y: -100000, width: 200000, height: 200000 }];
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(0);
    expect(t.svc.status.blockedReason).toMatch(/private window/i);
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
      // Ollama's OpenAI-compatible API on this PC forwards "-cloud" models to ollama.com as well.
      { provider: 'openai-compatible' as const, openaiBaseUrl: 'http://127.0.0.1:11434/v1', openaiModel: 'qwen3-vl:235b-cloud' },
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
      expect(t.factory.calls).toBe(0);
      expect(t.adapter.calls).toHaveLength(0);
    }
  });

  it('listing models is refused only for endpoints off this PC, never because of the typed model', async () => {
    for (const ai of [{ provider: 'anthropic' as const }, { provider: 'openai-compatible' as const, openaiBaseUrl: 'https://api.example.com/v1', openaiModel: 'gpt-x' }]) {
      const t = setup(aiLocal({ ai }));
      expect(await t.svc.listModels()).toMatchObject({ ok: false, error: expect.stringMatching(/not on this PC/) });
      expect(t.factory.calls).toBe(0);
    }
    for (const ai of [
      { provider: 'ollama' as const, ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: 'gpt-oss:120b-cloud' },
      { provider: 'openai-compatible' as const, openaiBaseUrl: 'http://127.0.0.1:11434/v1', openaiModel: 'qwen3-vl:235b-cloud' },
    ]) {
      const t = setup(aiLocal({ ai }));
      expect(await t.svc.listModels()).toEqual({ ok: true, models: ['qwen3-vl:4b-instruct'] });
      expect(t.adapter.calls).toHaveLength(0);
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

  it('a private window that appears inside the region during the grab drops the frame (masks re-checked)', async () => {
    const t = setup(aiLocal());
    // Between the 5x5 sample points, so only the refreshed mask list can see it.
    t.cap.during = () => {
      t.host.excludedRects = [{ x: 805, y: 505, width: 60, height: 40 }];
    };
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(1);
    expect(t.cap.requests[0]!.maskRectsPx).not.toContainEqual({ x: 805, y: 505, width: 60, height: 40 });
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);

    // Next time it is part of the masks the frame is taken with, and the frame is used.
    t.cap.during = null;
    t.clock.advance(31_000);
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests[1]!.maskRectsPx).toContainEqual({ x: 805, y: 505, width: 60, height: 40 });
    expect(t.adapter.calls).toHaveLength(1);
  });

  it('a private window that moves during the grab drops the frame; one that stays put does not', async () => {
    const t = setup(aiLocal());
    t.host.excludedRects = [{ x: 0, y: 0, width: 900, height: 600 }];
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(1);
    t.cap.during = () => {
      t.host.excludedRects = [{ x: 0, y: 0, width: 1000, height: 600 }];
    };
    t.clock.advance(31_000);
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(1);
    expect(t.svc.drainEvents().filter((e) => e.type === 'perception.visual')).toHaveLength(1);
  });

  it('the exclusion list failing after the grab drops the frame (fail closed)', async () => {
    const t = setup(localStats());
    t.cap.during = () => {
      t.host.getExcludedRects = () => {
        throw new Error('win32 gone');
      };
    };
    await requestAndSettle(t);
    expect(t.cap.requests).toHaveLength(1);
    expect(t.svc.drainEvents()).toEqual([]);
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

describe('where the model runs (a server on this PC may forward it to the cloud)', () => {
  const remote = () => Promise.resolve({ ok: true as const, locality: 'remote' as const, latencyMs: 1 });

  it('until the server confirms the model, AI is not running and nothing is sent (fail closed)', async () => {
    let answer!: () => void;
    const t = setup(aiLocal(), (a) => {
      a.localityImpl = () => new Promise((resolve) => (answer = () => resolve({ ok: true, locality: 'local', latencyMs: 1 })));
    });
    t.svc.request('curious', null);
    await flush();
    // A capture waiting for the answer has not started yet, and no image exists.
    expect(t.cap.requests).toHaveLength(0);
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', aiProviderLabel: null, blockedReason: expect.stringMatching(/not yet confirmed/) });
    answer();
    await flush();
    expect(t.adapter.localityCalls).toBe(1);
    expect(t.svc.status).toMatchObject({ mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)', blockedReason: null });
    expect(t.cap.requests[0]!.jpeg).not.toBeNull();
    expect(t.adapter.calls).toHaveLength(1);
  });

  it('an Ollama alias of a cloud model (server reports remote) needs "Allow cloud" and is labelled cloud', async () => {
    const t = setup(aiLocal({ ai: { ollamaModel: 'myvision' } }), (a) => (a.localityImpl = remote));
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests[0]!.jpeg).toBeNull();
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', aiProviderLabel: null, blockedReason: expect.stringMatching(/runs in the cloud.*Allow cloud/) });
    expect(await t.svc.testAi()).toMatchObject({ ok: false, message: expect.stringMatching(/runs in the cloud/) });
    expect(t.adapter.calls).toHaveLength(0);

    t.svc.updateSettings(aiLocal({ ai: { ollamaModel: 'myvision', allowCloud: true } }));
    await flush();
    expect(t.svc.status).toMatchObject({ mode: 'ai-cloud', aiProviderLabel: 'Ollama (cloud model)' });
  });

  it('the same holds for an OpenAI-compatible server on this PC (Ollama /v1)', async () => {
    const t = setup(aiLocal({ ai: { provider: 'openai-compatible', openaiBaseUrl: 'http://127.0.0.1:11434/v1', openaiModel: 'myvision' } }), (a) => (a.localityImpl = remote));
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', blockedReason: expect.stringMatching(/runs in the cloud/) });
  });

  it('a failed check keeps AI closed, reports why, and is retried', async () => {
    const t = setup(aiLocal(), (a) => {
      a.localityImpl = () => Promise.resolve({ ok: false, kind: 'network', message: 'Could not connect to Ollama (this PC). Is it running?', latencyMs: 1 });
    });
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests[0]!.jpeg).toBeNull();
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status).toMatchObject({ mode: 'local-stats', lastError: expect.stringMatching(/Is it running/), blockedReason: expect.stringMatching(/not yet confirmed/) });

    t.adapter.localityImpl = () => Promise.resolve({ ok: true, locality: 'local', latencyMs: 1 });
    t.clock.advance(31_000);
    await requestAndSettle(t, 'curious');
    expect(t.svc.status).toMatchObject({ mode: 'ai-local', lastError: null });
    expect(t.adapter.calls).toHaveLength(1);
  });

  it('the answer is kept per adapter configuration and asked again when the model changes', async () => {
    const t = setup(aiLocal());
    for (let i = 0; i < 3; i++) {
      await requestAndSettle(t, 'curious');
      t.clock.advance(31_000);
    }
    expect(t.adapter.localityCalls).toBe(1);
    t.svc.updateSettings(aiLocal({ ai: { ollamaModel: 'gemma3:4b' } }));
    await requestAndSettle(t, 'curious');
    expect(t.adapter.localityCalls).toBe(2);
  });
});

describe('AI vision (Tier C)', () => {
  it('sends the masked JPEG to the adapter and emits a validated scene report', async () => {
    const t = setup(aiLocal());
    await flush(); // the server confirms that it runs the model itself
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

  it('saving or removing an API key clears the circuit breaker and the stale error', async () => {
    const t = setup(aiLocal({ ai: { provider: 'anthropic', allowCloud: true } }));
    t.adapter.impl = () => Promise.resolve({ ok: false, kind: 'auth', message: 'The Anthropic API key was rejected.', status: 401, latencyMs: 2 });
    for (let i = 0; i < 3; i++) {
      await requestAndSettle(t, 'curious');
      t.clock.advance(31_000);
    }
    expect(t.adapter.calls).toHaveLength(3);
    expect(t.svc.status.lastError).toMatch(/rejected.*paused for 1 min/);

    t.adapter.impl = () => Promise.resolve({ ok: true, report: REPORT, latencyMs: 3 });
    t.svc.onCredentialsChanged();
    expect(t.svc.status.lastError).toBeNull();
    // 31 s after the trip the breaker would still be open; the new key is tried at once.
    await requestAndSettle(t, 'curious');
    expect(t.adapter.calls).toHaveLength(4);
    expect(ofType(t.svc.drainEvents(), 'perception.ai')).toHaveLength(1);
  });

  it('a key change aborts a request still running with the old key', async () => {
    const t = setup(aiLocal({ ai: { provider: 'anthropic', allowCloud: true } }));
    t.adapter.impl = (_img, signal) =>
      new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', message: 'The request was cancelled.', latencyMs: 0 })));
    await requestAndSettle(t, 'curious');
    t.svc.onCredentialsChanged();
    expect(t.adapter.calls[0]!.signal!.aborted).toBe(true);
    await flush();
    expect(t.svc.status.lastError).toBeNull();
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

  it('while AI vision runs, the preview is the JPEG exactly as it would be sent (and it is not sent)', async () => {
    const t = setup(aiLocal());
    const p = await t.svc.preview();
    expect(p.ok).toBe(true);
    expect(t.cap.requests[0]!.jpeg).toEqual({ maxWidth: 512, quality: 60 });
    expect(p.imageDataUrl).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
    expect(t.cap.pngCalls).toBe(0);
    expect(t.adapter.calls).toHaveLength(0);
  });

  it('AI configured but not allowed to run: the preview stays the analysis frame', async () => {
    const t = setup(aiLocal({ ai: { provider: 'anthropic' } }));
    const p = await t.svc.preview();
    expect(t.cap.requests[0]!.jpeg).toBeNull();
    expect(p.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('a private window that appears during the preview grab: no image is returned', async () => {
    const t = setup(localStats());
    t.cap.during = () => {
      t.host.excludedRects = [{ x: 805, y: 505, width: 60, height: 40 }];
    };
    const p = await t.svc.preview();
    expect(p).toMatchObject({ ok: false, blockedReason: expect.stringMatching(/private window moved/) });
    expect(p.imageDataUrl).toBeUndefined();
    expect(t.cap.pngCalls).toBe(0);
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

describe('capture bursts (motion over a fraction of a second)', () => {
  /** Colourful 8-px checkerboard shifted by `shift` px: every block changes between neighbouring shifts. */
  const scene = (shift: number) => makeFrame(256, 160, (x, y) => ((((x + shift) >> 3) + (y >> 3)) % 2 === 0 ? [220, 40, 40] : [30, 60, 200]));
  const grey = () => makeFrame(256, 160, () => [90, 90, 90]);

  /** Wraps the request's stillClear so a private app is in front only while it is asked (a momentary change). */
  function momentaryPrivateApp(t: ReturnType<typeof setup>) {
    const orig = t.cap.capture;
    t.cap.capture = (req, signal) =>
      orig(
        {
          ...req,
          stillClear: () => {
            t.host.foregroundExcluded = true;
            const ok = req.stillClear!();
            t.host.foregroundExcluded = false;
            return ok;
          },
        },
        signal,
      );
  }

  it('one request takes one 3-frame burst ~150 ms apart, counted as one capture, with one AI image', async () => {
    const t = setup(aiLocal());
    await requestAndSettle(t, 'curious');
    expect(t.cap.requests).toHaveLength(1);
    expect(t.cap.requests[0]).toMatchObject({ burst: { frames: 3, intervalMs: 150 }, jpeg: { maxWidth: 512, quality: 60 } });
    expect(t.cap.framesTaken).toEqual([3]);
    expect(t.adapter.calls).toHaveLength(1);
    expect(t.svc.status.capturesThisHour).toBe(1);
  });

  it('motion comes from the burst: a moving burst is motion, a change between captures is not', async () => {
    const t = setup(localStats());
    t.cap.frameFor = () => scene(0);
    t.cap.burstFor = (_i, k) => scene(k * 8);
    await requestAndSettle(t);
    const [moving] = ofType(t.svc.drainEvents(), 'perception.visual');
    expect(moving!.summary.features.motion).toBeGreaterThan(0.5);
    expect(moving!.summary.events).toContain('motion');

    const s = setup(localStats());
    s.cap.frameFor = (i) => (i % 2 === 0 ? grey() : scene(0)); // a big change between captures, none inside a burst
    await requestAndSettle(s);
    s.svc.drainEvents();
    s.clock.advance(20_000);
    await requestAndSettle(s);
    const [changed] = ofType(s.svc.drainEvents(), 'perception.visual');
    expect(changed!.summary.features.changeFraction).toBeGreaterThan(0.5);
    expect(changed!.summary.features.motion).toBe(0);
    expect(changed!.summary.events).not.toContain('motion');
  });

  it('sustained colourful burst motion on two captures in a row is reported as videoLike', async () => {
    const t = setup(localStats());
    t.cap.frameFor = () => scene(0);
    t.cap.burstFor = (_i, k) => scene(k * 8);
    await requestAndSettle(t);
    expect(ofType(t.svc.drainEvents(), 'perception.visual')[0]!.summary.events).not.toContain('videoLike');
    t.clock.advance(20_000);
    await requestAndSettle(t);
    expect(ofType(t.svc.drainEvents(), 'perception.visual')[0]!.summary.events).toContain('videoLike');
  });

  it('a compact panel that appears between captures is reported as newElement', async () => {
    const t = setup(localStats());
    const panel = () => makeFrame(256, 160, (x, y) => (x >= 150 && x < 230 && y >= 10 && y < 50 ? [245, 245, 245] : [90, 90, 90]));
    t.cap.frameFor = (i) => (i === 0 ? grey() : panel());
    await requestAndSettle(t);
    expect(ofType(t.svc.drainEvents(), 'perception.visual').flatMap((e) => e.summary.events)).not.toContain('newElement');
    t.clock.advance(20_000);
    await requestAndSettle(t);
    const [ev] = ofType(t.svc.drainEvents(), 'perception.visual');
    expect(ev!.summary.events).toContain('newElement');
    expect(ev!.summary.events).not.toContain('bigChange');
  });

  it('a private window appearing between burst frames stops the burst and discards every frame', async () => {
    const t = setup(aiLocal());
    t.cap.duringBurst = (k) => {
      if (k === 1) t.host.excludedRects = [{ x: 805, y: 505, width: 60, height: 40 }];
    };
    await requestAndSettle(t, 'curious');
    expect(t.cap.framesTaken).toEqual([1]); // nothing was grabbed after it appeared
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
  });

  it('a private app in front for a moment between burst frames discards the frames although it is gone again', async () => {
    const t = setup(aiLocal());
    momentaryPrivateApp(t);
    await requestAndSettle(t, 'curious');
    expect(t.cap.framesTaken).toEqual([1]);
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
    expect(t.svc.status.blockedReason).toBeNull();
    expect(t.logger.entries.some((e) => e.msg.includes('the screen changed during the burst'))).toBe(true);

    const p = setup(localStats());
    momentaryPrivateApp(p);
    expect(await p.svc.preview()).toMatchObject({ ok: false, blockedReason: expect.stringMatching(/changed while it was captured/) });
    expect(p.cap.pngCalls).toBe(0);
  });

  it('a privacy pause during the burst discards the frames', async () => {
    const t = setup(aiLocal());
    t.cap.duringBurst = () => t.svc.setPaused(true);
    await requestAndSettle(t, 'curious');
    expect(t.svc.drainEvents()).toEqual([]);
    expect(t.adapter.calls).toHaveLength(0);
  });

  it('the preview takes the same burst and reports its motion', async () => {
    const t = setup(localStats());
    t.cap.frameFor = () => scene(0);
    t.cap.burstFor = (_i, k) => scene(k * 8);
    const p = await t.svc.preview();
    expect(p.ok).toBe(true);
    expect(t.cap.requests[0]!.burst).toEqual({ frames: 3, intervalMs: 150 });
    expect(p.summary!.features.motion).toBeGreaterThan(0.5);
    expect(t.svc.status.capturesThisHour).toBe(1);
  });
});
