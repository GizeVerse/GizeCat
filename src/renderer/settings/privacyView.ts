// Pure view models for the privacy banner and the screen-analysis consent dialog.
import type { PerceptionMode, PerceptionStatus } from '../../shared/perception';
import type { Settings } from '../../shared/settings';
import { formatDuration, formatRelativeTime } from './format';
import { S } from './strings';
import { validateBaseUrl } from './validate';

const P = S.privacy;

export interface BannerModel {
  mode: PerceptionMode;
  title: string;
  text: string;
  details: string[];
  paused: boolean;
}

export function bannerModel(status: PerceptionStatus, now: number): BannerModel {
  const base = P.banner[status.mode];
  const details: string[] = [];
  if (status.aiProviderLabel && (status.mode === 'ai-local' || status.mode === 'ai-cloud')) details.push(P.bannerProvider(status.aiProviderLabel));
  if (status.paused) details.push(P.bannerPaused);
  else if (status.blockedReason) details.push(P.bannerBlocked(status.blockedReason));
  if (status.mode !== 'off') {
    details.push(
      status.lastCaptureAt === null ? P.bannerNoCapture : P.bannerLastCapture(formatRelativeTime(status.lastCaptureAt, now), status.capturesThisHour),
    );
  }
  if (status.lastError) details.push(P.bannerError(status.lastError));
  return { mode: status.mode, title: base.title, text: base.text, details, paused: status.paused };
}

export type Destination = 'none' | 'local' | 'remote' | 'cloud';

export interface ProviderTarget {
  destination: Destination;
  label: string;
}

/** Where AI images would go with the current settings. */
export function providerTarget(ai: Settings['ai']): ProviderTarget {
  switch (ai.provider) {
    case 'none':
      return { destination: 'none', label: S.ai.providers.none.title };
    case 'anthropic':
      return { destination: 'cloud', label: `${S.ai.providers.anthropic.title} (${ai.anthropicModel})` };
    case 'ollama':
      return hostTarget(S.ai.providers.ollama.title, ai.ollamaBaseUrl);
    case 'openai-compatible':
      return hostTarget(S.ai.providers['openai-compatible'].title, ai.openaiBaseUrl);
  }
}

function hostTarget(title: string, baseUrl: string): ProviderTarget {
  const parsed = validateBaseUrl(baseUrl);
  if (!parsed.ok) return { destination: 'remote', label: `${title} (${baseUrl || '?'})` };
  return { destination: parsed.value.loopback ? 'local' : 'remote', label: `${title} (${parsed.value.url})` };
}

export interface ConsentModel {
  title: string;
  intro: string;
  points: string[];
  destinationTitle: string | null;
  destination: string | null;
  warning: string | null;
  confirmLabel: string;
  tone: 'default' | 'caution';
}

export function consentModel(kind: 'local-stats' | 'ai', settings: Settings): ConsentModel {
  const region = P.regions[settings.perception.region];
  const interval = formatDuration(settings.perception.minIntervalSec);
  if (kind === 'local-stats') {
    return {
      title: P.consent.localTitle,
      intro: P.consent.intro,
      points: [...P.consent.localPoints(region, interval)],
      destinationTitle: null,
      destination: null,
      warning: null,
      confirmLabel: P.consent.confirm,
      tone: 'default',
    };
  }
  const aiInterval = formatDuration(Math.max(settings.perception.minIntervalSec, settings.ai.minIntervalSec));
  const target = providerTarget(settings.ai);
  const destination =
    target.destination === 'none'
      ? P.consent.destNone
      : target.destination === 'local'
        ? P.consent.destLocal(target.label)
        : target.destination === 'cloud'
          ? P.consent.destCloud(target.label)
          : P.consent.destRemote(target.label);
  const leavesDevice = target.destination === 'cloud' || target.destination === 'remote';
  return {
    title: P.consent.aiTitle,
    intro: P.consent.intro,
    points: [...P.consent.aiPoints(region, aiInterval, settings.ai.maxPerHour)],
    destinationTitle: P.consent.destination,
    destination,
    warning: leavesDevice && !settings.ai.allowCloud ? P.consent.cloudNotAllowed : null,
    confirmLabel: P.consent.confirm,
    tone: leavesDevice ? 'caution' : 'default',
  };
}
