// Ollama native API (/api/chat, /api/tags). Thinking is always disabled and
// models are never pulled automatically.
import { SCENE_SYSTEM_PROMPT, parseSceneReport, sceneUserPrompt } from '../../../core/perception/aiOutput';
import { isOllamaCloudModel, joinEndpoint } from '../../../core/perception/endpoint';
import { replaceInvisible } from '../../../core/perception/text';
import { failure, requestJson, sanitizeProviderMessage, transportFailure } from './http';
import { portableSceneSchema } from './schema';
import type { AdapterCommonOptions, DescribeResult, ListModelsResult, VisionAdapter, VisionImage } from './types';

export interface OllamaAdapterOptions extends AdapterCommonOptions {
  baseUrl: URL;
  model: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const displayName = (model: string): string => replaceInvisible(model).trim().slice(0, 100);

export function createOllamaAdapter(opts: OllamaAdapterOptions): VisionAdapter {
  const { label, timeoutMs } = opts;
  const model = opts.model.trim();
  const ctx = { label, timeoutMs, maxBytes: opts.maxResponseBytes };

  async function describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult> {
    if (model.length === 0) return failure('config', 'Choose an Ollama vision model in Settings.', 0);
    const res = await requestJson({
      fetchImpl: opts.fetchImpl,
      method: 'POST',
      url: joinEndpoint(opts.baseUrl, '/api/chat'),
      timeoutMs,
      signal,
      maxBytes: opts.maxResponseBytes,
      body: {
        model,
        stream: false,
        think: false,
        keep_alive: '5m',
        format: portableSceneSchema(),
        options: { temperature: 0, num_predict: 200 },
        messages: [
          { role: 'system', content: SCENE_SYSTEM_PROMPT },
          { role: 'user', content: sceneUserPrompt(), images: [image.base64] },
        ],
      },
    });
    if (!res.ok) {
      if (res.kind === 'http' && res.status === 404) {
        const name = displayName(model);
        return failure('not-found', `Model "${name}" is not installed in Ollama. Install it with "ollama pull ${name}" and try again.`, res.latencyMs, 404);
      }
      return transportFailure(res, ctx);
    }
    const body = res.json;
    if (!isObj(body)) return failure('bad-response', `${label} sent an unexpected answer.`, res.latencyMs);
    if (typeof body.error === 'string') {
      const detail = sanitizeProviderMessage(body.error);
      return failure('http', `${label} reported an error${detail ? `: ${detail}` : '.'}`, res.latencyMs);
    }
    const message = body.message;
    const content = isObj(message) ? message.content : undefined;
    if (typeof content !== 'string') return failure('bad-response', `${label} sent an answer without text.`, res.latencyMs);
    if (body.done_reason === 'length') return failure('invalid-output', 'The model answer was cut off.', res.latencyMs);
    const parsed = parseSceneReport(content);
    if (!parsed.ok) return failure('invalid-output', parsed.error, res.latencyMs);
    return { ok: true, report: parsed.report, latencyMs: res.latencyMs };
  }

  async function listModels(signal?: AbortSignal): Promise<ListModelsResult> {
    const res = await requestJson({
      fetchImpl: opts.fetchImpl,
      method: 'GET',
      url: joinEndpoint(opts.baseUrl, '/api/tags'),
      timeoutMs,
      signal,
      maxBytes: opts.maxResponseBytes,
    });
    if (!res.ok) return transportFailure(res, ctx);
    const models = isObj(res.json) ? res.json.models : undefined;
    if (!Array.isArray(models)) return failure('bad-response', `${label} sent an unexpected model list.`, res.latencyMs);
    const names = new Set<string>();
    for (const m of models) {
      if (!isObj(m)) continue;
      const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : null;
      if (!name || name.length > 200) continue;
      // Remote/cloud models would send screenshots off this PC.
      if ((typeof m.remote_host === 'string' && m.remote_host.length > 0) || isOllamaCloudModel(name)) continue;
      // Newer servers report capabilities; keep only vision models when they do.
      if (Array.isArray(m.capabilities) && !m.capabilities.includes('vision')) continue;
      names.add(displayName(name));
    }
    return { ok: true, models: [...names].sort((a, b) => a.localeCompare(b)), latencyMs: res.latencyMs };
  }

  return { provider: 'ollama', label, describe, listModels };
}
