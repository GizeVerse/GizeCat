// Builds the adapter for the configured provider. Egress rules are re-checked
// here (defence in depth): a non-loopback endpoint is refused unless allowCloud.
import { decideAiEgress, resolveAiEgress } from '../../../core/perception/privacy';
import type { Settings } from '../../../shared/settings';
import type { SecretStore } from '../../contracts';
import { createAnthropicAdapter } from './anthropic';
import { createOllamaAdapter } from './ollama';
import { createOpenAiCompatibleAdapter } from './openaiCompatible';
import type { VisionAdapter } from './types';

export type { VisionAdapter, VisionImage, DescribeResult, ListModelsResult, AdapterFailure, AdapterFailureKind, VisionProvider } from './types';
export { isProviderFault } from './types';
export { createOllamaAdapter } from './ollama';
export { createOpenAiCompatibleAdapter } from './openaiCompatible';
export { createAnthropicAdapter, buildAnthropicMessagesBody, anthropicTuning, ANTHROPIC_VERSION } from './anthropic';
export { requestJson, sanitizeProviderMessage, DEFAULT_MAX_RESPONSE_BYTES } from './http';
export { portableSceneSchema } from './schema';

export interface AdapterFactoryInput {
  settings: Settings;
  secrets: SecretStore;
  fetchImpl: typeof fetch;
}

export type AdapterFactoryResult = { ok: true; adapter: VisionAdapter; cloud: boolean } | { ok: false; message: string };
export type AdapterFactory = (input: AdapterFactoryInput) => AdapterFactoryResult;

/** Settings that, when changed, require a new adapter. */
export function adapterConfigKey(s: Settings): string {
  const a = s.ai;
  return JSON.stringify([a.provider, a.allowCloud, a.ollamaBaseUrl, a.ollamaModel, a.openaiBaseUrl, a.openaiModel, a.anthropicModel, a.timeoutSec]);
}

export const createVisionAdapter: AdapterFactory = ({ settings, secrets, fetchImpl }) => {
  const egress = resolveAiEgress(settings);
  if (!egress.ok) return { ok: false, message: egress.reason };
  const gate = decideAiEgress(settings);
  if (!gate.allowed) return { ok: false, message: gate.reason };
  const { provider, url, cloud, label } = egress.egress;
  const timeoutMs = settings.ai.timeoutSec * 1000;
  const safeGet = (name: 'anthropic' | 'openai-compatible'): string | null => {
    try {
      return secrets.get(name);
    } catch {
      return null;
    }
  };
  switch (provider) {
    case 'ollama':
      return { ok: true, cloud, adapter: createOllamaAdapter({ fetchImpl, timeoutMs, label, baseUrl: url, model: settings.ai.ollamaModel }) };
    case 'openai-compatible':
      return {
        ok: true,
        cloud,
        adapter: createOpenAiCompatibleAdapter({
          fetchImpl,
          timeoutMs,
          label,
          baseUrl: url,
          model: settings.ai.openaiModel,
          cloud,
          getApiKey: () => safeGet('openai-compatible'),
        }),
      };
    case 'anthropic':
      return {
        ok: true,
        cloud,
        adapter: createAnthropicAdapter({ fetchImpl, timeoutMs, label, model: settings.ai.anthropicModel, getApiKey: () => safeGet('anthropic') }),
      };
  }
};
