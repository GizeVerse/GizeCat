// v1.2 landing impact (ADR 0003 §6.4): the class and a 0..1 level of a landing from its vertical
// impact speed. Pure; the sim scales the landing pause and the recovery with it.
import type { LandingImpact } from '../../shared/cat';
import { MOVEMENT } from './constants';

/** soft below MOVEMENT.impactSoftBelowDip, hard from MOVEMENT.impactHardFromDip, medium between (DIP/s). */
export function impactClass(impactDip: number): LandingImpact {
  const v = Number.isFinite(impactDip) ? Math.abs(impactDip) : 0;
  if (v >= MOVEMENT.impactHardFromDip) return 'hard';
  return v >= MOVEMENT.impactSoftBelowDip ? 'medium' : 'soft';
}

/** 0..1 hardness for the renderer (`impact`): 0 at rest, 1 at twice the hard threshold. */
export function impactLevel(impactDip: number): number {
  const v = Number.isFinite(impactDip) ? Math.abs(impactDip) : 0;
  return Math.min(1, v / (2 * MOVEMENT.impactHardFromDip));
}
