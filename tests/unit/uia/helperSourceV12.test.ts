// v1.2 checks on the native helper's C# sources (ADR 0003 §7.1, §16.2 PRV acceptance), REAL source
// text: the never-read grep, the Win32-only gate before any UI Automation call, the protocol version,
// and the helper's allow-list table mirroring src/main/uia/allowList.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TAB_STRIP_APPS, UIA_NEVER_QUERY } from '../../../src/main/uia/allowList';
import { UIA_PROTOCOL_VERSION } from '../../../src/main/uia/protocol';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = path.join(root, 'native', 'uia-helper');
const sources = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.cs'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
const src = (name: string): string => sources.find((s) => s.file === name)!.text;

describe('native helper sources (v1.2)', () => {
  it('never reads Name, AutomationId, legacy MSAA, Value/Text patterns, help text, descriptions or item status', () => {
    // The ADR's grep (§7.1). `NameProperty` is matched as a whole identifier: ClassNameProperty
    // (the class-name reads the helper is built on) is not the Name property.
    const forbidden = /(?<![A-Za-z])NameProperty|\.Current\.Name\b|AutomationIdProperty|LegacyIAccessible|ValuePattern|TextPattern|HelpText|FullDescription|ItemStatus/;
    for (const s of sources) {
      const hits = s.text.split('\n').filter((l) => forbidden.test(l));
      expect(hits, s.file).toEqual([]);
    }
    // No `.Current.` property access at all (every read goes through an explicit cache request).
    for (const s of sources) expect(s.text.includes('.Current.'), s.file).toBe(false);
  });

  it('asks the Win32-only gate before anything that reaches UI Automation', () => {
    const tabs = src('TabStrips.cs');
    // FromHandle only inside the two discovery functions, which only GetElements calls.
    const fromHandle = [...tabs.matchAll(/AutomationElement\.FromHandle/g)].length;
    expect(fromHandle).toBe(2);
    const callers = [...tabs.matchAll(/GetElements\(/g)].length;
    expect(callers).toBe(3); // the definition, Strip and Subscribe
    for (const fn of ['internal string Strip(', 'private bool Subscribe(']) {
      const body = tabs.slice(tabs.indexOf(fn), tabs.indexOf('GetElements(', tabs.indexOf(fn)));
      expect(body, fn).toContain('Native.CheckTabWindow(');
    }
    expect(tabs).not.toContain('CheckBrowserWindow');
  });

  it('speaks the same protocol version as the app', () => {
    expect(src('Program.cs')).toMatch(new RegExp(`ProtocolVersion = ${UIA_PROTOCOL_VERSION};`));
    expect(UIA_PROTOCOL_VERSION).toBe(2);
  });

  it("the helper's allow-list table mirrors TAB_STRIP_APPS (kind, top-level class, image, required child)", () => {
    const native = src('Native.cs');
    const rows = [...native.matchAll(/new TabWindowRule\("(\w+)", ("[^"]*"|ChromeWindowClass), "([^"]+)", ImagePathRule\.(\w+), ("[^"]*"|null), ("[^"]*"|null)\)/g)].map((m) => ({
      kind: m[1],
      topLevelClass: m[2] === 'ChromeWindowClass' ? 'Chrome_WidgetWin_1' : m[2]!.slice(1, -1),
      processName: m[3],
      path: m[4],
      requiredChildClass: m[5] === 'null' ? null : m[5]!.slice(1, -1),
    }));
    const ts = TAB_STRIP_APPS.map((r) => ({ kind: r.kind, topLevelClass: r.topLevelClass, processName: r.processName, requiredChildClass: r.requiredChildClass }));
    expect(rows.map((r) => ({ kind: r.kind, topLevelClass: r.topLevelClass, processName: r.processName, requiredChildClass: r.requiredChildClass }))).toEqual(ts);
    // Full image paths for the TabView apps (ADR 0003 §7.1).
    expect(rows.find((r) => r.processName === 'explorer.exe')?.path).toBe('WindowsDirectory');
    expect(rows.find((r) => r.processName === 'windowsterminal.exe')?.path).toBe('TerminalPackage');
    // Never-queried apps have no helper rule either.
    for (const exe of UIA_NEVER_QUERY) expect(rows.some((r) => r.processName === exe), exe).toBe(false);
  });

  it('subscribes TabView events on the tab list only, never on the TabView element', () => {
    const tabs = src('TabStrips.cs');
    const sub = tabs.slice(tabs.indexOf('private bool Subscribe('), tabs.indexOf('private void Unwatch('));
    expect(sub).toContain('entry.Target = s.Container;');
    expect(sub).toContain('entry.Content = s.Container;');
    expect(sub).not.toMatch(/entry\.(Target|Content) = s\.TabView/);
  });
});
