// API-key encryption policy per platform (ADR 0004 §6, audit R6). On Linux, safeStorage can fall
// back to backends that do not encrypt (basic_text, unknown); there the keys are refused instead
// of being stored in effect in plaintext. Every Linux id is covered, XWayland included (review M1).
import type { Logger } from '../contracts';
import type { SecretCipher } from '../store/secretStore';
import { SECRET_BACKEND_REFUSED_REASON, type PlatformServices } from './index';

/** The parts of Electron's safeStorage used here (getSelectedStorageBackend exists on Linux only). */
export interface SafeStorageLike extends SecretCipher {
  getSelectedStorageBackend?: () => string;
}

export function isLinuxPlatform(id: PlatformServices['id']): boolean {
  return id === 'linux-x11' || id === 'linux-xwayland' || id === 'linux-wayland';
}

export function guardedCipher(platform: Pick<PlatformServices, 'id' | 'secretBackendAllowed'>, storage: SafeStorageLike, log: Logger): SecretCipher {
  if (!isLinuxPlatform(platform.id)) return storage;
  let refused: boolean | null = null;
  const allowed = (): boolean => {
    if (refused === null) {
      let backend: string | null;
      try {
        backend = storage.getSelectedStorageBackend ? storage.getSelectedStorageBackend() : null;
      } catch {
        backend = null;
      }
      refused = !platform.secretBackendAllowed(backend);
      if (refused) log.warn('API keys cannot be stored: plaintext keyring backend refused', { backend });
    }
    return !refused;
  };
  return {
    isEncryptionAvailable: () => allowed() && storage.isEncryptionAvailable(),
    encryptString: (plain) => {
      if (!allowed()) throw new Error(SECRET_BACKEND_REFUSED_REASON);
      return storage.encryptString(plain);
    },
    decryptString: (cipher) => {
      if (!allowed()) throw new Error(SECRET_BACKEND_REFUSED_REASON);
      return storage.decryptString(cipher);
    },
  };
}
