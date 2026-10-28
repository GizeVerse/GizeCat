// Ollama native API (/api/chat, /api/tags, /api/show). Thinking is always
// disabled and models are never pulled automatically. Ollama can forward a
// model to ollama.com ("cloud" models, also under another name), so without
// "Allow cloud" an image is only sent after the server confirmed that it runs
// the model itself.
import { SCENE_SYSTEM_PROMPT, parseSceneReport, sceneUserPrompt } from '../../../core/perception/aiOutput';
import { isOllamaCloudModel, joinEndpoint } from '../../../core/perception/endpoint';
import { BLOCK_REASONS } from '../../../core/perception/privacy';
import { replaceInvisible } from '../../../core/perception/text';
import { failure, requestJson, sanitizeProviderMessage, transportFailure } from './http';
import { portableSceneSchema } from './schema';
import type { AdapterCommonOptions, AdapterFailure, DescribeResult, ListModelsResult, LocalityResult, VisionAdapter, VisionImage } from './types';

export interface OllamaAdapterOptions extends AdapterCommonOptions {
  baseUrl: URL;
  model: string;
  /** "Allow cloud" is on: a model the server forwards to a cloud service may receive images. */
  allowRemoteModel: boolean;
}

/** Cap for /api/show answers, which carry the modelfile, template and licence texts. */
export const OLLAMA_SHOW_MAX_BYTES = 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const displayName = (model: string): string => replaceInvisible(model).trim().slice(0, 100);
const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
/** Ollama marks models it forwards to another host (ollama.com) in /api/tags and /api/show. */
const isRemoteEntry = (m: Record<string, unknown>): boolean => nonEmpty(m.remote_host) || nonEmpty(m.remote_model);

export const ollamaNotInstalledMessage = (model: string): string => {
  const name = displayName(model);
  return `Model "${name}" is not installed in Ollama. Install it with "ollama pull ${name}" and try again.`;
};

export interface OllamaLocalityRequest {
  fetchImpl: typeof fetch;
  /** Server root that serves /api/show. */
  root: URL;
  model: string;
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  secrets?: readonly string[];
}

/**
 * Asks an Ollama server where it runs `model` (POST /api/show; no image is
 * sent). Models Ollama forwards to ollama.com carry remote_host/remote_model,
 * also when they were copied or created under another name. Anything but a
 * model description fails, so the caller stays closed.
 */
export async function ollamaModelLocality(req: OllamaLocalityRequest): Promise<LocalityResult> {
  const { label, timeoutMs } = req;
  const res = await requestJson({
    fetchImpl: req.fetchImpl,
    method: 'POST',
    url: joinEndpoint(req.root, '/api/show'),
    headers: req.headers,
    timeoutMs,
    signal: req.signal,
    maxBytes: OLLAMA_SHOW_MAX_BYTES,
    body: { model: req.model },
  });
  if (!res.ok) {
    if (res.kind === 'http' && res.status === 404) return failure('not-found', ollamaNotInstalledMessage(req.model), res.latencyMs, 404);
    return transportFailure(res, { label, timeoutMs, maxBytes: OLLAMA_SHOW_MAX_BYTES, secrets: req.secrets });
  }
  const body = res.json;
  if (!isObj(body) || !(isObj(body.details) || typeof body.modelfile === 'string' || Array.isArray(body.capabilities))) {
    return failure('bad-response', `${label} did not describe the model, so it is not confirmed to run on this PC.`, res.latencyMs);
  }
  return { ok: true, locality: isRemoteEntry(body) ? 'remote' : 'local', latencyMs: res.latencyMs };
}

export function createOllamaAdapter(opts: OllamaAdapterOptions): VisionAdapter {
  const { label, timeoutMs } = opts;
  const model = opts.model.trim();
  const ctx = { label, timeoutMs, maxBytes: opts.maxResponseBytes };
  let knownLocality: 'local' | 'remote' | null = null;

  async function checkLocality(signal?: AbortSignal): Promise<LocalityResult> {
    if (model.length === 0) return failure('config', 'Choose an Ollama vision model in Settings.', 0);
    if (knownLocality) return { ok: true, locality: knownLocality, latencyMs: 0 };
    const res = await ollamaModelLocality({ fetchImpl: opts.fetchImpl, root: opts.baseUrl, model, label, timeoutMs, signal });
    if (res.ok) knownLocality = res.locality;
    return res;
  }

  /** Without "Allow cloud", images only go to a model the server runs itself. */
  async function localOnly(signal?: AbortSignal): Promise<AdapterFailure | null> {
    if (opts.allowRemoteModel) return null;
    if (isOllamaCloudModel(model)) return failure('config', BLOCK_REASONS['cloud-model-not-allowed'], 0);
    const where = await checkLocality(signal);
    if (!where.ok) return where;
    return where.locality === 'remote' ? failure('config', BLOCK_REASONS['cloud-model-not-allowed'], where.latencyMs) : null;
  }

  async function describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult> {
    if (model.length === 0) return failure('config', 'Choose an Ollama vision model in Settings.', 0);
    const refused = await localOnly(signal);
    if (refused) return refused;
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
      if (res.kind === 'http' && res.status === 404) return failure('not-found', ollamaNotInstalledMessage(model), res.latencyMs, 404);
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
      if (isRemoteEntry(m) || isOllamaCloudModel(name)) continue;
      // Newer servers report capabilities; keep only vision models when they do.
      if (Array.isArray(m.capabilities) && !m.capabilities.includes('vision')) continue;
      names.add(displayName(name));
    }
    return { ok: true, models: [...names].sort((a, b) => a.localeCompare(b)), latencyMs: res.latencyMs };
  }

  return { provider: 'ollama', label, describe, listModels, checkLocality };
}
