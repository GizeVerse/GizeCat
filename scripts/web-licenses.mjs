// The web app's third-party notices page (1.4.0): licenses.html, generated at build time from
// THIRD_PARTY_NOTICES.md with Node built-ins only, and shipped with every copy of the bundle, the
// Android app's assets included, so the notices are readable inside the app. Linked from the
// settings sheet's About section; the service worker precaches it, so it opens offline too.
//
// The page is static: no script element, its own strict CSP (scripts/web-csp.mjs,
// WEB_LICENSES_CSP), only the app's stylesheet and favicon. The Markdown subset it understands is
// the one the notices file uses (ATX headings, pipe tables, fenced code, "- " lists, paragraphs,
// inline code and bold). Everything is HTML-escaped and links stay plain text, so the page never
// leads out of the app (the Android app would refuse the navigation anyway).
//
// The Apache-2.0 terms (src/web/apache-2.0.txt, a verbatim copy of the terms in an installed
// package's LICENSE) are appended: the Android section of the notices lists components under that
// licence by name only, and its terms ask for a copy of the licence to be passed on.
//
// Pure Node (node:fs, node:path); importing it has no side effects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_LICENSES_CSP, WEB_LICENSES_FILE } from './web-csp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paragraphs of the notices file that this page makes false, left out of it: a line saying the app
 * does not show these notices cannot appear on the page that shows them. Matched by their start.
 * Once the notices file no longer has the sentence, the entry matches nothing and can be removed.
 */
const OMITTED_PARAGRAPHS = ['The Android app does not show these notices yet.'];

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Text-level Markdown in one line of plain text: code spans first (nothing inside them is Markdown). */
export function inlineHtml(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      const unlinked = part.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, '$1 ($2)').replace(/<([a-z][a-z0-9+.-]*:[^>\s]*)>/gi, '$1');
      return escapeHtml(unlinked).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

/** The cells of one `| a | b |` table row, trimmed. */
function tableCells(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

const isTableRow = (line) => line.trim().startsWith('|');
const isTableRule = (line) => /^\s*\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*$/.test(line);
const isFence = (line) => /^\s*```/.test(line);
const headingOf = (line) => /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
const isListItem = (line) => /^\s*- /.test(line);

/** The Markdown blocks of the notices file as an HTML fragment. */
export function markdownToHtml(markdown) {
  const lines = markdown.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (isFence(line)) {
      const code = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      out.push(`<h${heading[1].length}>${inlineHtml(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(tableCells(lines[i++]));
      const th = head.map((c) => `<th>${inlineHtml(c)}</th>`).join('');
      const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join('')}</tr>`).join('\n');
      out.push(`<div class="doc-table"><table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table></div>`);
      continue;
    }
    if (isListItem(line)) {
      const items = [];
      while (i < lines.length && isListItem(lines[i])) items.push(lines[i++].replace(/^\s*- /, ''));
      out.push(`<ul>\n${items.map((it) => `<li>${inlineHtml(it)}</li>`).join('\n')}\n</ul>`);
      continue;
    }
    // The first line is always taken (a table row without its rule line is plain text here).
    const paragraph = [lines[i++].trim()];
    while (i < lines.length && lines[i].trim() !== '' && !isFence(lines[i]) && !headingOf(lines[i]) && !isTableRow(lines[i]) && !isListItem(lines[i])) {
      paragraph.push(lines[i++].trim());
    }
    const text = paragraph.join(' ');
    if (!OMITTED_PARAGRAPHS.some((p) => text.startsWith(p))) out.push(`<p>${inlineHtml(text)}</p>`);
  }
  return out.join('\n');
}

const BACK_LINK = '<p class="doc-back"><a href="index.html">Back to GizeCat</a></p>';

/** The whole page, from the notices file's text and the Apache-2.0 terms. */
export function renderLicensesHtml({ notices, apacheTerms }) {
  const apache = apacheTerms.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd();
  return `<!doctype html>
<html lang="en" class="doc">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${WEB_LICENSES_CSP}" />
    <meta name="referrer" content="no-referrer" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>Third-party notices - GizeCat</title>
    <link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png" />
    <link rel="stylesheet" href="web.css" />
  </head>
  <body>
    ${BACK_LINK}
    <main>
<p class="note">GizeCat was formerly named Desktop Cat. This page is generated from the project's notices file and covers every GizeCat package, so it also names components that are not part of this copy.</p>
${markdownToHtml(notices)}
<h2>Apache License, Version 2.0</h2>
<p>The terms that apply to every component listed above as Apache-2.0.</p>
<pre>${escapeHtml(apache)}</pre>
    </main>
    ${BACK_LINK}
  </body>
</html>
`;
}

/** Writes licenses.html into a web build directory. */
export function writeWebLicenses(outDir, { noticesFile = path.join(root, 'THIRD_PARTY_NOTICES.md'), apacheFile = path.join(root, 'src', 'web', 'apache-2.0.txt') } = {}) {
  const html = renderLicensesHtml({ notices: fs.readFileSync(noticesFile, 'utf8'), apacheTerms: fs.readFileSync(apacheFile, 'utf8') });
  fs.writeFileSync(path.join(outDir, WEB_LICENSES_FILE), html);
}
