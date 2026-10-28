// API keys encrypted with Electron safeStorage (DPAPI on Windows). The file holds
// base64 ciphertext only; plaintext exists in memory only for the duration of a
// get() call. The cipher is injected so this module stays Electron-free.
import { z } from 'zod';
import type { Logger, SecretStore } from '../contracts';
import type { JsonStore } from './jsonStore';

export type SecretName = 'anthropic' | 'openai-compatible';

export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface ManagedSecretStore extends SecretStore {
  /** False when the OS cannot encrypt (keys are then never stored). */
  readonly encryptionAvailable: boolean;
  /** Human-readable reason set() refused, or null. */
  readonly unavailableReason: string | null;
}

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.partialRecord(z.enum(['anthropic', 'openai-compatible']), z.string().max(8192).regex(/^[A-Za-z0-9+/]*={0,2}$/)),
});
type SecretFile = z.infer<typeof FileSchema>;

export const ENCRYPTION_UNAVAILABLE_MESSAGE =
  'Secure storage (Windows DPAPI) is not available, so API keys cannot be saved. Local AI providers still work without a key.';

export function createSecretStore(opts: { store: JsonStore; cipher: SecretCipher; logger: Logger }): ManagedSecretStore {
  const log = opts.logger;
  let entries: Partial<Record<SecretName, string>> = {};

  const r = opts.store.read();
  if (r.status === 'ok' || r.status === 'recovered-backup') {
    const parsed = FileSchema.safeParse(r.value);
    if (parsed.success) entries = { ...parsed.data.entries };
    else log.warn('secrets file has an unexpected shape; ignoring it');
  }

  function available(): boolean {
    try {
      return opts.cipher.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  function persist(next: Partial<Record<SecretName, string>>): boolean {
    const file: SecretFile = { version: 1, entries: next };
    if (!opts.store.writeSync(file)) return false;
    entries = next;
    return true;
  }

  return {
    get encryptionAvailable() {
      return available();
    },
    get unavailableReason() {
      return available() ? null : ENCRYPTION_UNAVAILABLE_MESSAGE;
    },
    has(name) {
      return typeof entries[name] === 'string' && entries[name] !== '';
    },
    get(name) {
      const b64 = entries[name];
      if (!b64) return null;
      if (!available()) {
        log.warn('secret requested but encryption is unavailable', { provider: name });
        return null;
      }
      try {
        const plain = opts.cipher.decryptString(Buffer.from(b64, 'base64'));
        return plain.length > 0 ? plain : null;
      } catch (err) {
        log.error('stored secret could not be decrypted (different Windows user or profile?)', { provider: name, error: err });
        return null;
      }
    },
    set(name, value) {
      if (value === null) {
        if (!(name in entries)) return true;
        const next = { ...entries };
        delete next[name];
        return persist(next);
      }
      if (!available()) {
        log.warn('refusing to store an API key: encryption unavailable', { provider: name });
        return false;
      }
      let b64: string;
      try {
        b64 = opts.cipher.encryptString(value).toString('base64');
      } catch (err) {
        log.error('encrypting API key failed', { provider: name, error: err });
        return false;
      }
      return persist({ ...entries, [name]: b64 });
    },
  };
}
