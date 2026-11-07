// Code-point classes for untrusted text. Kept as numeric ranges (not regex
// escapes) so the source stays plain ASCII and easy to audit.
// Shared (1.4.0) by AI output cleaning (src/core/perception, which re-exports this module) and by
// imported profile names (src/shared/profileTransfer.ts); platform-agnostic, no dependencies.

/** Controls, zero-width, bidi overrides/isolates, BOM, interlinear annotation and Unicode tag characters. */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

export function isInvisibleCodePoint(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** True when the string contains any control/invisible/bidi code point or an ASCII space. */
export function hasInvisibleOrSpace(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20 || isInvisibleCodePoint(cp)) return true;
  }
  return false;
}

/** Replaces every invisible/control/bidi code point with a space. */
export function replaceInvisible(s: string): string {
  let out = '';
  for (const ch of s) out += isInvisibleCodePoint(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out;
}
