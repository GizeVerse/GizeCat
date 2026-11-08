// 1.4.0 profile files in the web host (src/web/profileFiles.ts): the Android bridge protocol
// (android/README.md: {type:'saveFile', name, mime, text} -> {type:'saveResult', ok, reason?}), the
// browser download and the iPad share sheet, the per-host choice, and the size check before a picked
// file is read. MOCKED: the bridge, the document, URL, the share API and files. Written in the 1.4.0
// mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import { MAX_PROFILE_BYTES, PROFILE_MIME } from '../../../src/shared/profileTransfer';
import type { HostMode } from '../../../src/web/hostMode';
import {
  createBrowserSaver,
  createNativeSaver,
  nativeBridge,
  NATIVE_SAVE_TIMEOUT_MS,
  parseSaveResult,
  readPickedFile,
  selectProfileSaver,
  type BrowserSaveEnv,
  type NativeBridgeLike,
} from '../../../src/web/profileFiles';

const BROWSER: HostMode = { kind: 'browser', standalone: false, apple: false, place: 'browser' };
const ANDROID: HostMode = { kind: 'android-app', standalone: true, apple: false, place: 'app' };

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      pending.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
  };
}

function fakeBridge() {
  const sent: string[] = [];
  const bridge: NativeBridgeLike = { postMessage: (m) => sent.push(m), onmessage: null };
  const answer = (data: unknown) => bridge.onmessage?.({ data });
  return { bridge, sent, answer };
}

describe('Android bridge', () => {
  it('is detected only as an object with postMessage', () => {
    expect(nativeBridge({})).toBeNull();
    expect(nativeBridge(null)).toBeNull();
    expect(nativeBridge({ gizecatNative: { postMessage: 1 } })).toBeNull();
    const b = { postMessage: () => undefined, onmessage: null };
    expect(nativeBridge({ gizecatNative: b })).toBe(b);
  });

  it('reads saveResult answers (string or object) and ignores anything else', () => {
    expect(parseSaveResult('{"type":"saveResult","ok":true}')).toBe('saved');
    expect(parseSaveResult({ type: 'saveResult', ok: false, reason: 'cancelled' })).toBe('cancelled');
    expect(parseSaveResult({ type: 'saveResult', ok: false, reason: 'busy' })).toBe('busy');
    for (const reason of ['invalid', 'too-large', 'unavailable', 'write-failed', undefined]) expect(parseSaveResult({ type: 'saveResult', ok: false, reason })).toBe('failed');
    for (const other of ['nope', '{"type":"other","ok":true}', { type: 'saveResult' }, null, 42, 'x'.repeat(5000)]) expect(parseSaveResult(other)).toBeNull();
  });

  it('posts exactly the four keys and resolves with the answer; one save at a time', async () => {
    const t = fakeTimers();
    const { bridge, sent, answer } = fakeBridge();
    const saver = createNativeSaver(bridge, t);
    const first = saver.save('gizecat-miso-2026-11-08.json', '{"kind":"x"}\n');
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'saveFile', name: 'gizecat-miso-2026-11-08.json', mime: PROFILE_MIME, text: '{"kind":"x"}\n' });
    expect(await saver.save('again.json', '{}')).toBe('busy');
    answer('{"type":"somethingElse"}');
    answer('{"type":"saveResult","ok":true}');
    expect(await first).toBe('saved');
    expect(t.pending[0]!.cleared).toBe(true);
  });

  it('gives up after the timeout (a native side that never answers)', async () => {
    const t = fakeTimers();
    const { bridge } = fakeBridge();
    const p = createNativeSaver(bridge, t).save('a.json', '{}');
    expect(t.pending[0]!.ms).toBe(NATIVE_SAVE_TIMEOUT_MS);
    t.pending[0]!.fn();
    expect(await p).toBe('failed');
  });

  it('a throwing postMessage fails the save', async () => {
    const t = fakeTimers();
    const bridge: NativeBridgeLike = {
      postMessage: () => {
        throw new Error('gone');
      },
      onmessage: null,
    };
    expect(await createNativeSaver(bridge, t).save('a.json', '{}')).toBe('failed');
  });
});

function browserEnv(over: Partial<BrowserSaveEnv> = {}) {
  const clicks: Array<{ href: string; download: string }> = [];
  const revoked: string[] = [];
  const t = fakeTimers();
  const env: BrowserSaveEnv = {
    doc: {
      createElement: (() => {
        const a = { href: '', download: '', rel: '', hidden: false, click: () => clicks.push({ href: a.href, download: a.download }), remove: () => undefined };
        return a;
      }) as unknown as Document['createElement'],
      body: { append: () => undefined } as unknown as HTMLElement,
    },
    url: { createObjectURL: () => 'blob:fake/1', revokeObjectURL: (u) => revoked.push(u) },
    makeBlob: (text) => ({ text }) as unknown as Blob,
    timers: t,
    preferShare: false,
    ...over,
  };
  return { env, clicks, revoked, t };
}

describe('browser saving', () => {
  it('downloads through an <a download> link and revokes the object URL later', async () => {
    const b = browserEnv();
    expect(await createBrowserSaver(b.env).save('gizecat-miso.json', '{}')).toBe('saved');
    expect(b.clicks).toEqual([{ href: 'blob:fake/1', download: 'gizecat-miso.json' }]);
    expect(b.revoked).toEqual([]);
    b.t.pending[0]!.fn();
    expect(b.revoked).toEqual(['blob:fake/1']);
  });

  it('the installed app on an iPad shares the file; a dismissed sheet is a cancel; a refused one falls back to the download', async () => {
    const shared: unknown[] = [];
    const file = { name: 'gizecat-miso.json' } as unknown as File;
    const ok = browserEnv({ preferShare: true, makeFile: () => file, share: { canShare: () => true, share: (d) => (shared.push(d), Promise.resolve()) } });
    expect(await createBrowserSaver(ok.env).save('gizecat-miso.json', '{}')).toBe('shared');
    expect(shared).toEqual([{ files: [file] }]);
    expect(ok.clicks).toHaveLength(0);

    const abort = browserEnv({ preferShare: true, makeFile: () => file, share: { canShare: () => true, share: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) } });
    expect(await createBrowserSaver(abort.env).save('a.json', '{}')).toBe('cancelled');

    const refused = browserEnv({ preferShare: true, makeFile: () => file, share: { canShare: () => true, share: () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) } });
    expect(await createBrowserSaver(refused.env).save('a.json', '{}')).toBe('saved');
    expect(refused.clicks).toHaveLength(1);

    const cannot = browserEnv({ preferShare: true, makeFile: () => file, share: { canShare: () => false, share: () => Promise.resolve() } });
    expect(await createBrowserSaver(cannot.env).save('a.json', '{}')).toBe('saved');
  });

  it('a browser tab never uses the share sheet', async () => {
    let asked = false;
    const b = browserEnv({ preferShare: false, makeFile: () => ({}) as File, share: { canShare: () => (asked = true), share: () => Promise.resolve() } });
    expect(await createBrowserSaver(b.env).save('a.json', '{}')).toBe('saved');
    expect(asked).toBe(false);
  });
});

describe('host choice and picked files', () => {
  it('the Android app saves through the bridge, or not at all without it; a browser uses the browser saver', () => {
    const t = fakeTimers();
    const browser = { save: () => Promise.resolve('saved' as const) };
    expect(selectProfileSaver(ANDROID, {}, () => browser, t)).toBeNull();
    expect(selectProfileSaver(ANDROID, { gizecatNative: fakeBridge().bridge }, () => browser, t)).not.toBe(browser);
    expect(selectProfileSaver(BROWSER, { gizecatNative: fakeBridge().bridge }, () => browser, t)).toBe(browser);
  });

  it('checks the size before reading, and turns a failed read into unreadable', async () => {
    let reads = 0;
    const big = { size: MAX_PROFILE_BYTES + 1, text: () => (reads++, Promise.resolve('x')) };
    expect(await readPickedFile(big, MAX_PROFILE_BYTES)).toEqual({ ok: false, reason: 'too-large' });
    expect(reads).toBe(0);
    expect(await readPickedFile({ size: Number.NaN, text: () => Promise.resolve('x') }, MAX_PROFILE_BYTES)).toEqual({ ok: false, reason: 'too-large' });
    expect(await readPickedFile({ size: 2, text: () => Promise.reject(new Error('NotReadableError')) }, MAX_PROFILE_BYTES)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await readPickedFile({ size: 2, text: () => Promise.resolve('{}') }, MAX_PROFILE_BYTES)).toEqual({ ok: true, text: '{}' });
  });
});
