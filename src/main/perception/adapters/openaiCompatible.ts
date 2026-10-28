// OpenAI-compatible chat completions (LM Studio, llama.cpp server, vLLM, ...).
// Tries json_schema structured output first and falls back to the plain
// instruction when a server rejects it; the result is validated either way.
import { SCENE_SYSTEM_PROMPT, parseSceneReport, sceneUserPrompt } from '../../../core/perception/aiOutput';
import { joinEndpoint } from '../../../core/perception/endpoint';
import { replaceInvisible } from '../../../core/perception/text';
import { failure, requestJson, transportFailure, type JsonResponse } from './http';
import { portableSceneSchema } from './schema';
import type { AdapterCommonOptions, DescribeResult, ListModelsResult, VisionAdapter, VisionImage } from './types';

export interface OpenAiCompatibleAdapterOptions extends AdapterCommonOptions {
  baseUrl: URL;
  model: string;
  /** Read at call time; null when no key is stored. */
  getApiKey: () => string | null;
  cloud: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

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

  async function describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult> {
    if (model.length === 0) return failure('config', 'Choose a model for the OpenAI-compatible server in Settings.', 0);
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
      if (isObj(m) && typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200) ids.add(replaceInvisible(m.id).trim());
    }
    return { ok: true, models: [...ids].sort((a, b) => a.localeCompare(b)), latencyMs: res.latencyMs };
  }

  return { provider: 'openai-compatible', label, describe, listModels };
}
