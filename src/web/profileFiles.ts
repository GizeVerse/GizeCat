// Where a GizeCat profile file goes and comes from in the web host (1.4.0, "Take your cat to
// another device"). Local files only: nothing here makes a network request (the page's CSP has
// connect-src 'none'), and nothing is read without the user picking a file.
//
// Saving:
// - in a browser tab: a Blob behind an <a download> link (the browser's own download);
// - in the installed web app on an iPad or iPhone: the share sheet with the file ("Save to Files"),
//   where a blob download is unreliable in standalone mode (platform knowledge, UNVERIFIED on a
//   device); a download when the share sheet cannot take files;
// - in the Android app: the native bridge `gizecatNative` (android/README.md): one JSON message
//   {type:'saveFile', name, mime, text}, answered by {type:'saveResult', ok, reason?}; the user picks
//   the place in the system "save as" screen.
// Loading: an <input type=file> everywhere (the Android app answers it with the system picker); the
// file's size is checked before it is read.
//
// Pure where it can be: the page objects come in as parameters (unit tests pass fakes).
import { PROFILE_MIME } from '../shared/profileTransfer';
import type { HostMode } from './hostMode';

export type SaveOutcome = 'saved' | 'shared' | 'cancelled' | 'busy' | 'failed';

export interface ProfileSaver {
  /** Saves `text` as `fileName`. Call it inside the click that asked for it (the share sheet needs that gesture). */
  save(fileName: string, text: string): Promise<SaveOutcome>;
}

/** The Android app's WebMessageListener object, as the page sees it. */
export interface NativeBridgeLike {
  postMessage(message: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** The bridge when the page runs in the Android app and the WebView supports it, else null. */
export function nativeBridge(scope: unknown): NativeBridgeLike | null {
  if (scope === null || typeof scope !== 'object') return null;
  const b = (scope as { gizecatNative?: unknown }).gizecatNative;
  if (b === null || typeof b !== 'object') return null;
  return typeof (b as { postMessage?: unknown }).postMessage === 'function' ? (b as NativeBridgeLike) : null;
}

/** Longest the page waits for the Android save screen's answer (the user may take a while). */
export const NATIVE_SAVE_TIMEOUT_MS = 15 * 60_000;

/** The answer to one saveFile message, or null when `data` is not a saveResult. */
export function parseSaveResult(data: unknown): SaveOutcome | null {
  let value: unknown = data;
  if (typeof data === 'string') {
    if (data.length > 4096) return null;
    try {
      value = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== 'object') return null;
  const r = value as { type?: unknown; ok?: unknown; reason?: unknown };
  if (r.type !== 'saveResult' || typeof r.ok !== 'boolean') return null;
  if (r.ok) return 'saved';
  if (r.reason === 'cancelled') return 'cancelled';
  if (r.reason === 'busy') return 'busy';
  return 'failed';
}

export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Saves through the Android app's bridge: one save at a time, answered by the native side. */
export function createNativeSaver(bridge: NativeBridgeLike, timers: TimerLike, timeoutMs = NATIVE_SAVE_TIMEOUT_MS): ProfileSaver {
  let waiting: ((outcome: SaveOutcome) => void) | null = null;
  let timer: unknown = null;
  const finish = (outcome: SaveOutcome): void => {
    const resolve = waiting;
    waiting = null;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    resolve?.(outcome);
  };
  return {
    save(fileName, text) {
      if (waiting) return Promise.resolve('busy');
      return new Promise<SaveOutcome>((resolve) => {
        waiting = resolve;
        bridge.onmessage = (event) => {
          const outcome = parseSaveResult(event.data);
          if (outcome !== null) finish(outcome);
        };
        timer = timers.setTimeout(() => finish('failed'), timeoutMs);
        try {
          bridge.postMessage(JSON.stringify({ type: 'saveFile', name: fileName, mime: PROFILE_MIME, text }));
        } catch {
          finish('failed');
        }
      });
    },
  };
}

/** The slice of the page a browser save needs. */
export interface BrowserSaveEnv {
  doc: Pick<Document, 'createElement' | 'body'>;
  url: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
  makeBlob: (text: string) => Blob;
  makeFile?: (text: string, fileName: string) => File;
  share?: { canShare?(data: { files: File[] }): boolean; share?(data: { files: File[] }): Promise<void> };
  timers: Pick<TimerLike, 'setTimeout'>;
  /** Offer the share sheet first (the installed web app on an Apple touch device). */
  preferShare: boolean;
}

/** How long the download link's object URL lives (ms). */
export const OBJECT_URL_LIFETIME_MS = 30_000;

function isAbort(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

export function createBrowserSaver(env: BrowserSaveEnv): ProfileSaver {
  function download(fileName: string, text: string): SaveOutcome {
    try {
      const href = env.url.createObjectURL(env.makeBlob(text));
      const a = env.doc.createElement('a');
      a.href = href;
      a.download = fileName;
      a.rel = 'noopener';
      a.hidden = true;
      env.doc.body.append(a);
      a.click();
      a.remove();
      env.timers.setTimeout(() => env.url.revokeObjectURL(href), OBJECT_URL_LIFETIME_MS);
      return 'saved';
    } catch {
      return 'failed';
    }
  }
  return {
    async save(fileName, text) {
      const share = env.share;
      if (env.preferShare && env.makeFile && share && typeof share.share === 'function' && typeof share.canShare === 'function') {
        let file: File | null;
        try {
          file = env.makeFile(text, fileName);
          if (!share.canShare({ files: [file] })) file = null;
        } catch {
          file = null;
        }
        if (file) {
          try {
            // Called before any await: the click's user activation is still there.
            await share.share({ files: [file] });
            return 'shared';
          } catch (err) {
            if (isAbort(err)) return 'cancelled';
            // NotAllowedError and friends: the download below is the fallback.
          }
        }
      }
      return download(fileName, text);
    },
  };
}

/** The saver for this host: the native bridge in the Android app (when present), else the browser's. */
export function selectProfileSaver(mode: HostMode, scope: unknown, browser: () => ProfileSaver, timers: TimerLike): ProfileSaver | null {
  if (mode.kind === 'android-app') {
    const bridge = nativeBridge(scope);
    // Android System WebView cannot download blobs: without the bridge there is no way to save.
    return bridge ? createNativeSaver(bridge, timers) : null;
  }
  return browser();
}

export type PickResult = { ok: true; text: string } | { ok: false; reason: 'too-large' | 'unreadable' };

/** Reads a picked file: the size first (a larger file is never read), then its text. Never throws. */
export async function readPickedFile(file: { size: number; text(): Promise<string> }, maxBytes: number): Promise<PickResult> {
  if (!(typeof file.size === 'number' && file.size >= 0 && file.size <= maxBytes)) return { ok: false, reason: 'too-large' };
  try {
    const text = await file.text();
    return typeof text === 'string' ? { ok: true, text } : { ok: false, reason: 'unreadable' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
