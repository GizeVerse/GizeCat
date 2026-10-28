import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, isLoopbackUrl, isOllamaCloudModel, joinEndpoint, parseEndpoint } from '../../../../src/core/perception/endpoint';
import {
  decide,
  decideAiEgress,
  decideCapture,
  effectiveMode,
  regionSamplePoints,
  type CaptureGateInput,
} from '../../../../src/core/perception/privacy';
import { defaultSettings, type Settings } from '../../../../src/shared/settings';
import type { WindowInfo } from '../../../../src/shared/world';

type Patch = { perception?: Partial<Settings['perception']>; ai?: Partial<Settings['ai']> };
function settings(p: Patch = {}): Settings {
  const d = defaultSettings();
  return { ...d, perception: { ...d.perception, ...p.perception }, ai: { ...d.ai, ...p.ai } };
}
const consented = (p: Patch = {}) => settings({ ...p, perception: { visualMode: 'local-stats', consentAt: '2026-10-28T10:00:00.000Z', ...p.perception } });

const win = (over: Partial<WindowInfo> = {}): WindowInfo => ({
  id: '1',
  rect: { x: 0, y: 0, width: 800, height: 600 },
  processName: 'code.exe',
  category: 'code',
  minimized: false,
  maximized: false,
  fullscreen: false,
  excluded: false,
  ...over,
});

const input = (over: Partial<CaptureGateInput> = {}): CaptureGateInput => ({
  settings: consented(),
  paused: false,
  locked: false,
  foreground: win(),
  region: { x: 100, y: 100, width: 800, height: 500 },
  isExcludedAt: () => false,
  ...over,
});

describe('decideCapture', () => {
  it('allows only with visualMode on, consent, no pause/lock/exclusion', () => {
    expect(decideCapture(input())).toEqual({ allowed: true });
  });

  it.each<[string, Partial<CaptureGateInput>, string]>([
    ['default settings (off)', { settings: defaultSettings() }, 'off'],
    ['consent missing', { settings: settings({ perception: { visualMode: 'local-stats', consentAt: null } }) }, 'no-consent'],
    ['consent garbage', { settings: settings({ perception: { visualMode: 'ai', consentAt: 'yes please' } }) }, 'no-consent'],
    ['consent blank', { settings: settings({ perception: { visualMode: 'ai', consentAt: '  ' } }) }, 'no-consent'],
    ['runtime pause', { paused: true }, 'paused'],
    ['persisted pause', { settings: consented({ perception: { paused: true } }) }, 'paused'],
    ['locked', { locked: true }, 'locked'],
    ['excluded foreground', { foreground: win({ excluded: true }) }, 'excluded-foreground'],
    ['no region', { region: null }, 'no-region'],
    ['empty region', { region: { x: 0, y: 0, width: 0, height: 10 } }, 'no-region'],
    ['excluded window at region centre', { isExcludedAt: (p) => p.x === 500 && p.y === 350 }, 'excluded-region'],
    ['excluded window in a corner cell', { isExcludedAt: (p) => p.x < 200 && p.y < 200 }, 'excluded-region'],
    [
      'exclusion check throws (fail closed)',
      {
        isExcludedAt: () => {
          throw new Error('win32 gone');
        },
      },
      'excluded-region',
    ],
  ])('%s -> %s', (_name, over, code) => {
    const d = decideCapture(input(over));
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.code).toBe(code);
      expect(d.reason.length).toBeGreaterThan(5);
    }
  });

  it('checks the order: off beats everything, consent before pause', () => {
    const d = decideCapture(input({ settings: settings({ perception: { visualMode: 'local-stats', consentAt: null } }), paused: true, locked: true }));
    expect(d.allowed ? null : d.code).toBe('no-consent');
  });

  it('samples a 5x5 grid that includes the centre', () => {
    const pts = regionSamplePoints({ x: 0, y: 0, width: 1000, height: 500 });
    expect(pts).toHaveLength(25);
    expect(pts).toContainEqual({ x: 500, y: 250 });
    expect(pts.every((p) => p.x > 0 && p.x < 1000 && p.y > 0 && p.y < 500)).toBe(true);
  });
});

describe('AI egress and effective mode', () => {
  const ai = (aiPatch: Partial<Settings['ai']>) => consented({ perception: { visualMode: 'ai' }, ai: aiPatch });

  it('mode is off without consent even if AI is configured', () => {
    expect(effectiveMode(settings({ perception: { visualMode: 'ai', consentAt: null }, ai: { provider: 'ollama' } }))).toBe('off');
  });

  it('local-stats mode never involves AI', () => {
    expect(effectiveMode(consented())).toBe('local-stats');
    const d = decide({ ...input(), purpose: 'ai' });
    expect(d.allowed).toBe(false);
  });

  it('visualMode ai + provider none -> local stats only', () => {
    const s = ai({ provider: 'none' });
    expect(effectiveMode(s)).toBe('local-stats');
    const d = decide({ ...input({ settings: s }), purpose: 'ai' });
    expect(d.allowed ? null : d.code).toBe('no-provider');
  });

  it('Ollama on loopback is local and needs no cloud permission', () => {
    const s = ai({ provider: 'ollama', ollamaModel: 'qwen3-vl:4b-instruct' });
    expect(effectiveMode(s)).toBe('ai-local');
    expect(decide({ ...input({ settings: s }), purpose: 'ai' })).toEqual({ allowed: true });
  });

  it('a remote Ollama or OpenAI-compatible host needs allowCloud', () => {
    for (const s of [
      ai({ provider: 'ollama', ollamaBaseUrl: 'http://192.168.1.20:11434', ollamaModel: 'm' }),
      ai({ provider: 'openai-compatible', openaiBaseUrl: 'https://api.example.com/v1', openaiModel: 'm' }),
    ]) {
      expect(effectiveMode(s)).toBe('local-stats');
      const d = decideAiEgress(s);
      expect(d.allowed ? null : d.code).toBe('cloud-not-allowed');
      const allowed = { ...s, ai: { ...s.ai, allowCloud: true } };
      expect(effectiveMode(allowed)).toBe('ai-cloud');
      expect(decideAiEgress(allowed)).toEqual({ allowed: true });
    }
  });

  it('Ollama cloud models count as cloud even on a loopback server', () => {
    const s = ai({ provider: 'ollama', ollamaModel: 'gpt-oss:120b-cloud' });
    const d = decideAiEgress(s);
    expect(d.allowed ? null : d.code).toBe('cloud-not-allowed');
    expect(effectiveMode({ ...s, ai: { ...s.ai, allowCloud: true } })).toBe('ai-cloud');
  });

  it('Anthropic is always cloud', () => {
    const s = ai({ provider: 'anthropic' });
    expect(decideAiEgress(s).allowed).toBe(false);
    expect(effectiveMode(s)).toBe('local-stats');
    expect(effectiveMode({ ...s, ai: { ...s.ai, allowCloud: true } })).toBe('ai-cloud');
  });

  it('an invalid endpoint is refused', () => {
    const d = decideAiEgress(ai({ provider: 'ollama', ollamaBaseUrl: 'not a url' }));
    expect(d.allowed ? null : d.code).toBe('invalid-endpoint');
  });

  it('capture blocks still apply to AI', () => {
    const s = ai({ provider: 'ollama', ollamaModel: 'm' });
    const d = decide({ ...input({ settings: s, locked: true }), purpose: 'ai' });
    expect(d.allowed ? null : d.code).toBe('locked');
  });
});

describe('loopback detection resists tricks', () => {
  const LS = String.fromCharCode(0x2028);
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);

  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:1234/v1',
    'HTTP://LOCALHOST:1234',
    'http://127.5.6.7/',
    'https://127.0.0.1/',
    'http://[::1]:8080/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://0x7f.0.0.1/',
    'http://2130706433/',
    'http://127.1/',
    'http://127.0.0.1./',
    '  http://127.0.0.1:11434  ',
  ])('loopback: %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost.evil.com/',
    'http://127.0.0.1.nip.io/',
    'http://localhost./',
    'http://sub.localhost/',
    'http://evil.com#@127.0.0.1',
    'http://evil.com/?h=127.0.0.1',
    'http://evil.com/127.0.0.1',
    'http://127.0.0.1@evil.com/',
    'http://user:pw@localhost/',
    'http://localhost%2eevil.com/',
    'http://[::2]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[fe80::1%25eth0]/',
    'http://0.0.0.0/',
    'http://128.0.0.1/',
    'http://126.255.255.255/',
    'ftp://127.0.0.1/',
    'file:///C:/Windows',
    'http://127.0.0.1 .evil.com',
    `http://127.0.0.1${LS}.evil.com/`,
    `http://localhost${RLO}moc.live/`,
    `http://local${ZWSP}host/`,
    '',
    'localhost',
  ])('not loopback: %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it('classifies the exact URL that would be fetched (backslash quirk)', () => {
    const p = parseEndpoint('http://127.0.0.1:80\\@evil.com');
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.loopback).toBe(true);
      expect(p.url.host).toBe('127.0.0.1');
    }
  });

  it('hostname helper handles IPv6 forms', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('[::ffff:7f00:1]')).toBe(true);
    expect(isLoopbackHostname('[::ffff:7f00:1:1]')).toBe(false);
    expect(isLoopbackHostname('[1::2::3]')).toBe(false);
    expect(isLoopbackHostname('127.0.0.256')).toBe(false);
    expect(isLoopbackHostname('127.00.0.1')).toBe(false);
  });

  it('joinEndpoint keeps the base path and host', () => {
    const p = parseEndpoint('http://127.0.0.1:1234/v1/');
    if (!p.ok) throw new Error('parse');
    expect(joinEndpoint(p.url, '/chat/completions').href).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(joinEndpoint(p.url, '../../x').host).toBe('127.0.0.1:1234');
  });

  it('detects Ollama cloud model tags', () => {
    expect(isOllamaCloudModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isOllamaCloudModel('qwen3-vl:235b-cloud')).toBe(true);
    expect(isOllamaCloudModel('foo:cloud')).toBe(true);
    expect(isOllamaCloudModel('qwen3-vl:4b-instruct')).toBe(false);
    expect(isOllamaCloudModel('cloudy-model:1b')).toBe(false);
  });
});
