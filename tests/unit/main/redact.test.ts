import { describe, expect, it } from 'vitest';
import { REDACTED, redactString, redactValue } from '../../../src/main/diagnostics/redact';

describe('redactString', () => {
  it.each([
    ['anthropic key', 'using key sk-ant-api03-AbCdEf0123456789xyz now'],
    ['openai key', 'sk-proj-1234567890abcdefABCDEF'],
    ['authorization header', 'Authorization: Bearer abc.def.ghi-123456'],
    ['x-api-key header', 'x-api-key=supersecretvalue'],
    ['json apiKey', '{"apiKey":"hunter2hunter2"}'],
    ['bearer token alone', 'token is Bearer eyJhbGciOiJIUzI1NiJ9.payload'],
    ['long hex', 'hash 0123456789abcdef0123456789abcdef01234567'],
    ['long base64', 'blob QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA= end'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('redacts %s', (_name, input) => {
    const out = redactString(input);
    expect(out).toContain(REDACTED);
    for (const secret of ['AbCdEf0123456789xyz', '1234567890abcdefABCDEF', 'abc.def.ghi-123456', 'supersecretvalue', 'hunter2hunter2', 'payload', '0123456789abcdef0123456789abcdef', 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA', 'abcdefghijklmnopqrstuvwxyz0123456789']) {
      expect(out).not.toContain(secret);
    }
  });

  it('removes data: URLs entirely', () => {
    const out = redactString('preview data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgH done');
    expect(out).toBe(`preview data:${REDACTED} done`);
  });

  it('leaves ordinary text, paths and URLs readable', () => {
    for (const s of [
      'overlay created on display 2528732444',
      'C:\\Users\\someone\\AppData\\Roaming\\Desktop Cat\\settings.json',
      'desktop-cat://app/renderer/overlay/index.html?display=1',
      'node_modules/electron/dist/resources/default_app.asar',
      'metadata: fine',
      'http://127.0.0.1:11434/api/tags',
    ]) {
      expect(redactString(s)).toBe(s);
    }
  });
});

describe('redactValue', () => {
  it('drops sensitive keys (window titles, keys, images) at any depth', () => {
    const out = redactValue({
      title: 'Online Banking - Account 1234',
      nested: { windowTitle: 'secret doc', apiKey: 'abc', key: 'k', imageDataUrl: 'data:image/png;base64,AAAA', ok: 1 },
      list: [{ Authorization: 'Bearer x' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/Banking|secret doc|"abc"|Bearer x|AAAA/);
    expect(out.title).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it('serialises errors with redacted message and stack', () => {
    const err = new Error('request failed with key sk-ant-abcdefghijklmnop');
    const out = redactValue(err) as { name: string; message: string; stack?: string };
    expect(out.name).toBe('Error');
    expect(out.message).not.toContain('abcdefghijklmnop');
    expect(out.stack ?? '').not.toContain('abcdefghijklmnop');
  });

  it('handles cycles, bigint, binary, functions and depth limits', () => {
    const a: Record<string, unknown> = { n: 1n, buf: Buffer.from('hello'), fn: () => 1 };
    a.self = a;
    const out = redactValue(a) as Record<string, unknown>;
    expect(out.n).toBe('1');
    expect(out.buf).toBe('[binary 5 bytes]');
    expect(out.fn).toBeUndefined();
    expect(out.self).toBe('[circular]');
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 10; i++) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    expect(JSON.stringify(redactValue(root))).toContain('[depth]');
  });

  it('truncates very long strings and arrays', () => {
    const out = redactValue({ s: 'x '.repeat(3000), arr: Array.from({ length: 80 }, (_, i) => i) }) as { s: string; arr: unknown[] };
    expect(out.s.length).toBeLessThan(2100);
    expect(out.arr).toHaveLength(51);
  });
});
