// Character seam (ADR 0004 §10): the cat's descriptor is built from the cat constants, so it can
// never drift from what the sim and the renderer use. Nothing reads it at run time yet.
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../../src/shared/brand';
import { ANIM_CLIPS, CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, CAT_REACTIONS, SKINS } from '../../../src/shared/cat';
import { CAT_CHARACTER } from '../../../src/shared/character';

describe('CAT_CHARACTER', () => {
  it('describes the cat with the constants of shared/cat.ts', () => {
    expect(CAT_CHARACTER.kind).toBe('cat');
    expect(CAT_CHARACTER.displayName).toBe(BRAND.product);
    expect(CAT_CHARACTER.body).toEqual({ widthDip: CAT_BASE_WIDTH_DIP, heightDip: CAT_BASE_HEIGHT_DIP });
    // The same lists, not copies.
    expect(CAT_CHARACTER.clips).toBe(ANIM_CLIPS);
    expect(CAT_CHARACTER.skins).toBe(SKINS);
    expect(CAT_CHARACTER.reactions).toBe(CAT_REACTIONS);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(CAT_CHARACTER)).toBe(true);
    expect(Object.isFrozen(CAT_CHARACTER.body)).toBe(true);
  });
});
