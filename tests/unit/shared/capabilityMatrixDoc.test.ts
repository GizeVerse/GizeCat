// The rendered capability matrix must match the declared table (ADR 0004 §2.3): statuses are
// stated in exactly one place, and the docs never drift from it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCapabilityMatrix } from '../../../src/shared/capabilityMatrixDoc';
import { CAPABILITY_IDS, PLATFORM_IDS } from '../../../src/shared/platform';

const DOC = path.join(__dirname, '..', '..', '..', 'docs', 'gizeverse', 'capability-matrix.md');

describe('docs/gizeverse/capability-matrix.md', () => {
  it('is up to date with src/shared/platform.ts (regenerate: node scripts/capability-matrix.mjs)', () => {
    // Line endings may be converted by git on checkout; compare the text, not the bytes.
    const onDisk = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(renderCapabilityMatrix());
  });

  it('has one row per capability in the overview and a section per platform', () => {
    const text = renderCapabilityMatrix();
    for (const p of PLATFORM_IDS) expect(text).toContain(`(\`${p}\`)`);
    const overview = text.split('## Overview')[1]!.split('\n## ')[0]!;
    expect(overview.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Capability')).length).toBe(CAPABILITY_IDS.length);
  });
});
