import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFile, createSecretStore, ENCRYPTION_UNAVAILABLE_MESSAGE, type SecretCipher } from '../../../src/main/store/secretStore';
import { memoryLogger, removeDir, tempDir } from './helpers';

/** Reversible stand-in for DPAPI: XOR with a fixed byte, so plaintext never appears in the file. */
function fakeCipher(available = true): SecretCipher & { available: boolean } {
  const c = {
    available,
    isEncryptionAvailable: () => c.available,
    encryptString: (s: string) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  };
  return c;
}

describe('secretStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'secrets.json');
  });
  afterEach(() => removeDir(dir));

  // The same wiring as app.ts.
  const make = (cipher = fakeCipher()) => createSecretStore({ store: createSecretFile(file), cipher, logger: memoryLogger() });
  /** Every file in the folder, as text. */
  const everything = () =>
    fs
      .readdirSync(dir)
      .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
      .join('\n');

  it('stores only base64 ciphertext and round-trips', () => {
    const key = 'sk-ant-test-1234567890abcdef';
    const s = make();
    expect(s.has('anthropic')).toBe(false);
    expect(s.set('anthropic', key)).toBe(true);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(key);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries.anthropic).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(s.get('anthropic')).toBe(key);
    expect(make().get('anthropic')).toBe(key);
    expect(make().has('openai-compatible')).toBe(false);
  });

  it('refuses to store keys when encryption is unavailable and says why', () => {
    const s = make(fakeCipher(false));
    expect(s.encryptionAvailable).toBe(false);
    expect(s.unavailableReason).toBe(ENCRYPTION_UNAVAILABLE_MESSAGE);
    expect(s.set('openai-compatible', 'secret-value-123')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes a key with null', () => {
    const s = make();
    s.set('anthropic', 'key-one-123456');
    s.set('openai-compatible', 'key-two-123456');
    expect(s.set('anthropic', null)).toBe(true);
    expect(s.has('anthropic')).toBe(false);
    expect(make().get('openai-compatible')).toBe('key-two-123456');
    expect(s.set('anthropic', null)).toBe(true);
  });

  it('a removed key leaves no copy on disk and does not come back when secrets.json is damaged', () => {
    const s = make();
    s.set('anthropic', 'sk-ant-REMOVE-ME-123456');
    s.set('openai-compatible', 'key-two-123456');
    const removedCiphertext = (JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, string> }).entries.anthropic!;
    expect(s.set('anthropic', null)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['secrets.json']);
    expect(everything()).not.toContain(removedCiphertext);

    fs.writeFileSync(file, '{"version":1,"entries":{"openai-compat');
    const after = make();
    expect(after.get('anthropic')).toBeNull();
    expect(after.has('anthropic')).toBe(false);
    expect(everything()).not.toContain(removedCiphertext);
  });

  it('never loads keys from a backup copy left by an older version, and deletes it', () => {
    const old = make();
    old.set('anthropic', 'sk-ant-OLD-KEY-123456');
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, '');
    const s = make();
    expect(s.has('anthropic')).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('returns null when decryption fails instead of throwing', () => {
    const cipher = fakeCipher();
    const s = make(cipher);
    s.set('anthropic', 'key-one-123456');
    cipher.decryptString = () => {
      throw new Error('DPAPI: wrong user');
    };
    expect(s.get('anthropic')).toBeNull();
  });

  it('ignores a malformed secrets file', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { anthropic: 'not base64 !!!' } }));
    expect(make().has('anthropic')).toBe(false);
  });
});
