// Small cat-head illustrations for the coat picker (inline SVG, no assets).
import type { SkinId } from '../../shared/cat';
import { svg } from './dom';

interface Coat {
  fur: string;
  /** Secondary colour: stripes, patches, mask or bib. */
  mark: string;
  pattern: 'stripes' | 'solid' | 'bib' | 'patches' | 'points';
  eye: string;
  innerEar: string;
}

const COATS: Record<SkinId, Coat> = {
  ginger: { fur: '#e8954a', mark: '#c4682a', pattern: 'stripes', eye: '#3a2a1a', innerEar: '#f3b98a' },
  gray: { fur: '#8f959d', mark: '#6c727a', pattern: 'stripes', eye: '#2c3a2a', innerEar: '#c9a5a5' },
  black: { fur: '#2b2b30', mark: '#2b2b30', pattern: 'solid', eye: '#e8c547', innerEar: '#5a4448' },
  tuxedo: { fur: '#2b2b30', mark: '#f4f1ec', pattern: 'bib', eye: '#9bd46a', innerEar: '#5a4448' },
  calico: { fur: '#f4efe6', mark: '#e2873e', pattern: 'patches', eye: '#4b3a1f', innerEar: '#f0b8b0' },
  siamese: { fur: '#efe3cf', mark: '#5b4334', pattern: 'points', eye: '#4f8fd6', innerEar: '#7a5a48' },
  cream: { fur: '#f1dcb3', mark: '#dcbd86', pattern: 'stripes', eye: '#4b3a1f', innerEar: '#f2bfae' },
};

export function coatArt(skin: SkinId): SVGSVGElement {
  const c = COATS[skin];
  const earFill = c.pattern === 'points' ? c.mark : c.fur;
  const parts: SVGElement[] = [
    svg('path', { d: 'M9 23 L13 5 L24 15 Z', fill: earFill, class: 'coat-outline' }),
    svg('path', { d: 'M47 23 L43 5 L32 15 Z', fill: c.pattern === 'patches' ? '#3a3433' : earFill, class: 'coat-outline' }),
    svg('path', { d: 'M13 18 L15 10 L20 15 Z', fill: c.innerEar }),
    svg('path', { d: 'M43 18 L41 10 L36 15 Z', fill: c.innerEar }),
    svg('ellipse', { cx: 28, cy: 29, rx: 19, ry: 16, fill: c.fur, class: 'coat-outline' }),
  ];
  if (c.pattern === 'stripes') {
    parts.push(
      svg('path', { d: 'M28 13 L28 19 M23 14 L24 19 M33 14 L32 19', stroke: c.mark, 'stroke-width': 2.2, 'stroke-linecap': 'round', fill: 'none' }),
    );
  } else if (c.pattern === 'patches') {
    parts.push(svg('path', { d: 'M12 22 Q14 14 24 14 Q22 22 15 28 Q11 27 12 22 Z', fill: c.mark }));
    parts.push(svg('path', { d: 'M36 14 Q44 15 45 24 Q40 22 35 19 Z', fill: '#3a3433' }));
  } else if (c.pattern === 'bib') {
    parts.push(svg('path', { d: 'M28 24 Q20 30 18 38 Q23 44 28 44 Q33 44 38 38 Q36 30 28 24 Z', fill: c.mark }));
  } else if (c.pattern === 'points') {
    parts.push(svg('ellipse', { cx: 28, cy: 35, rx: 9, ry: 8, fill: c.mark, opacity: 0.85 }));
  }
  parts.push(
    svg('ellipse', { cx: 21, cy: 28, rx: 2.6, ry: 3.2, fill: c.eye }),
    svg('ellipse', { cx: 35, cy: 28, rx: 2.6, ry: 3.2, fill: c.eye }),
    svg('path', { d: 'M26 34 L30 34 L28 36.5 Z', fill: '#e48f95' }),
  );
  return svg('svg', { viewBox: '0 0 56 48', width: 56, height: 48, class: 'coat-art', 'aria-hidden': 'true', focusable: 'false' }, parts);
}

/** Brand mark for the navigation rail. */
export function brandMark(): SVGSVGElement {
  return coatArt('ginger');
}
