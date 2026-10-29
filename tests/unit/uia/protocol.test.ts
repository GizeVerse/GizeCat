// Wire protocol parsing, restart budget and helper path resolution (pure / temp-dir based).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveUiaHelperPath, UIA_HELPER_EXE } from '../../../src/main/uia';
import { encodeRequest, parseHelperLine, QUIT_LINE } from '../../../src/main/uia/protocol';
import { RestartBudget } from '../../../src/main/uia/restartBudget';
import { removeDir, tempDir } from '../main/helpers';
import { wireStrip } from './fixtures';

describe('encodeRequest', () => {
  it('writes one JSON line per request', () => {
    expect(encodeRequest(7, { op: 'strip', hwnd: '123' })).toBe('{"id":7,"op":"strip","hwnd":"123"}\n');
    expect(encodeRequest(1, { op: 'watch', hwnds: ['1', '2'] })).toBe('{"id":1,"op":"watch","hwnds":["1","2"]}\n');
    expect(QUIT_LINE).toBe('{"op":"quit"}\n');
  });
});

describe('parseHelperLine', () => {
  it('accepts a strip response', () => {
    const strip = wireStrip({ browser: 'edge' });
    const m = parseHelperLine(JSON.stringify({ id: 3, ok: true, strip }));
    expect(m?.kind).toBe('response');
    if (m?.kind !== 'response' || !m.response.ok) throw new Error('expected ok response');
    expect(m.response.strip?.tabs).toHaveLength(3);
    expect(m.response.strip?.frame).toEqual({ x: 133, y: 125, w: 1359, h: 867 });
  });

  it('accepts pong, watch, error and event lines (BOM and CR tolerated)', () => {
    expect(parseHelperLine('\ufeff{"id":1,"ok":true,"pong":true,"version":1,"dpi":"permonitorv2","watching":0,"prunedRender":0,"prunedOther":0}\r')).toMatchObject({
      kind: 'response',
      response: { id: 1, ok: true, pong: true, version: 1 },
    });
    expect(parseHelperLine('{"id":2,"ok":true,"watching":1,"failed":[]}')).toMatchObject({ kind: 'response', response: { watching: 1 } });
    expect(parseHelperLine('{"id":null,"ok":false,"error":"bad-json","detail":null}')).toMatchObject({ kind: 'response', response: { id: null, error: 'bad-json' } });
    expect(parseHelperLine('{"id":4,"ok":false,"error":"internal","detail":"COMException"}')).toMatchObject({ response: { detail: 'COMException' } });
    expect(parseHelperLine('{"event":"selected","hwnd":"65552"}')).toEqual({ kind: 'event', event: { event: 'selected', hwnd: '65552' } });
  });

  it.each([
    ['empty', ''],
    ['not JSON', '{"id":'],
    ['array', '[1,2]'],
    ['primitive', '42'],
    ['no ok flag', '{"id":1}'],
    ['bad id', '{"id":0,"ok":true}'],
    ['fractional id', '{"id":1.5,"ok":true}'],
    ['unknown event', '{"event":"focus","hwnd":"1"}'],
    ['event hwnd with leading zero', '{"event":"selected","hwnd":"0123"}'],
    ['event hwnd not decimal', '{"event":"selected","hwnd":"0x10"}'],
    ['error code with text', '{"id":1,"ok":false,"error":"Tab title here","detail":null}'],
    ['error detail with spaces', '{"id":1,"ok":false,"error":"internal","detail":"a b"}'],
    ['fractional coordinate', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), frame: { x: 1.5, y: 0, w: 10, h: 10 } } })],
    ['negative width', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), frame: { x: 0, y: 0, w: -1, h: 10 } } })],
    ['huge coordinate', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), frame: { x: 1e12, y: 0, w: 1, h: 1 } } })],
    ['string selected flag', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), tabs: [{ x: 0, y: 0, w: 1, h: 1, selected: 'yes' }] } })],
    ['too many tabs', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), tabs: Array.from({ length: 257 }, () => ({ x: 0, y: 0, w: 1, h: 1, selected: false })) } })],
    ['unknown discovery path', JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), path: 'names' } })],
  ])('rejects %s', (_label, line) => {
    expect(parseHelperLine(line)).toBeNull();
  });

  it('never surfaces unknown fields such as names', () => {
    const m = parseHelperLine(JSON.stringify({ id: 1, ok: true, strip: { ...wireStrip({ browser: 'edge' }), name: 'secret tab' } }));
    if (m?.kind !== 'response' || !m.response.ok) throw new Error('expected ok response');
    expect(JSON.stringify(m)).not.toContain('secret');
  });
});

describe('RestartBudget', () => {
  it('backs off exponentially and is exhausted after 5 restarts inside 10 minutes', () => {
    const b = new RestartBudget();
    const t0 = 100_000;
    expect(b.recordFailure(t0)).toBe(t0 + 1000);
    expect(b.recordFailure(t0 + 1000)).toBe(t0 + 1000 + 2000);
    expect(b.recordFailure(t0 + 3000)).toBe(t0 + 3000 + 4000);
    expect(b.recordFailure(t0 + 7000)).toBe(t0 + 7000 + 8000);
    expect(b.recordFailure(t0 + 15_000)).toBe(t0 + 15_000 + 16_000);
    expect(b.exhausted).toBe(false);
    expect(b.recordFailure(t0 + 31_000)).toBeNull();
    expect(b.exhausted).toBe(true);
    expect(b.recentFailures).toBe(6);
  });

  it('forgets failures older than the window', () => {
    const b = new RestartBudget({ baseDelayMs: 1000, maxDelayMs: 60_000, maxRestarts: 5, windowMs: 600_000 });
    for (let i = 0; i < 5; i++) b.recordFailure(i * 1000);
    expect(b.recordFailure(700_000)).toBe(701_000);
    expect(b.recentFailures).toBe(1);
  });

  it('caps the delay and resets', () => {
    const b = new RestartBudget({ baseDelayMs: 1000, maxDelayMs: 5000, maxRestarts: 10, windowMs: 600_000 });
    let last = 0;
    for (let i = 0; i < 6; i++) last = b.recordFailure(i) ?? -1;
    expect(last).toBe(5 + 5000);
    b.reset();
    expect(b.recentFailures).toBe(0);
    expect(b.recordFailure(10)).toBe(1010);
  });
});

describe('resolveUiaHelperPath', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) removeDir(d);
  });

  const make = (rel: string): string => {
    const dir = tempDir('dcat-uiapath-');
    dirs.push(dir);
    const file = path.join(dir, rel, UIA_HELPER_EXE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'MZ');
    return dir;
  };

  it.runIf(process.platform === 'win32')('packaged: <resources>/native/DesktopCatUia.exe', () => {
    const resources = make('native');
    expect(resolveUiaHelperPath({ packaged: true, resourcesPath: resources, appRoot: 'C:\\nowhere' })).toBe(path.join(resources, 'native', UIA_HELPER_EXE));
  });

  it.runIf(process.platform === 'win32')('development: <appRoot>/out/native/DesktopCatUia.exe', () => {
    const root = make(path.join('out', 'native'));
    expect(resolveUiaHelperPath({ packaged: false, resourcesPath: 'C:\\nowhere', appRoot: root })).toBe(path.join(root, 'out', 'native', UIA_HELPER_EXE));
  });

  it('null when the helper is missing or the path is a directory', () => {
    const root = tempDir('dcat-uiapath-');
    dirs.push(root);
    expect(resolveUiaHelperPath({ packaged: false, resourcesPath: root, appRoot: root })).toBeNull();
    fs.mkdirSync(path.join(root, 'native', UIA_HELPER_EXE), { recursive: true });
    expect(resolveUiaHelperPath({ packaged: true, resourcesPath: root, appRoot: root })).toBeNull();
    expect(resolveUiaHelperPath({ packaged: true, resourcesPath: '', appRoot: root })).toBeNull();
  });
});
