// Where a dragged cat hangs from the cursor. Shared by the mover (which keeps the
// grabbing cursor on this point) and the renderer's `held` clip (which pivots and
// swings about it), so the drawn scruff is always under the hand.

/**
 * Scruff (back of the neck) in the `held` pose: offset from the ground anchor in DIP
 * at size 1, facing right (mirror x when facing left).
 */
export const HELD_SCRUFF_DIP = { x: -8, y: -58 } as const;

/** A fresh grab slides to the scruff over this long: the renderer's cross-fade into `held`. */
export const HELD_SETTLE_MS = 220;

/**
 * Anchor-minus-cursor offset that puts the scruff under the cursor, in the caller's
 * units: `unit` is the size of one size-1 DIP (size * display scale factor for px).
 */
export function heldScruffOffset(facing: 1 | -1, unit: number): { x: number; y: number } {
  return { x: -HELD_SCRUFF_DIP.x * facing * unit, y: -HELD_SCRUFF_DIP.y * unit };
}
