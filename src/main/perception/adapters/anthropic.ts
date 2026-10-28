// Claude Messages API over plain fetch (no SDK dependency in this app).
// Request shape per the claude-api reference (2026-10-21 API version):
// base64 image block before the text, structured output via
// output_config.format json_schema, no sampling parameters, thinking off where
// the model allows it.
import { SCENE_SYSTEM_PROMPT, parseSceneReport, sceneUserPrompt } from '../../../core/perception/aiOutput';
import { joinEndpoint } from '../../../core/perception/endpoint';
import { ANTHROPIC_API_BASE } from '../../../core/perception/privacy';
import { replaceInvisible } from '../../../core/perception/text';
import { failure, requestJson, sanitizeProviderMessage, transportFailure } from './http';
import { portableSceneSchema } from './schema';
import type { AdapterCommonOptions, DescribeResult, ListModelsResult, VisionAdapter, VisionImage } from './types';

export const ANTHROPIC_VERSION = '2026-10-21';

export interface AnthropicAdapterOptions extends AdapterCommonOptions {
  model: string;
  /** Read at call time; never cached or logged. */
  getApiKey: () => string | null;
  /** Override for tests (mock server); defaults to the public API. */
  baseUrl?: URL;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Thinking/effort per model family. Haiku 5.5 accepts thinking disabled at effort
 * low..high; Opus 5.5 / Sonnet 5.5 / Fable / Mythos reject "disabled", so only a
 * low effort is sent; older or unknown models get neither field.
 */
export function anthropicTuning(model: string): { thinking?: { type: 'disabled' }; effort?: 'low' } {
  if (/^claude-haiku-5-5(\b|$)/.test(model)) return { thinking: { type: 'disabled' }, effort: 'low' };
  if (/^claude-(opus|sonnet)-5-5(\b|$)|^claude-(fable|mythos)-/.test(model)) return { effort: 'low' };
  return {};
}

export function buildAnthropicMessagesBody(model: string, image: VisionImage): Record<string, unknown> {
  const tuning = anthropicTuning(model);
  return {
    model,
    max_tokens: 512,
    ...(tuning.thinking ? { thinking: tuning.thinking } : {}),
    output_config: {
      ...(tuning.effort ? { effort: tuning.effort } : {}),
      format: { type: 'json_schema', schema: portableSceneSchema() },
    },
    system: SCENE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
          { type: 'text', text: sceneUserPrompt() },
        ],
      },
    ],
  };
}

export function createAnthropicAdapter(opts: AnthropicAdapterOptions): VisionAdapter {
  const { label, timeoutMs } = opts;
  const model = opts.model.trim();
  const base = opts.baseUrl ?? new URL(ANTHROPIC_API_BASE);

  const auth = (): { key: string } | null => {
    const key = opts.getApiKey();
    return key && key.trim().length > 0 ? { key: key.trim() } : null;
  };
  const headersFor = (key: string): Record<string, string> => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION });

  function httpFailure(res: Extract<Awaited<ReturnType<typeof requestJson>>, { ok: false }>, key: string) {
    const ctx = { label, timeoutMs, maxBytes: opts.maxResponseBytes, secrets: [key], cloud: true };
    if (res.kind !== 'http') return transportFailure(res, ctx);
    const status = res.status ?? 0;
    const name = replaceInvisible(model).slice(0, 100);
    if (status === 401) return failure('auth', 'The Anthropic API key was rejected.', res.latencyMs, status);
    if (status === 402) return failure('auth', 'Anthropic reported a billing problem for this API key.', res.latencyMs, status);
    if (status === 403) return failure('auth', 'This Anthropic API key is not allowed to use this model.', res.latencyMs, status);
    if (status === 404) return failure('not-found', `Model "${name}" is not available to this Anthropic API key.`, res.latencyMs, status);
    if (status === 529) return failure('rate-limited', 'Anthropic is overloaded right now; try again later.', res.latencyMs, status);
    if (status === 400) {
      const detail = sanitizeProviderMessage(res.providerMessage, [key]);
      return failure('http', `Anthropic rejected the request${detail ? `: ${detail}` : '.'}`, res.latencyMs, status);
    }
    return transportFailure(res, ctx);
  }

  async function describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult> {
    if (model.length === 0) return failure('config', 'Choose a Claude model in Settings.', 0);
    const a = auth();
    if (!a) return failure('config', 'No Anthropic API key is saved.', 0);
    const res = await requestJson({
      fetchImpl: opts.fetchImpl,
      method: 'POST',
      url: joinEndpoint(base, '/v1/messages'),
      headers: headersFor(a.key),
      timeoutMs,
      signal,
      maxBytes: opts.maxResponseBytes,
      body: buildAnthropicMessagesBody(model, image),
    });
    if (!res.ok) return httpFailure(res, a.key);
    const body = res.json;
    if (!isObj(body) || !Array.isArray(body.content)) return failure('bad-response', 'Anthropic sent an unexpected answer.', res.latencyMs);
    if (body.stop_reason === 'refusal') return failure('refused', 'Claude declined to describe this screen.', res.latencyMs);
    if (body.stop_reason === 'max_tokens') return failure('invalid-output', 'The answer was cut off.', res.latencyMs);
    const text = body.content
      .filter(isObj)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const parsed = parseSceneReport(text);
    if (!parsed.ok) return failure('invalid-output', parsed.error, res.latencyMs);
    return { ok: true, report: parsed.report, latencyMs: res.latencyMs };
  }

  async function listModels(signal?: AbortSignal): Promise<ListModelsResult> {
    const a = auth();
    if (!a) return failure('config', 'No Anthropic API key is saved.', 0);
    const url = joinEndpoint(base, '/v1/models');
    url.searchParams.set('limit', '100');
    const res = await requestJson({ fetchImpl: opts.fetchImpl, method: 'GET', url, headers: headersFor(a.key), timeoutMs, signal, maxBytes: opts.maxResponseBytes });
    if (!res.ok) return httpFailure(res, a.key);
    const data = isObj(res.json) ? res.json.data : undefined;
    if (!Array.isArray(data)) return failure('bad-response', 'Anthropic sent an unexpected model list.', res.latencyMs);
    const ids = new Set<string>();
    for (const m of data) if (isObj(m) && typeof m.id === 'string' && /^claude-[a-z0-9.-]{1,80}$/.test(m.id)) ids.add(m.id);
    return { ok: true, models: [...ids].sort((x, y) => x.localeCompare(y)), latencyMs: res.latencyMs };
  }

  return { provider: 'anthropic', label, describe, listModels };
}
