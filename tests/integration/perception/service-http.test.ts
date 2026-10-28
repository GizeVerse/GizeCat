// Service + real adapters + mock provider servers (127.0.0.1, ephemeral ports).
import { afterEach, describe, expect, it } from 'vitest';
import { createPerceptionService } from '../../../src/main/perception';
import type { SimEvent } from '../../../src/shared/sim';
import { FakeCapturer, FakeClock, FakeHost, JPEG_MARKER, aiLocal, flush, memorySecrets, recordingLogger } from '../../unit/perception/fakes';
import { guardedFetch, sendJson, startMockServer, type MockServer } from './mockServer';

const REPORT = { scene: 'game', energy: 'intense', interest: 0.9, reaction: 'play', caption: 'A fast colourful game' };
const servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('PerceptionService with a mock Ollama server', () => {
  it('captures, sends the masked JPEG to /api/chat and emits the validated report', async () => {
    const s = await startMockServer((req, res) => {
      if (req.url === '/api/chat') sendJson(res, 200, { message: { role: 'assistant', content: `Here you go: ${JSON.stringify(REPORT)}` }, done: true });
      else if (req.url === '/api/tags') sendJson(res, 200, { models: [{ name: 'qwen3-vl:4b-instruct', capabilities: ['vision'] }] });
      else sendJson(res, 404, { error: 'nope' });
    });
    servers.push(s);
    const clock = new FakeClock();
    const cap = new FakeCapturer();
    const svc = createPerceptionService({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(),
      settings: aiLocal({ ai: { ollamaBaseUrl: s.url, ollamaModel: 'qwen3-vl:4b-instruct', timeoutSec: 5 } }),
      now: clock.now,
      capture: cap,
      fetchImpl: guardedFetch,
    });
    expect(svc.status).toMatchObject({ mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)' });

    const events: SimEvent[] = [];
    svc.request('curious', { x: 1200, y: 750 });
    await waitFor(() => {
      events.push(...svc.drainEvents());
      return events.some((e) => e.type === 'perception.ai');
    });
    const ai = events.find((e) => e.type === 'perception.ai');
    expect(ai).toEqual({ type: 'perception.ai', report: REPORT, regionPx: { x: 800, y: 500, width: 800, height: 500 } });
    expect(events.some((e) => e.type === 'perception.visual')).toBe(true);
    const chat = s.requests.filter((r) => r.url === '/api/chat');
    expect(chat).toHaveLength(1);
    expect((chat[0]!.json as { messages: Array<{ images?: string[] }> }).messages[1]!.images).toEqual([Buffer.from(JPEG_MARKER).toString('base64')]);

    expect(await svc.listModels()).toEqual({ ok: true, models: ['qwen3-vl:4b-instruct'] });
    const test = await svc.testAi();
    expect(test).toMatchObject({ ok: true, report: REPORT });
    expect(cap.requests).toHaveLength(1); // the test used a synthetic image
    svc.dispose();
    await flush();
  });

  it('a missing model surfaces the pull hint in status and never calls /api/pull', async () => {
    const s = await startMockServer((_req, res) => sendJson(res, 404, { error: "model 'qwen3-vl:2b-instruct' not found" }));
    servers.push(s);
    const svc = createPerceptionService({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(),
      settings: aiLocal({ ai: { ollamaBaseUrl: s.url, ollamaModel: 'qwen3-vl:2b-instruct' } }),
      now: new FakeClock().now,
      capture: new FakeCapturer(),
      fetchImpl: guardedFetch,
    });
    svc.request('curious', null);
    await waitFor(() => svc.status.lastError !== null);
    expect(svc.status.lastError).toContain('ollama pull qwen3-vl:2b-instruct');
    expect(s.requests.map((r) => r.url)).toEqual(['/api/chat']);
    svc.dispose();
  });

  it('a slow server times out and counts toward the breaker', async () => {
    const s = await startMockServer(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 5000));
      sendJson(res, 200, {});
    });
    servers.push(s);
    const svc = createPerceptionService({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(),
      settings: aiLocal({ ai: { ollamaBaseUrl: s.url, timeoutSec: 3 } }),
      now: new FakeClock().now,
      capture: new FakeCapturer(),
      fetchImpl: guardedFetch,
    });
    const t0 = Date.now();
    svc.request('curious', null);
    await waitFor(() => svc.status.lastError !== null, 6000);
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(svc.status.lastError).toMatch(/did not answer within 3 s/);
    svc.dispose();
  });
});
