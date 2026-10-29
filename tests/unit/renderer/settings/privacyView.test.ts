import { describe, expect, it } from 'vitest';
import { BLOCK_REASONS, effectiveMode, resolveAiEgress } from '../../../../src/core/perception/privacy';
import type { AppStatus } from '../../../../src/shared/ipc';
import type { PerceptionStatus } from '../../../../src/shared/perception';
import { defaultSettings, type Settings } from '../../../../src/shared/settings';
import { bannerModel, consentModel, pauseModel, providerTarget, type PrivacyViewInput } from '../../../../src/renderer/settings/privacyView';
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

function view(perception: Partial<PerceptionStatus> = {}, opts: { userPaused?: boolean; visible?: boolean } = {}): PrivacyViewInput {
  const settings = defaultSettings();
  settings.perception.paused = opts.userPaused ?? false;
  const app: AppStatus = {
    version: '0.0.0-test',
    visible: opts.visible ?? true,
    paused: false,
    interactionsEnabled: true,
    catState: 'idle',
    displayCount: 1,
    perception: status(perception),
    windowAwareness: 'event-hooks',
    loginItem: { enabled: true, preference: 'unset', disabledBy: null, active: false, writable: false, reason: null, showNotice: false },
    shortcutRegistered: true,
    startedAt: NOW - 60_000,
  };
  return { settings, status: app };
}

function withAi(ai: Partial<Settings['ai']>): Settings {
  const s = defaultSettings();
  s.ai = { ...s.ai, ...ai };
  return s;
}

describe('bannerModel', () => {
  it('shows a calm off state without capture details', () => {
    const m = bannerModel(view(), NOW);
    expect(m.mode).toBe('off');
    expect(m.title).toBe(S.privacy.banner.off.title);
    expect(m.details).toEqual([]);
  });

  it('lists provider, last capture and errors for cloud AI', () => {
    const m = bannerModel(view({ mode: 'ai-cloud', aiProviderLabel: 'Anthropic', lastCaptureAt: NOW - 95_000, capturesThisHour: 4, lastError: 'timeout' }), NOW);
    expect(m.title).toBe(S.privacy.banner['ai-cloud'].title);
    expect(m.details).toEqual([S.privacy.bannerProvider('Anthropic'), S.privacy.bannerLastCapture('1 min ago', 4), S.privacy.bannerError('timeout')]);
  });

  it('prefers the privacy-pause notice over a blocked reason', () => {
    const paused = bannerModel(view({ mode: 'local-stats', paused: true, blockedReason: 'locked' }, { userPaused: true }), NOW);
    expect(paused.paused).toBe(true);
    expect(paused.details).toContain(S.privacy.bannerPaused);
    expect(paused.details.some((d) => d.includes('locked'))).toBe(false);
    const blocked = bannerModel(view({ mode: 'local-stats', blockedReason: 'an excluded app is in front' }), NOW);
    expect(blocked.details).toContain(S.privacy.bannerBlocked('an excluded app is in front'));
    expect(blocked.details).toContain(S.privacy.bannerNoCapture);
  });

  it('reports a hidden cat as a suspension, not as a privacy pause', () => {
    // Main's runtime pause (hidden cat): status.paused is true, the user's setting is not.
    const m = bannerModel(view({ mode: 'local-stats', paused: true, blockedReason: BLOCK_REASONS.paused }, { visible: false }), NOW);
    expect(m.paused).toBe(false);
    expect(m.details).toContain(S.privacy.suspended.hidden);
    expect(m.details).not.toContain(S.privacy.bannerPaused);
    expect(m.details).not.toContain(S.privacy.bannerBlocked(BLOCK_REASONS.paused));
    const locked = bannerModel(view({ mode: 'ai-local', paused: true, blockedReason: BLOCK_REASONS.paused }, { visible: true }), NOW);
    expect(locked.details).toContain(S.privacy.suspended.locked);
  });

  it('never says "paused until you resume" while screen analysis is off', () => {
    for (const userPaused of [false, true]) {
      for (const visible of [false, true]) {
        const m = bannerModel(view({ mode: 'off', paused: true }, { userPaused, visible }), NOW);
        expect(m.paused).toBe(false);
        expect(m.details).toEqual([]);
      }
    }
  });
});

describe('pauseModel', () => {
  it('follows only the user’s privacy pause setting', () => {
    for (const userPaused of [false, true]) {
      for (const runtimePaused of [false, true]) {
        for (const visible of [false, true]) {
          const v = view({ mode: 'local-stats', paused: userPaused || runtimePaused }, { userPaused, visible });
          expect(pauseModel(v).userPaused).toBe(userPaused);
        }
      }
    }
  });

  it('names why capture is suspended when the user did not pause it', () => {
    expect(pauseModel(view({ mode: 'local-stats', paused: true }, { visible: false })).suspended).toBe('hidden');
    expect(pauseModel(view({ mode: 'local-stats', paused: true }, { visible: true })).suspended).toBe('locked');
    expect(pauseModel(view({ mode: 'local-stats', paused: true }, { userPaused: true, visible: false })).suspended).toBeNull();
    expect(pauseModel(view({ mode: 'local-stats', paused: false })).suspended).toBeNull();
    expect(pauseModel(view({ mode: 'off', paused: true }, { visible: false })).suspended).toBeNull();
  });
});

describe('providerTarget', () => {
  it('classifies where images would go', () => {
    expect(providerTarget(defaultSettings()).destination).toBe('none');
    expect(providerTarget(withAi({ provider: 'anthropic' })).destination).toBe('cloud');
    expect(providerTarget(withAi({ provider: 'ollama' })).destination).toBe('local');
    expect(providerTarget(withAi({ provider: 'ollama' })).host).toBe('127.0.0.1:11434');
    expect(providerTarget(withAi({ provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434' })).destination).toBe('remote');
    expect(providerTarget(withAi({ provider: 'openai-compatible' })).destination).toBe('local');
    expect(providerTarget(withAi({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.example.com/v1' })).destination).toBe('remote');
    const invalid = providerTarget(withAi({ provider: 'openai-compatible', openaiBaseUrl: 'garbage' }));
    expect(invalid.destination).toBe('invalid');
    expect(invalid.leavesDevice).toBe(false);
  });

  it('treats an Ollama cloud model as leaving the PC even through a local server', () => {
    const t = providerTarget(withAi({ provider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: 'gpt-oss:120b-cloud' }));
    expect(t.destination).toBe('cloud-model');
    expect(t.leavesDevice).toBe(true);
    expect(t.label).toBe(S.privacy.cloudModelLabel('Ollama', 'gpt-oss:120b-cloud'));
  });

  it('uses main’s loopback rule, so *.localhost names count as off this PC', () => {
    const t = providerTarget(withAi({ provider: 'ollama', ollamaBaseUrl: 'http://ollama.localhost:11434' }));
    expect(t.destination).toBe('remote');
    expect(t.leavesDevice).toBe(true);
    expect(providerTarget(withAi({ provider: 'ollama', ollamaBaseUrl: 'http://[::ffff:7f00:1]:11434' })).destination).toBe('local');
  });

  it('agrees with main on every provider, address and model combination', () => {
    const urls = [
      'http://127.0.0.1:11434',
      'http://localhost:1234/v1',
      'http://[::1]:8080',
      'http://[::ffff:7f00:1]:11434',
      'http://ollama.localhost:11434',
      'http://localhost.:11434',
      'http://192.168.1.20:11434',
      'https://api.example.com/v1',
      'http://127.0.0.1.nip.io:11434',
      'garbage',
      '',
    ];
    const models = ['', 'llava:7b', 'gpt-oss:120b-cloud', 'qwen3-vl:235b-cloud', 'cloud', 'mycloudmodel'];
    for (const provider of ['ollama', 'openai-compatible', 'anthropic'] as const) {
      for (const url of urls) {
        for (const model of models) {
          for (const allowCloud of [false, true]) {
            const s = withAi({ provider, ollamaBaseUrl: url, openaiBaseUrl: url, ollamaModel: model, openaiModel: model, allowCloud });
            const target = providerTarget(s);
            const consented: Settings = { ...s, perception: { ...s.perception, visualMode: 'ai', consentAt: new Date(NOW).toISOString() } };
            const mode = effectiveMode(consented);
            const egress = resolveAiEgress(s);
            const ctx = `${provider} ${url} ${model} allowCloud=${allowCloud}`;
            // The UI's "leaves this PC" is main's cloud flag, never a renderer guess.
            expect(target.leavesDevice, ctx).toBe(egress.ok && egress.egress.cloud);
            expect(target.destination === 'invalid', ctx).toBe(!egress.ok);
            // Main never runs on-device AI for a destination the UI flagged, nor sends to one without "Allow cloud".
            if (mode === 'ai-local') expect(target.destination, ctx).toBe('local');
            if (target.leavesDevice) expect(mode, ctx).toBe(allowCloud ? 'ai-cloud' : 'local-stats');
            if (target.destination === 'invalid') expect(mode, ctx).toBe('local-stats');
            const consent = consentModel('ai', s);
            expect(consent.tone, ctx).toBe(target.leavesDevice ? 'caution' : 'default');
            expect(consent.warning, ctx).toBe(target.leavesDevice && !allowCloud ? S.privacy.consent.cloudNotAllowed : null);
          }
        }
      }
    }
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

  it('names the local server and says its cloud models may leave this PC', () => {
    const s = withAi({ provider: 'ollama' });
    const m = consentModel('ai', s);
    expect(m.tone).toBe('default');
    expect(m.destination).toBe(S.privacy.consent.destLocal(providerTarget(s).label, '127.0.0.1:11434'));
    expect(m.destination).toContain('127.0.0.1:11434');
    expect(m.destination).toContain('Allow cloud');
  });

  it('does not promise that an Ollama cloud model on localhost keeps the image on this PC', () => {
    const s = withAi({ provider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434', ollamaModel: 'gpt-oss:120b-cloud', allowCloud: true });
    const m = consentModel('ai', s);
    expect(m.tone).toBe('caution');
    expect(m.destination).toBe(S.privacy.consent.destCloudModel(providerTarget(s).label, '127.0.0.1:11434'));
    expect(m.destination).toContain('ollama.com');
    expect(m.warning).toBeNull();
    s.ai.allowCloud = false;
    expect(consentModel('ai', s).warning).toBe(S.privacy.consent.cloudNotAllowed);
  });

  it('warns about a *.localhost server like any other remote server', () => {
    const s = withAi({ provider: 'ollama', ollamaBaseUrl: 'http://ollama.localhost:11434' });
    const m = consentModel('ai', s);
    expect(m.tone).toBe('caution');
    expect(m.destination).toBe(S.privacy.consent.destRemote(providerTarget(s).label));
    expect(m.warning).toBe(S.privacy.consent.cloudNotAllowed);
  });

  it('never claims for AI vision that the image cannot leave the device', () => {
    const settings = [
      withAi({ provider: 'ollama' }),
      withAi({ provider: 'ollama', ollamaModel: 'gpt-oss:120b-cloud' }),
      withAi({ provider: 'openai-compatible' }),
      withAi({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.example.com/v1' }),
      withAi({ provider: 'anthropic' }),
    ];
    for (const s of settings) {
      const text = consentModel('ai', s).destination ?? '';
      expect(text).not.toMatch(/does not leave|never leaves|stays on (this|your)/i);
    }
  });
});
