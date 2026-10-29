import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../../src/shared/settings';

describe('docs/settings.example.json', () => {
  it('matches the current schema defaults (regenerate with node scripts/print-default-settings.mjs)', () => {
    const file = path.join(__dirname, '..', '..', '..', 'docs', 'settings.example.json');
    const example: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(example).toEqual(defaultSettings());
  });
});
