// What the installable web app's static files must be for public hosting at a project-site subpath
// and for an iPad Home Screen app, read from the source files (no browser): every URL relative, a
// stable manifest id, the status bar overlaid with safe-area padding, the CSS-only first screen, and
// the static licenses page (scripts/web-licenses.mjs) with the production checks that hold it
// to that (scripts/web-csp.mjs). REAL: reads the committed files; nothing is written.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script without declarations
import * as cspModule from '../../../scripts/web-csp.mjs';
// @ts-expect-error a plain .mjs script without declarations
import * as licensesModule from '../../../scripts/web-licenses.mjs';

const csp = cspModule as {
  WEB_CSP: string;
  WEB_LICENSES_CSP: string;
  WEB_SHELL_FILES: readonly string[];
  isRelativeUrl(value: unknown): boolean;
  absoluteUrlProblems(name: string, html: string): string[];
  manifestProblems(text: string): string[];
  licensesProblems(html: string): string[];
  metaCsp(html: string): string | null;
};
const licenses = licensesModule as {
  inlineHtml(text: string): string;
  markdownToHtml(markdown: string): string;
  renderLicensesHtml(sources: { notices: string; apacheTerms: string }): string;
};

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX = read('src/web/index.html');
const MANIFEST = read('src/web/manifest.webmanifest');
const CSS = read('src/web/web.css');
const NOTICES = read('THIRD_PARTY_NOTICES.md');
const APACHE = read('src/web/apache-2.0.txt');
const PAGE = licenses.renderLicensesHtml({ notices: NOTICES, apacheTerms: APACHE });

describe('the page and the manifest under any path', () => {
  it('has only relative URLs in index.html', () => {
    expect(csp.absoluteUrlProblems('index.html', INDEX)).toEqual([]);
    expect(csp.absoluteUrlProblems('x.html', '<a href="/root">a</a><img src="https://cdn.test/a.png">')).toHaveLength(2);
  });

  it('tells a relative URL from one that would break under a subpath', () => {
    for (const ok of ['./', 'index.html', 'icons/a.png', 'gizecat']) expect(csp.isRelativeUrl(ok), ok).toBe(true);
    for (const bad of ['/', '/GizeCat/', 'https://example.test/', '//cdn.test/x', '\\x', 42, undefined]) expect(csp.isRelativeUrl(bad), String(bad)).toBe(false);
  });

  it('declares a relative start_url and scope, relative icons, a stable id, and the 192 and 512 icons in both purposes', () => {
    expect(csp.manifestProblems(MANIFEST)).toEqual([]);
    const m = JSON.parse(MANIFEST) as { id: string; name: string; short_name: string; display: string; start_url: string; scope: string };
    expect([m.name, m.short_name, m.display, m.start_url, m.scope, m.id]).toEqual(['GizeCat', 'GizeCat', 'standalone', './', './', 'gizecat']);
  });

  it('refuses a manifest that is absolute, has no id, or lacks an icon', () => {
    const good = JSON.parse(MANIFEST) as Record<string, unknown>;
    const problems = (over: Record<string, unknown>) => csp.manifestProblems(JSON.stringify({ ...good, ...over }));
    expect(problems({ start_url: '/GizeCat/' }).join()).toContain('start_url');
    expect(problems({ scope: 'https://example.test/' }).join()).toContain('scope');
    expect(problems({ id: undefined }).join()).toContain('id');
    expect(problems({ icons: [] }).join()).toContain('icon');
    expect(csp.manifestProblems('{ not json')[0]).toContain('not JSON');
  });

  it('keeps the licenses page in the production file set', () => {
    expect(csp.WEB_SHELL_FILES).toContain('licenses.html');
  });
});

describe('the iPad Home Screen look', () => {
  it('overlays the status bar and reaches the screen edges (viewport-fit=cover)', () => {
    expect(INDEX).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(INDEX).toContain('viewport-fit=cover');
    expect(INDEX).toContain('rel="apple-touch-icon" sizes="180x180"');
  });

  it('pads the toolbar under the status bar and gives white status-bar text something to sit on', () => {
    expect(CSS).toMatch(/\.bar \{[^}]*calc\(env\(safe-area-inset-top, 0px\) \+ 0\.5rem\)/);
    expect(CSS).toContain('--status-scrim');
    expect(CSS).toMatch(/@media \(display-mode: standalone\)/);
  });

  it('does not bounce: a fixed body and no overscroll', () => {
    expect(CSS).toMatch(/body \{\s*\/\*[^*]*\*\/\s*position: fixed;/);
    expect(CSS).toContain('overscroll-behavior: none');
  });
});

describe('the first screen', () => {
  it('stands in index.html before the toolbar, and needs no script of its own', () => {
    expect(INDEX).toContain('id="boot"');
    expect(INDEX.indexOf('id="boot"')).toBeLessThan(INDEX.indexOf('class="bar"'));
    expect(INDEX.match(/<script\b/g)).toHaveLength(1);
    expect(INDEX).not.toMatch(/\son[a-z]+="/i);
  });

  it('turns into the failure message by itself when nothing ends it', () => {
    expect(CSS).toMatch(/\.boot-failed \{[^}]*visibility: hidden;[^}]*animation: boot-show/);
    expect(CSS).toMatch(/\.boot-wait \{[^}]*animation: boot-hide/);
  });
});

describe('the notices page', () => {
  it('is static: its own CSP, no script, no handler, no form, and the notices in it', () => {
    expect(csp.licensesProblems(PAGE)).toEqual([]);
    expect(csp.metaCsp(PAGE)).toBe(csp.WEB_LICENSES_CSP);
    expect(PAGE).not.toMatch(/<script\b/i);
    expect(csp.absoluteUrlProblems('licenses.html', PAGE)).toEqual([]);
  });

  it('carries the third-party notices and the full Apache-2.0 terms, and a way back', () => {
    for (const needed of ['zod', 'androidx.webkit', 'END OF TERMS AND CONDITIONS', '(a) You must give any other recipients']) expect(PAGE, needed).toContain(needed);
    expect(PAGE).toContain('<a href="index.html">Back to GizeCat</a>');
  });

  it('leaves out the sentence that the app does not show these notices', () => {
    expect(PAGE).not.toContain('does not show these notices');
  });

  it('refuses a page with a script, a handler or a frame', () => {
    expect(csp.licensesProblems(PAGE.replace('</main>', '<script>x</script></main>')).join()).toContain('script');
    expect(csp.licensesProblems(PAGE.replace('</main>', '<p onclick="x">y</p></main>')).join()).toContain('handler');
    expect(csp.licensesProblems(PAGE.replace('</main>', '<iframe></iframe></main>')).join()).toContain('embedded');
    expect(csp.licensesProblems('<p>nothing</p>').join()).toContain('CSP');
  });
});

describe('the Markdown the notices use', () => {
  it('escapes everything and renders inline code and bold', () => {
    expect(licenses.inlineHtml('a & b <i> **c** `<d>`')).toBe('a &amp; b &lt;i&gt; <strong>c</strong> <code>&lt;d&gt;</code>');
  });

  it('keeps links as plain text, so the page leads nowhere', () => {
    expect(licenses.inlineHtml('see [the text](https://example.test/x) or <https://example.test/y>')).toBe('see the text (https://example.test/x) or https://example.test/y');
  });

  it('renders headings, tables, fences, lists and paragraphs', () => {
    const html = licenses.markdownToHtml(
      ['# Title', '', '## Sub', '', 'First line', 'second line.', '', '| A | B |', '|---|---|', '| 1 | `x` |', '', '```text', '<raw> & "q"', '```', '', '- one', '- two', ''].join('\n'),
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Sub</h2>');
    expect(html).toContain('<p>First line second line.</p>');
    expect(html).toContain('<th>A</th><th>B</th>');
    expect(html).toContain('<td>1</td><td><code>x</code></td>');
    expect(html).toContain('<pre>&lt;raw&gt; &amp; &quot;q&quot;</pre>');
    expect(html).toContain('<li>one</li>');
  });
});
