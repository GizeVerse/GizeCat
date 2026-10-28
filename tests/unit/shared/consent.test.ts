import { describe, expect, it } from 'vitest';
import { rejectConsentBypass } from '../../../src/shared/settings';

describe('rejectConsentBypass', () => {
  it('allows ordinary patches', () => {
    expect(rejectConsentBypass({ appearance: { size: 1.2 } })).toBeNull();
    expect(rejectConsentBypass({ perception: { region: 'display', minIntervalSec: 30 } })).toBeNull();
    expect(rejectConsentBypass(null)).toBeNull();
  });

  it('allows turning screen analysis off', () => {
    expect(rejectConsentBypass({ perception: { visualMode: 'off' } })).toBeNull();
  });

  it('refuses enabling analysis or writing the consent timestamp outside the consent actions', () => {
    expect(rejectConsentBypass({ perception: { visualMode: 'local-stats' } })).not.toBeNull();
    expect(rejectConsentBypass({ perception: { visualMode: 'ai' } })).not.toBeNull();
    expect(rejectConsentBypass({ perception: { consentAt: '2026-01-01T00:00:00.000Z' } })).not.toBeNull();
    expect(rejectConsentBypass({ perception: { consentAt: null } })).not.toBeNull();
    expect(rejectConsentBypass({ perception: { visualMode: 'off', consentAt: 'x' } })).not.toBeNull();
  });
});
