// The privacy gate. Every capture and every AI call is decided here, from the
// current settings and host state, before any pixel is read or any byte is sent.
import type { Point, Rect } from '../../shared/geometry';
import type { PerceptionMode } from '../../shared/perception';
import type { AiProviderId, Settings } from '../../shared/settings';
import type { WindowInfo } from '../../shared/world';
import { isOllamaCloudModel, parseEndpoint } from './endpoint';

export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

export type GateBlockCode =
  | 'off'
  | 'no-consent'
  | 'paused'
  | 'locked'
  | 'excluded-foreground'
  | 'excluded-region'
  | 'no-region'
  | 'no-provider'
  | 'invalid-endpoint'
  | 'cloud-not-allowed'
  | 'cloud-model-not-allowed'
  | 'model-unconfirmed';

export type GateDecision = { allowed: true } | { allowed: false; code: GateBlockCode; reason: string };

export const BLOCK_REASONS: Readonly<Record<GateBlockCode, string>> = Object.freeze({
  off: 'Screen analysis is off.',
  'no-consent': 'Screen analysis is waiting for your consent.',
  paused: 'Screen analysis is paused.',
  locked: 'The screen is locked.',
  'excluded-foreground': 'A private app is in front, so the screen is not analysed.',
  'excluded-region': 'A private window is in the capture area, so the screen is not analysed.',
  'no-region': 'There is no screen area to analyse.',
  'no-provider': 'No AI provider is selected.',
  'invalid-endpoint': 'The AI endpoint URL is not valid.',
  'cloud-not-allowed': 'This AI endpoint is not on this PC. Turn on "Allow cloud" to send images to it.',
  'cloud-model-not-allowed': 'This model runs in the cloud, not on this PC: the local server forwards images to it. Turn on "Allow cloud" to send images to it.',
  'model-unconfirmed': 'The AI server has not yet confirmed that this model runs on this PC, so no images are sent.',
});

const block = (code: GateBlockCode, reason: string = BLOCK_REASONS[code]): GateDecision => ({ allowed: false, code, reason });

export function hasConsent(settings: Settings): boolean {
  const c = settings.perception.consentAt;
  return typeof c === 'string' && c.trim().length > 0 && Number.isFinite(Date.parse(c));
}

/**
 * What the AI server on this PC reported about the configured model. A local
 * server can forward a model to a cloud service (Ollama "cloud" models, also
 * through its OpenAI-compatible /v1 API and under any alias), so only main's
 * check with the server can tell; 'unknown' until the server has answered.
 */
export type ModelLocality = 'local' | 'remote' | 'unknown';

export interface AiEgress {
  provider: Exclude<AiProviderId, 'none'>;
  /** Base URL that will receive requests. */
  url: URL;
  /** The endpoint itself is on this PC. */
  loopback: boolean;
  /** True when images would leave this PC. */
  cloud: boolean;
  /**
   * The endpoint is on this PC and nothing marks the model as cloud, but the
   * server has not confirmed that it runs the model locally. Images may then
   * only be sent with "Allow cloud" (fail closed).
   */
  unconfirmed: boolean;
  label: string;
}

const activeModel = (ai: Settings['ai']): string => (ai.provider === 'ollama' ? ai.ollamaModel : ai.openaiModel);

/**
 * Where AI requests would go for the current settings, independent of consent.
 * With the default locality ('unknown', e.g. in the settings UI) this is the
 * classification from the URL and the model name alone, and `unconfirmed`
 * marks what main still has to check with the server.
 */
export function resolveAiEgress(
  settings: Settings,
  locality: ModelLocality = 'unknown',
): { ok: true; egress: AiEgress } | { ok: false; code: GateBlockCode; reason: string } {
  const ai = settings.ai;
  switch (ai.provider) {
    case 'none':
      return { ok: false, code: 'no-provider', reason: BLOCK_REASONS['no-provider'] };
    case 'anthropic':
      return {
        ok: true,
        egress: { provider: 'anthropic', url: new URL(ANTHROPIC_API_BASE), loopback: false, cloud: true, unconfirmed: false, label: 'Anthropic (cloud)' },
      };
    case 'ollama':
    case 'openai-compatible': {
      const raw = ai.provider === 'ollama' ? ai.ollamaBaseUrl : ai.openaiBaseUrl;
      const parsed = parseEndpoint(raw);
      if (!parsed.ok) return { ok: false, code: 'invalid-endpoint', reason: `${BLOCK_REASONS['invalid-endpoint']} ${parsed.error}` };
      const { loopback } = parsed;
      // Any local server may be an Ollama that forwards "cloud" models to ollama.com.
      const cloudModel = loopback && (isOllamaCloudModel(activeModel(ai)) || locality === 'remote');
      const cloud = !loopback || cloudModel;
      const unconfirmed = loopback && !cloud && locality !== 'local';
      const name = ai.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible';
      const where = cloudModel ? 'cloud model' : loopback ? 'this PC' : parsed.url.host;
      return { ok: true, egress: { provider: ai.provider, url: parsed.url, loopback, cloud, unconfirmed, label: `${name} (${where})` } };
    }
  }
}

/**
 * Decides whether an image may be sent to the configured AI provider. Fails
 * closed: a model on a local server that the server has not confirmed as
 * local needs "Allow cloud", like every cloud destination.
 */
export function decideAiEgress(settings: Settings, locality: ModelLocality = 'unknown'): GateDecision {
  const r = resolveAiEgress(settings, locality);
  if (!r.ok) return block(r.code, r.reason);
  if (settings.ai.allowCloud) return { allowed: true };
  if (r.egress.cloud) return block(r.egress.loopback ? 'cloud-model-not-allowed' : 'cloud-not-allowed');
  if (r.egress.unconfirmed) return block('model-unconfirmed');
  return { allowed: true };
}

/**
 * Decides whether main may contact the configured endpoint for a request that
 * carries no screen data (listing models, asking where a model runs): only the
 * endpoint matters, never the model name.
 */
export function decideEndpointEgress(settings: Settings): GateDecision {
  const r = resolveAiEgress(settings);
  if (!r.ok) return block(r.code, r.reason);
  if (!r.egress.loopback && !settings.ai.allowCloud) return block('cloud-not-allowed');
  return { allowed: true };
}

/**
 * The mode the user has configured and consented to (runtime blocks such as
 * pause are reported separately). AI to a model that is not confirmed local
 * counts as cloud.
 */
export function effectiveMode(settings: Settings, locality: ModelLocality = 'unknown'): PerceptionMode {
  const visual = settings.perception.visualMode;
  if (visual === 'off' || !hasConsent(settings)) return 'off';
  if (visual === 'local-stats') return 'local-stats';
  if (!decideAiEgress(settings, locality).allowed) return 'local-stats';
  const r = resolveAiEgress(settings, locality);
  return r.ok && (r.egress.cloud || r.egress.unconfirmed) ? 'ai-cloud' : 'ai-local';
}

export interface CaptureGateInput {
  settings: Settings;
  /** Runtime privacy pause (tray/shortcut); settings.perception.paused is checked as well. */
  paused: boolean;
  locked: boolean;
  foreground: WindowInfo | null;
  /** Host verdict for the REAL foreground window (incl. owned dialogs/popups the app-window filter skips); fail closed. */
  foregroundExcluded?: boolean;
  /** Capture region in physical px; null when none could be determined. */
  region: Rect | null;
  /** Host check: is the top-level window at this physical point excluded? */
  isExcludedAt: (p: Point) => boolean;
}

/** Sample points used to look for excluded windows inside a region: an n x n grid of cell centres (includes the centre for odd n). */
export function regionSamplePoints(region: Rect, n = 5): Point[] {
  const pts: Point[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      pts.push({ x: Math.floor(region.x + ((i + 0.5) / n) * region.width), y: Math.floor(region.y + ((j + 0.5) / n) * region.height) });
    }
  }
  return pts;
}

/** Decides whether the screen may be captured for local analysis (Tier B, also the first step of Tier C). */
export function decideCapture(input: CaptureGateInput): GateDecision {
  const { settings } = input;
  if (settings.perception.visualMode === 'off') return block('off');
  if (!hasConsent(settings)) return block('no-consent');
  if (input.paused || settings.perception.paused) return block('paused');
  if (input.locked) return block('locked');
  if (input.foregroundExcluded === true || input.foreground?.excluded === true) return block('excluded-foreground');
  const region = input.region;
  if (!region || !(region.width > 0) || !(region.height > 0)) return block('no-region');
  for (const p of regionSamplePoints(region)) {
    let excluded: boolean;
    try {
      excluded = input.isExcludedAt(p);
    } catch {
      excluded = true; // fail closed
    }
    if (excluded) return block('excluded-region');
  }
  return { allowed: true };
}

export type GatePurpose = 'capture' | 'ai';

/** Full decision for a purpose: 'ai' additionally requires visualMode 'ai' and an allowed egress. */
export function decide(input: CaptureGateInput & { purpose: GatePurpose; locality?: ModelLocality }): GateDecision {
  const capture = decideCapture(input);
  if (!capture.allowed || input.purpose === 'capture') return capture;
  if (input.settings.perception.visualMode !== 'ai') return block('off', 'AI vision is not enabled.');
  return decideAiEgress(input.settings, input.locality);
}
