// 1.4.0 macOS wording: the secret store names the platform's own encryption (Windows DPAPI as
// before, the macOS Keychain on a Mac, a neutral term elsewhere). Pure strings. Written in the 1.4.0
// mission, NOT executed there.
import { describe, expect, it } from 'vitest';
import { apiKeySavedMessage, encryptionUnavailableMessage, ENCRYPTION_UNAVAILABLE_MESSAGE, secureStorageName } from '../../../src/main/store/secretStore';

describe('secret store wording per platform', () => {
  it('Windows keeps its pre-1.4.0 text exactly', () => {
    expect(encryptionUnavailableMessage('win32')).toBe('Secure storage (Windows DPAPI) is not available, so API keys cannot be saved. Local AI providers still work without a key.');
    expect(apiKeySavedMessage('win32')).toBe('API key saved (encrypted with Windows DPAPI).');
  });

  it('macOS names the Keychain and never Windows', () => {
    expect(encryptionUnavailableMessage('darwin')).toContain('macOS Keychain');
    expect(encryptionUnavailableMessage('darwin')).not.toContain('Windows');
    expect(apiKeySavedMessage('darwin')).toBe('API key saved (encrypted with the macOS Keychain).');
  });

  it('other platforms get a neutral term', () => {
    expect(secureStorageName('linux')).not.toMatch(/Windows|macOS|DPAPI|Keychain/);
    expect(encryptionUnavailableMessage('linux')).not.toMatch(/Windows|DPAPI/);
  });

  it('the exported constant is this process’s text', () => {
    expect(ENCRYPTION_UNAVAILABLE_MESSAGE).toBe(encryptionUnavailableMessage(process.platform));
  });
});
