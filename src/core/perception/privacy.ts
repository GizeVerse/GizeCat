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
  | 'cloud-not-allowed';

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
});

const block = (code: GateBlockCode, reason: string = BLOCK_REASONS[code]): GateDecision => ({ allowed: false, code, reason });

export function hasConsent(settings: Settings): boolean {
  const c = settings.perception.consentAt;
  return typeof c === 'string' && c.trim().length > 0 && Number.isFinite(Date.parse(c));
}

export interface AiEgress {
  provider: Exclude<AiProviderId, 'none'>;
  /** Base URL that will receive requests. */
  url: URL;
  /** True when images would leave this PC. */
  cloud: boolean;
  label: string;
}

/** Where AI requests would go for the current settings, independent of consent. */
export function resolveAiEgress(settings: Settings): { ok: true; egress: AiEgress } | { ok: false; code: GateBlockCode; reason: string } {
  const ai = settings.ai;
  switch (ai.provider) {
    case 'none':
      return { ok: false, code: 'no-provider', reason: BLOCK_REASONS['no-provider'] };
    case 'anthropic':
      return { ok: true, egress: { provider: 'anthropic', url: new URL(ANTHROPIC_API_BASE), cloud: true, label: 'Anthropic (cloud)' } };
    case 'ollama':
    case 'openai-compatible': {
      const raw = ai.provider === 'ollama' ? ai.ollamaBaseUrl : ai.openaiBaseUrl;
      const parsed = parseEndpoint(raw);
      if (!parsed.ok) return { ok: false, code: 'invalid-endpoint', reason: `${BLOCK_REASONS['invalid-endpoint']} ${parsed.error}` };
      const cloudModel = ai.provider === 'ollama' && isOllamaCloudModel(ai.ollamaModel);
      const cloud = !parsed.loopback || cloudModel;
      const name = ai.provider === 'ollama' ? 'Ollama' : 'OpenAI-compatible';
      const where = cloudModel ? 'cloud model' : parsed.loopback ? 'this PC' : parsed.url.host;
      return { ok: true, egress: { provider: ai.provider, url: parsed.url, cloud, label: `${name} (${where})` } };
    }
  }
}

/** Decides whether an image may be sent to the configured AI provider. */
export function decideAiEgress(settings: Settings): GateDecision {
  const r = resolveAiEgress(settings);
  if (!r.ok) return block(r.code, r.reason);
  if (r.egress.cloud && !settings.ai.allowCloud) return block('cloud-not-allowed');
  return { allowed: true };
}

/** The mode the user has configured and consented to (runtime blocks such as pause are reported separately). */
export function effectiveMode(settings: Settings): PerceptionMode {
  const visual = settings.perception.visualMode;
  if (visual === 'off' || !hasConsent(settings)) return 'off';
  if (visual === 'local-stats') return 'local-stats';
  if (!decideAiEgress(settings).allowed) return 'local-stats';
  const r = resolveAiEgress(settings);
  return r.ok && r.egress.cloud ? 'ai-cloud' : 'ai-local';
}

export interface CaptureGateInput {
  settings: Settings;
  /** Runtime privacy pause (tray/shortcut); settings.perception.paused is checked as well. */
  paused: boolean;
  locked: boolean;
  foreground: WindowInfo | null;
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
  if (input.foreground?.excluded === true) return block('excluded-foreground');
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
export function decide(input: CaptureGateInput & { purpose: GatePurpose }): GateDecision {
  const capture = decideCapture(input);
  if (!capture.allowed || input.purpose === 'capture') return capture;
  if (input.settings.perception.visualMode !== 'ai') return block('off', 'AI vision is not enabled.');
  return decideAiEgress(input.settings);
}
