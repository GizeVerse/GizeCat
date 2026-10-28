import { describe, expect, it } from 'vitest';
import { BoundedQueue, LruCache } from '../../../src/main/win32/collections';
import { categorizeProcess, ExclusionRules, exeBasename } from '../../../src/main/win32/processNames';
import { ignoresOwner, isExcludedByExStyle, isFullscreenGeometry, meetsMinimumSize, toRect } from '../../../src/main/win32/windowRules';
import { raw } from './fakes';

describe('categorizeProcess', () => {
  it.each([
    ['code.exe', 'code'],
    ['C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'code'],
    ['WindowsTerminal.exe', 'terminal'],
    ['pwsh', 'terminal'],
    ['chrome.exe', 'browser'],
    ['msedge.exe', 'browser'],
    ['vlc.exe', 'video'],
    ['steam.exe', 'game'],
    ['FortniteClient-Win64-Shipping.exe', 'game'],
    ['WINWORD.EXE', 'document'],
    ['Discord.exe', 'chat'],
    ['Figma.exe', 'design'],
    ['Spotify.exe', 'media'],
    ['KeePassXC.exe', 'sensitive'],
    ['explorer.exe', 'system'],
    ['/usr/bin/weird-tool', 'other'],
    ['mystery.exe', 'other'],
    ['', 'unknown'],
    ['   ', 'unknown'],
  ])('%s -> %s', (exe, category) => {
    expect(categorizeProcess(exe)).toBe(category);
  });

  it('extracts lower-case basenames from either separator', () => {
    expect(exeBasename('C:\\A\\B\\Foo.EXE')).toBe('foo.exe');
    expect(exeBasename('/a/b/Bar')).toBe('bar');
    expect(exeBasename('plain.exe')).toBe('plain.exe');
  });
});

describe('ExclusionRules', () => {
  it('matches processes with or without .exe, case-insensitively', () => {
    const r = new ExclusionRules(['KeePass.exe', 'bitwarden', '  '], []);
    expect(r.matchesProcess('keepass.exe')).toBe(true);
    expect(r.matchesProcess('KEEPASS')).toBe(true);
    expect(r.matchesProcess('Bitwarden.exe')).toBe(true);
    expect(r.matchesProcess('notepad.exe')).toBe(false);
    expect(r.matchesProcess('')).toBe(false);
  });

  it('matches title substrings case-insensitively and ignores blank patterns', () => {
    const r = new ExclusionRules([], ['Sign In', ' ', 'ŞIFRE'.toLowerCase()]);
    expect(r.hasTitlePatterns).toBe(true);
    expect(r.matchesTitle('Please SIGN IN to continue')).toBe(true);
    expect(r.matchesTitle('şifre değiştir')).toBe(true);
    expect(r.matchesTitle('Weather')).toBe(false);
    expect(r.matchesTitle('')).toBe(false);
    r.set([], []);
    expect(r.hasTitlePatterns).toBe(false);
    expect(r.matchesTitle('sign in')).toBe(false);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry', () => {
    const c = new LruCache<number, string>(2);
    c.set(1, 'a');
    c.set(2, 'b');
    expect(c.get(1)).toBe('a');
    c.set(3, 'c');
    expect(c.has(2)).toBe(false);
    expect(c.get(1)).toBe('a');
    expect(c.get(3)).toBe('c');
    c.set(3, 'C');
    expect(c.size).toBe(2);
    expect(c.get(3)).toBe('C');
    c.delete(1);
    expect(c.size).toBe(1);
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});

describe('BoundedQueue', () => {
  it('keeps FIFO order, drops the oldest and counts drops', () => {
    const q = new BoundedQueue<number>(3);
    for (let i = 1; i <= 5; i++) q.push(i);
    expect(q.length).toBe(3);
    expect(q.dropped).toBe(2);
    expect(q.drain()).toEqual([3, 4, 5]);
    expect(q.drain()).toEqual([]);
    q.push(9);
    expect(q.drain()).toEqual([9]);
    expect(q.dropped).toBe(2);
  });
});

describe('window rules', () => {
  it('applies the extended-style part of the Alt-Tab rule', () => {
    expect(isExcludedByExStyle(0)).toBe(false);
    expect(isExcludedByExStyle(0x80)).toBe(true);
    expect(isExcludedByExStyle(0x08000000)).toBe(true);
    expect(isExcludedByExStyle(0x80 | 0x40000)).toBe(false);
    expect(ignoresOwner(0x40000)).toBe(true);
    expect(ignoresOwner(0)).toBe(false);
  });

  it('enforces the minimum app-window size', () => {
    expect(meetsMinimumSize(toRect(raw(0, 0, 120, 60)))).toBe(true);
    expect(meetsMinimumSize(toRect(raw(0, 0, 119, 600)))).toBe(false);
    expect(meetsMinimumSize(toRect(raw(0, 0, 600, 59)))).toBe(false);
  });

  const monitor = raw(1920, -240, 2560, 1440);
  it('treats a borderless window covering its monitor as fullscreen', () => {
    expect(isFullscreenGeometry({ windowRect: monitor, frameRect: monitor, monitorRect: monitor, style: 0x80000000, exStyle: 0, maximized: false })).toBe(true);
  });
  it('rejects maximized framed windows even when they spill past the monitor', () => {
    const spill = raw(1912, -248, 2576, 1456);
    expect(isFullscreenGeometry({ windowRect: spill, frameRect: monitor, monitorRect: monitor, style: 0x00cf0000, exStyle: 0x100, maximized: true })).toBe(false);
  });
  it('accepts a framed, non-maximized window whose visible frame is exactly the monitor', () => {
    const spill = raw(1912, -240, 2576, 1448);
    expect(isFullscreenGeometry({ windowRect: spill, frameRect: monitor, monitorRect: monitor, style: 0x00cf0000, exStyle: 0, maximized: false })).toBe(true);
  });
  it('rejects windows that do not cover the monitor', () => {
    expect(isFullscreenGeometry({ windowRect: raw(1920, -240, 2560, 1400), frameRect: null, monitorRect: monitor, style: 0x80000000, exStyle: 0, maximized: false })).toBe(false);
  });
});
