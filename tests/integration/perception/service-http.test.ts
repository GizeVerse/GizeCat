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
      else if (req.url === '/api/show') sendJson(res, 200, { details: { family: 'qwen3vl' }, capabilities: ['completion', 'vision'] });
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
    // Until the server confirms the model runs on this PC, AI is not running (fail closed).
    expect(svc.status).toMatchObject({ mode: 'local-stats', blockedReason: expect.stringMatching(/not yet confirmed/) });
    await waitFor(() => svc.status.mode === 'ai-local');
    expect(svc.status).toMatchObject({ mode: 'ai-local', aiProviderLabel: 'Ollama (this PC)', blockedReason: null });

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
    // The server check found no such model, so no image was sent and nothing was pulled.
    const urls = s.requests.map((r) => r.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u === '/api/show')).toBe(true);
    svc.dispose();
  });

  it('an alias of a cloud model on the local Ollama: status says cloud, no image reaches the server', async () => {
    const s = await startMockServer((req, res) => {
      if (req.url === '/api/show') sendJson(res, 200, { details: { family: 'qwen3vl' }, remote_host: 'https://ollama.com:443', remote_model: 'qwen3-vl:235b' });
      else sendJson(res, 200, { message: { role: 'assistant', content: JSON.stringify(REPORT) }, done: true });
    });
    servers.push(s);
    const cap = new FakeCapturer();
    const svc = createPerceptionService({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(),
      settings: aiLocal({ ai: { ollamaBaseUrl: s.url, ollamaModel: 'myvision' } }),
      now: new FakeClock().now,
      capture: cap,
      fetchImpl: guardedFetch,
    });
    svc.request('curious', null);
    await waitFor(() => cap.requests.length === 1);
    await flush();
    expect(svc.status).toMatchObject({ mode: 'local-stats', aiProviderLabel: null, blockedReason: expect.stringMatching(/runs in the cloud.*Allow cloud/) });
    expect(cap.requests[0]!.jpeg).toBeNull();
    expect(s.requests.map((r) => r.url)).toEqual(['/api/show']);
    expect((await svc.testAi()).ok).toBe(false);
    expect(s.requests.map((r) => r.url)).toEqual(['/api/show']);
    svc.dispose();
  });

  it('OpenAI-compatible at a local Ollama /v1 with a cloud model: refused without "Allow cloud", reported as cloud with it', async () => {
    const s = await startMockServer((req, res) => {
      if (req.url === '/api/version') sendJson(res, 200, { version: '0.12.6' });
      else if (req.url === '/api/show') sendJson(res, 200, { details: {}, remote_host: 'https://ollama.com:443' });
      else sendJson(res, 200, { choices: [{ message: { role: 'assistant', content: JSON.stringify(REPORT) }, finish_reason: 'stop' }] });
    });
    servers.push(s);
    const ai = { provider: 'openai-compatible' as const, openaiBaseUrl: `${s.url}/v1`, openaiModel: 'vision-alias' };
    const svc = createPerceptionService({
      logger: recordingLogger(),
      host: new FakeHost(),
      secrets: memorySecrets(),
      settings: aiLocal({ ai }),
      now: new FakeClock().now,
      capture: new FakeCapturer(),
      fetchImpl: guardedFetch,
    });
    await waitFor(() => s.requests.some((r) => r.url === '/api/show'));
    await flush();
    expect(svc.status).toMatchObject({ mode: 'local-stats', blockedReason: expect.stringMatching(/runs in the cloud/) });
    svc.updateSettings(aiLocal({ ai: { ...ai, allowCloud: true } }));
    await waitFor(() => s.requests.filter((r) => r.url === '/api/show').length === 2);
    await flush();
    expect(svc.status).toMatchObject({ mode: 'ai-cloud', aiProviderLabel: 'OpenAI-compatible (cloud model)' });
    expect(s.requests.some((r) => r.url === '/v1/chat/completions')).toBe(false);
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
