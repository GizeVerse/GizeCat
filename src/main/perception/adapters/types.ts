import type { SceneReport } from '../../../shared/perception';

export type AdapterFailureKind =
  | 'config'
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'redirect'
  | 'too-large'
  | 'auth'
  | 'not-found'
  | 'rate-limited'
  | 'http'
  | 'bad-response'
  | 'invalid-output'
  | 'refused';

export interface AdapterFailure {
  ok: false;
  kind: AdapterFailureKind;
  /** Short, user-facing; never contains API keys, image data or model output. */
  message: string;
  status?: number;
  latencyMs: number;
}

export type DescribeResult = { ok: true; report: SceneReport; latencyMs: number } | AdapterFailure;
export type ListModelsResult = { ok: true; models: string[]; latencyMs: number } | AdapterFailure;
/** Where the server runs the configured model: 'remote' when it forwards requests to another service. */
export type LocalityResult = { ok: true; locality: 'local' | 'remote'; latencyMs: number } | AdapterFailure;

export interface VisionImage {
  /** Base64 without a data: prefix. */
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
}

export type VisionProvider = 'ollama' | 'openai-compatible' | 'anthropic';

export interface VisionAdapter {
  readonly provider: VisionProvider;
  /** e.g. "Ollama (this PC)". */
  readonly label: string;
  describe(image: VisionImage, signal?: AbortSignal): Promise<DescribeResult>;
  listModels(signal?: AbortSignal): Promise<ListModelsResult>;
  /**
   * Servers on this PC only: asks the server whether it runs the configured
   * model itself (no image is sent). The first answer is kept for the adapter's
   * lifetime; failures are not kept.
   */
  checkLocality?(signal?: AbortSignal): Promise<LocalityResult>;
}

export interface AdapterCommonOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Response body cap in bytes (default 64 KB). */
  maxResponseBytes?: number;
  label: string;
}

/** A failure that is the provider's or the network's fault (counts toward the circuit breaker). */
export function isProviderFault(kind: AdapterFailureKind): boolean {
  return kind !== 'aborted' && kind !== 'config' && kind !== 'refused';
}
