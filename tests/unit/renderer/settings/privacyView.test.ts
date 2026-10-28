import { describe, expect, it } from 'vitest';
import type { PerceptionStatus } from '../../../../src/shared/perception';
import { defaultSettings } from '../../../../src/shared/settings';
import { bannerModel, consentModel, providerTarget } from '../../../../src/renderer/settings/privacyView';
import { S } from '../../../../src/renderer/settings/strings';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const status = (over: Partial<PerceptionStatus> = {}): PerceptionStatus => ({
  mode: 'off',
  paused: false,
  blockedReason: null,
  lastCaptureAt: null,
  capturesThisHour: 0,
  aiProviderLabel: null,
  lastError: null,
  ...over,
});

describe('bannerModel', () => {
  it('shows a calm off state without capture details', () => {
    const m = bannerModel(status(), NOW);
    expect(m.mode).toBe('off');
    expect(m.title).toBe(S.privacy.banner.off.title);
    expect(m.details).toEqual([]);
  });

  it('lists provider, last capture and errors for cloud AI', () => {
    const m = bannerModel(
      status({ mode: 'ai-cloud', aiProviderLabel: 'Anthropic', lastCaptureAt: NOW - 95_000, capturesThisHour: 4, lastError: 'timeout' }),
      NOW,
    );
    expect(m.title).toBe(S.privacy.banner['ai-cloud'].title);
    expect(m.details).toEqual([S.privacy.bannerProvider('Anthropic'), S.privacy.bannerLastCapture('1 min ago', 4), S.privacy.bannerError('timeout')]);
  });

  it('prefers the paused notice over a blocked reason', () => {
    const paused = bannerModel(status({ mode: 'local-stats', paused: true, blockedReason: 'locked' }), NOW);
    expect(paused.paused).toBe(true);
    expect(paused.details).toContain(S.privacy.bannerPaused);
    expect(paused.details.some((d) => d.includes('locked'))).toBe(false);
    const blocked = bannerModel(status({ mode: 'local-stats', blockedReason: 'an excluded app is in front' }), NOW);
    expect(blocked.details).toContain(S.privacy.bannerBlocked('an excluded app is in front'));
    expect(blocked.details).toContain(S.privacy.bannerNoCapture);
  });
});

describe('providerTarget', () => {
  it('classifies where images would go', () => {
    const ai = defaultSettings().ai;
    expect(providerTarget(ai).destination).toBe('none');
    expect(providerTarget({ ...ai, provider: 'anthropic' }).destination).toBe('cloud');
    expect(providerTarget({ ...ai, provider: 'ollama' }).destination).toBe('local');
    expect(providerTarget({ ...ai, provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434' }).destination).toBe('remote');
    expect(providerTarget({ ...ai, provider: 'openai-compatible' }).destination).toBe('local');
    expect(providerTarget({ ...ai, provider: 'openai-compatible', openaiBaseUrl: 'https://api.example.com/v1' }).destination).toBe('remote');
    expect(providerTarget({ ...ai, provider: 'openai-compatible', openaiBaseUrl: 'garbage' }).destination).toBe('remote');
  });
});

describe('consentModel', () => {
  it('describes local statistics with the configured region and interval', () => {
    const s = defaultSettings();
    s.perception.region = 'active-window';
    s.perception.minIntervalSec = 90;
    const m = consentModel('local-stats', s);
    expect(m.title).toBe(S.privacy.consent.localTitle);
    expect(m.points[0]).toContain('active window');
    expect(m.points[1]).toContain('1 min 30 s');
    expect(m.destination).toBeNull();
    expect(m.tone).toBe('default');
  });

  it('warns that nothing is sent without a provider', () => {
    const m = consentModel('ai', defaultSettings());
    expect(m.destination).toBe(S.privacy.consent.destNone);
    expect(m.warning).toBeNull();
    expect(m.tone).toBe('default');
  });

  it('marks cloud providers as leaving the device and flags a missing allowCloud', () => {
    const s = defaultSettings();
    s.ai.provider = 'anthropic';
    s.ai.minIntervalSec = 300;
    const m = consentModel('ai', s);
    expect(m.tone).toBe('caution');
    expect(m.destination).toContain('internet');
    expect(m.warning).toBe(S.privacy.consent.cloudNotAllowed);
    expect(m.points[1]).toContain('5 min');
    expect(m.points[1]).toContain(String(s.ai.maxPerHour));
    s.ai.allowCloud = true;
    expect(consentModel('ai', s).warning).toBeNull();
  });

  it('treats a local Ollama server as staying on the device', () => {
    const s = defaultSettings();
    s.ai.provider = 'ollama';
    const m = consentModel('ai', s);
    expect(m.tone).toBe('default');
    expect(m.destination).toBe(S.privacy.consent.destLocal(providerTarget(s.ai).label));
  });
});
