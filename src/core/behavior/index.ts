// Public entry point of the cat's behaviour simulation.
import type { PersistedCat } from '../../shared/catState';
import type { CatSim, CreateCatSim } from '../../shared/sim';
import { CatSimImpl } from './sim';

/** Creates the cat simulation (see src/shared/sim.ts for the contract). */
export const createCatSim: CreateCatSim = (opts) => new CatSimImpl(opts);

/**
 * 1.4.0 (profile import): hands an imported cat to this core's simulation (CatSimImpl.adoptCat:
 * validated, traits clamped, lastPosition kept). False, changing nothing, when `sim` is another
 * CatSim implementation (a test fake); throws when `next` is not a valid persisted cat.
 */
export function adoptCatInto(sim: CatSim, next: PersistedCat): boolean {
  if (!(sim instanceof CatSimImpl)) return false;
  sim.adoptCat(next);
  return true;
}

export { migrateCatState } from './migrate';
export type { MigrationResult } from './migrate';
export { newPersistedCat, randomTraits, TRAIT_MAX, TRAIT_MIN } from './personality';
export { summarizeCat } from './summary';
export { mulberry32 } from './random';
export type { Random } from './random';
export { canTransition, findPath, MAX_STATE_CHANGES_PER_WINDOW, STATE_CHANGE_WINDOW_MS, STATE_SPECS, TRANSITIONS } from './states';
export type { TransitionCause } from './states';
export { CLIP_MAP, clipFor } from './clips';
export type { SimHooks, SimMode, TransitionRecord } from './sim';
export { createInstrumentedCatSim } from './sim';
