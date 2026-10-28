import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, resolveAppRequest, SECURITY_HEADERS } from '../../../src/main/protocol';

// Hoisted by vitest above the imports: protocol.ts only needs `protocol` at call time.
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn() } }));

const root = path.resolve('C:\\app\\out\\renderer');

describe('app protocol path resolution', () => {
  it('serves files under out/renderer with the right MIME type', () => {
    const r = resolveAppRequest('desktop-cat://app/renderer/overlay/index.html?display=1#x', root);
    expect(r).toEqual({ ok: true, filePath: path.join(root, 'overlay', 'index.html'), mime: 'text/html; charset=utf-8' });
    const js = resolveAppRequest('desktop-cat://app/renderer/settings/main.js', root);
    expect(js.ok && js.mime).toBe('text/javascript; charset=utf-8');
    const css = resolveAppRequest('desktop-cat://app/renderer/settings/style%20sheet.css', root);
    expect(css.ok && css.filePath).toBe(path.join(root, 'settings', 'style sheet.css'));
  });

  it.each([
    ['dot-dot', 'desktop-cat://app/renderer/../main/index.js'],
    ['encoded dot-dot', 'desktop-cat://app/renderer/%2e%2e/%2e%2e/package.json'],
    ['encoded slash traversal', 'desktop-cat://app/renderer/overlay/..%2f..%2fmain%2findex.js'],
    ['double-encoded', 'desktop-cat://app/renderer/overlay/%252e%252e/x.js'],
    ['backslash', 'desktop-cat://app/renderer/overlay/..%5c..%5csecret.js'],
    ['literal backslash', 'desktop-cat://app/renderer/overlay\\..\\..\\x.js'],
    ['NUL', 'desktop-cat://app/renderer/overlay/index.html%00.png'],
    ['drive letter', 'desktop-cat://app/renderer/C:/Windows/win.ini'],
    ['empty segment', 'desktop-cat://app/renderer//etc/passwd.txt'],
    ['outside prefix', 'desktop-cat://app/main/index.js'],
    ['other host', 'desktop-cat://evil/renderer/overlay/index.html'],
    ['other scheme', 'file:///C:/app/out/renderer/overlay/index.html'],
    ['unknown type', 'desktop-cat://app/renderer/overlay/payload.exe'],
    ['directory', 'desktop-cat://app/renderer/'],
    ['malformed', 'not a url'],
    ['bad escape', 'desktop-cat://app/renderer/overlay/%E0%A4%A.js'],
  ])('rejects %s', (_name, url) => {
    const r = resolveAppRequest(url, root);
    expect(r.ok).toBe(false);
  });

  it('never resolves outside the root', () => {
    for (const seg of ['..', '%2e%2e', '.%2e', '%2e.', '...', 'a/../..']) {
      const r = resolveAppRequest(`desktop-cat://app/renderer/${seg}/x.js`, root);
      if (r.ok) expect(path.relative(root, r.filePath).startsWith('..')).toBe(false);
    }
  });

  it('sends a strict CSP and nosniff', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});
