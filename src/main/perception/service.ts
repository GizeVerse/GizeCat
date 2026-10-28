// PerceptionService: event-driven, rate-limited, privacy-gated screen analysis.
// request() -> gate -> limits -> capture -> local stats -> (occasionally) AI.
import { FrameAnalyzer, VisualEventDeriver } from '../../core/perception/analysis';
import type { FrameBuffer } from '../../core/perception/frame';
import { CircuitBreaker, RateLimiter } from '../../core/perception/limits';
import {
  BLOCK_REASONS,
  decideAiEgress,
  decideCapture,
  effectiveMode,
  hasConsent,
  resolveAiEgress,
  type GateDecision,
} from '../../core/perception/privacy';
import { chooseRegion, projectRect, regionKey, stickyRegion, type RegionChoice } from '../../core/perception/region';
import { makeTestPattern } from '../../core/perception/testPattern';
import { inflateRect, rectCenter, rectIntersection, type Point, type Rect } from '../../shared/geometry';
import type { PerceptionStatus, SceneReport, VisualFeatures, VisualSummary } from '../../shared/perception';
import type { Settings } from '../../shared/settings';
import type { SimEvent } from '../../shared/sim';
import type { WindowInfo } from '../../shared/world';
import type { Logger, PerceptionHost, PerceptionService, SecretStore, Unsubscribe } from '../contracts';
import { adapterConfigKey, createVisionAdapter, isProviderFault, type AdapterFactory, type DescribeResult, type VisionAdapter } from './adapters';
import type { CapturedFrame, FrameCapturer } from './capture';

export const PERCEPTION_LIMITS = Object.freeze({
  analysisMaxWidth: 256,
  jpegMaxWidth: 512,
  jpegQuality: 60,
  capturesPerHour: 120,
  previewMinIntervalMs: 2_000,
  previewsPerHour: 60,
  testMinIntervalMs: 3_000,
  testsPerHour: 30,
  listTimeoutMs: 10_000,
  eventQueueMax: 32,
  /** changeFraction at/above which a visual summary is emitted even without labels. */
  significantChange: 0.05,
  /** changeFraction at/above which an AI look is worth its cost. */
  aiChangeTrigger: 0.15,
  catMaskPadPx: 12,
  maskPadFramePx: 2,
  /** After a gate block, requests are ignored this long (bounds host calls when the host asks often). */
  gateRetryMs: 2_000,
  /** Status is re-published at least this often so sliding counters stay current. */
  statusRefreshMs: 60_000,
});

export type PerceptionRequestReason = Parameters<PerceptionService['request']>[0];

/** Optional host extension: rects (px) of visible excluded windows, masked instead of only sampled. */
export interface PerceptionHostWithExclusions extends PerceptionHost {
  getExcludedRects(): readonly Rect[];
}

const hasExcludedRects = (h: PerceptionHost): h is PerceptionHostWithExclusions =>
  typeof (h as Partial<PerceptionHostWithExclusions>).getExcludedRects === 'function';

export interface PerceptionServiceDeps {
  logger: Logger;
  host: PerceptionHost;
  secrets: SecretStore;
  settings: Settings;
  /** Clock (ms); defaults to Date.now. */
  now?: () => number;
  capture?: FrameCapturer;
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to createVisionAdapter. */
  adapterFactory?: AdapterFactory;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

interface Plan {
  choice: RegionChoice;
  masksPx: Rect[];
}

class PerceptionServiceImpl implements PerceptionService {
  private settings: Settings;
  private readonly log: Logger;
  private readonly host: PerceptionHost;
  private readonly secrets: SecretStore;
  private readonly now: () => number;
  private readonly capturer: FrameCapturer;
  private readonly fetchImpl: typeof fetch;
  private readonly adapterFactory: AdapterFactory;

  private readonly analyzer = new FrameAnalyzer();
  private readonly deriver = new VisualEventDeriver();
  private readonly captureLimiter: RateLimiter;
  private readonly aiLimiter: RateLimiter;
  private readonly previewLimiter = new RateLimiter({ minIntervalMs: PERCEPTION_LIMITS.previewMinIntervalMs, maxPerWindow: PERCEPTION_LIMITS.previewsPerHour });
  private readonly testLimiter = new RateLimiter({ minIntervalMs: PERCEPTION_LIMITS.testMinIntervalMs, maxPerWindow: PERCEPTION_LIMITS.testsPerHour });
  private readonly breaker = new CircuitBreaker();

  private runtimePaused = false;
  private disposed = false;
  private captureCtl: AbortController | null = null;
  private aiCtl: AbortController | null = null;
  private previewCtl: AbortController | null = null;
  private testCtl: AbortController | null = null;
  private lastChoice: RegionChoice | null = null;
  private sceneUnknown = true;
  private adapterCache: { key: string; adapter: VisionAdapter } | null = null;

  private queue: SimEvent[] = [];
  private blockedReason: string | null = null;
  private lastError: string | null = null;
  private lastCaptureAt: number | null = null;
  private readonly listeners = new Set<(s: PerceptionStatus) => void>();
  private lastStatusJson = '';
  private gateRetryAt = 0;
  private deferred: { reason: PerceptionRequestReason; focus: Point | null } | null = null;
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statusTimer: ReturnType<typeof setInterval>;

  constructor(deps: PerceptionServiceDeps & { capture: FrameCapturer }) {
    this.settings = deps.settings;
    this.log = deps.logger.child('perception');
    this.host = deps.host;
    this.secrets = deps.secrets;
    this.now = deps.now ?? Date.now;
    this.capturer = deps.capture;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.adapterFactory = deps.adapterFactory ?? createVisionAdapter;
    this.captureLimiter = new RateLimiter(this.captureLimits(deps.settings));
    this.aiLimiter = new RateLimiter(this.aiLimits(deps.settings));
    this.lastStatusJson = JSON.stringify(this.computeStatus());
    this.statusTimer = setInterval(() => this.refresh(), PERCEPTION_LIMITS.statusRefreshMs);
    this.statusTimer.unref?.();
  }

  get status(): PerceptionStatus {
    return this.computeStatus();
  }

  updateSettings(next: Settings): void {
    if (this.disposed) return;
    const prev = this.settings;
    this.settings = next;
    this.captureLimiter.configure(this.captureLimits(next));
    this.aiLimiter.configure(this.aiLimits(next));
    this.gateRetryAt = 0;
    const prevMode = effectiveMode(prev);
    const nextMode = effectiveMode(next);
    if (nextMode === 'off' || this.isPaused()) this.abortAll();
    if (nextMode !== prevMode || prev.perception.region !== next.perception.region) {
      this.analyzer.reset();
      this.deriver.reset();
      this.lastChoice = null;
      this.sceneUnknown = true;
      this.blockedReason = null;
    }
    if (adapterConfigKey(prev) !== adapterConfigKey(next) || prev.perception.visualMode !== next.perception.visualMode) {
      this.aiCtl?.abort();
      this.testCtl?.abort();
      this.breaker.reset();
      this.adapterCache = null;
      this.lastError = null;
    }
    if (nextMode !== prevMode) this.log.info('perception mode', { mode: nextMode });
    this.refresh();
  }

  request(reason: PerceptionRequestReason, focus: Point | null): void {
    if (this.disposed) return;
    void this.runCapture(reason, focus);
  }

  drainEvents(): SimEvent[] {
    return this.queue.splice(0, this.queue.length);
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.runtimePaused = paused;
    this.gateRetryAt = 0;
    if (this.isPaused()) this.abortAll();
    this.refresh();
  }

  async preview(): Promise<{ ok: boolean; imageDataUrl?: string; summary?: VisualSummary; blockedReason?: string }> {
    if (this.disposed) return { ok: false, blockedReason: 'Perception has stopped.' };
    const plan = this.plan(null);
    const gate = this.gate(plan);
    if (!gate.allowed) return { ok: false, blockedReason: gate.reason };
    if (!plan) return { ok: false, blockedReason: BLOCK_REASONS['no-region'] };
    if (this.previewCtl) return { ok: false, blockedReason: 'A preview is already being taken.' };
    const now = this.now();
    const lim = this.previewLimiter.check(now);
    if (!lim.ok) return { ok: false, blockedReason: `Please wait ${Math.ceil(lim.retryInMs / 1000)} s before the next preview.` };
    this.previewLimiter.record(now);
    const ctl = new AbortController();
    this.previewCtl = ctl;
    let frame: CapturedFrame | null = null;
    try {
      frame = await this.capturer.capture(this.captureRequest(plan, false), ctl.signal);
      if (ctl.signal.aborted || this.disposed) return { ok: false, blockedReason: BLOCK_REASONS.paused };
      const recheck = this.gate(plan);
      if (!recheck.allowed) return { ok: false, blockedReason: recheck.reason };
      const at = this.now();
      const analysis = new FrameAnalyzer().analyze(frame.analysis, { masks: this.frameMasks(plan, frame.analysis), at });
      const events = new VisualEventDeriver().derive(analysis.features);
      const imageDataUrl = this.capturer.encodePng(frame.analysis);
      return { ok: true, imageDataUrl, summary: this.summary(plan, analysis.features, events, at) };
    } catch (e) {
      if (ctl.signal.aborted) return { ok: false, blockedReason: BLOCK_REASONS.paused };
      this.log.warn('preview capture failed', { error: errorText(e) });
      return { ok: false, blockedReason: 'The screen could not be captured.' };
    } finally {
      if (frame) wipe(frame);
      if (this.previewCtl === ctl) this.previewCtl = null;
      this.refresh();
    }
  }

  async testAi(): Promise<{ ok: boolean; message: string; latencyMs?: number; report?: SceneReport }> {
    if (this.disposed) return { ok: false, message: 'Perception has stopped.' };
    if (this.isPaused()) return { ok: false, message: BLOCK_REASONS.paused };
    const egress = decideAiEgress(this.settings);
    if (!egress.allowed) return { ok: false, message: egress.reason };
    if (this.testCtl) return { ok: false, message: 'A test is already running.' };
    const now = this.now();
    const lim = this.testLimiter.check(now);
    if (!lim.ok) return { ok: false, message: `Please wait ${Math.ceil(lim.retryInMs / 1000)} s before testing again.` };
    const made = this.adapter();
    if (!made.ok) return { ok: false, message: made.message };
    this.testLimiter.record(now);
    const ctl = new AbortController();
    this.testCtl = ctl;
    try {
      // A synthetic picture: testing a provider never sends real screen content.
      const pattern = makeTestPattern(320, 200);
      const jpeg = this.capturer.encodeJpeg(pattern, 70);
      const base64 = Buffer.from(jpeg).toString('base64');
      const result = await this.describe(made.adapter, base64, ctl.signal);
      if (ctl.signal.aborted) return { ok: false, message: 'The test was cancelled.' };
      if (!result.ok) return { ok: false, message: result.message, latencyMs: result.latencyMs };
      this.breaker.recordSuccess();
      this.lastError = null;
      return { ok: true, message: `${made.adapter.label} answered in ${result.latencyMs} ms.`, latencyMs: result.latencyMs, report: result.report };
    } catch (e) {
      this.log.warn('ai test failed', { error: errorText(e) });
      return { ok: false, message: 'The AI test failed unexpectedly.' };
    } finally {
      if (this.testCtl === ctl) this.testCtl = null;
      this.refresh();
    }
  }

  async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    if (this.disposed) return { ok: false, models: [], error: 'Perception has stopped.' };
    // No screen data is sent, but the same egress rule applies to every network call.
    const egress = decideAiEgress(this.settings);
    if (!egress.allowed) return { ok: false, models: [], error: egress.reason };
    const made = this.adapter();
    if (!made.ok) return { ok: false, models: [], error: made.message };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PERCEPTION_LIMITS.listTimeoutMs);
    try {
      const res = await made.adapter.listModels(ctl.signal);
      if (!res.ok) return { ok: false, models: [], error: res.kind === 'aborted' ? 'Listing models took too long.' : res.message };
      return { ok: true, models: res.models };
    } catch (e) {
      this.log.warn('model listing failed', { error: errorText(e) });
      return { ok: false, models: [], error: 'Could not list models.' };
    } finally {
      clearTimeout(timer);
    }
  }

  onStatusChange(cb: (s: PerceptionStatus) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.statusTimer);
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    this.deferred = null;
    this.abortAll();
    this.listeners.clear();
    this.analyzer.reset();
    this.deriver.reset();
    this.queue = [];
    this.adapterCache = null;
  }

  // ---- capture pipeline -------------------------------------------------

  private async runCapture(reason: PerceptionRequestReason, focus: Point | null): Promise<void> {
    try {
      await this.captureOnce(reason, focus);
    } catch (e) {
      this.log.warn('perception capture failed', { error: errorText(e) });
      this.lastError = 'The screen could not be captured.';
      this.refresh();
    }
  }

  private async captureOnce(reason: PerceptionRequestReason, focus: Point | null): Promise<void> {
    const mode = effectiveMode(this.settings);
    if (mode === 'off' || this.isPaused() || this.captureCtl) return;
    const now = this.now();
    if (now < this.gateRetryAt) {
      // Keep the latest request and replay it once, so the block status follows the screen.
      this.defer(reason, focus, this.gateRetryAt - now);
      return;
    }
    if (!this.captureLimiter.check(now).ok) return;

    const plan = this.plan(focus);
    const gate = this.gate(plan);
    if (!gate.allowed || !plan) {
      this.gateRetryAt = now + PERCEPTION_LIMITS.gateRetryMs;
      this.setBlocked(gate.allowed ? BLOCK_REASONS['no-region'] : gate.reason);
      return;
    }

    const aiPossible =
      (mode === 'ai-local' || mode === 'ai-cloud') &&
      this.aiCtl === null &&
      this.aiConfigProblem() === null &&
      this.aiLimiter.check(now).ok &&
      this.breaker.canRequest(now);
    this.captureLimiter.record(now);
    const ctl = new AbortController();
    this.captureCtl = ctl;
    let frame: CapturedFrame;
    try {
      frame = await this.capturer.capture(this.captureRequest(plan, aiPossible), ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) return;
      throw e;
    } finally {
      if (this.captureCtl === ctl) this.captureCtl = null;
    }

    try {
      if (ctl.signal.aborted || this.disposed) return;
      // The world may have changed while the frame was grabbed: decide again before using it.
      const recheck = this.gate(plan);
      if (!recheck.allowed) {
        this.gateRetryAt = this.now() + PERCEPTION_LIMITS.gateRetryMs;
        this.setBlocked(recheck.reason);
        return;
      }
      const at = this.now();
      const t0 = performance.now();
      const key = regionKey(plan.choice);
      const analysis = this.analyzer.analyze(frame.analysis, { masks: this.frameMasks(plan, frame.analysis), at, regionKey: key });
      const events = this.deriver.derive(analysis.features);
      this.log.debug('frame analysed', { analyseMs: Math.round((performance.now() - t0) * 10) / 10, captureMs: frame.durationMs, reason });
      this.lastChoice = plan.choice;
      this.lastCaptureAt = at;
      this.blockedReason = null;
      if (this.lastError === 'The screen could not be captured.') this.lastError = null;

      const summary = this.summary(plan, analysis.features, events, at);
      const cf = analysis.features.changeFraction;
      if (events.length > 0 || (cf ?? 0) >= PERCEPTION_LIMITS.significantChange) this.push({ type: 'perception.visual', summary });

      const trigger = reason === 'curious' || this.sceneUnknown || cf === null || cf >= PERCEPTION_LIMITS.aiChangeTrigger || events.includes('bigChange');
      if (frame.jpeg && trigger) {
        const jpeg = frame.jpeg;
        frame.jpeg = null;
        void this.runAi(jpeg, plan.choice.regionPx);
      }
    } finally {
      wipe(frame);
      this.refresh();
    }
  }

  private async runAi(jpeg: Uint8Array, regionPx: Rect): Promise<void> {
    let ctl: AbortController | null = null;
    try {
      if (this.disposed || this.isPaused() || this.settings.perception.visualMode !== 'ai') return;
      const egress = decideAiEgress(this.settings);
      if (!egress.allowed || this.aiConfigProblem() !== null) return;
      const made = this.adapter();
      if (!made.ok) {
        this.lastError = made.message;
        return;
      }
      const now = this.now();
      if (this.aiCtl || !this.aiLimiter.check(now).ok || !this.breaker.tryAcquire(now)) return;
      this.aiLimiter.record(now);
      this.sceneUnknown = false;
      ctl = new AbortController();
      this.aiCtl = ctl;
      const base64 = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength).toString('base64');
      jpeg.fill(0);
      const result = await this.describe(made.adapter, base64, ctl.signal);
      if (ctl.signal.aborted || this.disposed) {
        this.breaker.releaseProbe();
        return;
      }
      if (result.ok) {
        this.breaker.recordSuccess();
        this.lastError = null;
        this.push({ type: 'perception.ai', report: result.report, regionPx });
        this.log.debug('ai scene report', { scene: result.report.scene, reaction: result.report.reaction, latencyMs: result.latencyMs });
        return;
      }
      if (isProviderFault(result.kind)) {
        const at = this.now();
        this.breaker.recordFailure(at);
        const wait = this.breaker.retryInMs(at);
        this.lastError = wait > 0 ? `${result.message} AI requests are paused for ${Math.ceil(wait / 60_000)} min.` : result.message;
      } else {
        this.breaker.releaseProbe();
        this.lastError = result.message;
      }
      this.log.info('ai request failed', { kind: result.kind, status: result.status ?? null, latencyMs: result.latencyMs, provider: made.adapter.provider });
    } catch (e) {
      this.breaker.releaseProbe();
      this.log.warn('ai request crashed', { error: errorText(e) });
      this.lastError = 'The AI request failed unexpectedly.';
    } finally {
      jpeg.fill(0);
      if (ctl && this.aiCtl === ctl) this.aiCtl = null;
      this.refresh();
    }
  }

  private async describe(adapter: VisionAdapter, base64: string, signal: AbortSignal): Promise<DescribeResult> {
    return adapter.describe({ base64, mediaType: 'image/jpeg' }, signal);
  }

  // ---- helpers ------------------------------------------------------------

  private adapter(): { ok: true; adapter: VisionAdapter } | { ok: false; message: string } {
    const key = adapterConfigKey(this.settings);
    if (this.adapterCache?.key === key) return { ok: true, adapter: this.adapterCache.adapter };
    const made = this.adapterFactory({ settings: this.settings, secrets: this.secrets, fetchImpl: this.fetchImpl });
    if (!made.ok) return made;
    this.adapterCache = { key, adapter: made.adapter };
    return { ok: true, adapter: made.adapter };
  }

  private defer(reason: PerceptionRequestReason, focus: Point | null, delayMs: number): void {
    this.deferred = { reason, focus };
    if (this.deferTimer) return;
    this.deferTimer = setTimeout(() => {
      this.deferTimer = null;
      const d = this.deferred;
      this.deferred = null;
      if (d && !this.disposed) this.request(d.reason, d.focus);
    }, Math.max(1, delayMs));
    this.deferTimer.unref?.();
  }

  /** Missing model or key: AI cannot run, so no frame is encoded for it. */
  private aiConfigProblem(): string | null {
    const ai = this.settings.ai;
    if (ai.provider === 'ollama' && ai.ollamaModel.trim() === '') return 'Choose an Ollama vision model in Settings.';
    if (ai.provider === 'openai-compatible' && ai.openaiModel.trim() === '') return 'Choose a model for the OpenAI-compatible server in Settings.';
    if (ai.provider === 'anthropic') {
      if (ai.anthropicModel.trim() === '') return 'Choose a Claude model in Settings.';
      const hasKey = this.safe(() => this.secrets.has('anthropic'), false);
      if (!hasKey) return 'No Anthropic API key is saved.';
    }
    return null;
  }

  private captureLimits(s: Settings) {
    return { minIntervalMs: s.perception.minIntervalSec * 1000, maxPerWindow: PERCEPTION_LIMITS.capturesPerHour };
  }

  private aiLimits(s: Settings) {
    return { minIntervalMs: s.ai.minIntervalSec * 1000, maxPerWindow: s.ai.maxPerHour };
  }

  private isPaused(): boolean {
    return this.runtimePaused || this.settings.perception.paused;
  }

  private abortAll(): void {
    this.captureCtl?.abort();
    this.aiCtl?.abort();
    this.previewCtl?.abort();
    this.testCtl?.abort();
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (e) {
      this.log.warn('perception host call failed', { error: errorText(e) });
      return fallback;
    }
  }

  private plan(focus: Point | null): Plan | null {
    const displays = this.safe(() => this.capturer.getDisplays(), []);
    const catBounds = this.safe(() => this.host.getCatBounds(), null);
    const foreground = this.safe<WindowInfo | null>(() => this.host.getForeground(), null);
    const interest = focus ?? (catBounds ? rectCenter(catBounds) : null);
    const choice = chooseRegion({
      policy: this.settings.perception.region,
      displays,
      focus,
      catBounds,
      catDisplayId: this.safe(() => this.host.getCatDisplayId(), null),
      foreground,
    });
    if (!choice) return null;
    const stable = stickyRegion(this.lastChoice, choice, interest);
    const masksPx: Rect[] = [];
    if (catBounds) masksPx.push(inflateRect(catBounds, PERCEPTION_LIMITS.catMaskPadPx));
    if (hasExcludedRects(this.host)) {
      const host = this.host;
      for (const r of this.safe(() => host.getExcludedRects(), [])) {
        const clipped = rectIntersection(r, stable.regionPx);
        if (clipped) masksPx.push(clipped);
      }
    }
    return { choice: stable, masksPx };
  }

  private gate(plan: Plan | null): GateDecision {
    let state: { locked: boolean; foreground: WindowInfo | null };
    try {
      state = { locked: this.host.isLocked(), foreground: this.host.getForeground() };
    } catch (e) {
      this.log.warn('perception host state unavailable', { error: errorText(e) });
      return { allowed: false, code: 'excluded-foreground', reason: 'Could not check which app is in front, so the screen is not analysed.' };
    }
    return decideCapture({
      settings: this.settings,
      paused: this.isPaused(),
      locked: state.locked,
      foreground: state.foreground,
      region: plan?.choice.regionPx ?? null,
      isExcludedAt: (p) => this.host.isExcludedAt(p),
    });
  }

  private captureRequest(plan: Plan, withJpeg: boolean) {
    return {
      display: plan.choice.display,
      regionPx: plan.choice.regionPx,
      maskRectsPx: plan.masksPx,
      analysisMaxWidth: PERCEPTION_LIMITS.analysisMaxWidth,
      jpeg: withJpeg ? { maxWidth: PERCEPTION_LIMITS.jpegMaxWidth, quality: PERCEPTION_LIMITS.jpegQuality } : null,
    };
  }

  private frameMasks(plan: Plan, frame: FrameBuffer): Rect[] {
    return plan.masksPx
      .map((m) => projectRect(m, plan.choice.regionPx, frame.width, frame.height, PERCEPTION_LIMITS.maskPadFramePx))
      .filter((r): r is Rect => r !== null);
  }

  private summary(plan: Plan, features: VisualFeatures, events: VisualSummary['events'], at: number): VisualSummary {
    const r = plan.choice.regionPx;
    const box = features.changeBox;
    return {
      features,
      events,
      regionPx: { ...r },
      changeCenterPx: box ? { x: Math.round(r.x + (box.x + box.width / 2) * r.width), y: Math.round(r.y + (box.y + box.height / 2) * r.height) } : null,
      at,
    };
  }

  private push(ev: SimEvent): void {
    if (this.disposed) return;
    if (this.queue.length >= PERCEPTION_LIMITS.eventQueueMax) this.queue.shift();
    this.queue.push(ev);
  }

  private setBlocked(reason: string): void {
    this.blockedReason = reason;
    this.refresh();
  }

  private computeStatus(): PerceptionStatus {
    const s = this.settings;
    const now = this.now();
    const mode = effectiveMode(s);
    const paused = this.isPaused();
    let blockedReason: string | null = null;
    if (s.perception.visualMode !== 'off' && !hasConsent(s)) blockedReason = BLOCK_REASONS['no-consent'];
    else if (mode !== 'off') {
      if (paused) blockedReason = BLOCK_REASONS.paused;
      else if (this.blockedReason) blockedReason = this.blockedReason;
      else if (s.perception.visualMode === 'ai' && mode === 'local-stats') {
        const d = decideAiEgress(s);
        if (!d.allowed) blockedReason = `AI vision is not running: ${d.reason}`;
      } else if (mode === 'ai-local' || mode === 'ai-cloud') {
        const problem = this.aiConfigProblem();
        if (problem) blockedReason = `AI vision is not running: ${problem}`;
      }
    }
    const egress = mode === 'ai-local' || mode === 'ai-cloud' ? resolveAiEgress(s) : null;
    return {
      mode,
      paused,
      blockedReason,
      lastCaptureAt: this.lastCaptureAt,
      capturesThisHour: this.captureLimiter.count(now) + this.previewLimiter.count(now),
      aiProviderLabel: egress?.ok ? egress.egress.label : null,
      lastError: this.lastError,
    };
  }

  private refresh(): void {
    if (this.disposed) return;
    const status = this.computeStatus();
    const json = JSON.stringify(status);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    for (const cb of [...this.listeners]) {
      try {
        cb(status);
      } catch (e) {
        this.log.warn('perception status listener failed', { error: errorText(e) });
      }
    }
  }
}

function wipe(frame: CapturedFrame | null): void {
  if (!frame) return;
  frame.analysis.data.fill(0);
  frame.jpeg?.fill(0);
  frame.jpeg = null;
}

/** Service with an explicit capturer (no Electron dependency); see index.ts for the app default. */
export function createPerceptionServiceWith(deps: PerceptionServiceDeps & { capture: FrameCapturer }): PerceptionService {
  return new PerceptionServiceImpl(deps);
}
