import { makeFrame, type FrameBuffer } from '../../../src/core/perception/frame';
import type { Logger, PerceptionHost, SecretStore } from '../../../src/main/contracts';
import type { AdapterFactory, VisionAdapter } from '../../../src/main/perception/adapters';
import type { CaptureDisplay, CaptureRequest, CapturedFrame, FrameCapturer } from '../../../src/main/perception/capture';
import type { Point, Rect } from '../../../src/shared/geometry';
import type { SceneReport } from '../../../src/shared/perception';
import { defaultSettings, type Settings } from '../../../src/shared/settings';
import type { WindowInfo } from '../../../src/shared/world';

export const CONSENT = '2026-10-28T10:00:00.000Z';
export const JPEG_MARKER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]);
export const REPORT: SceneReport = { scene: 'code', energy: 'calm', interest: 0.3, reaction: 'sit_nearby', caption: 'Someone writing code' };

type Patch = { perception?: Partial<Settings['perception']>; ai?: Partial<Settings['ai']> };
export function makeSettings(p: Patch = {}): Settings {
  const d = defaultSettings();
  return { ...d, perception: { ...d.perception, ...p.perception }, ai: { ...d.ai, ...p.ai } };
}
export const localStats = (p: Patch = {}) => makeSettings({ ...p, perception: { visualMode: 'local-stats', consentAt: CONSENT, ...p.perception } });
export const aiLocal = (p: Patch = {}) =>
  makeSettings({
    perception: { visualMode: 'ai', consentAt: CONSENT, ...p.perception },
    ai: { provider: 'ollama', ollamaModel: 'qwen3-vl:4b-instruct', minIntervalSec: 30, maxPerHour: 12, ...p.ai },
  });

export interface LogEntry {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}
export function recordingLogger(entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const make = (scope: string): Logger => ({
    error: (msg, data) => entries.push({ level: 'error', msg: `${scope}:${msg}`, data }),
    warn: (msg, data) => entries.push({ level: 'warn', msg: `${scope}:${msg}`, data }),
    info: (msg, data) => entries.push({ level: 'info', msg: `${scope}:${msg}`, data }),
    debug: (msg, data) => entries.push({ level: 'debug', msg: `${scope}:${msg}`, data }),
    child: (s) => make(`${scope}/${s}`),
  });
  return Object.assign(make('root'), { entries });
}

export class FakeClock {
  t = 1_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export class FakeHost implements PerceptionHost {
  catBounds: Rect | null = { x: 1150, y: 700, width: 100, height: 100 };
  catDisplayId: string | null = '1';
  foreground: WindowInfo | null = null;
  locked = false;
  excludedAt: (p: Point) => boolean = () => false;
  getCatBounds = () => this.catBounds;
  getCatDisplayId = () => this.catDisplayId;
  getForeground = () => this.foreground;
  isExcludedAt = (p: Point) => this.excludedAt(p);
  excludedRects: Rect[] = [];
  getExcludedRects = () => this.excludedRects;
  foregroundExcluded = false;
  isForegroundExcluded = () => this.foregroundExcluded;
  isLocked = () => this.locked;
}

export function window(over: Partial<WindowInfo> = {}): WindowInfo {
  return {
    id: '42',
    rect: { x: 100, y: 100, width: 1200, height: 800 },
    processName: 'code.exe',
    category: 'code',
    minimized: false,
    maximized: false,
    fullscreen: false,
    excluded: false,
    ...over,
  };
}

export class FakeCapturer implements FrameCapturer {
  readonly displays: CaptureDisplay[] = [{ id: '1', boundsPx: { x: 0, y: 0, width: 2400, height: 1500 }, scaleFactor: 1.25, primary: true }];
  requests: CaptureRequest[] = [];
  /** Produces frame i (default: alternating dark / bright, i.e. big change). */
  frameFor: (i: number) => FrameBuffer = (i) => makeFrame(256, 160, () => (i % 2 === 0 ? [15, 15, 15] : [240, 240, 240]));
  /** Runs before the capture resolves (simulate the world changing mid-capture). */
  during: (() => void) | null = null;
  /** When set, capture waits for this promise. */
  gate: Promise<void> | null = null;
  pngCalls = 0;
  jpegCalls = 0;

  getDisplays = () => this.displays;

  capture = async (req: CaptureRequest, signal: AbortSignal): Promise<CapturedFrame> => {
    const i = this.requests.length;
    this.requests.push(req);
    if (this.gate) await this.gate;
    this.during?.();
    if (signal.aborted) throw new Error('aborted');
    return { analysis: this.frameFor(i), jpeg: req.jpeg ? JPEG_MARKER.slice() : null, durationMs: 3 };
  };

  encodePng = (_f: FrameBuffer) => {
    this.pngCalls++;
    return 'data:image/png;base64,iVBORw0KGgo=';
  };

  encodeJpeg = (_f: FrameBuffer, _q: number) => {
    this.jpegCalls++;
    return JPEG_MARKER.slice();
  };
}

export class MockAdapter implements VisionAdapter {
  readonly provider = 'ollama' as const;
  readonly label = 'Ollama (this PC)';
  calls: Array<{ base64: string; signal?: AbortSignal }> = [];
  impl: VisionAdapter['describe'] = () => Promise.resolve({ ok: true, report: REPORT, latencyMs: 12 });
  models: string[] = ['qwen3-vl:4b-instruct'];
  /** What the "server" says about where it runs the model. */
  localityImpl: NonNullable<VisionAdapter['checkLocality']> = () => Promise.resolve({ ok: true, locality: 'local', latencyMs: 1 });
  localityCalls = 0;

  describe: VisionAdapter['describe'] = (image, signal) => {
    this.calls.push({ base64: image.base64, signal });
    return this.impl(image, signal);
  };

  listModels: VisionAdapter['listModels'] = () => Promise.resolve({ ok: true, models: this.models, latencyMs: 1 });

  checkLocality: NonNullable<VisionAdapter['checkLocality']> = (signal) => {
    this.localityCalls++;
    return this.localityImpl(signal);
  };
}

export function mockFactory(adapter: MockAdapter): AdapterFactory & { calls: number } {
  const f = Object.assign(
    (input: Parameters<AdapterFactory>[0]) => {
      f.calls++;
      // Keep the real egress rules in force for the mock as well.
      return input.settings.ai.provider === 'none' ? { ok: false as const, message: 'No AI provider is selected.' } : { ok: true as const, adapter, cloud: false };
    },
    { calls: 0 },
  );
  return f;
}

export const memorySecrets = (key: string | null = null): SecretStore => ({ has: () => key !== null, get: () => key, set: () => true });

export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
