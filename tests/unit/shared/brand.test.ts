// Display names (ADR 0004 §9): the product is GizeCat, a GizeVerse character; what Windows lists
// for the installed app stays "Desktop Cat" until the installer names change. Settings-window
// strings are covered by tests/unit/renderer/settings/branding.test.ts.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAUNCH_NOTICE } from '../../../src/main/lifecycle/loginItemNotice';
import { NO_SANDBOX_MESSAGE, NO_SANDBOX_TITLE } from '../../../src/main/platform/boot';
import { BRAND } from '../../../src/shared/brand';
import { CAT_CHARACTER } from '../../../src/shared/character';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

describe('BRAND', () => {
  it('names the product, its platform, the installed name and the former name', () => {
    expect(BRAND).toEqual({ platform: 'GizeVerse', product: 'GizeCat', installedName: 'Desktop Cat', formerName: 'Desktop Cat' });
    expect(Object.isFrozen(BRAND)).toBe(true);
    expect(CAT_CHARACTER.displayName).toBe(BRAND.product);
  });

  it('installedName is what the installer really shows in Windows (shortcut, Apps list, exe description)', () => {
    const yml = read('electron-builder.yml');
    const value = (key: string): string | undefined => new RegExp(`^[ \\t]*${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(yml)?.[1];
    // productName is the exe's FileDescription, which Task Manager › Startup apps lists.
    expect(value('productName')).toBe(BRAND.installedName);
    expect(value('shortcutName')).toBe(BRAND.installedName);
    expect(value('uninstallDisplayName')).toBe(BRAND.installedName);
  });
});

describe('product name in the main process and the window titles', () => {
  it('dialogs and the startup notice say GizeCat', () => {
    expect(NO_SANDBOX_TITLE).toBe('GizeCat cannot start safely');
    expect(NO_SANDBOX_MESSAGE.startsWith('GizeCat was started with --no-sandbox')).toBe(true);
    expect(LAUNCH_NOTICE.title).toBe('GizeCat now starts with Windows');
  });

  it('window titles, the tray tooltip and the page titles use the product name', () => {
    // These modules construct Electron objects, so their source is checked.
    expect(read('src', 'main', 'overlay', 'overlayWindow.ts')).toContain('title: BRAND.product,');
    expect(read('src', 'main', 'settingsWindow.ts')).toContain('title: `${BRAND.product} — Settings`,');
    expect(read('src', 'main', 'tray.ts')).toContain('tray.setToolTip(BRAND.product);');
    expect(read('src', 'renderer', 'overlay', 'index.html')).toContain(`<title>${BRAND.product}</title>`);
    expect(read('src', 'renderer', 'settings', 'index.html')).toContain(`<title>${BRAND.product} Settings</title>`);
  });

  it('no code outside brand.ts and identity.ts spells the old name (comments may, for history)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|html|css)$/.test(entry.name)) {
          const rel = path.relative(ROOT, full).replaceAll('\\', '/');
          if (rel === 'src/shared/brand.ts' || rel === 'src/shared/identity.ts') continue;
          fs.readFileSync(full, 'utf8')
            .split(/\r?\n/)
            .forEach((line, i) => {
              const t = line.trim();
              const comment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--');
              if (!comment && line.includes('Desktop Cat')) offenders.push(`${rel}:${i + 1}`);
            });
        }
      }
    };
    // The web host (src/web) is out of this check's scope.
    for (const dir of ['core', 'main', 'preload', 'renderer', 'shared']) walk(path.join(ROOT, 'src', dir));
    expect(offenders).toEqual([]);
  });
});
