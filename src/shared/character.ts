// Character seam (ADR 0004 §10). The documented contract a second character would fill; today it
// describes the one cat, built from the constants in cat.ts. Hosts keep importing those constants:
// nothing reads a `kind` at run time and nothing here is persisted.
import { ANIM_CLIPS, CAT_BASE_HEIGHT_DIP, CAT_BASE_WIDTH_DIP, CAT_REACTIONS, SKINS, type AnimClip, type CatReactionKind, type SkinId } from './cat';
import { BRAND } from './brand';

export interface CharacterDescriptor {
  readonly kind: 'cat';
  /** The character's name in the UI. */
  readonly displayName: string;
  /** Nominal footprint at size 1.0, in DIP (movement limits; the renderer reports exact pose bounds). */
  readonly body: { readonly widthDip: number; readonly heightDip: number };
  /** Every animation clip the renderer draws. */
  readonly clips: readonly AnimClip[];
  /** The coats the user can choose. */
  readonly skins: readonly SkinId[];
  /** Short body-language reactions layered on the current clip. */
  readonly reactions: readonly CatReactionKind[];
}

export const CAT_CHARACTER: CharacterDescriptor = Object.freeze({
  kind: 'cat',
  displayName: BRAND.product,
  body: Object.freeze({ widthDip: CAT_BASE_WIDTH_DIP, heightDip: CAT_BASE_HEIGHT_DIP }),
  clips: ANIM_CLIPS,
  skins: SKINS,
  reactions: CAT_REACTIONS,
});
