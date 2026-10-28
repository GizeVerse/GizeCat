// Pure view models for the privacy banner and the screen-analysis consent dialog.
import { isLoopbackUrl } from '../../core/perception/endpoint';
import { resolveAiEgress } from '../../core/perception/privacy';
import type { SettingsViewState } from '../../shared/ipc';
import type { PerceptionMode } from '../../shared/perception';
import type { Settings } from '../../shared/settings';
import { formatDuration, formatRelativeTime } from './format';
import { S } from './strings';

const P = S.privacy;

/** The parts of the view that decide what the privacy surfaces show. */
export type PrivacyViewInput = Pick<SettingsViewState, 'settings' | 'status'>;

export interface PauseModel {
  /** The user's privacy pause (settings.perception.paused). This alone drives the pause switch. */
  userPaused: boolean;
  /**
   * Capture is suspended although the user did not pause it. Main suspends capture
   * while the cat is hidden or the session is locked; null while analysis is off.
   */
  suspended: 'hidden' | 'locked' | null;
}

export function pauseModel(view: PrivacyViewInput): PauseModel {
  const userPaused = view.settings.perception.paused;
  const p = view.status.perception;
  // status.perception.paused is the user's pause OR main's runtime pause (app.ts:
  // hidden || locked). With the user's pause off, a visible cat means the PC is locked.
  const suspended = !userPaused && p.paused && p.mode !== 'off' ? (view.status.visible ? 'locked' : 'hidden') : null;
  return { userPaused, suspended };
}

export interface BannerModel {
  mode: PerceptionMode;
  title: string;
  text: string;
  details: string[];
  /** The user's privacy pause is on while analysis is configured. */
  paused: boolean;
}

export function bannerModel(view: PrivacyViewInput, now: number): BannerModel {
  const status = view.status.perception;
  const base = P.banner[status.mode];
  const pause = pauseModel(view);
  const paused = status.mode !== 'off' && pause.userPaused;
  const details: string[] = [];
  if (status.aiProviderLabel && (status.mode === 'ai-local' || status.mode === 'ai-cloud')) details.push(P.bannerProvider(status.aiProviderLabel));
  if (paused) details.push(P.bannerPaused);
  else if (pause.suspended) details.push(P.suspended[pause.suspended]);
  else if (status.blockedReason) details.push(P.bannerBlocked(status.blockedReason));
  if (status.mode !== 'off') {
    details.push(
      status.lastCaptureAt === null ? P.bannerNoCapture : P.bannerLastCapture(formatRelativeTime(status.lastCaptureAt, now), status.capturesThisHour),
    );
  }
  if (status.lastError) details.push(P.bannerError(status.lastError));
  return { mode: status.mode, title: base.title, text: base.text, details, paused };
}

/**
 * - local: a server on this PC with a model main does not treat as cloud. The
 *   server itself may still forward to a cloud model main cannot recognise.
 * - remote: a server on another computer.
 * - cloud: a cloud provider's API.
 * - cloud-model: a server on this PC that forwards to a cloud model (Ollama "-cloud").
 * - invalid: the server address cannot be used, so nothing is sent.
 */
export type Destination = 'none' | 'local' | 'remote' | 'cloud' | 'cloud-model' | 'invalid';

export interface ProviderTarget {
  destination: Destination;
  label: string;
  /** host[:port] that receives the requests ('' when there is none). */
  host: string;
  /** Main's classification (resolveAiEgress): images would leave this PC, so "Allow cloud" is required. */
  leavesDevice: boolean;
}

/**
 * Where AI images would go with the current settings. The classification is main's
 * own (resolveAiEgress, isLoopbackUrl), never re-derived here, so the UI cannot
 * call "on this PC" what main sends to the cloud.
 */
export function providerTarget(settings: Settings): ProviderTarget {
  const ai = settings.ai;
  if (ai.provider === 'none') return { destination: 'none', label: S.ai.providers.none.title, host: '', leavesDevice: false };
  const title = S.ai.providers[ai.provider].title;
  const raw = ai.provider === 'anthropic' ? '' : (ai.provider === 'ollama' ? ai.ollamaBaseUrl : ai.openaiBaseUrl).trim();
  const resolved = resolveAiEgress(settings);
  if (!resolved.ok) return { destination: 'invalid', label: `${title} (${raw || '?'})`, host: '', leavesDevice: false };
  const { egress } = resolved;
  const common = { host: egress.url.host, leavesDevice: egress.cloud };
  if (ai.provider === 'anthropic') return { destination: 'cloud', label: `${title} (${ai.anthropicModel})`, ...common };
  if (!egress.cloud) return { destination: 'local', label: `${title} (${raw})`, ...common };
  if (!isLoopbackUrl(raw)) return { destination: 'remote', label: `${title} (${raw})`, ...common };
  // Main counts a server on this PC as cloud only for a model that it forwards to the cloud.
  const model = (ai.provider === 'ollama' ? ai.ollamaModel : ai.openaiModel).trim();
  return { destination: 'cloud-model', label: P.cloudModelLabel(title, model), ...common };
}

function destinationText(t: ProviderTarget): string {
  switch (t.destination) {
    case 'none':
      return P.consent.destNone;
    case 'invalid':
      return P.consent.destInvalid(t.label);
    case 'local':
      return P.consent.destLocal(t.label, t.host);
    case 'remote':
      return P.consent.destRemote(t.label);
    case 'cloud':
      return P.consent.destCloud(t.label);
    case 'cloud-model':
      return P.consent.destCloudModel(t.label, t.host);
  }
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
  const target = providerTarget(settings);
  return {
    title: P.consent.aiTitle,
    intro: P.consent.intro,
    points: [...P.consent.aiPoints(region, aiInterval, settings.ai.maxPerHour)],
    destinationTitle: P.consent.destination,
    destination: destinationText(target),
    warning: target.leavesDevice && !settings.ai.allowCloud ? P.consent.cloudNotAllowed : null,
    confirmLabel: P.consent.confirm,
    tone: target.leavesDevice ? 'caution' : 'default',
  };
}
