import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTHROPIC_VERSION,
  anthropicTuning,
  createAnthropicAdapter,
  createOllamaAdapter,
  createOpenAiCompatibleAdapter,
  createVisionAdapter,
  type VisionImage,
} from '../../../src/main/perception/adapters';
import type { SecretStore } from '../../../src/main/contracts';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import { guardedFetch, sendJson, sleep, startMockServer, type MockServer } from './mockServer';

// Request bodies are inspected loosely; the adapters under test build them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = any;

const REPORT = { scene: 'video', energy: 'moderate', interest: 0.7, reaction: 'watch', caption: 'Someone watching a video' };
const IMAGE: VisionImage = { base64: 'SU1BR0VEQVRBX0JBU0U2NF9NQVJLRVI=', mediaType: 'image/jpeg' };
const API_KEY = 'sk-ant-test-0123456789abcdefSECRET';

const servers: MockServer[] = [];
async function server(h: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const s = await startMockServer(h);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const common = { fetchImpl: guardedFetch, timeoutMs: 2000 };
const ollama = (s: MockServer, over: { model?: string; timeoutMs?: number; maxResponseBytes?: number } = {}) =>
  createOllamaAdapter({ ...common, label: 'Ollama (this PC)', baseUrl: new URL(s.url), model: 'qwen3-vl:4b-instruct', ...over });
const openai = (s: MockServer, key: string | null = null) =>
  createOpenAiCompatibleAdapter({ ...common, label: 'OpenAI-compatible (this PC)', baseUrl: new URL(`${s.url}/v1`), model: 'local-vlm', getApiKey: () => key, cloud: false });
const anthropic = (s: MockServer, key: string | null = API_KEY, model = 'claude-haiku-5-5') =>
  createAnthropicAdapter({ ...common, label: 'Anthropic (cloud)', baseUrl: new URL(s.url), model, getApiKey: () => key });

const noLeak = (text: string) => {
  expect(text).not.toContain(IMAGE.base64);
  expect(text).not.toContain(API_KEY);
};

describe('Ollama adapter', () => {
  it('sends a non-streaming, thinking-off chat with a raw base64 image and a JSON schema format', async () => {
    const s = await server((_r, res) => sendJson(res, 200, { model: 'm', message: { role: 'assistant', content: JSON.stringify(REPORT) }, done: true }));
    const r = await ollama(s).describe(IMAGE);
    expect(r).toMatchObject({ ok: true, report: REPORT });
    expect(s.requests).toHaveLength(1);
    const req = s.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/chat');
    const body = req.json as Record<string, LooseJson>;
    expect(body.model).toBe('qwen3-vl:4b-instruct');
    expect(body.stream).toBe(false);
    expect(body.think).toBe(false);
    expect(body.format.type).toBe('object');
    expect(body.format.additionalProperties).toBe(false);
    expect(body.options.temperature).toBe(0);
    expect(body.messages[1].images).toEqual([IMAGE.base64]);
    expect(String(body.messages[1].images[0])).not.toMatch(/^data:/);
  });

  it('missing model -> actionable message, never pulls', async () => {
    const s = await server((_r, res) => sendJson(res, 404, { error: "model 'qwen3-vl:4b-instruct' not found" }));
    const r = await ollama(s).describe(IMAGE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('not-found');
      expect(r.message).toContain('ollama pull qwen3-vl:4b-instruct');
    }
    expect(s.requests.map((q) => q.url)).toEqual(['/api/chat']);
  });

  it('server error 500', async () => {
    const s = await server((_r, res) => sendJson(res, 500, { error: 'boom' }));
    const r = await ollama(s).describe(IMAGE);
    expect(r).toMatchObject({ ok: false, kind: 'http', status: 500 });
  });

  it('malformed JSON body', async () => {
    const s = await server((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"message": {"content": ');
    });
    expect(await ollama(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'bad-response' });
  });

  it('schema-invalid model output is rejected', async () => {
    const s = await server((_r, res) => sendJson(res, 200, { message: { content: '{"scene":"banking","energy":"x"}' }, done: true }));
    const r = await ollama(s).describe(IMAGE);
    expect(r).toMatchObject({ ok: false, kind: 'invalid-output' });
  });

  it('200 with an error field is an error', async () => {
    const s = await server((_r, res) => sendJson(res, 200, { error: 'model only supports one image' }));
    const r = await ollama(s).describe(IMAGE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('one image');
  });

  it('slow server -> timeout at the configured deadline', async () => {
    const s = await server(async (_r, res) => {
      await sleep(3000);
      sendJson(res, 200, {});
    });
    const t0 = performance.now();
    const r = await ollama(s, { timeoutMs: 300 }).describe(IMAGE);
    const took = performance.now() - t0;
    expect(r).toMatchObject({ ok: false, kind: 'timeout' });
    expect(took).toBeLessThan(1500);
  });

  it('slow body after headers also times out', async () => {
    const s = await server(async (_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"message":');
      await sleep(3000);
      res.end('{}}');
    });
    expect(await ollama(s, { timeoutMs: 300 }).describe(IMAGE)).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('oversized body is cut off (declared length and chunked)', async () => {
    const big = JSON.stringify({ message: { content: 'x'.repeat(100_000) } });
    const s1 = await server((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(big) });
      res.end(big);
    });
    expect(await ollama(s1).describe(IMAGE)).toMatchObject({ ok: false, kind: 'too-large' });
    const s2 = await server((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 10; i++) res.write(big.slice(i * 10_000, (i + 1) * 10_000));
      res.end(big.slice(100_000));
    });
    expect(await ollama(s2).describe(IMAGE)).toMatchObject({ ok: false, kind: 'too-large' });
  });

  it('does not follow redirects (the target never sees the image)', async () => {
    const target = await server((_r, res) => sendJson(res, 200, { message: { content: JSON.stringify(REPORT) } }));
    const s = await server((_r, res) => {
      res.writeHead(307, { location: `${target.url}/api/chat` });
      res.end();
    });
    expect(await ollama(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'redirect' });
    expect(target.requests).toHaveLength(0);
  });

  it('external abort -> aborted', async () => {
    const s = await server(async (_r, res) => {
      await sleep(2000);
      sendJson(res, 200, {});
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    expect(await ollama(s).describe(IMAGE, ctl.signal)).toMatchObject({ ok: false, kind: 'aborted' });
  });

  it('connection refused -> network error', async () => {
    const s = await server(() => undefined);
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    expect(await ollama(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'network' });
  });

  it('listModels filters cloud/remote and non-vision models', async () => {
    const s = await server((_r, res) =>
      sendJson(res, 200, {
        models: [
          { name: 'qwen3-vl:4b-instruct', capabilities: ['completion', 'vision'] },
          { name: 'llama3:8b', capabilities: ['completion'] },
          { name: 'gpt-oss:120b-cloud' },
          { name: 'remote-thing:1b', remote_host: 'https://ollama.com:443' },
          { name: 'gemma3:4b' },
        ],
      }),
    );
    const r = await ollama(s).listModels();
    expect(r).toMatchObject({ ok: true, models: ['gemma3:4b', 'qwen3-vl:4b-instruct'] });
    expect(s.requests[0]!.url).toBe('/api/tags');
  });

  it('empty model -> config error without any request', async () => {
    const s = await server((_r, res) => sendJson(res, 200, {}));
    expect(await ollama(s, { model: ' ' }).describe(IMAGE)).toMatchObject({ ok: false, kind: 'config' });
    expect(s.requests).toHaveLength(0);
  });
});

describe('OpenAI-compatible adapter', () => {
  const completion = (content: unknown, extra: Record<string, unknown> = {}) => ({
    choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
  });

  it('sends a data-URL image and json_schema response_format; bearer only when a key is set', async () => {
    const s = await server((_r, res) => sendJson(res, 200, completion(JSON.stringify(REPORT))));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: true, report: REPORT });
    const req = s.requests[0]!;
    expect(req.url).toBe('/v1/chat/completions');
    const body = req.json as Record<string, LooseJson>;
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${IMAGE.base64}`);
    expect(req.headers.authorization).toBeUndefined();
    await openai(s, 'lm-key-123456').describe(IMAGE);
    expect(s.requests[1]!.headers.authorization).toBe('Bearer lm-key-123456');
  });

  it('falls back to the plain instruction when response_format is rejected, and remembers', async () => {
    const s = await server((r, res) => {
      const body = r.json as Record<string, unknown>;
      if ('response_format' in body) sendJson(res, 400, { error: { message: 'response_format not supported' } });
      else sendJson(res, 200, completion('```json\n' + JSON.stringify(REPORT) + '\n```'));
    });
    const a = openai(s);
    expect(await a.describe(IMAGE)).toMatchObject({ ok: true });
    expect(s.requests).toHaveLength(2);
    expect(await a.describe(IMAGE)).toMatchObject({ ok: true });
    expect(s.requests).toHaveLength(3);
    expect('response_format' in (s.requests[2]!.json as object)).toBe(false);
  });

  it('accepts content as an array of text parts', async () => {
    const s = await server((_r, res) => sendJson(res, 200, completion([{ type: 'text', text: JSON.stringify(REPORT) }])));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: true, report: REPORT });
  });

  it('refusal and truncation are reported', async () => {
    const s = await server((_r, res) => sendJson(res, 200, completion(null, { refusal: 'I cannot help' })));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'refused' });
    s.setHandler((_r, res) => sendJson(res, 200, { choices: [{ message: { content: '{"scene":' }, finish_reason: 'length' }] }));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'invalid-output' });
  });

  it('500 and schema-invalid output', async () => {
    const s = await server((_r, res) => sendJson(res, 503, { error: { message: 'loading' } }));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'http', status: 503 });
    s.setHandler((_r, res) => sendJson(res, 200, completion(JSON.stringify({ ...REPORT, reaction: 'shutdown_pc' }))));
    expect(await openai(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'invalid-output' });
  });

  it('listModels reads /models', async () => {
    const s = await server((_r, res) => sendJson(res, 200, { object: 'list', data: [{ id: 'b-model' }, { id: 'a-model' }, { nope: 1 }] }));
    expect(await openai(s).listModels()).toMatchObject({ ok: true, models: ['a-model', 'b-model'] });
    expect(s.requests[0]!.url).toBe('/v1/models');
  });
});

describe('Anthropic adapter', () => {
  const message = (text: string, stop = 'end_turn') => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text }],
    stop_reason: stop,
    stop_details: null,
    usage: { input_tokens: 500, output_tokens: 40 },
  });

  it('sends the Messages API shape: headers, thinking off, base64 image first, structured output, no sampling params', async () => {
    const s = await server((_r, res) => sendJson(res, 200, message(JSON.stringify(REPORT))));
    expect(await anthropic(s).describe(IMAGE)).toMatchObject({ ok: true, report: REPORT });
    const req = s.requests[0]!;
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe(API_KEY);
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe('2026-10-21');
    const body = req.json as Record<string, LooseJson>;
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    const schemaText = JSON.stringify(body.output_config.format.schema);
    expect(schemaText).not.toMatch(/"minimum"|"maximum"|"maxLength"|"minLength"/);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: IMAGE.base64 } });
    expect(body.messages[0].content[1].type).toBe('text');
    for (const k of ['temperature', 'top_p', 'top_k', 'tools', 'tool_choice']) expect(k in body).toBe(false);
  });

  it('skips thinking blocks and joins text blocks', async () => {
    const s = await server((_r, res) =>
      sendJson(res, 200, { ...message(''), content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(REPORT) }] }),
    );
    expect(await anthropic(s).describe(IMAGE)).toMatchObject({ ok: true });
  });

  it('refusal and max_tokens stop reasons', async () => {
    const s = await server((_r, res) => sendJson(res, 200, message('', 'refusal')));
    expect(await anthropic(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'refused' });
    s.setHandler((_r, res) => sendJson(res, 200, message('{"scene":"co', 'max_tokens')));
    expect(await anthropic(s).describe(IMAGE)).toMatchObject({ ok: false, kind: 'invalid-output' });
  });

  it('401/429/529/400 map to short messages that never include the key', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'authentication_error', 'auth'],
      [429, 'rate_limit_error', 'rate-limited'],
      [529, 'overloaded_error', 'rate-limited'],
      [400, 'invalid_request_error', 'http'],
      [500, 'api_error', 'http'],
    ];
    for (const [status, type, kind] of cases) {
      const s = await server((_r, res) =>
        sendJson(res, status, { type: 'error', error: { type, message: `bad key ${API_KEY} data ${IMAGE.base64}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }, request_id: 'req_1' }),
      );
      const r = await anthropic(s).describe(IMAGE);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.kind).toBe(kind);
        noLeak(r.message);
      }
    }
  });

  it('no key -> config error and no request', async () => {
    const s = await server((_r, res) => sendJson(res, 200, message(JSON.stringify(REPORT))));
    expect(await anthropic(s, null).describe(IMAGE)).toMatchObject({ ok: false, kind: 'config' });
    expect(await anthropic(s, null).listModels()).toMatchObject({ ok: false, kind: 'config' });
    expect(s.requests).toHaveLength(0);
  });

  it('listModels', async () => {
    const s = await server((_r, res) => sendJson(res, 200, { data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-opus-5-5' }, { id: 'evil<script>' }], has_more: false }));
    expect(await anthropic(s).listModels()).toMatchObject({ ok: true, models: ['claude-haiku-5-5', 'claude-opus-5-5'] });
    expect(s.requests[0]!.url).toBe('/v1/models?limit=100');
    expect(s.requests[0]!.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
  });

  it('per-model tuning: only Haiku 5.5 gets thinking disabled', () => {
    expect(anthropicTuning('claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' }, effort: 'low' });
    expect(anthropicTuning('claude-opus-5-5')).toEqual({ effort: 'low' });
    expect(anthropicTuning('claude-sonnet-5-5')).toEqual({ effort: 'low' });
    expect(anthropicTuning('claude-haiku-4-5')).toEqual({});
  });
});

describe('createVisionAdapter (egress re-check)', () => {
  const secrets: SecretStore = { has: () => true, get: () => API_KEY, set: () => true };
  const withAi = (ai: Partial<Settings['ai']>): Settings => {
    const d = defaultSettings();
    return { ...d, ai: { ...d.ai, ...ai } };
  };

  it('refuses remote endpoints and Anthropic without allowCloud', () => {
    expect(createVisionAdapter({ settings: withAi({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.example.com/v1' }), secrets, fetchImpl: guardedFetch }).ok).toBe(false);
    expect(createVisionAdapter({ settings: withAi({ provider: 'anthropic' }), secrets, fetchImpl: guardedFetch }).ok).toBe(false);
    expect(createVisionAdapter({ settings: withAi({ provider: 'none' }), secrets, fetchImpl: guardedFetch }).ok).toBe(false);
  });

  it('builds adapters when allowed', () => {
    const a = createVisionAdapter({ settings: withAi({ provider: 'anthropic', allowCloud: true }), secrets, fetchImpl: guardedFetch });
    expect(a.ok && a.cloud && a.adapter.provider).toBe('anthropic');
    const o = createVisionAdapter({ settings: withAi({ provider: 'ollama' }), secrets, fetchImpl: guardedFetch });
    expect(o.ok && !o.cloud && o.adapter.label).toBe('Ollama (this PC)');
  });
});
