import { describe, expect, it } from 'vitest';
import { S } from '../../../../src/renderer/settings/strings';
import {
  isLoopbackHost,
  validateApiKey,
  validateBaseUrl,
  validateCatName,
  validateModel,
  validateProcessName,
  validateShortcut,
  validateTitlePattern,
  type Validation,
} from '../../../../src/renderer/settings/validate';

const V = S.validation;

function value<T>(r: Validation<T>): T {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

function error<T>(r: Validation<T>): string {
  if (r.ok) throw new Error('expected an error');
  return r.error;
}

describe('validateShortcut', () => {
  it('normalises aliases, case, spacing and modifier order', () => {
    expect(value(validateShortcut('Control+Alt+Shift+C'))).toBe('Control+Alt+Shift+C');
    expect(value(validateShortcut(' ctrl + alt + shift + c '))).toBe('Control+Alt+Shift+C');
    expect(value(validateShortcut('shift+win+p'))).toBe('Shift+Super+P');
    expect(value(validateShortcut('Alt+CmdOrCtrl+f5'))).toBe('CommandOrControl+Alt+F5');
    expect(value(validateShortcut('Ctrl+Alt+space'))).toBe('Control+Alt+Space');
    expect(value(validateShortcut('ctrl+alt+plus'))).toBe('Control+Alt+Plus');
    expect(value(validateShortcut('Alt+num5'))).toBe('Alt+num5');
    expect(value(validateShortcut('Control+/'))).toBe('Control+/');
  });

  it('allows a bare high function key', () => {
    expect(value(validateShortcut('F13'))).toBe('F13');
    expect(value(validateShortcut('shift+f24'))).toBe('Shift+F24');
  });

  it('rejects malformed shortcuts with specific messages', () => {
    expect(error(validateShortcut(''))).toBe(V.shortcutEmpty);
    expect(error(validateShortcut('Control+Alt+'))).toBe(V.shortcutNoKey);
    expect(error(validateShortcut('Control+Alt'))).toBe(V.shortcutNoKey);
    expect(error(validateShortcut('Control+A+B'))).toBe(V.shortcutTwoKeys);
    expect(error(validateShortcut('Control+Hyper+C'))).toBe(V.shortcutUnknownPart('Hyper'));
    expect(error(validateShortcut('Control++C'))).toBe(V.shortcutUnknownPart('+'));
    expect(error(validateShortcut('Ctrl+Control+C'))).toBe(V.shortcutDuplicateModifier('Control'));
    expect(error(validateShortcut('CmdOrCtrl+Ctrl+C'))).toBe(V.shortcutDuplicateModifier('Control'));
    expect(error(validateShortcut('C'))).toBe(V.shortcutNeedsModifier);
    expect(error(validateShortcut('Shift+C'))).toBe(V.shortcutNeedsModifier);
    expect(error(validateShortcut('F5'))).toBe(V.shortcutNeedsModifier);
    expect(error(validateShortcut('x'.repeat(65)))).toBe(V.tooLong(64));
  });

  it('rejects combinations Windows reserves', () => {
    for (const s of ['Ctrl+Alt+Delete', 'alt+tab', 'Alt+F4', 'Win+L', 'Control+Shift+Esc', 'CmdOrCtrl+Escape']) {
      expect(error(validateShortcut(s))).toBe(V.shortcutReserved);
    }
  });
});

describe('exclusion entries', () => {
  it('normalises process names to lower-case .exe basenames', () => {
    expect(value(validateProcessName('KeePass', [], 200))).toBe('keepass.exe');
    expect(value(validateProcessName('  Proton Pass.EXE ', [], 200))).toBe('proton pass.exe');
  });

  it('rejects paths, duplicates and full lists', () => {
    expect(error(validateProcessName('C:\\Tools\\app.exe', [], 200))).toBe(V.processInvalid);
    expect(error(validateProcessName('dir/app', [], 200))).toBe(V.processInvalid);
    expect(error(validateProcessName('.exe', [], 200))).toBe(V.processInvalid);
    expect(error(validateProcessName('   ', [], 200))).toBe(V.required);
    expect(error(validateProcessName('KEEPASS.exe', ['keepass.exe'], 200))).toBe(V.duplicate);
    expect(error(validateProcessName('new.exe', ['a.exe', 'b.exe'], 2))).toBe(V.listFull(2));
    expect(error(validateProcessName('a'.repeat(125), [], 200))).toBe(V.tooLong(128));
  });

  it('normalises title patterns and enforces a useful minimum length', () => {
    expect(value(validateTitlePattern('  Online   BANKING ', [], 100))).toBe('online banking');
    expect(error(validateTitlePattern('x', [], 100))).toBe(V.patternTooShort);
    expect(error(validateTitlePattern('', [], 100))).toBe(V.required);
    expect(error(validateTitlePattern('Password', ['password'], 100))).toBe(V.duplicate);
    expect(error(validateTitlePattern('a\u0007b', ['ab'], 100))).toBe(V.duplicate);
  });
});

describe('AI connection fields', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.255.0.9', '[::1]', '::1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['192.168.1.10', '10.0.0.1', 'example.com', '127.0.0.1.example.com', '0.0.0.0', '128.0.0.1']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('accepts http(s) URLs and reports whether they stay on this PC', () => {
    expect(value(validateBaseUrl('http://127.0.0.1:11434'))).toEqual({ url: 'http://127.0.0.1:11434', loopback: true });
    expect(value(validateBaseUrl(' http://localhost:1234/v1 '))).toEqual({ url: 'http://localhost:1234/v1', loopback: true });
    expect(value(validateBaseUrl('https://gpu-box.lan:8000/v1'))).toEqual({ url: 'https://gpu-box.lan:8000/v1', loopback: false });
  });

  it('rejects other schemes, garbage and embedded credentials', () => {
    expect(error(validateBaseUrl(''))).toBe(V.required);
    expect(error(validateBaseUrl('not a url'))).toBe(V.urlInvalid);
    expect(error(validateBaseUrl('file:///C:/x'))).toBe(V.urlInvalid);
    expect(error(validateBaseUrl('ftp://127.0.0.1'))).toBe(V.urlInvalid);
    expect(error(validateBaseUrl('http://user:secret@127.0.0.1:1234'))).toBe(V.urlCredentials);
    expect(error(validateBaseUrl(`http://127.0.0.1/${'a'.repeat(200)}`))).toBe(V.tooLong(200));
  });

  it('validates model names and API keys', () => {
    expect(value(validateModel('  vision-model:7b ', 200))).toBe('vision-model:7b');
    expect(value(validateModel('', 200))).toBe('');
    expect(error(validateModel('two words', 200))).toBe(V.modelInvalid);
    expect(error(validateModel('m'.repeat(101), 100))).toBe(V.tooLong(100));
    expect(value(validateApiKey('  abcdefgh12345 '))).toBe('abcdefgh12345');
    expect(value(validateApiKey('abcdefgh12345\n'))).toBe('abcdefgh12345');
    expect(error(validateApiKey('short'))).toBe(V.apiKeyLength);
    expect(error(validateApiKey('abc defgh12345'))).toBe(V.apiKeyWhitespace);
    expect(error(validateApiKey('k'.repeat(401)))).toBe(V.apiKeyLength);
  });

  it('validates the cat name', () => {
    expect(value(validateCatName('  Pixel '))).toBe('Pixel');
    expect(error(validateCatName('   '))).toBe(V.required);
    expect(error(validateCatName('x'.repeat(25)))).toBe(V.tooLong(24));
  });
});
