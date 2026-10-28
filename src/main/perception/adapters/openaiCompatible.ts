// OpenAI-compatible chat completions (LM Studio, llama.cpp server, vLLM, ...).
// Tries json_schema structured output first and falls back to the plain
// instruction when a server rejects it; the result is validated either way.
// A server on this PC may be Ollama's /v1 API, which forwards "cloud" models to
// ollama.com: without "Allow cloud" such a server is asked first where it runs
// the model, and images go only to a model it runs itself.
import { SCENE_SYSTEM_PROMPT, parseSceneReport, sceneUserPrompt } from '../../../core/perception/aiOutput';
import { isOllamaCloudModel, joinEndpoint, openAiServerRoot } from '../../../core/perception/endpoint';
import { BLOCK_REASONS } from '../../../core/perception/privacy';
import { replaceInvisible } from '../../../core/perception/text';
import { failure, requestJson, transportFailure, type JsonResponse } from './http';
import { ollamaModelLocality } from './ollama';
import { portableSceneSchema } from './schema';
import type { AdapterCommonOptions, AdapterFailure, DescribeResult, ListModelsResult, LocalityResult, VisionAdapter, VisionImage } from './types';

export interface OpenAiCompatibleAdapterOptions extends AdapterCommonOptions {
  baseUrl: URL;
  model: string;
  /** Read at call time; null when no key is stored. */
  getApiKey: () => string | null;
  cloud: boolean;
  /** The server is on this PC (it may still forward models elsewhere). */
  localServer: boolean;
  /** "Allow cloud" is on: a model the server forwards to a cloud service may receive images. */
  allowRemoteModel: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An answer to GET /api/version that rules out Ollama (which always serves it as JSON). */
function notOllama(res: Extract<JsonResponse, { ok: false }>): boolean {
  if (res.kind === 'bad-json') return true;
  const status = res.status ?? 0;
  return res.kind === 'http' && status >= 400 && status < 500 && ![401, 403, 407, 408, 429].includes(status);
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter(isObj).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

export function createOpenAiCompatibleAdapter(opts: OpenAiCompatibleAdapterOptions): VisionAdapter {
  const { label, timeoutMs } = opts;
  const model = opts.model.trim();
  let structuredSupported = true;

  const headers = (): { headers: Record<string, string>; secrets: string[] } => {
    const key = opts.getApiKey();
    return key ? { headers: { authorization: `Bearer ${key}` }, secrets: [key] } : { headers: {}, secrets: [] };
  };

  let knownLocality: 'local' | 'remote' | null = null;

  async function checkLocality(signal?: AbortSignal): Promise<LocalityResult> {
    if (!opts.localServer) return { ok: true, locality: 'remote', latencyMs: 0 };
    if (model.length === 0) return failure('config', 'Choose a model for the OpenAI-compatible server in Settings.', 0);
    if (knownLocality) return { ok: true, locality: knownLocality, latencyMs: 0 };
    const auth = headers();
    const root = openAiServerRoot(opts.baseUrl);
    // Ollama serves GET /api/version next to its /v1 API; other servers do not.
    const probe = await requestJson({
      fetchImpl: opts.fetchImpl,
      method: 'GET',
      url: joinEndpoint(root, '/api/version'),
      headers: auth.headers,
      timeoutMs,
      signal,
      maxBytes: opts.maxResponseBytes,
    });
    let res: LocalityResult;
    if (probe.ok && isObj(probe.json) && typeof probe.json.version === 'string') {
      res = await ollamaModelLocality({ fetchImpl: opts.fetchImpl, root, model, label, timeoutMs, signal, headers: auth.headers, secrets: auth.secrets });
    } else if (probe.ok || notOllama(probe)) {
      res = { ok: true, locality: 'local', latencyMs: probe.latencyMs };
    } else {
      res = transportFailure(probe, { label, timeoutMs, maxBytes: opts.maxResponseBytes, secrets: auth.secrets, cloud: opts.cloud });
    }
    if (res.ok) knownLocality = res.locality;
    return res;
  }

  /** Without "Allow cloud", images only go to a model a server on this PC runs itself. */
  async function localOnly(signal?: AbortSignal): Promise<AdapterFailure | null> {
    if (opts.allowRemoteModel) return null;
    if (!opts.localServer) return failure('config', BLOCK_REASONS['cloud-not-allowed'], 0);
    if (isOllamaCloudModel(model)) return failure('config', BLOCK_REASONS['cloud-model-not-allowed'], 0);
    const where = await checkLocality(signal);
    if (!where.ok) return where;
    return where.locality === 'remote' ? failure('config', BLOCK_REASONS['cloud-model-not-allowed'], where.latencyMs) : null;
  }

  async function describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult> {
    if (model.length === 0) return failure('config', 'Choose a model for the OpenAI-compatible server in Settings.', 0);
    const refused = await localOnly(signal);
    if (refused) return refused;
    const deadline = performance.now() + timeoutMs;
    const auth = headers();
    const ctx = { label, timeoutMs, maxBytes: opts.maxResponseBytes, secrets: auth.secrets, cloud: opts.cloud };
    const send = (structured: boolean): Promise<JsonResponse> =>
      requestJson({
        fetchImpl: opts.fetchImpl,
        method: 'POST',
        url: joinEndpoint(opts.baseUrl, '/chat/completions'),
        headers: auth.headers,
        timeoutMs: Math.max(1, deadline - performance.now()),
        signal,
        maxBytes: opts.maxResponseBytes,
        body: {
          model,
          stream: false,
          temperature: 0,
          max_tokens: 200,
          messages: [
            { role: 'system', content: SCENE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: sceneUserPrompt() },
                { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
              ],
            },
          ],
          ...(structured
            ? { response_format: { type: 'json_schema', json_schema: { name: 'scene_report', strict: true, schema: portableSceneSchema() } } }
            : {}),
        },
      });

    let res = await send(structuredSupported);
    if (!res.ok && res.kind === 'http' && (res.status === 400 || res.status === 422) && structuredSupported) {
      // Many local servers reject response_format/json_schema; remember and retry once with the plain instruction.
      structuredSupported = false;
      if (deadline - performance.now() < 500) return failure('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)} s.`, res.latencyMs);
      res = await send(false);
    }
    if (!res.ok) {
      if (res.kind === 'http' && res.status === 404) {
        return failure('not-found', `Model "${replaceInvisible(model).slice(0, 100)}" was not found on ${label}.`, res.latencyMs, 404);
      }
      return transportFailure(res, ctx);
    }
    const choices = isObj(res.json) ? res.json.choices : undefined;
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    const message = isObj(first) ? first.message : undefined;
    if (!isObj(first) || !isObj(message)) return failure('bad-response', `${label} sent an unexpected answer.`, res.latencyMs);
    if (typeof message.refusal === 'string' && message.refusal.trim().length > 0) {
      return failure('refused', 'The model declined to describe this screen.', res.latencyMs);
    }
    if (first.finish_reason === 'length') return failure('invalid-output', 'The model answer was cut off.', res.latencyMs);
    const text = messageText(message.content);
    if (text === null) return failure('bad-response', `${label} sent an answer without text.`, res.latencyMs);
    const parsed = parseSceneReport(text);
    if (!parsed.ok) return failure('invalid-output', parsed.error, res.latencyMs);
    return { ok: true, report: parsed.report, latencyMs: res.latencyMs };
  }

  async function listModels(signal?: AbortSignal): Promise<ListModelsResult> {
    const auth = headers();
    const res = await requestJson({
      fetchImpl: opts.fetchImpl,
      method: 'GET',
      url: joinEndpoint(opts.baseUrl, '/models'),
      headers: auth.headers,
      timeoutMs,
      signal,
      maxBytes: opts.maxResponseBytes,
    });
    if (!res.ok) return transportFailure(res, { label, timeoutMs, maxBytes: opts.maxResponseBytes, secrets: auth.secrets, cloud: opts.cloud });
    const data = isObj(res.json) ? res.json.data : undefined;
    if (!Array.isArray(data)) return failure('bad-response', `${label} sent an unexpected model list.`, res.latencyMs);
    const ids = new Set<string>();
    for (const m of data) {
      if (!isObj(m) || typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 200) continue;
      // On this PC, Ollama's /v1 lists its cloud models too; they would send screenshots off this PC.
      if (opts.localServer && isOllamaCloudModel(m.id)) continue;
      ids.add(replaceInvisible(m.id).trim());
    }
    return { ok: true, models: [...ids].sort((a, b) => a.localeCompare(b)), latencyMs: res.latencyMs };
  }

  return { provider: 'openai-compatible', label, describe, listModels, checkLocality };
}
