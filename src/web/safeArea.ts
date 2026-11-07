// Safe-area insets (1.4.0): the parts of the screen under the home indicator, a gesture bar, a
// camera housing or rounded corners, as env(safe-area-inset-*) reports them with
// viewport-fit=cover. CSS cannot hand env() to script directly, so a hidden, fixed, full-viewport
// #safe-area-probe carries them as its padding (web.css) and this reads the computed padding.
// The display service subtracts the bottom inset from the work area, so the cat's floor sits above
// the home indicator; the toolbar and the sheet pad themselves in CSS.
//
// Pure: the computed style is passed in.

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: Readonly<Insets> = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Insets above this (CSS px) are treated as a broken reading. */
const MAX_INSET_PX = 400;

/** The slice of CSSStyleDeclaration read here (getComputedStyle's result satisfies it). */
export interface PaddingStyle {
  readonly paddingTop: string;
  readonly paddingRight: string;
  readonly paddingBottom: string;
  readonly paddingLeft: string;
}

function px(v: string | undefined): number {
  const n = Number.parseFloat(v ?? '');
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_INSET_PX, n);
}

/** The insets in CSS px from the probe's computed padding; anything unreadable is 0. */
export function insetsFromPadding(style: PaddingStyle | null | undefined): Insets {
  if (!style) return { ...NO_INSETS };
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}

/** Reads the insets from `probe` with `getStyle` (window.getComputedStyle); never throws. */
export function readSafeAreaInsets<E>(probe: E | null, getStyle: (el: E) => PaddingStyle): Insets {
  if (probe === null) return { ...NO_INSETS };
  try {
    return insetsFromPadding(getStyle(probe));
  } catch {
    return { ...NO_INSETS };
  }
}

export function sameInsets(a: Insets, b: Insets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}
