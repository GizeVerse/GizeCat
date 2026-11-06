// API-key encryption policy per platform (ADR 0004 §6, audit R6, review M1): plaintext safeStorage
// backends are refused on every Linux id, XWayland included; other platforms use safeStorage as is.
import { describe, expect, it } from 'vitest';
import { createPlatformServices, SECRET_BACKEND_REFUSED_REASON } from '../../../src/main/platform';
import { guardedCipher, isLinuxPlatform, type SafeStorageLike } from '../../../src/main/platform/secrets';
import type { PlatformProbe } from '../../../src/shared/platform';
import { memoryLogger } from './helpers';

function storage(backend: string | null): SafeStorageLike & { encrypted: string[] } {
  const encrypted: string[] = [];
  return {
    encrypted,
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => {
      encrypted.push(s);
      return Buffer.from(`enc:${s}`);
    },
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
    ...(backend === null ? {} : { getSelectedStorageBackend: () => backend }),
  };
}

const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({}) as never, getCursorScreenPoint: () => ({ x: 0, y: 0 }) };
const services = (probe: Partial<PlatformProbe>) =>
  createPlatformServices({ os: 'linux', waylandDisplay: false, x11Display: true, ozonePlatform: null, ...probe }, screen);

describe('guardedCipher', () => {
  it('refuses basic_text on linux-x11, linux-xwayland and linux-wayland alike', () => {
    for (const probe of [{}, { waylandDisplay: true, ozonePlatform: 'x11' }, { waylandDisplay: true }]) {
      const p = services(probe);
      expect(isLinuxPlatform(p.id)).toBe(true);
      const s = storage('basic_text');
      const log = memoryLogger();
      const c = guardedCipher(p, s, log);
      expect(c.isEncryptionAvailable(), p.id).toBe(false);
      expect(() => c.encryptString('sk-test'), p.id).toThrow(SECRET_BACKEND_REFUSED_REASON);
      expect(s.encrypted).toEqual([]);
      expect(log.entries.some((e) => e.msg === 'API keys cannot be stored: plaintext keyring backend refused')).toBe(true);
    }
  });

  it('refuses an unknown backend and a missing backend query on Linux', () => {
    expect(guardedCipher(services({}), storage('unknown'), memoryLogger()).isEncryptionAvailable()).toBe(false);
    expect(guardedCipher(services({}), storage(null), memoryLogger()).isEncryptionAvailable()).toBe(false);
  });

  it('uses a real keyring backend on Linux', () => {
    const s = storage('gnome_libsecret');
    const c = guardedCipher(services({ waylandDisplay: true, ozonePlatform: 'x11' }), s, memoryLogger());
    expect(c.isEncryptionAvailable()).toBe(true);
    expect(c.decryptString(c.encryptString('sk-test'))).toBe('sk-test');
  });

  it('returns safeStorage itself on Windows and macOS (v1.2 behaviour)', () => {
    for (const os of ['win32', 'darwin']) {
      const s = storage(null);
      expect(guardedCipher(services({ os }), s, memoryLogger())).toBe(s);
    }
  });
});
